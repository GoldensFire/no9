// Один стол или разные: две записи одного пака — это совместная трансляция
// (одна игра) или два стола, сыгравшие пак каждый сам по себе.
//
// Решение пользователя (13.11.2026): одной игрой считается только совместная
// трансляция. Twitch на записи о ней ничего не говорит — у Video таких полей
// нет, — поэтому судим по кадрам:
//
//   marks — слова, что держались на экране всю игру этого пака, кроме слов
//     его тем: ники игроков на табло, ведущий, подписи оверлея. Держались —
//     значит, видны хотя бы на четверти кадров отрезка пака;
//   один стол — пак шёл у двух каналов в одно и то же время, и
//     (а) ник одного канала виден на экране у другого: в SIGame стример
//         обычно сидит под своим ником, и сосед по столу видит его на табло
//         (так на mint__ow 30.10 держались rafchasgrande и saundwewe);
//     (б) или общих редких слов экрана не меньше трёх — ники тех, кто сидит
//         не под именем канала. Редких — то есть не тех, что держатся
//         у многих каналов разом («ответить», «сообщение», «донат»: чат,
//         оверлеи, интерфейс).
//
// Сверяет обход (src/twitch/store.js, linkGames) и кладёт итог в колонку
// game: у строк одной игры она одна. Worker только группирует по ней
// (cf/src/library/streams.js).

import { allowedDist, hasLetters, lev, norm, skelOf } from './text.js';

/** Сколько слов хранить у пака на записи. */
const MAX_MARKS = 40;

/** Доля кадров отрезка, на которой слово должно быть видно. */
const SHARE = 0.25;

/** Сколько общих редких слов делают стол общим без ника канала. */
export const SHARED_MARKS = 3;

/** Слово экрана держится у стольких каналов — значит, оно не про стол. */
export const COMMON_CHANNELS = 4;

/** Запас на сдвиг: начало пака на записи известно с точностью до шага кадров. */
export const OVERLAP_SLACK_S = 10 * 60;

// Слова интерфейса SIGame и чата, которые держатся у всех и ничего про стол
// не говорят. Остальное такое отсекает частота по каналам (COMMON_CHANNELS).
const STOP = new Set([
	'вопрос', 'вопросы', 'ответ', 'ответа', 'ответить', 'игра', 'игры', 'игрок', 'игроки', 'ведущий',
	'раунд', 'тема', 'темы', 'ставка', 'пас', 'финал', 'сообщение', 'сообщения', 'чат', 'закрыть',
	'экран', 'меню', 'пауза', 'зрители', 'участники', 'назовите', 'выбирайте', 'подключился',
	'донат', 'гив', 'топ', 'рек', 'тут', 'после', 'назвать', 'стрим', 'twitch',
].map(w => skelOf(norm(w))));

/** Слова кадра: буквенные, от трёх знаков, скелетом (src/twitch/text.js). */
export function frameWords(lines) {
	const out = new Set();
	for (const line of lines) {
		for (const w of norm(line.text).split(' ')) {
			if (w.length >= 3 && w.length <= 24 && hasLetters(w)) out.add(skelOf(w));
		}
	}
	return out;
}

/**
 * Что держалось на экране, пока шёл пак.
 *
 * @param {Array<{t:number, words?:Set<string>}>} frames кадры записи
 * @param {{from:number, to:number}} pack отрезок пака
 * @param {Set<string>} themeWords слова тем самого пака — их не берём:
 *   у двух столов с одним паком они общие по определению
 * @returns {string} слова через пробел
 */
export function marksOf(frames, pack, themeWords) {
	const own = frames.filter(f => f.words && f.t >= pack.from && f.t <= pack.to);
	if (own.length < 3) return '';
	const count = new Map();
	for (const f of own) {
		for (const w of f.words) {
			if (STOP.has(w) || themeWords.has(w)) continue;
			count.set(w, (count.get(w) || 0) + 1);
		}
	}
	const need = Math.max(3, Math.ceil(own.length * SHARE));
	return [...count]
		.filter(([, n]) => n >= need)
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
		.slice(0, MAX_MARKS)
		.map(([w]) => w)
		.join(' ');
}

/** Слова тем пака — скелетом. */
export function themeWordsOf(index, key) {
	const out = new Set();
	for (const th of index.themes) {
		if (!th.packs.includes(key)) continue;
		for (const w of th.skel.split(' ')) out.add(w);
	}
	return out;
}

/**
 * Ник канала виден среди слов экрана (с допуском на ошибку OCR). Ник
 * с подчёркиваниями («mint__ow») распадается на экране на слова, как и всё
 * остальное, — поэтому видны должны быть все его куски от четырёх знаков.
 */
function loginSeen(login, words) {
	const parts = skelOf(norm(login)).split(' ').filter(p => p.length >= 4);
	if (!parts.length) return false;
	return parts.every(k => {
		const allow = Math.min(2, allowedDist(k.length));
		return words.some(w => Math.abs(w.length - k.length) <= allow && (w === k || lev(w, k, allow) <= allow));
	});
}

/**
 * Две строки pack_streams одного пака — один стол?
 *
 * @param {{channel, played_at, t_from, t_to, marks}} a
 * @param {{channel, played_at, t_from, t_to, marks}} b
 * @param {Set<string>} common слова, что держатся у многих каналов
 */
export function sameTable(a, b, common) {
	if (a.channel === b.channel) return false;
	const aEnd = a.played_at + (a.t_to - a.t_from) * 1000;
	const bEnd = b.played_at + (b.t_to - b.t_from) * 1000;
	if (Math.min(aEnd, bEnd) + OVERLAP_SLACK_S * 1000 < Math.max(a.played_at, b.played_at)) return false;

	const wa = String(a.marks || '').split(' ').filter(Boolean);
	const wb = String(b.marks || '').split(' ').filter(Boolean);
	if (!wa.length && !wb.length) return false;
	if (loginSeen(b.channel, wa) || loginSeen(a.channel, wb)) return true;

	const set = new Set(wa.filter(w => !common.has(w)));
	let shared = 0;
	for (const w of wb) if (set.has(w) && ++shared >= SHARED_MARKS) return true;
	return false;
}

/**
 * Слова, что держатся у многих каналов разом: по marks всех строк.
 *
 * @param {Array<{channel, marks}>} rows
 */
export function commonWords(rows) {
	const by = new Map();
	for (const r of rows) {
		for (const w of String(r.marks || '').split(' ')) {
			if (!w) continue;
			let s = by.get(w);
			if (!s) by.set(w, s = new Set());
			s.add(r.channel);
		}
	}
	return new Set([...by].filter(([, s]) => s.size >= COMMON_CHANNELS).map(([w]) => w));
}
