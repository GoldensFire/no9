// Отсев шума на YouTube ДО траты Gemini-запросов и расписание срезов видео.
//
// По итогам живых замеров (youtube-gemini-plan.md, 1.1–1.2 и аудит запуска 45564727007):
//   - единица вызова — батч из 3 срезов по 12 с при fps=0.25 (~1 850 токенов):
//     на треть экономнее по суточному лимиту RPD (500/модель), который и есть реальный потолок;
//   - сетка перемежается так, чтобы батч #0 сразу смотрел ~10%, ~50% и ~86%
//     (ловит «сначала другая игра, потом SIGame» в конце записи), а батч #1 — ~28%, ~68%, ~94%
//     (ранний выход на шуме за 2 запроса);
//   - если в описании есть главы с упоминанием SIGame/пака, подставляем точку
//     +30 с после начала главы вместо хвостовых точек сетки (не плодя лишний батч);
//   - каждый срез строго ограничен сверху (duration - 5 с), чтобы не ловить 400.

import { isSvoyakShow, SIGAME_TITLE_RE } from '../twitch/plan.js';

export const PLAN_VERSION = 'yt-v3';

/** Минимальная длина ролика (15 мин): отсекает шортсы, нарезки, гайды и песню Sigame. */
export const MIN_LENGTH_S = 900;

/** Длина одного среза, частота кадров и размер батча. */
export const CLIP_LEN_S = 12;
export const CLIP_FPS = 0.25;
export const BATCH_SIZE = 3;

// YouTube-специфичный шум: телешоу НТВ, студийное «Шоу не своя игра», PUBG «только своя игра»,
// STALKER «Народная Солянка», гайды по созданию паков.
// В JS \b работает только для ASCII — для кириллицы используем явные границы (?<![а-яёa-z0-9]).
const NTV_TITLE_RE = /(?<![а-яёa-z0-9])нтв(?![а-яёa-z0-9])|\bntv\b|(?<![а-яё])(?:выпуск|эфир)\s+от(?![а-яё])|своя\s+игра\s+от\s+\d|(?<![а-яё])новый\s+выпуск(?![а-яё])|телепередача|кулешов|игровой\s+стол\s+нтв/i;
const STUDIO_SHOW_RE = /шоу\s+не\s+своя\s+игра/i;
const PUBG_SOLO_RE = /\bpubg(?:m|mobile\w*)?\b|пабг\s*мобайл/i;
const STRICT_SIGAME_RE = /\bsi\s*-?\s*game|си\s*-?\s*г[еэ]йм|сигаме/i;
const BLOCKED_CHANNEL_RE = /^(?:нтв|ntv|канал\s+коваля|своя\s+игра\s+нтв|своя\s+игра\s*[-—|]\s*нтв)$/i;
const STALKER_RE = /народная\s+солянка|\bs\.?t\.?a\.?l\.?k\.?e\.?r\.?\b|сталкер.*солянк/i;
const GUIDE_TITLE_RE = /как\s+(?:создать|сделать|написать|собрать|скачать)\s+(?:свой\s+)?пак|гайд.*(?:sigame|сигейм|си\s*гейм)|(?:sigame|сигейм|си\s*гейм).*гайд|how\s+to\s+(?:create|make).*sigame|siquester|siq\s*editor|туториал.*(?:sigame|пак)/i;
const CHAPTER_SIGAME_RE = /\bsi\s*-?\s*game|си\s*-?\s*г[еэ]йм|сигаме|сишечк|своя\s+игра|свою\s+игру|свояк|(?<![а-яё])пак(?![а-яё])/i;

function checkTitleAndChannel(title, channelTitle, requireTitleMatch) {
	const t = String(title || '');
	const ch = String(channelTitle || '').trim();

	if (ch && BLOCKED_CHANNEL_RE.test(ch)) return { skip: true, reason: 'стоп-канал (НТВ / шоу)' };
	if (NTV_TITLE_RE.test(t)) return { skip: true, reason: 'телепередача НТВ' };
	if (STUDIO_SHOW_RE.test(t)) return { skip: true, reason: 'студийное шоу' };
	if (PUBG_SOLO_RE.test(t) && !STRICT_SIGAME_RE.test(t)) return { skip: true, reason: 'PUBG / не SIGame' };
	if (STALKER_RE.test(t)) return { skip: true, reason: 'STALKER Солянка' };
	if (GUIDE_TITLE_RE.test(t)) return { skip: true, reason: 'гайд / туториал' };
	if (isSvoyakShow({ title: t, game: '' })) return { skip: true, reason: 'шоу / геймдев / спам' };

	if (requireTitleMatch && !SIGAME_TITLE_RE.test(t)) {
		return { skip: true, reason: 'в названии нет SIGame' };
	}
	return { skip: false };
}

