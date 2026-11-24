// Отсев шума на YouTube ДО траты Gemini-запросов и расписание срезов видео.
//
// По итогам живых замеров (youtube-gemini-plan.md, 1.2 и 3.3):
//   - единица вызова — батч из 2 срезов по 12 с при fps=0.25 (~1 050 токенов);
//   - сетка перемежается так, чтобы батч #0 сразу смотрел ~8% и ~45%,
//     а батч #1 — ~25% и ~75% ролика (ранний выход на шуме за 2 запроса);
//   - если в описании есть главы с упоминанием SIGame/пака, добавляем точку
//     +30 с после начала главы;
//   - каждый срез строго ограничен сверху (duration - 5 с), чтобы не ловить 400.

import { isSvoyakShow, SIGAME_TITLE_RE } from '../twitch/plan.js';

export const PLAN_VERSION = 'yt-v1';

/** Минимальная длина ролика (15 мин): отсекает шортсы, нарезки, гайды и песню Sigame. */
export const MIN_LENGTH_S = 900;

/** Длина одного среза, частота кадров и размер батча. */
export const CLIP_LEN_S = 12;
export const CLIP_FPS = 0.25;
export const BATCH_SIZE = 2;

// YouTube-специфичный шум: телешоу НТВ, STALKER «Народная Солянка», гайды по созданию паков.
const NTV_TITLE_RE = /\bнтв\b|\bntv\b|\bвыпуск\s+от\b|\bэфир\s+от\b|своя\s+игра\s+от\s+\d|\bновый\s+выпуск\b|телепередача|кулешов|игровой\s+стол\s+нтв/i;
const BLOCKED_CHANNEL_RE = /^(?:нтв|ntv|канал\s+коваля|своя\s+игра\s+нтв|своя\s+игра\s*[-—|]\s*нтв)$/i;
const STALKER_RE = /народная\s+солянка|\bs\.?t\.?a\.?l\.?k\.?e\.?r\.?\b|сталкер.*солянк/i;
const GUIDE_TITLE_RE = /как\s+(?:создать|сделать|написать|собрать|скачать)\s+(?:свой\s+)?пак|гайд.*(?:sigame|сигейм|си\s*гейм)|(?:sigame|сигейм|си\s*гейм).*гайд|how\s+to\s+(?:create|make).*sigame|siquester|siq\s*editor|туториал.*(?:sigame|пак)/i;
const CHAPTER_SIGAME_RE = /\bsi\s*-?\s*game|си\s*-?\s*г[еэ]йм|сигаме|сишечк|своя\s+игра|свою\s+игру|свояк|пак\b/i;

/**
 * Проверить, надо ли отбросить ролик ещё до обращения к Gemini.
 *
 * @param {{ title, channelTitle, length, isLive }} video
 * @param {{ requireTitleMatch?: boolean }} [opts]
 * @returns {{ skip: boolean, reason?: string }}
 */
export function shouldSkipVideo(video, { requireTitleMatch = true } = {}) {
	if (!video) return { skip: true, reason: 'нет данных видео' };
	if (video.isLive) return { skip: true, reason: 'прямой эфир / анонс' };
	if (!video.length || video.length < MIN_LENGTH_S) return { skip: true, reason: 'короче 15 мин' };

	const title = String(video.title || '');
	const ch = String(video.channelTitle || '').trim();

	if (BLOCKED_CHANNEL_RE.test(ch)) return { skip: true, reason: 'стоп-канал (НТВ / шоу)' };
	if (NTV_TITLE_RE.test(title)) return { skip: true, reason: 'телепередача НТВ' };
	if (STALKER_RE.test(title)) return { skip: true, reason: 'STALKER Солянка' };
	if (GUIDE_TITLE_RE.test(title)) return { skip: true, reason: 'гайд / туториал' };
	if (isSvoyakShow({ title, game: '' })) return { skip: true, reason: 'шоу / геймдев / спам' };

	if (requireTitleMatch && !SIGAME_TITLE_RE.test(title)) {
		return { skip: true, reason: 'в названии нет SIGame' };
	}

	return { skip: false };
}

/**
 * Извлечь из описания ролика таймкоды глав, где упоминается SIGame / пак.
 * Возвращает точки +30 с после начала главы (секунды).
 */
export function parseChapterTimestamps(description, duration) {
	if (!description || !duration) return [];
	const out = [];
	const maxStart = Math.max(0, duration - CLIP_LEN_S - 5);

	for (const line of String(description).split(/\r?\n/)) {
		const m = /(?:^|\s)(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\s|$|[-–—)])/.exec(line);
		if (!m) continue;
		if (!CHAPTER_SIGAME_RE.test(line)) continue;
		const sec = Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
		const target = Math.min(maxStart, Math.max(10, sec + 30));
		if (target < maxStart) out.push(target);
	}
	return out;
}

/**
 * Расписание батчей срезов по длине ролика:
 *   15–55 мин   → 3 батча (6 окон)
 *   55–120 мин  → 4 батча (8 окон)
 *   120–210 мин → 5 батчей (10 окон)
 *   > 210 мин   → 6 батчей (12 окон)
 *
 * Первые 4 точки всегда идут в порядке [~8%, ~45%, ~25%, ~75%], чтобы
 * батчи #0 и #1 накрывали весь ролик целиком и давали чистый ранний выход
 * на не-SIGame видео.
 *
 * @param {{ length: number, description?: string }} video
 * @returns {Array<Array<{ start: number, end: number, fps: number }>>}
 */
export function planSlices(video) {
	const duration = Math.max(CLIP_LEN_S + 10, Math.floor(video.length || 0));
	const maxStart = Math.max(0, duration - CLIP_LEN_S - 5);
	const mins = duration / 60;

	let count;
	if (mins < 55) count = 6;
	else if (mins < 120) count = 8;
	else if (mins < 210) count = 10;
	else count = 12;

	// Доли таймлайна в порядке приоритета (сначала ~8% и ~45%, затем ~25% и ~75%, потом заполнение)
	const presets = {
		6: [0.08, 0.45, 0.25, 0.75, 0.60, 0.90],
		8: [0.08, 0.45, 0.25, 0.75, 0.16, 0.58, 0.35, 0.88],
		10: [0.08, 0.45, 0.25, 0.75, 0.16, 0.58, 0.35, 0.88, 0.66, 0.94],
		12: [0.08, 0.45, 0.25, 0.75, 0.15, 0.55, 0.33, 0.85, 0.21, 0.65, 0.40, 0.93],
	};

	const starts = (presets[count] || presets[8]).map(f => Math.min(maxStart, Math.max(10, Math.round(duration * f))));

	// Дополняем явными SIGame-главами из описания (до +2 точек, без дублей в пределах 90 с)
	const chapters = parseChapterTimestamps(video.description, duration);
	let added = 0;
	for (const t of chapters) {
		if (added >= 2) break;
		if (starts.some(s => Math.abs(s - t) < 90)) continue;
		// Ставим главу ближе к началу, но после первичной разведки
		starts.splice(Math.min(2 + added, starts.length), 0, t);
		added++;
	}

	const clips = starts.map(start => ({
		start,
		end: Math.min(duration - 2, start + CLIP_LEN_S),
		fps: CLIP_FPS,
	}));

	const batches = [];
	for (let i = 0; i < clips.length; i += BATCH_SIZE) {
		batches.push(clips.slice(i, i + BATCH_SIZE));
	}
	return batches;
}

export function planKey(model) {
	return `${PLAN_VERSION}/${model || 'gemini'}`;
}
