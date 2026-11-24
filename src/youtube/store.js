// Слой D1 для YouTube-сканера: youtube_videos, youtube_channels, проверка
// живости YouTube-строк в pack_streams и переиспользование savePackStreams /
// linkGames / notifyStreamOwners из src/twitch/store.js.

import { askRows } from '../../scripts/deploy/d1.js';
import { ensureSchema, linkGames, notifyStreamOwners, savePackStreams } from '../twitch/store.js';

const YT_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS youtube_videos (
		video_id TEXT PRIMARY KEY,
		channel_id TEXT NOT NULL,
		channel_title TEXT NOT NULL DEFAULT '',
		title TEXT NOT NULL DEFAULT '',
		published_at INTEGER NOT NULL,
		length_s INTEGER NOT NULL,
		source TEXT NOT NULL DEFAULT '',
		status TEXT NOT NULL,
		calls INTEGER NOT NULL DEFAULT 0,
		tokens_in INTEGER NOT NULL DEFAULT 0,
		signs INTEGER,
		plan_key TEXT,
		scanned_at INTEGER,
		tries INTEGER NOT NULL DEFAULT 0,
		error TEXT,
		views INTEGER,
		embeddable INTEGER NOT NULL DEFAULT 1,
		age_restricted INTEGER NOT NULL DEFAULT 0
	)`,
	'CREATE INDEX IF NOT EXISTS ix_youtube_videos_pub ON youtube_videos (published_at)',
	'CREATE INDEX IF NOT EXISTS ix_youtube_videos_ch ON youtube_videos (channel_id)',
	`CREATE TABLE IF NOT EXISTS youtube_channels (
		channel_id TEXT PRIMARY KEY,
		title TEXT NOT NULL DEFAULT '',
		handle TEXT,
		twitch_login TEXT,
		source TEXT NOT NULL DEFAULT '',
		sigame_videos INTEGER NOT NULL DEFAULT 0,
		last_checked_at INTEGER,
		added_at INTEGER NOT NULL
	)`,
];

const str = v => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const num = v => (v != null && v !== '' && Number.isFinite(Number(v)) ? String(Math.round(Number(v))) : 'NULL');

export async function ensureYoutubeSchema() {
	await ensureSchema();
	for (const sql of YT_SCHEMA) await askRows(sql);
}

/** Все уже просмотренные YouTube-видео: video_id → строка. */
export async function knownYoutubeVideos() {
	const rows = await askRows('SELECT video_id, channel_id, status, plan_key, tries FROM youtube_videos');
	return new Map(rows.map(r => [String(r.video_id), r]));
}

/** Все известные YouTube-каналы. */
export async function knownYoutubeChannels() {
	return await askRows('SELECT channel_id, title, handle, twitch_login, source, sigame_videos, last_checked_at FROM youtube_channels');
}

/** Подтверждённые Twitch-каналы (signs >= 5 или есть в pack_streams) для моста socialMedias. */
export async function confirmedTwitchLogins() {
	const rows = await askRows(`SELECT DISTINCT LOWER(channel) AS login FROM twitch_vods
		WHERE status = 'done' AND (
			signs >= 5
			OR vod_id IN (SELECT DISTINCT vod_id FROM pack_streams WHERE vod_id NOT LIKE 'yt:%')
		)`);
	return rows.map(r => String(r.login)).filter(Boolean);
}

/** Служебная метка времени в twitch_kv (для еженедельных задач: мост и живость). */
export async function getKvTime(key) {
	const [row] = await askRows(`SELECT value FROM twitch_kv WHERE key = ${str(key)}`);
	const n = Number(row?.value || 0);
	return Number.isFinite(n) ? n : 0;
}

export async function setKvTime(key, ts = Date.now()) {
	await askRows(`INSERT INTO twitch_kv (key, value, expires_at) VALUES (${str(key)}, ${str(ts)}, NULL)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
}

/** Сохранить/обновить просмотренные YouTube-видео. */
export async function saveYoutubeVideos(rows) {
	const now = Date.now();
	for (let i = 0; i < rows.length; i += 30) {
		const values = rows.slice(i, i + 30).map(r => `(${[
			str(r.id),
			str(r.channelId || ''),
			str((r.channelTitle || '').slice(0, 200)),
			str((r.title || '').slice(0, 300)),
			num(r.publishedAt || now),
			num(r.length || 0),
			str(r.source || ''),
			str(r.status),
			num(r.calls || 0),
			num(r.tokensIn || 0),
			num(r.signs),
			str(r.planKey ?? null),
			num(now),
			r.status === 'error' ? '1' : '0',
			str(r.error ? String(r.error).slice(0, 300) : null),
			num(r.views),
			r.embeddable === false ? '0' : '1',
			r.ageRestricted ? '1' : '0',
		].join(', ')})`);

		await askRows(`INSERT INTO youtube_videos (
				video_id, channel_id, channel_title, title, published_at, length_s, source, status,
				calls, tokens_in, signs, plan_key, scanned_at, tries, error, views, embeddable, age_restricted
			) VALUES ${values.join(',\n')}
			ON CONFLICT (video_id) DO UPDATE SET
				channel_id = CASE WHEN excluded.channel_id <> '' THEN excluded.channel_id ELSE youtube_videos.channel_id END,
				channel_title = CASE WHEN excluded.channel_title <> '' THEN excluded.channel_title ELSE youtube_videos.channel_title END,
				title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE youtube_videos.title END,
				length_s = CASE WHEN excluded.length_s > 0 THEN excluded.length_s ELSE youtube_videos.length_s END,
				status = excluded.status,
				calls = excluded.calls,
				tokens_in = excluded.tokens_in,
				signs = COALESCE(excluded.signs, youtube_videos.signs),
				plan_key = excluded.plan_key,
				scanned_at = excluded.scanned_at,
				error = excluded.error,
				views = COALESCE(excluded.views, youtube_videos.views),
				embeddable = excluded.embeddable,
				age_restricted = excluded.age_restricted,
				tries = CASE WHEN excluded.status = 'error' THEN youtube_videos.tries + 1 ELSE youtube_videos.tries END`);
	}
}

