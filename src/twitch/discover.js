// Какие записи сегодня смотреть.
//
// Источники (twitch-streams.md, 6.2; twitch-discovery.md):
//   - категория SIGame на Twitch — около недели записей одной страницей;
//   - каналы, игравшие SIGame по SullyGnome, — все их записи: SIGame часто
//     идёт не первой игрой, и категория записи тогда чужая;
//   - каналы, пойманные в живой категории SIGame поллером Worker'а
//     (twitch_seen_channels, cf/src/twitch-live.js) — видит даже мелкие каналы;
//   - поиск VOD по ключевым словам через GQL searchFor — находит стримы,
//     где категорию SIGame не ставили вообще (Just Chatting и др.);
//   - каналы, где SIGame уже находилась раньше (из twitch_vods), и владельцы
//     записей категории — на случай, если остальные промолчали.
//
// Записи каналов приходят сразу с главами, поэтому где внутри записи SIGame,
// видно без отдельных запросов (plan.js). Сбой источника задачу не роняет:
// идём по тому, что есть, а сбой попадает в итог.

import { PLAN_VERSION, windowsOf } from './plan.js';
import { MAX_TRIES } from './store.js';
import { sigameChannels } from './sullygnome.js';
import { categoryVideos, channelVideos, searchVideos, videosById } from './twitch.js';

/** Потолок probe-записей за один запуск, чтобы всплеск по слову «свояк» не вытеснил записи с категорией. */
const MAX_PROBE_PER_RUN = 50;

/**
 * @param {{sullyDays: number, since: number, known: Map, knownChannels: string[], seenChannels?: string[], rescan?: boolean}} o
 */
export async function discover(o) {
	const stats = { category: 0, sully: 0, live: 0, search: 0, channels: 0, videos: 0, errors: [] };
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

	let sully = [];
	try {
		sully = await sigameChannels(o.sullyDays);
		stats.sully = sully.length;
	} catch (e) {
		stats.errors.push(`SullyGnome: ${e.message}`);
	}

	const live = (o.seenChannels || []).map(c => String(c || '').toLowerCase()).filter(Boolean);
	stats.live = live.length;

	let search = [];
	try {
		search = await searchVideos(undefined, { since: o.since });
		stats.search = search.length;
	} catch (e) {
		stats.errors.push(`поиск VOD: ${e.message}`);
	}

	const fromSully = new Set(sully.map(c => c.toLowerCase()));
	const fromLive = new Set(live);
	const fromSearch = new Set(search.map(v => v.channel.toLowerCase()).filter(Boolean));
	const channels = [...new Set([
		...sully,
		...live,
		...o.knownChannels,
		...category.map(v => v.channel),
		...search.map(v => v.channel),
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
			if (!tagged) add([v], fromSearch.has(ch) ? 'search' : 'channel');
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

	const allTodo = [];
	const skipped = { old: 0, notSigame: 0, recording: 0, seen: 0, subonly: 0, gone: 0, failed: 0, probeCap: 0 };
	for (const { video, sources } of seen.values()) {
		if (video.createdAt < o.since) { skipped.old++; continue; }
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
