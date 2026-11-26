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
import { commonWords, isYoutubeVod, sameTable, YT_WINDOW_MS } from './marks.js';

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
		error TEXT,
		views INTEGER,
		signs INTEGER
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
	`CREATE TABLE IF NOT EXISTS twitch_seen_channels (
		channel TEXT PRIMARY KEY,
		seen_at INTEGER NOT NULL
	)`,
	'CREATE INDEX IF NOT EXISTS ix_twitch_seen_at ON twitch_seen_channels (seen_at)',
	`CREATE TABLE IF NOT EXISTS twitch_seen_windows (
		channel TEXT NOT NULL,
		stream_id TEXT NOT NULL,
		first_seen INTEGER NOT NULL,
		last_seen INTEGER NOT NULL,
		PRIMARY KEY (channel, stream_id)
	)`,
	'CREATE INDEX IF NOT EXISTS ix_twitch_seen_windows_last ON twitch_seen_windows (last_seen)',
	`CREATE TABLE IF NOT EXISTS twitch_kv (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		expires_at INTEGER
	)`,
];

/** Сколько раз пробовать запись, которая не далась. */
export const MAX_TRIES = 3;

const str = v => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const num = v => (v != null && v !== '' && Number.isFinite(Number(v)) ? String(Math.round(Number(v))) : 'NULL');

export async function ensureSchema() {
	for (const sql of SCHEMA) await askRows(sql);
	// marks, game и views появились, когда таблицы уже жили: «IF NOT EXISTS»
	// их не донесёт. Выкладка дописывает их тоже (scripts/deploy/columns.js) —
	// кто придёт первым
	const [psRow] = await askRows("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pack_streams'");
	for (const column of ['marks', 'game']) {
		if (psRow?.sql && !new RegExp(`\\b${column}\\b`).test(psRow.sql)) await askRows(`ALTER TABLE pack_streams ADD COLUMN ${column} TEXT`);
	}
	const [vodRow] = await askRows("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'twitch_vods'");
	for (const column of ['views', 'signs']) {
		if (vodRow?.sql && !new RegExp(`\\b${column}\\b`).test(vodRow.sql)) await askRows(`ALTER TABLE twitch_vods ADD COLUMN ${column} INTEGER`);
	}
}

/** Все уже известные записи (включая старые вечные HIGHLIGHT): номер → строка. */
export async function knownVods() {
	const rows = await askRows('SELECT vod_id, channel, status, plan_key, tries FROM twitch_vods');
	return new Map(rows.map(r => [String(r.vod_id), r]));
}

/** Каналы, где SIGame действительно находилась (без ложных probe с нулём признаков игры). */
export async function knownChannels(since) {
	const rows = await askRows(`SELECT DISTINCT channel FROM twitch_vods
		WHERE status = 'done' AND created_at >= ${num(since)}
			AND (
				signs >= 5
				OR vod_id IN (SELECT DISTINCT vod_id FROM pack_streams)
				OR (signs IS NULL AND COALESCE(plan_key, '') NOT LIKE '%/probe/%')
			)`);
	return rows.map(r => String(r.channel));
}

/** Заголовки подтверждённых SIGame-записей с @упоминаниями со-стримеров. */
export async function knownTitles(since) {
	const rows = await askRows(`SELECT title FROM twitch_vods
		WHERE status = 'done' AND created_at >= ${num(since)} AND title LIKE '%@%'
			AND (
				signs >= 5
				OR vod_id IN (SELECT DISTINCT vod_id FROM pack_streams)
				OR (signs IS NULL AND COALESCE(plan_key, '') NOT LIKE '%/probe/%')
			)`);
	return rows.map(r => String(r.title));
}

/** Каналы, замеченные поллером Worker'а (cf/src/twitch-live.js), и время последнего снимка. */
export async function seenChannels(since) {
	const rows = await askRows(`SELECT channel, seen_at FROM twitch_seen_channels WHERE seen_at >= ${num(since)}`);
	let latestAt = 0;
	const channels = [];
	for (const r of rows) {
		channels.push(String(r.channel));
		const t = Number(r.seen_at || 0);
		if (t > latestAt) latestAt = t;
	}
	return { channels, latestAt };
}

/** Окна [firstSeen, lastSeen] живых стримов Just Chatting с заголовком/тегом SIGame. */
export async function seenWindows(since) {
	const rows = await askRows(`SELECT channel, first_seen, last_seen FROM twitch_seen_windows WHERE last_seen >= ${num(since)}`);
	const byChannel = new Map();
	for (const r of rows) {
		const ch = String(r.channel).toLowerCase();
		const list = byChannel.get(ch) || [];
		list.push({ firstSeen: Number(r.first_seen), lastSeen: Number(r.last_seen) });
		byChannel.set(ch, list);
	}
	return byChannel;
}

