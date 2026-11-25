// Обход YouTube-записей «Своей игры»:
//   еженедельная живость → мост Twitch → YouTube → поиск → скан (Gemini / локальный OCR / гибрид) → D1 → итог.
// Точка входа — scripts/youtube.js.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../twitch/index.js';
import { cleanVideoId, videosById } from './api.js';
import { bridgeTwitchChannels, discover } from './discover.js';
import { createYoutubeGemini, KeyBlockedError, QuotaExhaustedError } from './gemini.js';
import { AgeRestrictedError, createLocalScanner, LocalBotCheckError, scanYoutubeVideoLocal } from './local.js';
import { details, markdown, writeSummary } from './report.js';
import { scanYoutubeVideo } from './scan.js';
import {
	aliveYoutubeVideos, channelYieldStats, confirmedTwitchLogins, ensureYoutubeSchema,
	getKvJson, getKvTime, knownYoutubeChannels, knownYoutubeVideos, markAliveYoutube,
	markChannelsChecked, saveYoutubePackStreams, saveYoutubeVideos, setKvJson, setKvTime,
	upsertYoutubeChannels,
} from './store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const WEEK_MS = 7 * 864e5;
const MAX_RESET_WAIT_MS = 15 * 60_000;
const sleep = ms => new Promise(res => setTimeout(res, ms));

/*
 * Ключи запуска:
 *   --engine=gemini|local|hybrid  чем смотреть видео (по умолчанию gemini):
 *                                   gemini — Gemini Video API (облачный раннер);
 *                                   local  — yt-dlp + ffmpeg + tesseract на ПК (0 квоты Gemini, 18+ пропускаются);
 *                                   hybrid — local для обычных видео + Gemini только на 18+ (рекомендуется на ПК)
 *   --local                       короткая запись --engine=local
 *   --hybrid                      короткая запись --engine=hybrid
 *   --jobs=N                      число параллельных воркеров кадров/OCR в local/hybrid (по умолчанию 8)
 *   --cookies=файл                cookies для yt-dlp (если нужно локально смотреть и 18+)
 *   --cookies-from-browser=имя    взять cookies yt-dlp из браузера (chrome, edge, firefox)
 *   --videos=id1,id2              эти ролики (URL или ID), а не найденные поиском
 *   --discover                    только найти и показать кандидатов — без просмотра видео
 *   --alive                       только проверить живость YouTube-записей в pack_streams
 *   --backfill                    глубокий обход (по дате + релевантности, до 500 видео на паковый канал, лимит 300)
 *   --sync-channels               принудительно прогнать мост Twitch socialMedias → youtube_channels
 *   --no-bridge                   не запускать мост Twitch → YouTube в этом прогоне
 *   --days=N                      горизонт поиска в днях (по умолчанию 7)
 *   --limit=N                     не больше N роликов за запуск (по умолчанию 60; при --backfill — 300)
 *   --minutes=N                   сколько минут отпущено (по умолчанию 120; при --local/--hybrid — 360)
 *   --rescan                      не пропускать уже просмотренные
 *   --dry                         не читать и не писать D1
 *   --db=путь                     база паков (по умолчанию data/sibase.db)
 *   --out=файл                    подробности по каждому ролику в JSON
 */
export function options(argv = process.argv.slice(2)) {
	const a = Object.fromEntries(argv.map(s => {
		const m = /^--([^=]+)(?:=(.*))?$/.exec(s);
		return m ? [m[1], m[2] ?? true] : [s, true];
	}));
	const rawVideos = a.videos ? String(a.videos).split(/[\s,]+/).map(cleanVideoId).filter(Boolean) : null;
	let engine = a.engine ? String(a.engine).toLowerCase() : (a.hybrid ? 'hybrid' : (a.local ? 'local' : 'gemini'));
	if (!['gemini', 'local', 'hybrid'].includes(engine)) {
		throw new Error(`Неизвестный --engine=${engine} (ожидается gemini, local или hybrid)`);
	}
	const isLocalMode = engine === 'local' || engine === 'hybrid';
	return {
		engine,
		jobs: a.jobs !== undefined ? Number(a.jobs) : 8,
		cookies: a.cookies ? String(a.cookies) : null,
		cookiesFromBrowser: a['cookies-from-browser'] ? String(a['cookies-from-browser']) : null,
		videos: rawVideos && rawVideos.length ? rawVideos : null,
		discoverOnly: !!a.discover,
		aliveOnly: !!a.alive,
		backfill: !!a.backfill,
		syncChannels: !!a['sync-channels'],
		noBridge: !!a['no-bridge'],
		days: a.days !== undefined ? Number(a.days) : (a.backfill ? 0 : 7),
		limit: a.limit !== undefined ? Number(a.limit) : (a.videos ? Infinity : (a.backfill ? (isLocalMode ? 1000 : 300) : 60)),
		minutes: a.minutes !== undefined ? Number(a.minutes) : (isLocalMode ? 360 : 120),
		rescan: !!a.rescan,
		dry: !!a.dry,
		db: path.resolve(root, a.db ? String(a.db) : path.join('data', 'sibase.db')),
		out: a.out ? path.resolve(String(a.out)) : null,
	};
}

