// Копии одного пака: склейка дубликатов ВК ↔ ВК, ВК ↔ Steam и Steam ↔ Steam.
//
// Один и тот же файл выкладывают по нескольку раз: в обсуждение ВК, в Мастерскую
// Steam, с мелкими правками опечаток или пересжатым медиафайлом. Копией пак
// признаётся по содержимому (отпечатки вопросов pack_prints, SHA-1 манифеста,
// вес архива, автор и название).
//
// Правила выживания (см. разделы 5.1–5.3 и 10.3 в steam-workshop.md):
// 1. Живой ВК-пак (url <> '') всегда приоритетнее Steam-дубля, кроме случая
//    «промоушена»: если Steam-пак уже выложен в D1 (есть в d1_sync или уже
//    получил ВК-зеркало ранее), а ВК-дубль новый — сохраняем id Steam-пака,
//    чтобы не потерять пользовательские оценки и комментарии по pack_key,
//    и копируем в него ВК-ссылку.
// 2. Среди Steam ↔ Steam дубликатов одного автора остаётся ПОСЛЕДНЯЯ версия
//    (max updated_at, при равенстве created_at / steam_id). Среди дубликатов
//    разных авторов — самый ранний.
// 3. Все строки pack_steam синхронизируют target_package_id и is_primary,
//    поэтому склейка полностью обратима.
//
// Приговоры выносятся всей библиотеке разом, поэтому шаг ждёт разбора
// и отпечатков по-настоящему, а не «кормится» ими (см. STEPS в steps.js).

import { db, buildAuthorKey } from '../db.js';
import { contentTs, decodePrints } from '../plagiarism.js';
import { say } from './progress.js';
import { targetSql } from './queue.js';

// ————— пороги склейки —————

/** Допуск расхождения веса для пар ВК ↔ ВК (0,5% — прежнее правило). */
const VK_SIZE_SPREAD = 0.005;

/** Допуск расхождения вопросов для пар ВК ↔ ВК (3%). */
const VK_QUESTION_SPREAD = 0.03;

/**
 * Допуск расхождения веса для кросс-источниковых (ВК ↔ Steam) и Steam-пар (5%).
 * По живым замерам реальные дубли GoldensFire / «кринж солянка №5» расходятся
 * на 0,75%–0,90% из-за правок и пересжатия медиа — 0,5% их пропускал.
 */
const STEAM_SIZE_SPREAD = 0.05;

/** Допуск расхождения числа вопросов для уровня 2 (ВК ↔ Steam / Steam ↔ Steam). */
const STEAM_QUESTION_SPREAD = 0.05;

/** Порог пересечения отпечатков для уровня 2 (с совпадением нешаблонного имени и автора). */
const STEAM_OVERLAP_MIN = 0.75;

/** Порог пересечения отпечатков для уровня 3 (переименование / шаблонное имя). */
const RENAME_OVERLAP_MIN = 0.95;

/** Допуск числа вопросов и веса для уровня 3 (без опоры на имя). */
const RENAME_QUESTION_SPREAD = 0.03;
const RENAME_SIZE_SPREAD = 0.02;

/** Отпечаток, встречающийся в стольких паках, — фольклор; в инвертированный индекс не идёт. */
const INDEX_COMMON_PACKS = 5;

/**
 * Шаблонные названия паков: по одному имени и весу никогда не склеиваются —
 * только по точному SHA-1 или по уровню 3 (pack_prints >= 95%).
 */
const TEMPLATE_NAMES = new Set([
	'',
	'вопросы sigame',
	'свояк',
	'мой пак',
	'своя игра',
	'sigame',
	'пак',
	'новый пак',
	'без названия',
]);

const isTemplateName = nameKey => TEMPLATE_NAMES.has(nameKey);

function sizeSpread(a, b) {
	const max = Math.max(a.size ?? 0, b.size ?? 0);

	if (max <= 0) {
		return 0;
	}

	return Math.abs((a.size ?? 0) - (b.size ?? 0)) / max;
}

function questionSpread(a, b) {
	const max = Math.max(a.questions ?? 0, b.questions ?? 0);

	if (max <= 0) {
		return 0;
	}

	return Math.abs((a.questions ?? 0) - (b.questions ?? 0)) / max;
}

function printsCommon(a, b) {
	const [small, big] = a.prints.size <= b.prints.size ? [a.prints, b.prints] : [b.prints, a.prints];
	let common = 0;

	for (const fp of small) {
		if (big.has(fp)) {
			common++;
		}
	}

	return common;
}

