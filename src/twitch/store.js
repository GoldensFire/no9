// Что обход стримов помнит наверху, в D1: какие записи уже просмотрены
// (twitch_vods) и какие паки на них играли (pack_streams).
//
// Пишет через тот же клиент D1, что и выкладка (scripts/deploy/d1.js):
// REST с ключом CLOUDFLARE_API_TOKEN, а без ключа — wrangler. Таблицу
// заводит сам перед первой записью: выкладка схему не применяет. twitch_vods
// Worker не читает вовсе, pack_streams читает страница пака
// (cf/src/library/streams.js). Описание таблиц — в cf/schema.sql.
//
// И ещё одно: когда на записи впервые находится пак, чьё авторство признано
// за кем-то на сайте, — звонок колокольчика ему ('stream' в notifications,
// см. cf/src/library/notifications.js), если он его не выключил.

import { askRows } from '../../scripts/deploy/d1.js';
import { PACK_KEY_SQL } from '../keys.js';
import { commonWords, sameTable } from './marks.js';

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS twitch_vods (
		vod_id TEXT PRIMARY KEY,
		channel TEXT NOT NULL,
		title TEXT NOT NULL DEFAULT '',
		created_at INTEGER NOT NULL,
		length_s INTEGER NOT NULL,
		source TEXT NOT NULL DEFAULT '',
		status TEXT NOT NULL,
		frames INTEGER NOT NULL DEFAULT 0,
		plan_key TEXT,
		scanned_at INTEGER,
		tries INTEGER NOT NULL DEFAULT 0,
		error TEXT
	)`,
	'CREATE INDEX IF NOT EXISTS ix_twitch_vods_created ON twitch_vods (created_at)',
	`CREATE TABLE IF NOT EXISTS pack_streams (
		vod_id TEXT NOT NULL,
		pack_key TEXT NOT NULL,
		channel TEXT NOT NULL,
		channel_name TEXT,
		played_at INTEGER NOT NULL,
		t_from INTEGER NOT NULL,
		t_to INTEGER NOT NULL,
		themes INTEGER NOT NULL,
		alive INTEGER NOT NULL DEFAULT 1,
		checked_at INTEGER NOT NULL,
		marks TEXT,
		game TEXT,
		PRIMARY KEY (vod_id, pack_key)
	)`,
	'CREATE INDEX IF NOT EXISTS ix_pack_streams_pack ON pack_streams (pack_key, alive, played_at)',
];

/** Сколько раз пробовать запись, которая не далась. */
export const MAX_TRIES = 3;

const str = v => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const num = v => (Number.isFinite(Number(v)) ? String(Math.round(Number(v))) : 'NULL');

export async function ensureSchema() {
	for (const sql of SCHEMA) await askRows(sql);
	// marks и game появились 13.11.2026, когда таблица уже жила: «IF NOT EXISTS»
	// её не донесёт. Выкладка дописывает её тоже (scripts/deploy/columns.js) —
	// кто придёт первым
	const [row] = await askRows("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pack_streams'");
	for (const column of ['marks', 'game']) {
		if (row?.sql && !new RegExp(`\\b${column}\\b`).test(row.sql)) await askRows(`ALTER TABLE pack_streams ADD COLUMN ${column} TEXT`);
	}
}

/** Записи, о которых уже есть строка, новее since (мс): номер → строка. */
export async function knownVods(since) {
	const rows = await askRows(`SELECT vod_id, channel, status, plan_key, tries FROM twitch_vods WHERE created_at >= ${num(since)}`);
	return new Map(rows.map(r => [String(r.vod_id), r]));
}

/** Каналы, где SIGame уже находилась: их записи смотрим, даже если SullyGnome промолчал. */
export async function knownChannels(since) {
	const rows = await askRows(`SELECT DISTINCT channel FROM twitch_vods WHERE status = 'done' AND created_at >= ${num(since)}`);
	return rows.map(r => String(r.channel));
}

/**
 * @param {Array<{id, channel, title, createdAt, length, source, status, frames, planKey, error}>} rows
 */
export async function saveVods(rows) {
	const now = Date.now();
	for (let i = 0; i < rows.length; i += 40) {
		const values = rows.slice(i, i + 40).map(r => `(${[
			str(r.id), str(r.channel), str((r.title || '').slice(0, 300)), num(r.createdAt), num(r.length), str(r.source || ''),
			str(r.status), num(r.frames || 0), str(r.planKey ?? null), num(now), r.status === 'error' ? '1' : '0',
			str(r.error ? String(r.error).slice(0, 300) : null),
		].join(', ')})`);
		await askRows(`INSERT INTO twitch_vods (vod_id, channel, title, created_at, length_s, source, status, frames, plan_key, scanned_at, tries, error)
			VALUES ${values.join(',\n')}
			ON CONFLICT (vod_id) DO UPDATE SET
				status = excluded.status, frames = excluded.frames, plan_key = excluded.plan_key,
				scanned_at = excluded.scanned_at, error = excluded.error, title = excluded.title, length_s = excluded.length_s,
				tries = CASE WHEN excluded.status = 'error' THEN twitch_vods.tries + 1 ELSE twitch_vods.tries END`);
	}
}

/**
 * Паки одной записи — вместо того, что о ней было: запись пересмотрели
 * (новая версия сверки) — и старый вердикт уходит целиком.
 *
 * @param {{id, channel, channelName, createdAt}} video
 * @param {Array<{key, themes, from, to, marks?}>} packs вердикт (src/twitch/verdict.js)
 *   и marks — что держалось на экране (src/twitch/marks.js)
 * @returns {Promise<string[]>} ключи паков, которых на этой записи раньше не было
 */
export async function savePackStreams(video, packs) {
	const now = Date.now();
	const before = new Set((await askRows(`SELECT pack_key FROM pack_streams WHERE vod_id = ${str(video.id)}`))
		.map(r => String(r.pack_key)));
	const rows = packs.map(p => `(${[
		str(video.id), str(p.key), str(video.channel), str(video.channelName || video.channel),
		num(video.createdAt + p.from * 1000), num(p.from), num(p.to), num(p.themes), '1', num(now),
		str(p.marks || null),
	].join(', ')})`);
	let sql = `DELETE FROM pack_streams WHERE vod_id = ${str(video.id)};`;
	if (rows.length) {
		sql += ` INSERT INTO pack_streams (vod_id, pack_key, channel, channel_name, played_at, t_from, t_to, themes, alive, checked_at, marks)
			VALUES ${rows.join(', ')}`;
	}
	await askRows(sql);
	return packs.map(p => String(p.key)).filter(key => !before.has(key));
}

/** Слова, что держатся у многих каналов: считаются раз за запуск обхода. */
let common = null;

/**
 * Одна игра или разные: эта запись и другие записи тех же паков
 * (src/twitch/marks.js). Строкам одного стола — одна метка game,
 * наименьшая из их собственных «запись:пак», чтобы выходила одна и та же,
 * в каком бы порядке записи ни смотрели. Сбой здесь обход не роняет:
 * без метки строка — просто своя игра.
 *
 * @param {{id, channel, createdAt}} video
 * @param {Array<{key, from, to, marks}>} packs
 * @returns {Promise<number>} сколько паков записи оказались чужим столом
 */
export async function linkGames(video, packs) {
	let linked = 0;
	try {
		common ??= commonWords(await askRows(`SELECT channel, marks FROM pack_streams
			WHERE marks IS NOT NULL AND played_at >= ${num(Date.now() - 61 * 864e5)}`));
		for (const p of packs) {
			const me = { channel: video.channel, played_at: video.createdAt + p.from * 1000, t_from: p.from, t_to: p.to, marks: p.marks };
			const near = await askRows(`SELECT vod_id, channel, played_at, t_from, t_to, marks, game FROM pack_streams
				WHERE pack_key = ${str(p.key)} AND vod_id <> ${str(video.id)}
					AND played_at BETWEEN ${num(me.played_at - 12 * 3600e3)} AND ${num(me.played_at + 12 * 3600e3)}`);
			const mates = near.filter(r => sameTable(me, r, common));
			const ids = [`${video.id}:${p.key}`, ...mates.map(r => r.game || `${r.vod_id}:${p.key}`)];
			const game = ids.sort()[0];
			let sql = `UPDATE pack_streams SET game = ${mates.length ? str(game) : 'NULL'}
				WHERE vod_id = ${str(video.id)} AND pack_key = ${str(p.key)}`;
			if (mates.length) {
				linked++;
				const vods = mates.map(r => str(r.vod_id)).join(', ');
				const games = [...new Set(mates.map(r => r.game).filter(Boolean))].map(str);
				sql += `; UPDATE pack_streams SET game = ${str(game)} WHERE pack_key = ${str(p.key)}
					AND (vod_id IN (${vods})${games.length ? ` OR game IN (${games.join(', ')})` : ''})`;
				console.log(`  ${p.key}: один стол с ${mates.map(r => r.channel).join(', ')}`);
			}
			await askRows(sql);
		}
	} catch (e) {
		console.log(`столы не сверились: ${e.message}`);
	}
	return linked;
}

/** Свежей записью звенеть незачем, если ей больше недели: пак играли давно. */
const NOTIFY_MAX_AGE = 7 * 864e5;

/**
 * Звонок авторам: их пак сыграли на стриме. Кому — тем же правилом, что
 * и разговор под паком (ownersOfPack в cf/src/library/authorship.js): страница
 * ВК, с которой пак выложен, или галочка на подписи. Кто выключил звонок
 * в настройках профиля (user_settings.notify_streams = 0), тому не кладётся.
 *
 * Сбой здесь обход не роняет: записанное о стримах важнее звонка.
 *
 * @param {{createdAt}} video
 * @param {string[]} keys паки, впервые найденные на этой записи
 */
export async function notifyStreamOwners(video, keys) {
	if (!keys.length || Date.now() - video.createdAt > NOTIFY_MAX_AGE) return 0;
	const now = Date.now();
	let sent = 0;
	for (const key of keys) {
		const owners = `
			SELECT v.user_id AS id
			FROM packages p INDEXED BY ix_packages_pack_key
			JOIN pack_authors a ON a.package_id = p.id
			JOIN user_vk v ON v.vk_id = a.canon_account
			WHERE ${PACK_KEY_SQL} = ${str(key)}
			UNION
			SELECT b.user_id AS id
			FROM packages p INDEXED BY ix_packages_pack_key
			JOIN pack_authors a ON a.package_id = p.id
			JOIN author_badges b ON b.author_key = a.author_key OR b.author_key = a.canon_key
			WHERE ${PACK_KEY_SQL} = ${str(key)}`;
		try {
			const rows = await askRows(`INSERT INTO notifications (user_id, kind, pack_key, comment_id, actor_id, created_at)
				SELECT o.id, 'stream', ${str(key)}, NULL, NULL, ${num(now)}
				FROM (${owners}) o
				LEFT JOIN user_settings s ON s.user_id = o.id
				WHERE COALESCE(s.notify_streams, 1) = 1
				RETURNING id`);
			sent += rows.length;
		} catch (e) {
			console.log(`звонок о паке ${key} не лёг: ${e.message}`);
		}
	}
	return sent;
}

/** Записи, которые полоса показывает живыми. */
export async function aliveVods() {
	const rows = await askRows('SELECT DISTINCT vod_id FROM pack_streams WHERE alive = 1');
	return rows.map(r => String(r.vod_id));
}

/**
 * Записи умерли: из полосы — вон, строка остаётся историей и статистикой
 * (решение 3 в twitch-streams.md). Живым — отметка, что проверены сегодня.
 */
export async function markAlive(dead) {
	const now = Date.now();
	for (let i = 0; i < dead.length; i += 50) {
		const ids = dead.slice(i, i + 50).map(str).join(', ');
		await askRows(`UPDATE pack_streams SET alive = 0, checked_at = ${now} WHERE vod_id IN (${ids});
			UPDATE twitch_vods SET status = 'gone' WHERE vod_id IN (${ids})`);
	}
	await askRows(`UPDATE pack_streams SET checked_at = ${now} WHERE alive = 1`);
}