export async function run(o = options()) {
	const started = Date.now();
	const useD1 = !o.dry;
	const deadline = started + o.minutes * 60_000;

	let known = new Map();
	let channels = [];
	let channelYield = new Map();
	let alive = null;
	let bridge = null;

	if (useD1) {
		await ensureYoutubeSchema();

		// Проверка живости: при --alive всегда, иначе раз в неделю
		const lastAlive = await getKvTime('yt_alive_at');
		if (o.aliveOnly || started - lastAlive >= WEEK_MS) {
			alive = await checkAliveYoutube();
			if (!alive.error) await setKvTime('yt_alive_at', started);
		}
		if (o.aliveOnly) {
			writeSummary(markdown({ alive, results: [] }));
			return;
		}

		known = await knownYoutubeVideos();
		channels = await knownYoutubeChannels();
		channelYield = await channelYieldStats();

		// Мост Twitch → YouTube: раз в неделю, при --sync-channels или пока youtube_channels пуста.
		// При --backfill запускаем только если кэш/интервал этого просит (не спамя 72 Integrity-ошибки каждый прогон).
		const lastBridge = await getKvTime('yt_bridge_at');
		if (!o.videos && !o.noBridge && (o.syncChannels || channels.length === 0 || started - lastBridge >= WEEK_MS || (o.backfill && (o.engine === 'local' || o.engine === 'hybrid')))) {
			bridge = await syncTwitchBridge(channels, { force: o.syncChannels });
			if (!bridge.error) {
				await setKvTime('yt_bridge_at', started);
				if (bridge.added > 0) channels = await knownYoutubeChannels();
			}
		}
	}

	// 1. Что смотреть
	let items = [];
	let discovery = null;
	if (o.videos) {
		const { videos, missing } = await videosById(o.videos);
		for (const id of o.videos) {
			const v = videos.get(id);
			if (v) items.push({ video: v, source: 'вручную' });
			else if (missing.includes(id)) items.push({ video: { id, channelId: '', channelTitle: '', title: '', publishedAt: 0, length: 0 }, gone: true, source: 'вручную' });
		}
	} else {
		discovery = await discover({
			days: o.days,
			backfill: o.backfill,
			known,
			channels,
			channelYield,
			rescan: o.rescan,
		});
		items = discovery.todo;
		if (useD1 && discovery.checkedChannelIds.length) {
			await markChannelsChecked(discovery.checkedChannelIds);
		}
	}

	if (o.discoverOnly) {
		const lines = items.map(({ video: v, source }) =>
			`| [${v.id}](https://youtu.be/${v.id}) | ${v.channelTitle || v.channelId} | ${v.publishedAt ? new Date(v.publishedAt).toISOString().slice(0, 10) : '—'} | ${Math.round(v.length / 60)} мин | ${v.views ?? '—'} | ${source} | ${(v.title || '').replace(/\|/g, '\\|')} |`
		);
		writeSummary([
			markdown({ alive, bridge, discovery, results: [], engine: o.engine }),
			'| Видео | Канал | Дата | Длина | Просмотры | Откуда | Название |',
			'|---|---|---|---|---|---|---|',
			...lines,
		].join('\n'));
		return;
	}

	// 2. Подготовка движка: Gemini, локальный OCR (yt-dlp+ffmpeg+tesseract) или гибрид
	const index = buildIndex(o.db);
	const localScanner = (o.engine === 'local' || o.engine === 'hybrid')
		? createLocalScanner({ jobs: o.jobs, cookies: o.cookies, cookiesFromBrowser: o.cookiesFromBrowser })
		: null;
	const gemini = (o.engine === 'gemini' || o.engine === 'hybrid')
		? createYoutubeGemini({ log: s => console.log(s) })
		: null;

	const engineNote = localScanner
		? `${o.engine} (ffmpeg=${localScanner.ffmpeg}, воркеров=${localScanner.workers}${localScanner.cookies || localScanner.cookiesFromBrowser ? ', cookies' : ''})`
		: 'gemini';
	console.log(`словарь: ${index.packs.size} паков, ${index.themes.length} тем, ${index.ms} мс; движок: ${engineNote}; к просмотру ${items.length} (лимит ${o.limit})`);

	const ctx = { index, gemini, local: localScanner, log: s => console.log(s) };

	const results = [];
	let stoppedReason = null;
	let waitedQuotaReset = false;
	let geminiExhausted = false;
	let skippedAge = 0;

	const queue = items.slice(0, o.limit);
	try {
		for (let idx = 0; idx < queue.length; idx++) {
			if (Date.now() > deadline) {
				stoppedReason = `вышло время (${o.minutes} мин) — осталось ${queue.length - idx} видео, возьмём в следующий раз`;
				console.log(stoppedReason);
				break;
			}
			const item = queue[idx];
			const v = item.video;
			console.log(`▶ [${idx + 1}/${queue.length}] ${v.id} [${v.channelTitle || v.channelId}] «${v.title}» ${Math.round((v.length || 0) / 60)} мин`);

			let res = null;
			if (item.gone) {
				res = { status: 'gone', engine: o.engine, calls: 0, tokensIn: 0, frames: 0, signs: 0, error: 'видео удалено или недоступно', packs: [], near: [], names: [], inside: [] };
			} else if (o.engine === 'gemini') {
				try {
					res = await scanYoutubeVideo(v, ctx);
				} catch (err) {
					if (err instanceof QuotaExhaustedError) {
						const waitMs = err.retryAfterMs;
						const remainingMs = deadline - Date.now();
						if (!waitedQuotaReset && waitMs && waitMs > 0 && waitMs <= MAX_RESET_WAIT_MS && remainingMs > waitMs + 5 * 60_000) {
							waitedQuotaReset = true;
							const pauseMs = waitMs + 15_000;
							console.log(`⏳ Суточная квота Gemini сбросится через ${Math.ceil(pauseMs / 60_000)} мин — жду сброса и продолжаю…`);
							await sleep(pauseMs);
							gemini.resetExhausted();
							idx--;
							continue;
						}
						stoppedReason = err.message;
						console.warn(`⚠️ ${stoppedReason}`);
						break;
					}
					if (err instanceof KeyBlockedError) {
						stoppedReason = err.message;
						console.warn(`⚠️ ${stoppedReason}`);
						break;
					}
					res = { status: 'error', engine: 'gemini', calls: 0, tokensIn: 0, signs: 0, error: err.message, packs: [], near: [], names: [], inside: [] };
				}
			} else {
				// local или hybrid
				try {
					res = await scanYoutubeVideoLocal(v, ctx);
				} catch (err) {
					if (err instanceof AgeRestrictedError) {
						if (o.engine === 'hybrid' && gemini && !geminiExhausted) {
							console.log(`  [hybrid] ролик 18+ → передаю в Gemini Video API`);
							try {
								res = await scanYoutubeVideo(v, ctx);
							} catch (gErr) {
								if (gErr instanceof QuotaExhaustedError || gErr instanceof KeyBlockedError) {
									geminiExhausted = true;
									skippedAge++;
									console.warn(`  ⚠️ Gemini недоступен (${gErr.message}) — пропускаю 18+ и продолжаю локально`);
									continue;
								}
								res = { status: 'error', engine: 'gemini', calls: 0, tokensIn: 0, signs: 0, error: gErr.message, packs: [], near: [], names: [], inside: [] };
							}
						} else {
							skippedAge++;
							console.log(`  → пропущено (18+, оставлено для Gemini / --cookies)`);
							continue;
						}
					} else if (err instanceof LocalBotCheckError) {
						stoppedReason = err.message;
						console.warn(`⚠️ ${stoppedReason}`);
						break;
					} else {
						res = { status: 'error', engine: 'local', calls: 0, tokensIn: 0, frames: 0, signs: 0, error: err.message, packs: [], near: [], names: [], inside: [] };
					}
				}
			}

			results.push({ video: v, res, source: item.source });
			const packNote = res.packs?.length
				? `✅ ${res.packs.map(p => `#${p.pack.id} «${p.pack.name}» (${p.themes} тем)`).join(', ')}`
				: (res.status === 'done' ? (res.signs > 0 ? 'SIGame (вне базы)' : 'не SIGame') : `${res.status}: ${res.error || ''}`);
			const metric = res.engine === 'local'
				? `${res.frames || 0} кадр., ${Math.round((res.ms || 0) / 1000)} с`
				: `${res.calls || 0} выз., ${res.tokensIn || 0} tok`;
			console.log(`  → ${packNote} [${metric}]`);

			if (useD1 && !item.gone) {
				if (res.status === 'done') {
					const { notified } = await saveYoutubePackStreams(v, res.packs);
					if (notified) console.log(`  звонков авторам: ${notified}`);
					if (v.channelId && (res.packs.length > 0 || (res.signs || 0) > 0)) {
						await upsertYoutubeChannels([{
							channelId: v.channelId,
							title: v.channelTitle,
							source: item.source.includes('channel') ? 'channel' : 'search',
							sigameDelta: 1,
						}]);
					}
				}
				await saveYoutubeVideos([{
					...v,
					source: item.source,
					status: res.status,
					calls: res.calls,
					tokensIn: res.tokensIn,
					signs: res.signs,
					planKey: res.planKey,
					error: res.error,
				}]);
			}
		}
	} finally {
		localScanner?.close();
	}

	// 3. Итог
	writeSummary(markdown({
		alive, bridge, discovery, results, index,
		took: Date.now() - started, stoppedReason,
		engine: o.engine, skippedAge,
	}));
	if (o.out) fs.writeFileSync(o.out, JSON.stringify(results.map(details), null, '\t'));
}

