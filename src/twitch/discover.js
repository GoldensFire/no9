// Какие записи сегодня смотреть.
//
// Источники (twitch-streams.md, 6.2; twitch-coverage-and-youtube.md):
//   - категория SIGame на Twitch — архивы, вечные хайлайты и загрузки ≥ 10 мин;
//   - каналы, пойманные живым поллером Worker'а (twitch_seen_channels и
//     twitch_seen_windows, cf/src/twitch-live.js) — категория SIGame и RU
//     Just Chatting по заголовку/тегам, видит даже мелкие каналы;
//   - поиск VOD по ключевым словам через GQL searchFor — находит стримы,
//     где категорию SIGame не ставили вообще (Just Chatting и др.);
//   - клипы категории SIGame за последнюю неделю (1 GQL-запрос) — страховка
//     от коротких переключений категории;
//   - со-стримеры из @упоминаний в заголовках подтверждённых SIGame-записей;
//   - каналы, где SIGame уже находилась раньше (из twitch_vods с signs >= 5);
//   - SullyGnome — только как аварийный фоллбэк (--all/--days, пустая
//     twitch_seen_channels или live-поллер молчит дольше 12 часов).
//
// Записи каналов приходят сразу с главами, поэтому где внутри записи SIGame,
// видно без отдельных запросов (plan.js). Сбой источника задачу не роняет:
// идём по тому, что есть, а сбой попадает в итог.

import { PLAN_VERSION, windowsOf } from './plan.js';
import { MAX_TRIES } from './store.js';
import { sigameChannels } from './sullygnome.js';
import { categoryClips, categoryVideos, channelVideos, searchVideos, videosById } from './twitch.js';

/** Потолок probe-записей за один запуск, чтобы всплеск по слову «свояк» не вытеснил записи с категорией. */
const MAX_PROBE_PER_RUN = 50;

/** Если live-поллер не обновлял twitch_seen_channels дольше 12 ч — включается фоллбэк SullyGnome. */
const LIVE_STALE_MS = 12 * 3600e3;

/** Запас вокруг живого окна Just Chatting (10 мин — шаг cron поллера). */
const LIVE_WINDOW_PAD_S = 600;

const MENTION_RE = /(?:^|[^a-zA-Z0-9_])@([a-zA-Z0-9_]{3,25})(?![a-zA-Z0-9_])/g;

function extractMentions(titles) {
	const out = new Set();
	for (const t of titles) {
		if (!t || !String(t).includes('@')) continue;
		for (const m of String(t).matchAll(MENTION_RE)) out.add(m[1].toLowerCase());
	}
	return [...out];
}

function liveWindowsFor(video, seenWindowsMap) {
	if (!seenWindowsMap?.size || !video.createdAt || !video.length) return null;
	const list = seenWindowsMap.get(String(video.channel || '').toLowerCase());
	if (!list?.length) return null;
	const start = video.createdAt;
	const end = video.createdAt + video.length * 1000;
	const out = [];
	for (const w of list) {
		if (w.lastSeen < start || w.firstSeen > end) continue;
		const from = Math.max(0, (w.firstSeen - start) / 1000 - LIVE_WINDOW_PAD_S);
		const to = Math.min(video.length, (w.lastSeen - start) / 1000 + LIVE_WINDOW_PAD_S);
		if (to > from) out.push([from, to]);
	}
	return out.length ? out : null;
}

/**
 * @param {{sullyDays: number, forceSully?: boolean, since: number, known: Map, knownChannels: string[], knownTitles?: string[], seenChannels?: string[], seenLatestAt?: number, seenWindows?: Map, rescan?: boolean}} o
 */
