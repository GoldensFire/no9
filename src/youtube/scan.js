// Адаптивный скан одного YouTube-ролика через Gemini Video API + существующий
// матчер FirePacks (src/twitch/match.js, verdict.js, marks.js).

import { frameWords, themeWordsOf } from '../twitch/marks.js';
import { analyzeFrame } from '../twitch/match.js';
import { collectHits, collectNames, judge } from '../twitch/verdict.js';
import { BadSliceError, VideoAccessError } from './gemini.js';
import { planDrillDown, planKey, planSlices } from './plan.js';

/** Разобрать таймкод вида «MM:SS» или «HH:MM:SS» в секунды (или null). */
function parseAt(raw) {
	const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
	if (!m) return null;
	return {
		sec: Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]),
		twoPart: !m[1],
	};
}

/**
 * Привязать таймкод, названный Gemini, к реальному времени видео.
 * Используем номер фрагмента (clip: 1, 2, ...), а если его нет или он не задан —
 * проверяем прямое попадание в срез, HH:MM (когда модель опустила секунды: «01:22» → 82 мин)
 * и относительный сдвиг внутри среза (0..30 с).
 */
function resolveTime(rawAt, batch, clipIdx = null) {
	const primary = Number.isInteger(clipIdx) && clipIdx >= 1 && clipIdx <= batch.length
		? batch[clipIdx - 1]
		: null;
	const parsed = parseAt(rawAt);
	const candidates = primary ? [primary, ...batch.filter(c => c !== primary)] : batch;

	if (parsed) {
		const { sec, twoPart } = parsed;
		for (const c of candidates) {
			if (sec >= Math.max(0, c.start - 20) && sec <= c.end + 20) return sec;
		}
		// Модель иногда пишет HH:MM вместо HH:MM:SS («00:32» для 32:36, «01:22» для 1:21:58)
		if (twoPart && sec > 0) {
			const asMin = sec * 60;
			for (const c of candidates) {
				if (asMin >= Math.max(0, c.start - 90) && asMin <= c.end + 90) {
					return Math.min(c.end, Math.max(c.start, asMin));
				}
			}
		}
		// Относительный таймкод внутри короткого среза (0..30 с)
		if (sec <= 30 && (primary || batch.length === 1)) {
			const c = primary || batch[0];
			return c.start + Math.min(sec, c.end - c.start);
		}
	}
	return primary?.start ?? batch[0]?.start ?? 0;
}

/** Убрать хвостовую цену («Тема, 300» → «Тема»), если модель всё же дописала её. */
function cleanThemeName(raw) {
	return String(raw || '').trim().replace(/\s*[,，]\s*\d{2,5}\s*$/, '').trim();
}

/**
 * Собрать опорные таймкоды для добора (drill-down) по near-пакам (≥ 2 опознающих тем).
 * Берём середину отрезка найденных тем каждого near-кандидата.
 */
function nearAnchors(nearList, hits) {
	const anchors = [];
	for (const n of nearList) {
		const times = [];
		for (const h of hits.values()) {
			if (!h.th.distinctive || !h.th.packs.includes(n.key)) continue;
			times.push(h.first);
			if (h.last !== h.first) times.push(h.last);
		}
		if (!times.length) continue;
		times.sort((a, b) => a - b);
		const mid = Math.round((times[0] + times[times.length - 1]) / 2);
		anchors.push(mid);
	}
	return anchors;
}

/**
 * Найти центры самых широких непросмотренных промежутков ролика —
 * на случай когда на явном SIGame-ролике срезы попали в экраны вопросов без табло.
 */
