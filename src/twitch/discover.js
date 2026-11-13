// Какие записи сегодня смотреть.
//
// Источники (twitch-streams.md, 6.2):
//   - категория SIGame на Twitch — около недели записей одной страницей;
//   - каналы, игравшие SIGame по SullyGnome, — все их записи: SIGame часто
//     идёт не первой игрой, и категория записи тогда чужая;
//   - каналы, где SIGame уже находилась раньше (из twitch_vods), и владельцы
//     записей категории — на случай, если SullyGnome промолчал.
//
// Записи каналов приходят сразу с главами, поэтому где внутри записи SIGame,
// видно без отдельных запросов (plan.js). Сбой источника задачу не роняет:
// идём по тому, что есть, а сбой попадает в итог.

import { PLAN_VERSION, windowsOf } from './plan.js';
import { MAX_TRIES } from './store.js';
import { sigameChannels } from './sullygnome.js';
import { categoryVideos, channelVideos } from './twitch.js';

/**
 * @param {{sullyDays: number, since: number, known: Map, knownChannels: string[], rescan?: boolean}} o
 */
export async function discover(o) {
	const stats = { category: 0, sully: 0, channels: 0, videos: 0, errors: [] };
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

	const fromSully = new Set(sully);
	const channels = [...new Set([...sully, ...o.knownChannels, ...category.map(v => v.channel.toLowerCase())])].filter(Boolean);
	stats.channels = channels.length;
	try {
		const list = await channelVideos(channels);
		stats.videos = list.length;
		for (const v of list) add([v], fromSully.has(v.channel.toLowerCase()) ? 'sully' : 'channel');
	} catch (e) {
		stats.errors.push(`записи каналов: ${e.message}`);
	}

	const todo = [], skipped = { old: 0, notSigame: 0, recording: 0, seen: 0, subonly: 0, gone: 0, failed: 0 };
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
		todo.push({ video, plan, source: [...sources].sort().join('+') });
	}
	// Старые первыми: им умирать раньше
	todo.sort((a, b) => a.video.createdAt - b.video.createdAt);
	return { todo, stats, skipped };
}