/**
 * Предварительный отсев ДО videosById (по превью из search.list / playlistItems.list / InnerTube):
 * если длина ещё неизвестна (0 в Data API v3), по длине не отсеиваем — это проверит shouldSkipVideo.
 *
 * @param {{ title?: string, channelTitle?: string, length?: number, isLive?: boolean }} preview
 * @param {{ requireTitleMatch?: boolean }} [opts]
 */
export function shouldSkipPreview(preview, { requireTitleMatch = true } = {}) {
	if (!preview) return { skip: false };
	if (preview.isLive) return { skip: true, reason: 'прямой эфир / анонс' };
	if (preview.length > 0 && preview.length < MIN_LENGTH_S) return { skip: true, reason: 'короче 15 мин' };
	if (!preview.title) return { skip: false };
	return checkTitleAndChannel(preview.title, preview.channelTitle, requireTitleMatch);
}

/**
 * Проверить, надо ли отбросить ролик ещё до обращения к Gemini / локальному OCR.
 *
 * @param {{ title, channelTitle, length, isLive }} video
 * @param {{ requireTitleMatch?: boolean }} [opts]
 * @returns {{ skip: boolean, reason?: string }}
 */
export function shouldSkipVideo(video, { requireTitleMatch = true } = {}) {
	if (!video) return { skip: true, reason: 'нет данных видео' };
	if (video.isLive) return { skip: true, reason: 'прямой эфир / анонс' };
	if (!video.length || video.length < MIN_LENGTH_S) return { skip: true, reason: 'короче 15 мин' };
	return checkTitleAndChannel(video.title, video.channelTitle, requireTitleMatch);
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
 * Расписание батчей срезов по длине ролика (по 3 среза в батче):
 *   15–55 мин   → 2 батча (6 окон)
 *   55–130 мин  → 3 батча (9 окон)
 *   130–260 мин → 4 батча (12 окон)
 *   > 260 мин   → 5 батчей (15 окон)
 *
 * Первые 6 точек всегда идут в порядке [10%, 50%, 86%] и [28%, 68%, 94%],
 * чтобы батч #0 сразу накрывал начало, середину и хвост ролика (включая
 * «сначала другая игра, потом SIGame»), а батч #1 закрывал промежутки и давал
 * чистый ранний выход на не-SIGame видео за 2 запроса.
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
	else if (mins < 130) count = 9;
	else if (mins < 260) count = 12;
	else count = 15;

	const presets = {
		6: [0.10, 0.50, 0.86, 0.28, 0.68, 0.94],
		9: [0.10, 0.50, 0.86, 0.28, 0.68, 0.94, 0.19, 0.40, 0.77],
		12: [0.10, 0.50, 0.86, 0.28, 0.68, 0.94, 0.19, 0.40, 0.77, 0.04, 0.59, 0.91],
		15: [0.10, 0.50, 0.86, 0.28, 0.68, 0.94, 0.19, 0.40, 0.77, 0.04, 0.59, 0.91, 0.34, 0.46, 0.82],
	};

	const starts = (presets[count] || presets[9]).map(f => Math.min(maxStart, Math.max(10, Math.round(duration * f))));

	// Дополняем явными SIGame-главами из описания (до +2 точек, без дублей в пределах 90 с):
	// вставляем во второй батч и вытесняем хвостовые filler-точки, чтобы не плодить лишний RPD-батч.
	const chapters = parseChapterTimestamps(video.description, duration);
	let added = 0;
	for (const t of chapters) {
		if (added >= 2) break;
		if (starts.some(s => Math.abs(s - t) < 90)) continue;
		if (starts.length >= 9) starts.pop();
		starts.splice(Math.min(3 + added, starts.length), 0, t);
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

/**
 * Дополнительные срезы для уточнения near-кандидатов (2 опознающие темы)
 * или разреженных участков видео, где основная сетка попала на экраны вопросов.
 *
 * @param {{ length: number }} video
 * @param {number[]} anchors опорные точки (секунды)
 * @param {Array<{ start: number }>} existingClips уже просмотренные срезы
 * @param {{ maxClips?: number, offsets?: number[], minGap?: number }} [opts]
 * @returns {Array<Array<{ start: number, end: number, fps: number }>>}
 */
export function planDrillDown(video, anchors, existingClips, {
	maxClips = 3,
	offsets = [-240, 240, -480, 480, -120, 120],
	minGap = 60,
} = {}) {
	const duration = Math.max(CLIP_LEN_S + 10, Math.floor(video.length || 0));
	const maxStart = Math.max(0, duration - CLIP_LEN_S - 5);
	const used = existingClips.map(c => c.start);
	const picked = [];

	// Перебираем сдвиги слоями по всем опорным точкам, чтобы при 2 near-паках каждый получил по паре срезов
	for (const off of offsets) {
		for (const anchor of anchors) {
			if (picked.length >= maxClips) break;
			const t = Math.min(maxStart, Math.max(10, Math.round(anchor + off)));
			if (used.some(u => Math.abs(u - t) < minGap)) continue;
			used.push(t);
			picked.push(t);
		}
		if (picked.length >= maxClips) break;
	}

	const clips = picked.map(start => ({
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
