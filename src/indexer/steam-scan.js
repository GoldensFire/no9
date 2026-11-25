// Обход Мастерской Steam (SIGame, AppID 3553500): новые паки, обновления
// на месте (смена hcontent) и проверка пропавших/забаненных элементов.
//
// Только для дома и GitHub Actions: в cf/src/** не используется.
// По устройству повторяет src/indexer/vk-scan.js:
// - в инкрементальном режиме (--tail или когда уже есть отметка steam_tail_at
//   и не задан --steam-full) листает RankedByLastUpdatedDate до steam_tail_at;
// - при первом запуске или --steam-full обходит всю Мастерскую сверху вниз
//   по подпискам (RankedByTotalUniqueSubscriptions), а затем сверяет живые
//   steam_id через безключевой GetPublishedFileDetails пачками по 100;
// - --steam-ids=id1,id2 подтягивает конкретные элементы Мастерской точечно.

import { config } from '../config.js';
import { db } from '../db.js';
import { getSteamSession } from '../steam/session.js';
import {
	getPublishedFileDetails,
	queryWorkshopFiles,
	WORKSHOP_QUERY,
} from '../steam/workshop.js';
import {
	freshSince, limit, maxPages, outOfTime, steamCheck, steamFull, steamIds, tail,
} from './options.js';
import { retryNetwork } from './pipeline.js';
import { say, track } from './progress.js';
import {
	insertPackage,
	markPackSteamState,
	refreshPackSteamMeta,
	updateSteamRecheck,
	upsertPackSteam,
} from './store.js';
import { noteSteamTailRead, steamTailReadUntil } from './tail.js';

const APP_ID = config.steamAppId;

/** Минимальный вес элемента Мастерской (10 КБ): отсеивает пустышки до скачивания. */
const MIN_STEAM_FILE_SIZE = 10_240;

/** Размер страницы QueryFiles#1 (верхний предел протокола Valve — 100). */
const PAGE_SIZE = 100;

/** Размер пачки для GetPublishedFileDetails/v1 (верхний предел HTTP API — 100). */
const DETAILS_BATCH = 100;

/** Запас при --tail, если отметки steam_tail_at ещё нет: сутки до freshSince. */
const TAIL_MARGIN_MS = 86_400_000;

const findSteamById = db.prepare(`
	SELECT ps.package_id, ps.steam_id, ps.target_package_id, ps.is_primary,
		ps.hcontent, ps.state, p.status, p.url
	FROM pack_steam ps
	JOIN packages p ON p.id = ps.package_id
	WHERE ps.steam_id = ?
`);

const findPackageBySourceKey = db.prepare('SELECT id, status, url FROM packages WHERE source_key = ?');

const aliveSteamRows = db.prepare(`
	SELECT ps.package_id, ps.steam_id, ps.target_package_id, ps.is_primary, p.status, p.url
	FROM pack_steam ps
	JOIN packages p ON p.id = ps.package_id
	WHERE ps.state = 'ok' AND ps.synced_at < ?
	ORDER BY ps.synced_at ASC
`);

const countAliveSteam = db.prepare(`SELECT COUNT(*) AS c FROM pack_steam WHERE state = 'ok'`);

const resurrectSteamPackage = db.prepare(`
	UPDATE packages SET status = 'new', error = NULL, recheck = 0
	WHERE id = ? AND status = 'dead'
`);

const burySteamOnlyPackage = db.prepare(`
	UPDATE packages SET status = 'dead', error = ?, recheck = 0
	WHERE id = ? AND url = '' AND status IN ('ok', 'new', 'copy')
`);

const promoteOtherPrimary = db.prepare(`
	UPDATE pack_steam SET is_primary = 1
	WHERE package_id = (
		SELECT package_id FROM pack_steam
		WHERE target_package_id = ? AND state = 'ok' AND package_id <> ?
		ORDER BY subscriptions DESC, updated_at DESC, package_id ASC
		LIMIT 1
	)
`);

function formatSteamFileName(item) {
	const raw = String(item.filename ?? '').trim();

	if (raw) {
		const base = raw.split(/[\\/]/).pop();

		if (base) {
			return base;
		}
	}

	const title = String(item.title ?? '').trim().slice(0, 120);

	return title ? `${title}.siq` : `steam-${item.steamId}.siq`;
}

function deadReason(item) {
	if (item.result !== undefined && item.result !== 1) {
		return { state: 'dead', reason: 'элемент удалён из Мастерской Steam' };
	}

	if (item.banned) {
		return { state: 'banned', reason: 'элемент заблокирован в Мастерской Steam' };
	}

	if (item.visibility !== 0) {
		return { state: 'hidden', reason: 'элемент скрыт в Мастерской Steam' };
	}

	return null;
}

/** Применяет пропажу/блокировку элемента Мастерской: для Steam-only хоронит пак, для зеркала — снимает значок. */
function applySteamDead(row, state, reason, now) {
	markPackSteamState.run(state, now, row.package_id);

	if (row.url === '') {
		burySteamOnlyPackage.run(reason, row.package_id);
	}

	if (row.is_primary === 1 && row.target_package_id !== row.package_id) {
		promoteOtherPrimary.run(row.target_package_id, row.package_id);
	}
}

