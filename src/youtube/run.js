// Обход YouTube-записей «Своей игры» через Gemini Video API:
//   еженедельная живость → мост Twitch → YouTube → поиск → скан → D1 → итог.
// Точка входа — scripts/youtube.js.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../twitch/index.js';
import { cleanVideoId, videosById } from './api.js';
import { bridgeTwitchChannels, discover } from './discover.js';
import { createYoutubeGemini, KeyBlockedError, QuotaExhaustedError } from './gemini.js';
import { details, markdown, writeSummary } from './report.js';
import { scanYoutubeVideo } from './scan.js';
import {
	aliveYoutubeVideos, confirmedTwitchLogins, ensureYoutubeSchema, getKvTime,
	knownYoutubeChannels, knownYoutubeVideos, markAliveYoutube, markChannelsChecked,
	saveYoutubePackStreams, saveYoutubeVideos, setKvTime, upsertYoutubeChannels,
} from './store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const WEEK_MS = 7 * 864e5;

/*
 * Ключи запуска:
 *   --videos=id1,id2  эти ролики (URL или ID), а не найденные поиском
 *   --discover        только найти и показать кандидатов — без вызовов Gemini
 *   --alive           только проверить живость YouTube-записей в pack_streams
 *   --backfill        глубокий обход (больше страниц поиска и до 50 видео на канал)
 *   --sync-channels   принудительно прогнать мост Twitch socialMedias → youtube_channels
 *   --days=N          горизонт поиска в днях (по умолчанию 7)
 *   --limit=N         не больше N роликов за запуск (по умолчанию 40 в сутки)
 *   --minutes=N       сколько минут отпущено (по умолчанию 120)
 *   --rescan          не пропускать уже просмотренные
 *   --dry             не читать и не писать D1
 *   --db=путь         база паков (по умолчанию data/sibase.db)
 *   --out=файл        подробности по каждому ролику в JSON
 */
export function options(argv = process.argv.slice(2)) {
	const a = Object.fromEntries(argv.map(s => {
		const m = /^--([^=]+)(?:=(.*))?$/.exec(s);
		return m ? [m[1], m[2] ?? true] : [s, true];
	}));
	const rawVideos = a.videos ? String(a.videos).split(/[\s,]+/).map(cleanVideoId).filter(Boolean) : null;
	return {
		videos: rawVideos && rawVideos.length ? rawVideos : null,
		discoverOnly: !!a.discover,
		aliveOnly: !!a.alive,
		backfill: !!a.backfill,
		syncChannels: !!a['sync-channels'],
		days: a.days ? Number(a.days) : (a.backfill ? 0 : 7),
		limit: a.limit ? Number(a.limit) : (a.videos ? Infinity : 45),
		minutes: a.minutes ? Number(a.minutes) : 120,
		rescan: !!a.rescan,
		dry: !!a.dry,
		db: path.resolve(root, a.db ? String(a.db) : path.join('data', 'sibase.db')),
		out: a.out ? path.resolve(String(a.out)) : null,
	};
}

export async function run(o = options()) {
	const started = Date.now();
	const useD1 = !o.dry;

	let known = new Map();
	let channels = [];
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

		// Мост Twitch → YouTube: раз в неделю, при --sync-channels/--backfill или пока youtube_channels пуста
		const lastBridge = await getKvTime('yt_bridge_at');
		if (!o.videos && (o.syncChannels || o.backfill || channels.length === 0 || started - lastBridge >= WEEK_MS)) {
			bridge = await syncTwitchBridge(channels);
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
			markdown({ alive, bridge, discovery, results: [] }),
			'| Видео | Канал | Дата | Длина | Просмотры | Откуда | Название |',
			'|---|---|---|---|---|---|---|',
			...lines,
		].join('\n'));
		return;
	}

	// 2. Смотреть через Gemini Video API
	const index = buildIndex(o.db);
	console.log(`словарь: ${index.packs.size} паков, ${index.themes.length} тем, ${index.ms} мс; к просмотру ${items.length} (лимит ${o.limit})`);
	const gemini = createYoutubeGemini({ log: s => console.log(s) });
	const ctx = { index, gemini, log: s => console.log(s) };

	const results = [];
	let stoppedReason = null;

	for (const item of items.slice(0, o.limit)) {
		if (Date.now() - started > o.minutes * 60_000) {
			stoppedReason = `вышло время (${o.minutes} мин) — осталось ${items.length - results.length} видео, возьмём завтра`;
			console.log(stoppedReason);
			break;
		}
		const v = item.video;
		console.log(`▶ ${v.id} [${v.channelTitle || v.channelId}] «${v.title}» ${Math.round((v.length || 0) / 60)} мин`);

		let res;
		if (item.gone) {
			res = { status: 'gone', calls: 0, tokensIn: 0, signs: 0, error: 'видео удалено или недоступно', packs: [], near: [], names: [], inside: [] };
		} else {
			try {
				res = await scanYoutubeVideo(v, ctx);
			} catch (err) {
				if (err instanceof QuotaExhaustedError || err instanceof KeyBlockedError) {
					stoppedReason = err.message;
					console.warn(`⚠️ ${stoppedReason}`);
					break;
				}
				res = { status: 'error', calls: 0, tokensIn: 0, signs: 0, error: err.message, packs: [], near: [], names: [], inside: [] };
			}
		}

		results.push({ video: v, res, source: item.source });
		const packNote = res.packs?.length
			? `✅ ${res.packs.map(p => `#${p.pack.id} «${p.pack.name}» (${p.themes} тем)`).join(', ')}`
			: (res.status === 'done' ? (res.signs > 0 ? 'SIGame (вне базы)' : 'не SIGame') : `${res.status}: ${res.error || ''}`);
		console.log(`  → ${packNote} [${res.calls || 0} выз., ${res.tokensIn || 0} tok]`);

		if (useD1 && !item.gone) {
			if (res.status === 'done') {
				const { notified } = await saveYoutubePackStreams(v, res.packs);
				if (notified) console.log(`  звонков авторам: ${notified}`);
				// Если канал подтвердил SIGame — сохраняем/усиливаем его в youtube_channels
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

	// 3. Итог
	writeSummary(markdown({ alive, bridge, discovery, results, index, took: Date.now() - started, stoppedReason }));
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

async function syncTwitchBridge(existingChannels) {
	try {
		const logins = await confirmedTwitchLogins();
		const knownIds = new Set(existingChannels.map(c => String(c.channel_id)));
		const knownLogins = new Set(existingChannels.map(c => String(c.twitch_login || '').toLowerCase()).filter(Boolean));
		const { channels, checked, integrityBlocked } = await bridgeTwitchChannels(logins, knownIds, knownLogins);
		if (channels.length) {
			await upsertYoutubeChannels(channels.map(c => ({ ...c, source: 'twitch', sigameDelta: 0 })));
		}
		const note = integrityBlocked ? ' (socialMedias закрыты Twitch Integrity с этого IP — взяты панели/описания)' : '';
		console.log(`мост Twitch → YouTube: проверено ${checked} каналов, добавлено ${channels.length}${note}`);
		return { checked, added: channels.length, integrityBlocked };
	} catch (e) {
		console.log(`мост Twitch → YouTube не сработал: ${e.message}`);
		return { error: e.message };
	}
}