function gapAnchors(duration, scannedClips, maxCount = 2) {
	const pts = [0, ...scannedClips.map(c => c.start).sort((a, b) => a - b), duration];
	const gaps = [];
	for (let i = 0; i + 1 < pts.length; i++) {
		const span = pts[i + 1] - pts[i];
		if (span >= 360) gaps.push({ mid: Math.round((pts[i] + pts[i + 1]) / 2), span });
	}
	return gaps.sort((a, b) => b.span - a.span).slice(0, maxCount).map(g => g.mid);
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
	const scannedClips = [];
	const frames = [];
	const playerBatches = [];
	const seenThemeTexts = new Set();
	let calls = 0;
	let tokensIn = 0;
	let signs = 0;
	let succeeded = 0;
	let failed = 0;
	let lastError = null;
	let usedModel = ctx.gemini.activeModel();

	const applyResult = (batch, res) => {
		calls++;
		tokensIn += res.tokensIn;
		usedModel = res.model;
		succeeded++;
		scannedClips.push(...batch);

		if (res.is_sigame) signs++;

		// Темы → как строки табло («Название 100 200 300 400 500»), чтобы
		// включались строгие правила match.js без шума свободного поиска.
		// Запятую перед числом внутри названия (например «Музыка, 2000-е») заменяем
		// пробелом, иначе match.js примет её за заголовок «Тема, цена» и обрежет хвост.
		const byTime = new Map();
		for (const th of res.themes) {
			const clean = cleanThemeName(th.name);
			if (!clean) continue;
			seenThemeTexts.add(clean.toLowerCase());
			const safe = clean.replace(/[,，](?=\s*\d{2,5}\b)/g, ' ');
			const t = resolveTime(th.at, batch, th.clip);
			let list = byTime.get(t);
			if (!list) byTime.set(t, list = []);
			list.push({ text: `${safe} 100 200 300 400 500` });
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
	};

	for (let i = 0; i < batches.length; i++) {
		const batch = batches[i];
		try {
			const res = await ctx.gemini.analyzeClips(video.id, batch);
			applyResult(batch, res);

			// Ранний выход на шуме: батчи #0 (10%, 50%, 86%) и #1 (28%, 68%, 94%) оба без SIGame
			if (i === 1 && batches.length > 2 && succeeded >= 2 && signs === 0) {
				ctx.log?.(`  ранний выход на шуме (2 батча, 6 окон, is_sigame=false)`);
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

	let hits = collectHits(frames);
	let names = collectNames(frames);
	let verdict = judge(hits, ctx.index, names);

	// Адаптивный добор (drill-down, 1–2 доп. батча):
	//   1) если один или два пака набрали ровно 2 опознающие темы (near ×2 — не хватило одной темы
	//      из-за того, что срез попал на экран вопроса, а не на табло) — добираем по 2 среза рядом;
	//   2) иначе, если SIGame подтверждён (signs ≥ 2), но паков нет и тем вычитано мало (< 6),
	//      добираем 1 батч в двух самых широких непросмотренных промежутках ролика.
	if (signs > 0 && failed * 2 < batches.length) {
		const near2 = verdict.near.filter(n => n.themes >= 2).slice(0, 2);
		let extraBatches = [];
		let drillReason = '';

		if (near2.length) {
			const anchors = nearAnchors(near2, hits);
			if (anchors.length) {
				// 3 среза = ровно 1 дополнительный батч при BATCH_SIZE=3 (достаточно для 1–2 near-паков)
				extraBatches = planDrillDown(video, anchors, scannedClips, { maxClips: 3 });
				drillReason = `near ×2 (${near2.map(n => `#${n.pack.id}`).join(', ')})`;
			}
		} else if (verdict.packs.length === 0 && signs >= 2 && seenThemeTexts.size < 6) {
			const anchors = gapAnchors(Math.floor(video.length || 0), scannedClips, 3);
			if (anchors.length) {
				extraBatches = planDrillDown(video, anchors, scannedClips, { maxClips: 3, offsets: [0, -180, 180] });
				drillReason = `мало тем (${seenThemeTexts.size})`;
			}
		}

		if (extraBatches.length) {
			ctx.log?.(`  добор ${extraBatches.length} батч. (${drillReason})`);
			for (const batch of extraBatches) {
				try {
					const res = await ctx.gemini.analyzeClips(video.id, batch);
					applyResult(batch, res);
				} catch (err) {
					if (err.name === 'QuotaExhaustedError' || err.name === 'KeyBlockedError') {
						throw err;
					}
					if (err instanceof VideoAccessError) break;
					// Сбой добора не обнуляет уже пройденную основную сетку
					lastError = err.message;
				}
			}
			hits = collectHits(frames);
			names = collectNames(frames);
			verdict = judge(hits, ctx.index, names);
		}
	}

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