async function checkAliveYoutube() {
	try {
		const ids = await aliveYoutubeVideos();
		if (!ids.length) return { checked: 0, dead: 0 };
		const { videos, missing } = await videosById(ids);
		await markAliveYoutube(missing, [...videos.values()]);
		console.log(`живость YouTube: в полосе ${ids.length} записей, умерло ${missing.length}`);
		return { checked: ids.length, dead: missing.length };
	} catch (e) {
		console.log(`живость YouTube не проверилась: ${e.message}`);
		return { error: e.message };
	}
}

async function syncTwitchBridge(existingChannels, { force = false } = {}) {
	try {
		const logins = await confirmedTwitchLogins();
		const knownIds = new Set(existingChannels.map(c => String(c.channel_id)));
		const knownLogins = new Set(existingChannels.map(c => String(c.twitch_login || '').toLowerCase()).filter(Boolean));
		const checkedCache = await getKvJson('yt_bridge_checked', { full: {}, partial: {} });
		const res = await bridgeTwitchChannels(logins, knownIds, knownLogins, { checkedCache, force });
		if (res.channels.length) {
			await upsertYoutubeChannels(res.channels.map(c => ({ ...c, source: 'twitch', sigameDelta: 0 })));
		}
		if (res.checkedCache && (res.checked > 0 || force)) {
			await setKvJson('yt_bridge_checked', res.checkedCache);
		}
		const note = res.integrityBlocked ? ' (socialMedias закрыты Twitch Integrity с этого IP — взяты панели/описания)' : '';
		const cacheNote = res.skippedCached ? `, в кэше ${res.skippedCached}` : '';
		console.log(`мост Twitch → YouTube: проверено ${res.checked} каналов, добавлено ${res.channels.length}${cacheNote}${note}`);
		return { checked: res.checked, added: res.channels.length, skippedCached: res.skippedCached || 0, integrityBlocked: res.integrityBlocked };
	} catch (e) {
		console.log(`мост Twitch → YouTube не сработал: ${e.message}`);
		return { error: e.message };
	}
}
