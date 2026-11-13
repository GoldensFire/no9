// Что обход стримов помнит наверху, в D1: какие записи уже просмотрены
// (twitch_vods) и какие паки на них играли (pack_streams).
//
// Пишет через тот же клиент D1, что и выкладка (scripts/deploy/d1.js):
// REST с ключом CLOUDFLARE_API_TOKEN, а без ключа — wrangler. Таблицу
// заводит сам перед первой записью: выкладка схему не применяет. twitch_vods
// Worker не читает вовсе, pack_streams читает страница пака
// (cf/src/library/streams.js). Описание таблиц — в cf/schema.sql.

import { askRows } from '../../scripts/deploy/d1.js';

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
 * @param {Array<{key, themes, from, to}>} packs вердикт (src/twitch/verdict.js)
 */
export async function savePackStreams(video, packs) {
	const now = Date.now();
	const rows = packs.map(p => `(${[
		str(video.id), str(p.key), str(video.channel), str(video.channelName || video.channel),
		num(video.createdAt + p.from * 1000), num(p.from), num(p.to), num(p.themes), '1', num(now),
	].join(', ')})`);
	let sql = `DELETE FROM pack_streams WHERE vod_id = ${str(video.id)};`;
	if (rows.length) {
		sql += ` INSERT INTO pack_streams (vod_id, pack_key, channel, channel_name, played_at, t_from, t_to, themes, alive, checked_at)
			VALUES ${rows.join(', ')}`;
	}
	await askRows(sql);
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
