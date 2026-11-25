// Адаптивный скан одного YouTube-ролика через Gemini Video API + существующий
// матчер FirePacks (src/twitch/match.js, verdict.js, marks.js).

import { frameWords, themeWordsOf } from '../twitch/marks.js';
import { analyzeFrame } from '../twitch/match.js';
import { collectHits, collectNames, judge } from '../twitch/verdict.js';
import { BadSliceError, VideoAccessError } from './gemini.js';
import { planKey, planSlices } from './plan.js';

/** Разобрать таймкод вида «MM:SS» или «HH:MM:SS» в секунды (или null). */
function parseAt(raw) {
	const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
	if (!m) return null;
	return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Привязать таймкод, названный Gemini, к реальному времени видео.
 * Gemini иногда называет реальный таймкод видео («35:04»), а иногда относительный
 * сдвиг внутри среза («00:05»). Если число попадает в один из срезов батча —
 * берём его напрямую; иначе привязываем к ближайшему срезу батча.
 */
function resolveTime(rawAt, batch) {
	const sec = parseAt(rawAt);
	if (sec != null) {
		for (const c of batch) {
			if (sec >= Math.max(0, c.start - 15) && sec <= c.end + 15) return sec;
		}
		// Относительный таймкод внутри короткого батча (0..30 с)
		if (sec <= 30 && batch.length === 1) return batch[0].start + Math.min(sec, batch[0].end - batch[0].start);
	}
	return batch[0]?.start ?? 0;
}

/** Убрать хвостовую цену («Тема, 300» → «Тема»), если модель всё же дописала её. */
function cleanThemeName(raw) {
	return String(raw || '').trim().replace(/\s*[,，]\s*\d{2,5}\s*$/, '').trim();
}

/**
 * Собрать marks (ники игроков) для пака на YouTube-записи.
 * В отличие от Tesseract на десятках кадров, Gemini сразу возвращает чистый список
 * ников игроков (players), и батчей всего 3–6 на всё видео. Поэтому берём слова,
 * встретившиеся в батчах отрезка пака (или во всех SIGame-батчах, если пак один),
 * очищенные от слов тем самого пака.
 */
function youtubeMarksOf(playerBatches, pack, themeWords, singlePack) {
	let own = playerBatches.filter(b => b.words.size && b.t >= pack.from - 600 && b.t <= pack.to + 600);
	if (!own.length && singlePack) own = playerBatches.filter(b => b.words.size);
	if (!own.length) return '';

	const count = new Map();
	for (const b of own) {
		for (const w of b.words) {
			if (themeWords.has(w)) continue;
			count.set(w, (count.get(w) || 0) + 1);
		}
	}
	return [...count]
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
		.slice(0, 40)
		.map(([w]) => w)
		.join(' ');
}

/**
 * Просканировать одно YouTube-видео.
 *
 * @param {object} video метаданные из api.js
 * @param {{ index, gemini, log }} ctx
 */
export async function scanYoutubeVideo(video, ctx) {
	const batches = planSlices(video);
	const frames = [];
	const playerBatches = [];
	let calls = 0;
	let tokensIn = 0;
	let signs = 0;
	let succeeded = 0;
	let failed = 0;
	let lastError = null;
	let usedModel = ctx.gemini.activeModel();

	for (let i = 0; i < batches.length; i++) {
		const batch = batches[i];
		try {
			const res = await ctx.gemini.analyzeClips(video.id, batch);
			calls++;
			tokensIn += res.tokensIn;
			usedModel = res.model;
			succeeded++;

			if (res.is_sigame) signs++;

			// Темы → как строки табло («Название 100 200 300 400 500»), чтобы
			// включались строгие правила match.js без шума свободного поиска.
			// Группируем по таймкоду, чтобы collectHits честно считал first/last.
			const byTime = new Map();
			for (const th of res.themes) {
				const clean = cleanThemeName(th.name);
				if (!clean) continue;
				const t = resolveTime(th.at, batch);
				let list = byTime.get(t);
				if (!list) byTime.set(t, list = []);
				list.push({ text: `${clean} 100 200 300 400 500` });
			}
			for (const pn of res.pack_names) {
				const t = batch[0]?.start ?? 0;
				let list = byTime.get(t);
				if (!list) byTime.set(t, list = []);
				list.push({ text: pn });
			}

			for (const [t, rawLines] of byTime) {
				const analyzed = analyzeFrame(rawLines, ctx.index);
				frames.push({ t, matches: analyzed.matches, names: analyzed.names });
			}

			if (res.players.length) {
				const words = frameWords(res.players.map(p => ({ text: p })));
				const mid = batch[0]?.start ?? 0;
				playerBatches.push({ t: mid, words });
			}

			// Ранний выход на шуме: батчи #0 (~8%, ~45%) и #1 (~25%, ~75%) оба без SIGame
			if (i === 1 && succeeded >= 2 && signs === 0) {
				ctx.log?.(`  ранний выход на шуме (2 батча, is_sigame=false)`);
				break;
			}
		} catch (err) {
			if (err instanceof VideoAccessError) {
				return {
					status: 'restricted',
					calls,
					tokensIn,
					signs,
					planKey: planKey(usedModel),
					error: err.message,
					packs: [],
					near: [],
					names: [],
					inside: [],
				};
			}
			if (err instanceof BadSliceError) {
				failed++;
				lastError = err.message;
				continue;
			}
			// QuotaExhaustedError / KeyBlockedError летят выше в run.js
			if (err.name === 'QuotaExhaustedError' || err.name === 'KeyBlockedError') {
				throw err;
			}
			failed++;
			lastError = err.message;
		}
	}

	const hits = collectHits(frames);
	const names = collectNames(frames);
	const verdict = judge(hits, ctx.index, names);

	// Контроль полноты скана: если >= 50% батчей провалилось и пак не найден — повторим завтра
	if (failed * 2 >= batches.length && verdict.packs.length === 0) {
		return {
			status: 'error',
			calls,
			tokensIn,
			signs,
			planKey: planKey(usedModel),
			error: lastError || `провалилось ${failed} из ${batches.length} батчей`,
			packs: [],
			near: verdict.near,
			names: verdict.names,
			inside: verdict.inside,
			hits,
		};
	}

	const singlePack = verdict.packs.length === 1;
	for (const p of verdict.packs) {
		p.marks = youtubeMarksOf(playerBatches, p, themeWordsOf(ctx.index, p.key), singlePack);
	}

	return {
		status: 'done',
		calls,
		tokensIn,
		signs,
		planKey: planKey(usedModel),
		packs: verdict.packs,
		near: verdict.near,
		names: verdict.names,
		inside: verdict.inside,
		hits,
		errors: failed,
		lastError,
	};
}