/**
 * @param {Array<{id, channel, title, createdAt, length, source, status, frames, planKey, error, views?, signs?}>} rows
 */
export async function saveVods(rows) {
	const now = Date.now();
	for (let i = 0; i < rows.length; i += 40) {
		const values = rows.slice(i, i + 40).map(r => `(${[
			str(r.id), str(r.channel), str((r.title || '').slice(0, 300)), num(r.createdAt), num(r.length), str(r.source || ''),
			str(r.status), num(r.frames || 0), str(r.planKey ?? null), num(now), r.status === 'error' ? '1' : '0',
			str(r.error ? String(r.error).slice(0, 300) : null), num(r.views), num(r.signs),
		].join(', ')})`);
		await askRows(`INSERT INTO twitch_vods (vod_id, channel, title, created_at, length_s, source, status, frames, plan_key, scanned_at, tries, error, views, signs)
			VALUES ${values.join(',\n')}
			ON CONFLICT (vod_id) DO UPDATE SET
				status = excluded.status, frames = excluded.frames, plan_key = excluded.plan_key,
				scanned_at = excluded.scanned_at, error = excluded.error, title = excluded.title, length_s = excluded.length_s,
				views = COALESCE(excluded.views, twitch_vods.views),
				signs = COALESCE(excluded.signs, twitch_vods.signs),
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
			const me = { vod_id: video.id, channel: video.channel, played_at: video.createdAt + p.from * 1000, t_from: p.from, t_to: p.to, marks: p.marks };
			const yt = isYoutubeVod(video.id);
			const timeFilter = yt
				? `played_at BETWEEN ${num(me.played_at - YT_WINDOW_MS)} AND ${num(me.played_at + YT_WINDOW_MS)}`
				: `(played_at BETWEEN ${num(me.played_at - 12 * 3600e3)} AND ${num(me.played_at + 12 * 3600e3)}`
					+ ` OR (vod_id LIKE 'yt:%' AND played_at BETWEEN ${num(me.played_at - YT_WINDOW_MS)} AND ${num(me.played_at + YT_WINDOW_MS)}))`;
			const near = await askRows(`SELECT vod_id, channel, played_at, t_from, t_to, marks, game FROM pack_streams
				WHERE pack_key = ${str(p.key)} AND vod_id <> ${str(video.id)}
					AND ${timeFilter}`);
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
			SELECT s.user_id AS id
			FROM packages p INDEXED BY ix_packages_pack_key
			JOIN pack_authors a ON a.package_id = p.id
			JOIN user_steam s ON s.steam_id = a.canon_steam
			WHERE ${PACK_KEY_SQL} = ${str(key)}
			UNION
			SELECT u.id AS id
			FROM packages p INDEXED BY ix_packages_pack_key
			JOIN pack_authors a ON a.package_id = p.id
			JOIN users u INDEXED BY ix_users_steam ON u.steam_id = a.canon_steam
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

/** Записи Twitch, которые полоса показывает живыми (YouTube проверяется отдельно). */
export async function aliveVods() {
	const rows = await askRows("SELECT DISTINCT vod_id FROM pack_streams WHERE alive = 1 AND vod_id NOT LIKE 'yt:%'");
	return rows.map(r => String(r.vod_id));
}

/**
 * Записи умерли: удаляем их из pack_streams (хранить стримы с удалённой записью
 * незачем), а в twitch_vods отмечаем 'gone', чтобы не пытаться сканировать снова.
 * Живым — отметка, что проверены сегодня, и свежие просмотры с Twitch.
 *
 * @param {string[]} dead
 * @param {Array<[string, number]>} views
 */
export async function markAlive(dead, views = []) {
	const now = Date.now();
	for (let i = 0; i < dead.length; i += 50) {
		const ids = dead.slice(i, i + 50).map(str).join(', ');
		await askRows(`DELETE FROM pack_streams WHERE vod_id IN (${ids});
			UPDATE twitch_vods SET status = 'gone' WHERE vod_id IN (${ids})`);
	}
	await askRows("DELETE FROM pack_streams WHERE alive = 0 AND vod_id NOT LIKE 'yt:%'");
	for (let i = 0; i < views.length; i += 40) {
		const part = views.slice(i, i + 40);
		const cases = part.map(([id, count]) => `WHEN ${str(id)} THEN ${num(count)}`).join(' ');
		const ids = part.map(([id]) => str(id)).join(', ');
		await askRows(`UPDATE twitch_vods SET views = CASE vod_id ${cases} ELSE views END WHERE vod_id IN (${ids})`);
	}
	await askRows(`UPDATE pack_streams SET checked_at = ${now} WHERE alive = 1 AND vod_id NOT LIKE 'yt:%'`);
}
