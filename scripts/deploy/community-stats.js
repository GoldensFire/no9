// Снимок статистики стримов (Twitch + YouTube) и активности сообщества FirePacks
// из боевой базы D1 — домой, до сборки статики.
//
// Эти таблицы живут только в D1 (pack_streams, twitch_vods, youtube_videos,
// played, planned, ratings, comments, users): домашняя sibase.db про них
// не знает. Чтобы страница /stats показывала живую сводку по стримам и отметкам
// при 0 чтениях D1 в рантайме, выкладка один раз забирает компактные агрегаты
// сюда, в .wrangler/community-stats.json, а сборка (scripts/build-web.js)
// подмешивает их в cf/public/stats.json (см. enrichCommunity в src/library-stats-deep.js).
//
// Устроено ровно как scripts/deploy/hidden.js: не вышло прочитать — остаётся
// прошлая копия, срывать из-за этого всю выкладку несоразмерно.

import fs from 'node:fs';
import path from 'node:path';
import { root } from './options.js';
import { askRows } from './d1.js';

/** Где лежит снимок. Тот же путь читают scripts/build-web.js и src/server.js. */
export const COMMUNITY_STATS_FILE = path.join(root, '.wrangler', 'community-stats.json');

/** Прочитать последний сохранённый снимок сообщества (или null, если его нет). */
export function readCommunityStats() {
	try {
		return JSON.parse(fs.readFileSync(COMMUNITY_STATS_FILE, 'utf8'));
	} catch {
		return null;
	}
}

/** Выполнить один запрос к D1, мягко возвращая пустой массив, если таблицы ещё нет. */
async function safeAsk(sql) {
	try {
		return await askRows(sql);
	} catch (error) {
		if (/no such (table|column)/i.test(String(error?.message))) {
			return [];
		}

		throw error;
	}
}

/**
 * Привезти компактный снимок стримов и активности посетителей из D1.
 * Все выборки — короткие агрегаты (одна строка или Top-12), не трогают полные таблицы паков.
 */
export async function pullCommunityStats() {
	let streamsRow;
	let topStreamedRows;
	let vodsCountRow;
	let ytCountRow;
	let usersRow;
	let playedRow;
	let plannedRow;
	let ratingsRow;
	let commentsRow;
	let topPlayedRows;
	let topPlannedRows;
	let streamTopicsRows;

	try {
		[
			[streamsRow],
			topStreamedRows,
			[vodsCountRow],
			[ytCountRow],
			[usersRow],
			[playedRow],
			[plannedRow],
			[ratingsRow],
			[commentsRow],
			topPlayedRows,
			topPlannedRows,
			streamTopicsRows,
		] = await Promise.all([
			safeAsk(`
				SELECT
					COUNT(*) AS stream_links,
					COUNT(DISTINCT pack_key) AS streamed_packs,
					COUNT(DISTINCT channel) AS stream_channels,
					COUNT(DISTINCT CASE WHEN vod_id LIKE 'yt:%' THEN vod_id END) AS yt_stream_videos,
					COUNT(DISTINCT CASE WHEN vod_id NOT LIKE 'yt:%' THEN vod_id END) AS twitch_stream_vods
				FROM pack_streams
			`),
			safeAsk(`
				SELECT
					pack_key,
					COUNT(DISTINCT COALESCE(NULLIF(game, ''), 'solo:' || vod_id)) AS games,
					COUNT(DISTINCT channel) AS channels,
					COUNT(*) AS links
				FROM pack_streams
				GROUP BY pack_key
				ORDER BY games DESC, channels DESC, links DESC
				LIMIT 15
			`),
			safeAsk(`SELECT COUNT(*) AS total FROM twitch_vods WHERE status = 'done'`),
			safeAsk(`SELECT COUNT(*) AS total FROM youtube_videos WHERE status = 'done'`),
			safeAsk(`SELECT COUNT(*) AS total FROM users`),
			safeAsk(`SELECT COUNT(*) AS marks, COUNT(DISTINCT pack_key) AS packs FROM played`),
			safeAsk(`SELECT COUNT(*) AS marks, COUNT(DISTINCT pack_key) AS packs FROM planned`),
			safeAsk(`SELECT COUNT(*) AS total, AVG(score) AS avg_score FROM ratings`),
			safeAsk(`SELECT COUNT(*) AS total FROM comments WHERE deleted_at IS NULL`),
			safeAsk(`
				SELECT pack_key, COUNT(*) AS cnt
				FROM played
				GROUP BY pack_key
				ORDER BY cnt DESC
				LIMIT 15
			`),
			safeAsk(`
				SELECT pack_key, COUNT(*) AS cnt
				FROM planned
				GROUP BY pack_key
				ORDER BY cnt DESC
				LIMIT 15
			`),
			safeAsk(`
				SELECT p.primary_topic AS topic, COUNT(*) AS cnt
				FROM pack_streams s
				JOIN packages p ON p.id = CAST(s.pack_key AS INTEGER)
				WHERE p.status = 'ok' AND p.primary_topic IS NOT NULL AND p.primary_topic <> 'unknown'
				GROUP BY p.primary_topic
				ORDER BY cnt DESC
			`),
		]);
	} catch (error) {
		console.log(`Снимок сообщества наверху прочитать не вышло (${error.message}). Беру прежний файл.`);
		return;
	}

	const avgRaw = Number(ratingsRow?.avg_score);
	const snapshot = {
		pulledAt: Date.now(),
		twitchVods: Number(vodsCountRow?.total ?? 0),
		ytVideos: Number(ytCountRow?.total ?? 0),
		twitchStreamVods: Number(streamsRow?.twitch_stream_vods ?? 0),
		ytStreamVideos: Number(streamsRow?.yt_stream_videos ?? 0),
		streamLinks: Number(streamsRow?.stream_links ?? 0),
		streamedPacks: Number(streamsRow?.streamed_packs ?? 0),
		streamChannels: Number(streamsRow?.stream_channels ?? 0),
		streamTopics: streamTopicsRows.map(row => ({
			key: String(row.topic),
			count: Number(row.cnt ?? 0),
		})),
		users: Number(usersRow?.total ?? 0),
		playedMarks: Number(playedRow?.marks ?? 0),
		playedPacks: Number(playedRow?.packs ?? 0),
		plannedMarks: Number(plannedRow?.marks ?? 0),
		plannedPacks: Number(plannedRow?.packs ?? 0),
		ratings: Number(ratingsRow?.total ?? 0),
		avgRating: Number.isFinite(avgRaw) && Number(ratingsRow?.total ?? 0) > 0
			? Math.round(avgRaw * 100) / 100
			: null,
		comments: Number(commentsRow?.total ?? 0),
		topStreamed: topStreamedRows.map(row => ({
			packKey: String(row.pack_key),
			games: Number(row.games ?? 0),
			channels: Number(row.channels ?? 0),
		})),
		topPlayed: topPlayedRows.map(row => ({
			packKey: String(row.pack_key),
			count: Number(row.cnt ?? 0),
		})),
		topPlanned: topPlannedRows.map(row => ({
			packKey: String(row.pack_key),
			count: Number(row.cnt ?? 0),
		})),
	};

	fs.mkdirSync(path.dirname(COMMUNITY_STATS_FILE), { recursive: true });
	fs.writeFileSync(COMMUNITY_STATS_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
	console.log(
		`Снимок сообщества: ${snapshot.streamLinks} стрим-связок (${snapshot.streamedPacks} паков, `
		+ `${snapshot.streamChannels} каналов), ${snapshot.playedMarks} «Сыграно», ${snapshot.plannedMarks} «В планах».`,
	);
}