/** Сверяет один элемент Мастерской с локальной базой (packages + pack_steam). */
function syncWorkshopItem(item, now, tally) {
	const steamId = String(item.steamId ?? '').trim();

	if (!steamId || steamId === '0') {
		tally.skipped++;
		return;
	}

	const existing = findSteamById.get(steamId);
	const dead = deadReason(item);

	if (dead) {
		if (existing && existing.state !== dead.state) {
			applySteamDead(existing, dead.state, dead.reason, now);
			tally.dead++;
		} else {
			tally.skipped++;
		}

		return;
	}

	if (!item.hcontent || item.hcontent === '0' || (item.fileSize ?? 0) < MIN_STEAM_FILE_SIZE) {
		tally.skipped++;
		return;
	}

	const createdAt = item.createdAt > 0 ? item.createdAt : now;
	const updatedAt = item.updatedAt > 0 ? item.updatedAt : createdAt;

	if (existing) {
		const contentChanged = Boolean(existing.hcontent && existing.hcontent !== item.hcontent);

		if (contentChanged) {
			upsertPackSteam.run(
				existing.package_id,
				steamId,
				existing.target_package_id,
				existing.is_primary,
				item.hcontent,
				null, // sha1 пересчитается при разборе нового манифеста
				item.creatorId || null,
				item.title || null,
				item.fileSize || null,
				item.subscriptions ?? 0,
				item.views ?? 0,
				item.revision ?? 0,
				createdAt,
				updatedAt,
				item.previewUrl || null,
				'ok',
				now,
			);

			// При обновлении «на месте» vk_ts не трогаем, чтобы правка опечатки
			// не поднимала старый пак наверх «Новых» (раздел 5.4 steam-workshop.md)
			updateSteamRecheck.run(updatedAt, existing.package_id);
			tally.updated++;
			return;
		}

		refreshPackSteamMeta.run(
			item.creatorId || null,
			item.title || null,
			item.fileSize || null,
			item.subscriptions ?? 0,
			item.views ?? 0,
			item.revision ?? 0,
			createdAt,
			updatedAt,
			item.previewUrl || null,
			'ok',
			now,
			existing.package_id,
		);

		if (existing.state !== 'ok' && existing.status === 'dead') {
			resurrectSteamPackage.run(existing.package_id);
			tally.back++;
		}

		tally.refreshed++;
		return;
	}

	// Новый элемент Мастерской: создаём строку в packages с url = '' (не NULL —
	// колонка NOT NULL в src/db.js) и пустыми ВК-полями, чтобы не задеть vk-scan и mergeAuthors
	const sourceKey = `steam:${steamId}`;
	let pkg = findPackageBySourceKey.get(sourceKey);

	if (!pkg) {
		const res = insertPackage.run(
			sourceKey,
			'',
			formatSteamFileName(item),
			null,
			null,
			null,
			null,
			null,
			createdAt,
			updatedAt,
			null,
		);

		const id = res.changes > 0
			? Number(res.lastInsertRowid)
			: findPackageBySourceKey.get(sourceKey)?.id;

		if (!id) {
			tally.skipped++;
			return;
		}

		pkg = { id };
	}

	upsertPackSteam.run(
		pkg.id,
		steamId,
		pkg.id,
		1,
		item.hcontent,
		null,
		item.creatorId || null,
		item.title || null,
		item.fileSize || null,
		item.subscriptions ?? 0,
		item.views ?? 0,
		item.revision ?? 0,
		createdAt,
		updatedAt,
		item.previewUrl || null,
		'ok',
		now,
	);

	tally.added++;
}

/**
 * Ночная сверка живых steam_id через безключевой GetPublishedFileDetails/v1:
 * QueryFiles просто перестаёт отдавать удалённые/скрытые/забаненные паки,
 * и заметить их пропажу можно только по прямому списку ID.
 */
async function checkAliveSteamItems(startedAt, tally) {
	const rows = aliveSteamRows.all(startedAt);

	if (rows.length === 0) {
		return;
	}

	const aliveTotal = countAliveSteam.get().c;
	const pendingDead = [];
	const now = Date.now();

	say('steam', `проверяю ${rows.length} прежних элементов Мастерской на удаление/блокировку…`);

	for (let at = 0; at < rows.length && !outOfTime(); at += DETAILS_BATCH) {
		const batch = rows.slice(at, at + DETAILS_BATCH);
		const ids = batch.map(r => r.steam_id);
		const details = await retryNetwork(() => getPublishedFileDetails(ids));
		const byId = new Map(details.map(item => [item.steamId, item]));

		for (const row of batch) {
			const item = byId.get(row.steam_id);

			if (!item) {
				continue;
			}

			const dead = deadReason(item);

			if (dead) {
				pendingDead.push({ row, ...dead });
			} else {
				syncWorkshopItem(item, now, tally);
			}
		}
	}

	if (pendingDead.length === 0) {
		return;
	}

	// Тот же предохранитель, что в vk-scan.js (applyPending): обвал > 5% базы
	// за один проход похож на сбой Steam API, а не на массовое удаление паков
	const ceiling = Math.max(25, Math.round(aliveTotal * 0.05));

	if (pendingDead.length > ceiling) {
		console.error(
			`[Steam] сверка насчитала ${pendingDead.length} пропавших паков при ${aliveTotal} живых — `
			+ 'похоже на сбой Steam API, ничего не хороню.',
		);
		return;
	}

	for (const entry of pendingDead) {
		applySteamDead(entry.row, entry.state, entry.reason, now);
		tally.dead++;
	}
}