/** Добавить или обновить YouTube-каналы в youtube_channels. */
export async function upsertYoutubeChannels(channels) {
	if (!channels.length) return;
	const now = Date.now();
	for (let i = 0; i < channels.length; i += 40) {
		const values = channels.slice(i, i + 40).map(c => `(${[
			str(c.channelId),
			str((c.title || '').slice(0, 200)),
			str(c.handle || null),
			str(c.twitchLogin || null),
			str(c.source || 'search'),
			num(c.sigameDelta || 0),
			num(c.lastCheckedAt ?? null),
			num(now),
		].join(', ')})`);

		await askRows(`INSERT INTO youtube_channels (
				channel_id, title, handle, twitch_login, source, sigame_videos, last_checked_at, added_at
			) VALUES ${values.join(',\n')}
			ON CONFLICT (channel_id) DO UPDATE SET
				title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE youtube_channels.title END,
				handle = COALESCE(excluded.handle, youtube_channels.handle),
				twitch_login = COALESCE(excluded.twitch_login, youtube_channels.twitch_login),
				sigame_videos = youtube_channels.sigame_videos + excluded.sigame_videos,
				last_checked_at = COALESCE(excluded.last_checked_at, youtube_channels.last_checked_at)`);
	}
}

/** Отметить время обхода проверенных каналов. */
export async function markChannelsChecked(channelIds) {
	if (!channelIds.length) return;
	const now = Date.now();
	for (let i = 0; i < channelIds.length; i += 50) {
		const ids = channelIds.slice(i, i + 50).map(str).join(', ');
		await askRows(`UPDATE youtube_channels SET last_checked_at = ${now} WHERE channel_id IN (${ids})`);
	}
}

/** Сохранить найденные паки YouTube-видео в pack_streams, склеить столы и оповестить авторов. */
export async function saveYoutubePackStreams(video, packs) {
	const adapter = {
		id: `yt:${video.id}`,
		channel: video.channelId,
		channelName: video.channelTitle || video.channelId,
		createdAt: video.publishedAt || Date.now(),
	};
	const fresh = await savePackStreams(adapter, packs);
	const linked = await linkGames(adapter, packs);
	const notified = await notifyStreamOwners(adapter, fresh);
	return { fresh, linked, notified };
}

/** Живые YouTube-записи, которые сейчас стоят в pack_streams. */
export async function aliveYoutubeVideos() {
	const rows = await askRows("SELECT DISTINCT substr(vod_id, 4) AS id FROM pack_streams WHERE alive = 1 AND vod_id LIKE 'yt:%'");
	return rows.map(r => String(r.id)).filter(Boolean);
}

/**
 * Обновить живость, просмотры и embeddable/age_restricted для YouTube-записей в pack_streams.
 *
 * @param {string[]} deadIds ID без префикса yt:
 * @param {Array<{ id, views, embeddable, ageRestricted, title, channelTitle }>} liveVideos
 */
export async function markAliveYoutube(deadIds, liveVideos = []) {
	const now = Date.now();
	for (let i = 0; i < deadIds.length; i += 50) {
		const raw = deadIds.slice(i, i + 50);
		const vodIds = raw.map(id => str(`yt:${id}`)).join(', ');
		const ytIds = raw.map(str).join(', ');
		await askRows(`DELETE FROM pack_streams WHERE vod_id IN (${vodIds});
			UPDATE youtube_videos SET status = 'gone' WHERE video_id IN (${ytIds})`);
	}

	for (let i = 0; i < liveVideos.length; i += 30) {
		const part = liveVideos.slice(i, i + 30);
		const statements = part.map(v => `UPDATE youtube_videos SET
			views = COALESCE(${num(v.views)}, views),
			embeddable = ${v.embeddable === false ? 0 : 1},
			age_restricted = ${v.ageRestricted ? 1 : 0}
			WHERE video_id = ${str(v.id)}`);
		await askRows(statements.join('; '));
	}

	await askRows(`UPDATE pack_streams SET checked_at = ${now} WHERE alive = 1 AND vod_id LIKE 'yt:%'`);
}