/** Уровень 1б / 2: сравнение внутри корзины (одинаковые автор и название). */
function sameBucketContent(a, b) {
	if (a.nameKey !== b.nameKey || a.authorsKey !== b.authorsKey) {
		return false;
	}

	if (a.printsVersion !== b.printsVersion || a.prints.size === 0 || b.prints.size === 0) {
		return false;
	}

	const crossOrSteam = a.isSteam || b.isSteam;
	const template = isTemplateName(a.nameKey);
	const maxSizeSpread = crossOrSteam && !template ? STEAM_SIZE_SPREAD : VK_SIZE_SPREAD;

	if (sizeSpread(a, b) > maxSizeSpread) {
		return false;
	}

	const total = Math.max(a.prints.size, b.prints.size);
	const common = printsCommon(a, b);

	// Для шаблонных названий («Вопросы SIGame», «Свояк») и пар ВК ↔ ВК
	// держим строгий порог по отпечаткам вопросов (>= 95% / >= 97%)
	if (crossOrSteam && !template) {
		if (questionSpread(a, b) > STEAM_QUESTION_SPREAD) {
			return false;
		}

		return common / total >= STEAM_OVERLAP_MIN;
	}

	if (template && crossOrSteam) {
		return common / total >= RENAME_OVERLAP_MIN;
	}

	return total - common <= Math.max(1, Math.floor(total * VK_QUESTION_SPREAD));
}

/** Уровень 3: сравнение по отпечаткам без опоры на название (переименование / шаблонное имя). */
function samePrintsContent(a, b) {
	if (a.printsVersion !== b.printsVersion || a.prints.size === 0 || b.prints.size === 0) {
		return false;
	}

	if (questionSpread(a, b) > RENAME_QUESTION_SPREAD) {
		return false;
	}

	const sameAuthor = (a.authorsKey !== '' && a.authorsKey === b.authorsKey)
		|| (a.steamCreatorId !== '' && a.steamCreatorId === b.steamCreatorId);

	if (!sameAuthor && sizeSpread(a, b) > RENAME_SIZE_SPREAD) {
		return false;
	}

	const total = Math.max(a.prints.size, b.prints.size);
	const common = printsCommon(a, b);

	return common / total >= RENAME_OVERLAP_MIN;
}

/** Сравнение строковых 64-битных steam_id по убыванию (новее — больше). */
function compareSteamIdDesc(a, b) {
	const left = BigInt(a.steamId || '0');
	const right = BigInt(b.steamId || '0');

	if (left === right) {
		return 0;
	}

	return right > left ? 1 : -1;
}