export async function scanSteam() {
	const startedAt = Date.now();
	const bar = track('steam');
	const tally = { added: 0, updated: 0, refreshed: 0, skipped: 0, dead: 0, back: 0 };

	// Точечный режим --steam-ids=3635881022,3496225043: быстро и без CM-листинга
	if (steamIds.length > 0) {
		say('steam', `точечный обход элементов Мастерской: ${steamIds.length} шт.`);
		bar.expand(steamIds.length);

		for (let at = 0; at < steamIds.length; at += DETAILS_BATCH) {
			const batch = steamIds.slice(at, at + DETAILS_BATCH);
			const details = await retryNetwork(() => getPublishedFileDetails(batch));
			const now = Date.now();

			for (const item of details) {
				syncWorkshopItem(item, now, tally);
				bar.tick();
			}
		}

		say(
			'steam',
			`добавлено ${tally.added}, обновлено ${tally.updated}, сверено ${tally.refreshed}, `
			+ `пропущено ${tally.skipped}${tally.dead ? `, пропало ${tally.dead}` : ''}.`,
		);
		return;
	}

	const storedTail = steamTailReadUntil();
	const useTail = !steamFull && (tail || storedTail !== null);
	const since = useTail
		? (storedTail ?? (freshSince !== null ? freshSince - TAIL_MARGIN_MS : startedAt - TAIL_MARGIN_MS))
		: null;

	const queryType = useTail
		? WORKSHOP_QUERY.RankedByLastUpdatedDate
		: WORKSHOP_QUERY.RankedByTotalUniqueSubscriptions;

	say(
		'steam',
		useTail
			? `инкрементальный обход Мастерской (обновления новее ${new Date(since).toLocaleString('ru-RU')})`
			: 'полный обход Мастерской Steam (сначала самые популярные по подпискам)',
	);

	const session = await getSteamSession();
	let cursor = '*';
	let pages = 0;
	let read = 0;
	let announced = null;
	let reachedEnd = false;
	let stoppedByBudget = false;
	let broken = false;

	try {
		while (pages < maxPages && !outOfTime()) {
			const remaining = limit === Infinity ? PAGE_SIZE : Math.min(PAGE_SIZE, limit - read);

			if (remaining <= 0) {
				stoppedByBudget = true;
				break;
			}

			const page = await retryNetwork(() => queryWorkshopFiles(session.cm, {
				appId: APP_ID,
				queryType,
				numPerPage: remaining,
				cursor,
			}));

			pages++;

			if (announced === null && page.total > 0) {
				announced = limit === Infinity ? page.total : Math.min(page.total, limit);
				bar.expand(announced);
			}

			if (page.items.length === 0) {
				reachedEnd = true;
				break;
			}

			const now = Date.now();
			let hitCutoff = false;

			for (const item of page.items) {
				if (useTail && item.updatedAt > 0 && item.updatedAt < since) {
					hitCutoff = true;
					break;
				}

				syncWorkshopItem(item, now, tally);
				read++;
				bar.tick();

				if (read >= limit) {
					stoppedByBudget = true;
					break;
				}
			}

			if (hitCutoff) {
				reachedEnd = true;
				break;
			}

			if (stoppedByBudget) {
				break;
			}

			if (!page.nextCursor || page.nextCursor === cursor) {
				reachedEnd = true;
				break;
			}

			cursor = page.nextCursor;

			if (pages % 10 === 0) {
				say('steam', `прочитано ${read}${announced ? ` из ${announced}` : ''} элементов (страниц ${pages})`);
			}
		}
	} catch (error) {
		broken = true;
		throw error;
	} finally {
		// Двигаем хвост только если обход честно дошёл до отсечки/конца (не оборвался и не упёрся в --limit/--pages)
		if (!broken && reachedEnd && !stoppedByBudget && maxPages === Infinity && !outOfTime()) {
			noteSteamTailRead(startedAt);
		}
	}

	// Сверка удалённых/забаненных: при полном проходе без лимита или по явному --steam-check
	if ((steamCheck || (!useTail && !stoppedByBudget && maxPages === Infinity)) && !outOfTime()) {
		await checkAliveSteamItems(startedAt, tally);
	}

	say(
		'steam',
		`просмотрено ${read} элементов (страниц ${pages}): новых ${tally.added}, `
		+ `обновлено ${tally.updated}, сверено ${tally.refreshed}, пропущено ${tally.skipped}`
		+ `${tally.back ? `, вернулось ${tally.back}` : ''}`
		+ `${tally.dead ? `, пропало/скрыто ${tally.dead}` : ''}.`,
	);
}
