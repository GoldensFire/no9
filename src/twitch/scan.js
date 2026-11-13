// Одна запись целиком: план кадров → кадры → OCR → темы → паки.
//
// Кэш OCR (необязательный) — чтобы крутить сверку без Twitch: записи
// живут неделю, а пороги подгоняются неделями. Формат:
//   { "<номер записи>": { video: {...}, frames: { "<t>": { at, raw } } } }
// где raw — tsv Tesseract или простой текст (старый ocr.json).

import fs from 'node:fs';
import path from 'node:path';
import { grabFrame } from './frames.js';
import { analyzeFrame } from './match.js';
import { frameWords, marksOf, themeWordsOf } from './marks.js';
import { linesOf } from './ocr.js';
import { COARSE, grid, MAX_FRAMES, merge, openings, planKey, STEP, STRETCH, windowsOf } from './plan.js';
import { openMedia, SubOnly } from './twitch.js';
import { collectHits, collectNames, judge } from './verdict.js';

const DOWNLOADS = 6;

/**
 * @param {ReturnType<import('../twitch/twitch.js').videoOf>} video
 * @param {{index, recognize, tmp: string, cache?: object, replay?: boolean, log?: Function}} ctx
 */
export async function scanVod(video, ctx) {
	const started = Date.now();
	const log = ctx.log || (() => {});
	const plan = ctx.replay ? { mode: 'replay', windows: [] } : windowsOf(video);
	if (!plan.mode) return { status: 'skip', reason: plan.reason };

	const cached = ctx.cache?.[video.id]?.frames || {};
	let media = null;
	if (!ctx.replay) {
		try {
			media = await openMedia(video.id);
		} catch (e) {
			if (e instanceof SubOnly) return { status: 'subonly', error: e.message, ms: Date.now() - started };
			return { status: 'error', error: e.message, ms: Date.now() - started };
		}
	}

	const frames = new Map(); // t → { t (время кадра), matches, names, sign }
	let errors = 0, lastError = '';

	async function shoot(times) {
		const todo = [...new Set(times.map(Math.round))].filter(t => !frames.has(t) && t >= 0 && (!media || t < media.length));
		let i = 0;
		const worker = async () => {
			while (i < todo.length) {
				const t = todo[i++];
				let at = t, raw = cached[t]?.raw;
				if (raw != null) at = cached[t].at ?? t;
				else if (ctx.replay) continue;
				else {
					const png = path.join(ctx.tmp, `${video.id}_${t}.png`);
					try {
						const f = await grabFrame(media, t, png);
						at = f.at;
						raw = await ctx.recognize(png);
					} catch (e) {
						errors++;
						lastError = e.message;
						continue;
					} finally {
						fs.rmSync(png, { force: true });
					}
					if (ctx.cache) ((ctx.cache[video.id] ||= { video, frames: {} }).frames[t] = { at, raw });
				}
				const lines = linesOf(raw);
				const an = analyzeFrame(lines, ctx.index);
				// words — для marks: что держалось на экране (src/twitch/marks.js)
				frames.set(t, { t: at, matches: an.matches, names: an.names, sign: an.sign, words: frameWords(lines) });
			}
		};
		await Promise.all(Array.from({ length: Math.min(DOWNLOADS + 2, todo.length) }, worker));
	}

	let windows = plan.windows;
	if (ctx.replay) {
		await shoot(Object.keys(cached).map(Number));
	} else {
		// Потолок кадров: шире шаг, а не обрезанная запись
		const span = windows.reduce((a, [x, y]) => a + y - x, 0);
		const base = plan.mode === 'probe' ? COARSE : STEP;
		const step = Math.max(base, Math.ceil(span / MAX_FRAMES / 60) * 60);
		await shoot(grid(windows, step));

		if (plan.mode === 'chapters') {
			// Края глав: пока на крайнем кадре видна игра — ещё STRETCH дальше
			for (let round = 0; round < 12; round++) {
				const more = [];
				windows = windows.map(([a, b], wi) => {
					const lo = wi ? windows[wi - 1][1] : 0, hi = wi < windows.length - 1 ? windows[wi + 1][0] : media.length;
					const own = [...frames.keys()].filter(t => t >= a && t <= b).sort((x, y) => x - y);
					if (!own.length) return [a, b];
					let na = a, nb = b;
					if (frames.get(own[0]).sign && a - lo > STEP) {
						na = Math.max(lo, a - STRETCH);
						more.push(...grid([[na, a]], step));
					}
					if (frames.get(own.at(-1)).sign && hi - b > STEP) {
						nb = Math.min(hi, b + STRETCH);
						more.push(...grid([[b, nb]], step));
					}
					return [na, nb];
				});
				windows = merge(windows);
				if (!more.length) break;
				await shoot(more);
			}
		} else if (plan.mode === 'probe') {
			// Редкая сетка нашла игру — вокруг такого кадра шаг 2 мин
			const near = [];
			for (const [t, f] of frames) {
				if (!f.sign) continue;
				for (let k = STEP; k < COARSE; k += STEP) near.push(t - k, t + k);
			}
			await shoot(near);
		}

		// Густое начало каждой игры: экран с названием пака и прокрутка тем
		await shoot(openings([...frames].map(([t, f]) => [t, f.sign])));
	}

	const shot = [...frames.values()].sort((a, b) => a.t - b.t);
	const tried = shot.length + errors;
	if (!ctx.replay && tried >= 8 && errors > tried / 2) {
		return { status: 'error', error: `${errors} из ${tried} кадров не вышло: ${lastError}`, frames: shot.length, ms: Date.now() - started };
	}

	const hits = collectHits(shot);
	const { packs, near, names, inside } = judge(hits, ctx.index, collectNames(shot));
	// Что держалось на экране, пока шёл пак: по этому обход потом решает,
	// одна это игра с другой записью того же пака или нет (src/twitch/marks.js)
	for (const p of packs) p.marks = marksOf(shot, p, themeWordsOf(ctx.index, p.key));
	log(`  ${video.id}: ${shot.length} кадров${errors ? `, ошибок ${errors}` : ''}, тем ${hits.size}, паков ${packs.length}`);
	return {
		status: 'done',
		mode: plan.mode,
		windows,
		frames: shot.length,
		errors,
		lastError,
		signs: shot.filter(f => f.sign).length,
		planKey: planKey(plan.mode, media?.variant || 'cache'),
		hits,
		packs,
		near,
		names,
		inside,
		ms: Date.now() - started,
	};
}