export async function discover(o) {
	const stats = { category: 0, sully: 0, sullyReason: null, live: 0, search: 0, clips: 0, mentions: 0, channels: 0, videos: 0, errors: [] };
	const seen = new Map(); // номер → { video, sources: Set }
	const add = (list, source) => {
		for (const v of list) {
			if (!v) continue;
			const e = seen.get(v.id);
			if (e) e.sources.add(source);
			else seen.set(v.id, { video: v, sources: new Set([source]) });
		}
	};

	let category = [];
	try {
		category = await categoryVideos();
		stats.category = category.length;
		add(category, 'category');
	} catch (e) {
		stats.errors.push(`категория SIGame: ${e.message}`);
	}

	const live = (o.seenChannels || []).map(c => String(c || '').toLowerCase()).filter(Boolean);
	stats.live = live.length;

	let sullyReason = null;
	if (o.forceSully) sullyReason = 'флаг --all/--days';
	else if (!live.length) sullyReason = 'нет данных live-поллера';
	else if (!o.seenLatestAt || Date.now() - o.seenLatestAt > LIVE_STALE_MS) sullyReason = 'live-поллер молчит >12 ч';
	stats.sullyReason = sullyReason;

	let sully = [];
	if (sullyReason) {
		try {
			sully = await sigameChannels(o.sullyDays);
			stats.sully = sully.length;
		} catch (e) {
			stats.errors.push(`SullyGnome: ${e.message}`);
		}
	}

	let search = [];
	try {
		search = await searchVideos(undefined, { since: o.since });
		stats.search = search.length;
	} catch (e) {
		stats.errors.push(`поиск VOD: ${e.message}`);
	}

	let clips = { channels: [], videoIds: [] };
	try {
		clips = await categoryClips('LAST_WEEK');
		stats.clips = clips.channels.length;
	} catch (e) {
		stats.errors.push(`клипы SIGame: ${e.message}`);
	}

	const mentions = extractMentions([
		...(o.knownTitles || []),
		...category.map(v => v.title),
		...search.map(v => v.title),
	]);
	stats.mentions = mentions.length;

	const fromSully = new Set(sully.map(c => c.toLowerCase()));
	const fromLive = new Set(live);
	const fromClips = new Set(clips.channels);
	const fromMentions = new Set(mentions);
	const fromSearch = new Set(search.map(v => v.channel.toLowerCase()).filter(Boolean));
	const channels = [...new Set([
		...sully,
		...live,
		...clips.channels,
		...o.knownChannels,
		...category.map(v => v.channel),
		...search.map(v => v.channel),
		...mentions,
	].map(c => String(c || '').toLowerCase()))].filter(Boolean);
	stats.channels = channels.length;

	try {
		const list = await channelVideos(channels);
		stats.videos = list.length;
		for (const v of list) {
			const ch = v.channel.toLowerCase();
			let tagged = false;
			if (fromSully.has(ch)) { add([v], 'sully'); tagged = true; }
			if (fromLive.has(ch)) { add([v], 'live'); tagged = true; }
			if (fromClips.has(ch)) { add([v], 'clips'); tagged = true; }
			if (!tagged) {
				if (fromSearch.has(ch)) add([v], 'search');
				else if (fromMentions.has(ch)) add([v], 'mention');
				else add([v], 'channel');
			}
		}
	} catch (e) {
		stats.errors.push(`записи каналов: ${e.message}`);
	}

	// Записи из поиска, которые уже пришли с главами из category/channelVideos,
	// просто помечаем источником 'search'; для остальных добираем главы через videosById.
	const missingSearch = [];
	for (const v of search) {
		const e = seen.get(v.id);
		if (e) e.sources.add('search');
		else missingSearch.push(v);
	}
	if (missingSearch.length) {
		try {
			const full = await videosById(missingSearch.map(v => v.id));
			full.forEach((v, i) => add([v || missingSearch[i]], 'search'));
		} catch (e) {
			stats.errors.push(`главы из поиска: ${e.message}`);
			add(missingSearch, 'search');
		}
	}

	// Записи, привязанные к клипам категории SIGame, если не попали через каналы
	const missingClipIds = [];
	for (const id of clips.videoIds) {
		const e = seen.get(id);
		if (e) e.sources.add('clips');
		else missingClipIds.push(id);
	}
	if (missingClipIds.length) {
		try {
			const full = await videosById(missingClipIds);
			add(full.filter(Boolean), 'clips');
		} catch (e) {
			stats.errors.push(`записи из клипов: ${e.message}`);
		}
	}

	const allTodo = [];
	const skipped = { old: 0, notSigame: 0, recording: 0, seen: 0, subonly: 0, gone: 0, failed: 0, probeCap: 0 };
	for (const { video, sources } of seen.values()) {
		if (video.type !== 'HIGHLIGHT' && video.createdAt < o.since) { skipped.old++; continue; }
		const lw = liveWindowsFor(video, o.seenWindows);
		if (lw) video.liveWindows = lw;
		const plan = windowsOf(video);
		if (!plan.mode) { skipped.notSigame++; continue; }
		if (video.status === 'RECORDING') { skipped.recording++; continue; }
		const row = o.rescan ? null : o.known.get(video.id);
		if (row) {
			if (row.status === 'done' && String(row.plan_key || '').startsWith(`${PLAN_VERSION}/`)) { skipped.seen++; continue; }
			if (row.status === 'subonly') { skipped.subonly++; continue; }
			if (row.status === 'gone') { skipped.gone++; continue; }
			if (row.status === 'error' && row.tries >= MAX_TRIES) { skipped.failed++; continue; }
		}
		allTodo.push({ video, plan, source: [...sources].sort().join('+') });
	}
	// Сначала точные записи (главы/категория SIGame), потом probe; внутри группы — старые первыми
	const rank = item => (item.plan.mode === 'probe' ? 1 : 0);
	allTodo.sort((a, b) => rank(a) - rank(b) || a.video.createdAt - b.video.createdAt);

	const todo = [];
	let probes = 0;
	for (const item of allTodo) {
		if (item.plan.mode === 'probe') {
			if (probes >= MAX_PROBE_PER_RUN) { skipped.probeCap++; continue; }
			probes++;
		}
		todo.push(item);
	}
	return { todo, stats, skipped };
}