/** Множество ID паков, уже выложенных в D1 (для правила промоушена из раздела 5.3). */
function readPublishedIds() {
	const hasTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'd1_sync'`).get();

	if (!hasTable) {
		return new Set();
	}

	return new Set(
		db.prepare(`SELECT row_id FROM d1_sync WHERE tbl = 'packages'`).all().map(r => r.row_id),
	);
}

/** Проверяет, принадлежат ли все Steam-паки в группе одному автору. */
function sameSteamAuthor(group) {
	const creators = new Set(group.map(e => e.steamCreatorId).filter(Boolean));

	if (creators.size === 1 && group.every(e => e.steamCreatorId !== '')) {
		return true;
	}

	const authors = new Set(group.map(e => e.authorsKey).filter(Boolean));

	return authors.size === 1 && group.every(e => e.authorsKey !== '');
}

/**
 * Выбирает выжившего в группе дубликатов (разделы 5.1, 5.3, 10.3).
 * Возвращает `{ kept, promotedFrom }` — если сработал промоушен уже выложенного
 * Steam-пака, `promotedFrom` указывает на живой ВК-пак, чья ссылка копируется в `kept`.
 */
function pickSurvivor(group, publishedIds) {
	const nativeVk = group.filter(e => !e.isSteam && e.url !== '');
	const steam = group.filter(e => e.isSteam);

	if (nativeVk.length > 0) {
		const earliestVk = nativeVk
			.slice()
			.sort((a, b) => (a.ts ?? Infinity) - (b.ts ?? Infinity) || a.id - b.id)[0];

		// Вариант 1 раздела 5.3: если Steam-пак уже публиковался в D1 (или уже был
		// повышен раньше), а ВК-дубль ещё не публиковался — оставляем id Steam-пака
		// для сохранения pack_key (оценок, комментариев, URL) и копируем в него ВК-ссылку
		if (!publishedIds.has(earliestVk.id) && steam.length > 0) {
			const promotedCandidates = steam
				.filter(s => publishedIds.has(s.id) || s.url !== '')
				.sort((a, b) => (a.ts ?? Infinity) - (b.ts ?? Infinity) || a.id - b.id);

			if (promotedCandidates.length > 0) {
				return { kept: promotedCandidates[0], promotedFrom: earliestVk };
			}
		}

		// Стандартный случай: живой ВК-пак всегда приоритетнее Steam
		return { kept: earliestVk, promotedFrom: null };
	}

	// В группе только Steam-паки (или паки без ВК-ссылки)
	if (steam.length === group.length && sameSteamAuthor(steam)) {
		// Решение 10.3: среди дубликатов одного автора в Steam оставляем ПОСЛЕДНИЙ
		const latest = steam
			.slice()
			.sort((a, b) => (b.steamUpdatedAt - a.steamUpdatedAt)
				|| (b.steamCreatedAt - a.steamCreatedAt)
				|| compareSteamIdDesc(a, b)
				|| (b.id - a.id))[0];

		return { kept: latest, promotedFrom: null };
	}

	// Дубликаты разных авторов или без живых ссылок — остаётся самый ранний
	const earliest = group
		.slice()
		.sort((a, b) => (a.ts ?? Infinity) - (b.ts ?? Infinity) || (b.steamSubs - a.steamSubs) || (a.id - b.id))[0];

	return { kept: earliest, promotedFrom: null };
}

/** Система непересекающихся множеств (DSU) для объединения пар дубликатов. */
function createUnionFind(size) {
	const parent = Int32Array.from({ length: size }, (_, i) => i);

	const find = x => {
		while (parent[x] !== x) {
			parent[x] = parent[parent[x]];
			x = parent[x];
		}

		return x;
	};

	const union = (a, b) => {
		const ra = find(a);
		const rb = find(b);

		if (ra !== rb) {
			parent[rb] = ra;
		}
	};

	return { find, union };
}

/** Синхронизирует target_package_id и is_primary во всей таблице pack_steam. */
function syncPackSteamLinks() {
	const steamRows = db.prepare(`
		SELECT ps.package_id, ps.target_package_id, ps.is_primary, ps.state,
			ps.subscriptions, ps.updated_at, p.status, p.copy_of
		FROM pack_steam ps
		JOIN packages p ON p.id = ps.package_id
		ORDER BY ps.package_id
	`).all();

	if (steamRows.length === 0) {
		return { linked: 0, updated: 0 };
	}

	const desiredTarget = new Map();
	const byTargetOk = new Map();

	for (const row of steamRows) {
		const target = row.status === 'copy' && row.copy_of ? row.copy_of : row.package_id;
		desiredTarget.set(row.package_id, target);

		if (row.state === 'ok') {
			const list = byTargetOk.get(target) ?? [];
			list.push(row);
			byTargetOk.set(target, list);
		}
	}

	const primaryForTarget = new Map();

	for (const [target, list] of byTargetOk) {
		// Если сама целевая карточка — Steam-пак, главной остаётся её собственная запись;
		// иначе (ВК-пак со Steam-зеркалами) выбираем зеркало с максимумом подписок
		const own = list.find(r => r.package_id === target);

		if (own) {
			primaryForTarget.set(target, own.package_id);
		} else {
			const best = list
				.slice()
				.sort((a, b) => (b.subscriptions - a.subscriptions)
					|| ((b.updated_at ?? 0) - (a.updated_at ?? 0))
					|| (a.package_id - b.package_id))[0];
			primaryForTarget.set(target, best.package_id);
		}
	}

	const updateLink = db.prepare(`
		UPDATE pack_steam SET target_package_id = ?, is_primary = ? WHERE package_id = ?
	`);

	let updated = 0;
	let linked = 0;

	for (const row of steamRows) {
		const target = desiredTarget.get(row.package_id);
		const isPrimary = row.state === 'ok' && primaryForTarget.get(target) === row.package_id ? 1 : 0;

		if (target !== row.package_id && row.state === 'ok') {
			linked++;
		}

		if (row.target_package_id !== target || row.is_primary !== isPrimary) {
			updateLink.run(target, isPrimary, row.package_id);
			updated++;
		}
	}

	return { linked, updated };
}

export function markCopies() {
	// Сужение написано под UPDATE, поэтому и таблица названа полным именем:
	// у запроса на изменение алиаса «p» нет, и «p.id IN (…)» в нём — ошибка
	const target = targetSql('packages');
	const publishedIds = readPublishedIds();

	// Разбирается вся база разом, а не названные паки: копия — это отношение
	// пака к другим, и по одному паку его не выяснить. `--packs=` здесь сужает
	// только то, кому меняется отметка
	const rows = db.prepare(`
		SELECT p.id, p.source_key, p.url, p.name, p.authors_key, p.size, p.question_count,
			p.vk_ts, p.file_ts, p.status, p.copy_of,
			p.vk_topic, p.vk_comment, p.vk_author, p.vk_author_url, p.vk_date, p.comment_text,
			q.prints, COALESCE(q.version, 1) AS prints_version,
			ps.steam_id, ps.sha1 AS steam_sha1, ps.creator_id AS steam_creator_id,
			ps.subscriptions AS steam_subs, ps.created_at AS steam_created_at,
			ps.updated_at AS steam_updated_at, ps.state AS steam_state
		FROM packages p
		LEFT JOIN pack_prints q ON q.package_id = p.id
		LEFT JOIN pack_steam ps ON ps.package_id = p.id
		WHERE p.status = 'ok' OR p.status = 'copy'
		ORDER BY p.id
	`).all();

	const entries = [];
	const byId = new Map();
	const buckets = new Map();
	const bySha1 = new Map();

	for (const row of rows) {
		const isSteam = Boolean(row.source_key?.startsWith('steam:'));
		const entry = {
			idx: entries.length,
			id: row.id,
			sourceKey: row.source_key ?? '',
			isSteam,
			url: row.url ?? '',
			status: row.status,
			copyOf: row.copy_of ?? null,
			size: row.size ?? 0,
			questions: row.question_count ?? 0,
			nameKey: buildAuthorKey(row.name ?? ''),
			authorsKey: buildAuthorKey(row.authors_key ?? ''),
			ts: contentTs(row),
			printsVersion: row.prints_version,
			prints: new Set(decodePrints(row.prints, row.prints_version).byPrint.keys()),
			steamId: row.steam_id ?? '',
			steamSha1: row.steam_sha1 ?? '',
			steamCreatorId: row.steam_creator_id ?? '',
			steamSubs: row.steam_subs ?? 0,
			steamCreatedAt: row.steam_created_at ?? row.vk_ts ?? 0,
			steamUpdatedAt: row.steam_updated_at ?? row.file_ts ?? row.vk_ts ?? 0,
			vkTopic: row.vk_topic ?? null,
			vkComment: row.vk_comment ?? null,
			vkAuthor: row.vk_author ?? null,
			vkAuthorUrl: row.vk_author_url ?? null,
			vkDate: row.vk_date ?? null,
			commentText: row.comment_text ?? null,
		};

		entries.push(entry);
		byId.set(entry.id, entry);

		// Уровень 1а: побайтово одинаковые .siq из Steam по SHA-1 из манифеста
		if (entry.steamSha1) {
			const list = bySha1.get(entry.steamSha1);

			if (list) {
				list.push(entry);
			} else {
				bySha1.set(entry.steamSha1, [entry]);
			}
		}

		// Корзина уровня 1б / 2: (подпись автора + название)
		const bucketKey = `${entry.authorsKey}\n${entry.nameKey}`;
		const known = buckets.get(bucketKey);

		if (known) {
			known.push(entry);
		} else {
			buckets.set(bucketKey, [entry]);
		}
	}

	const dsu = createUnionFind(entries.length);

	// 1а. Склейка точных SHA-1 совпадений среди Steam-паков
	for (const list of bySha1.values()) {
		if (list.length < 2) {
			continue;
		}

		for (let i = 1; i < list.length; i++) {
			dsu.union(list[0].idx, list[i].idx);
		}
	}

	// 1б и 2. Склейка внутри корзин (одинаковые автор и название)
	for (const bucket of buckets.values()) {
		if (bucket.length < 2) {
			continue;
		}

		for (let i = 0; i < bucket.length; i++) {
			for (let j = i + 1; j < bucket.length; j++) {
				if (sameBucketContent(bucket[i], bucket[j])) {
					dsu.union(bucket[i].idx, bucket[j].idx);
				}
			}
		}
	}

	// 3. Инвертированный индекс отпечатков для Steam-паков (переименованные и шаблонные имена)
	const steamWithPrints = entries.filter(e => e.isSteam && e.prints.size > 0);

	if (steamWithPrints.length > 0) {
		const holders = new Map();

		for (const entry of entries) {
			if (entry.prints.size === 0) {
				continue;
			}

			for (const fp of entry.prints) {
				const list = holders.get(fp);

				if (list) {
					list.push(entry.idx);
				} else {
					holders.set(fp, [entry.idx]);
				}
			}
		}

		for (const entry of steamWithPrints) {
			const counts = new Map();
			let rareTotal = 0;

			for (const fp of entry.prints) {
				const list = holders.get(fp);

				if (!list || list.length >= INDEX_COMMON_PACKS) {
					continue;
				}

				rareTotal++;

				for (const otherIdx of list) {
					if (otherIdx === entry.idx) {
						continue;
					}

					counts.set(otherIdx, (counts.get(otherIdx) ?? 0) + 1);
				}
			}

			if (rareTotal === 0) {
				continue;
			}

			// Кандидат должен совпасть хотя бы по 70% редких вопросов, прежде чем делаем точную проверку >= 95%
			const minHits = Math.max(5, Math.floor(rareTotal * 0.7));

			for (const [otherIdx, hits] of counts) {
				if (hits < minHits) {
					continue;
				}

				const other = entries[otherIdx];

				if (dsu.find(entry.idx) === dsu.find(otherIdx)) {
					continue;
				}

				if (samePrintsContent(entry, other)) {
					dsu.union(entry.idx, otherIdx);
				}
			}
		}
	}

	// Собираем связные компоненты и выбираем выжившего в каждой группе
	const components = new Map();

	for (const entry of entries) {
		const root = dsu.find(entry.idx);
		const list = components.get(root);

		if (list) {
			list.push(entry);
		} else {
			components.set(root, [entry]);
		}
	}

	/** Кто чьей копией стал: id -> kept.id. */
	const copies = new Map();

	/** Повышенные Steam-паки: steamId -> источник ВК-полей (раздел 5.3, вариант 1). */
	const promoted = new Map();

	for (const group of components.values()) {
		if (group.length < 2) {
			continue;
		}

		const { kept, promotedFrom } = pickSurvivor(group, publishedIds);

		if (promotedFrom) {
			promoted.set(kept.id, promotedFrom);
		}

		for (const entry of group) {
			if (entry.id !== kept.id) {
				copies.set(entry.id, kept.id);
			}
		}
	}

	const setCopy = db.prepare(`UPDATE packages SET status = 'copy', copy_of = ? WHERE id = ?${target.where}`);
	const setBack = db.prepare(`UPDATE packages SET status = 'ok', copy_of = NULL WHERE id = ?${target.where}`);
	const applyPromotion = db.prepare(`
		UPDATE packages SET
			url = ?, vk_topic = ?, vk_comment = ?, vk_author = ?, vk_author_url = ?,
			vk_date = ?, comment_text = COALESCE(comment_text, ?)
		WHERE id = ?${target.where}
	`);
	const revertPromotion = db.prepare(`
		UPDATE packages SET
			url = '', vk_topic = NULL, vk_comment = NULL, vk_author = NULL, vk_author_url = NULL, vk_date = NULL
		WHERE id = ?${target.where}
	`);

	let marked = 0;
	let freed = 0;
	let promotedCount = 0;

	for (const entry of entries) {
		const keeper = copies.get(entry.id) ?? null;

		if (keeper !== null && (entry.status !== 'copy' || entry.copyOf !== keeper)) {
			marked += setCopy.run(keeper, entry.id, ...target.params).changes;
		}

		// Копия, у которой старший пак умер или которая перестала быть копией
		// после переразбора, возвращается в библиотеку сама
		if (keeper === null && entry.status === 'copy') {
			const owner = byId.get(entry.copyOf);

			if (owner && owner.printsVersion !== entry.printsVersion) {
				continue;
			}

			freed += setBack.run(entry.id, ...target.params).changes;
		}

		// Синхронизируем промоушен (если ВК-дубль обновил ссылку — обновляем и на повышенном Steam-паке;
		// если ВК-дубль умер — возвращаем повышенный Steam-пак обратно в Steam-only)
		const vkSource = promoted.get(entry.id);

		if (vkSource) {
			if (entry.url !== vkSource.url || entry.vkTopic !== vkSource.vkTopic || entry.vkComment !== vkSource.vkComment) {
				promotedCount += applyPromotion.run(
					vkSource.url,
					vkSource.vkTopic,
					vkSource.vkComment,
					vkSource.vkAuthor,
					vkSource.vkAuthorUrl,
					vkSource.vkDate,
					vkSource.commentText,
					entry.id,
					...target.params,
				).changes;
			}
		} else if (entry.isSteam && entry.url !== '' && keeper === null) {
			revertPromotion.run(entry.id, ...target.params);
		}
	}

	const steamSync = syncPackSteamLinks();

	say(
		'copies',
		`копий в базе ${copies.size}: спрятано ${marked}, возвращено ${freed}`
		+ `${promotedCount ? `, повышено Steam→ВК ${promotedCount}` : ''}`
		+ `${steamSync.linked || steamSync.updated ? `; Steam-зеркал ${steamSync.linked} (обновлено привязок ${steamSync.updated})` : ''}.`,
	);
}
