// Словарь библиотеки для сверки кадров: все названия тем живых паков,
// чьи они и насколько редкие.
//
// Строится из домашней базы (на раннере — приехавшей с полки) за пару секунд
// и живёт в памяти, пока идёт обход. 10–11 тыс. паков дают ~240 тыс. названий,
// ~117 тыс. разных после скелета (twitch-streams.md, 3.4).

import { DatabaseSync } from 'node:sqlite';
import { normalizeRounds, packKey } from '../keys.js';
import { allowedDist, lev, skel, trigrams } from './text.js';

// Триграмма, которая есть у тысяч тем («по », « на»), кандидатов не отбирает,
// а время ест: такие при поиске пропускаются.
const POSTING_CAP = 4000;

/**
 * Опознающая тема: встречается не больше чем у трёх паков с разными
 * названиями и достаточно длинная. «Аниме», «Музыка», «Игры» пак не выдают:
 * самые частые названия есть у тысячи паков.
 */
const MAX_GROUPS = 3;

export function buildIndex(dbPath) {
	const started = Date.now();
	const db = new DatabaseSync(dbPath, { readOnly: true });
	const rows = db.prepare("SELECT id, name, copy_of, match_key, rounds FROM packages WHERE status = 'ok'").all();
	db.close();

	const themes = [];
	const byKey = new Map();
	const packs = new Map(); // ключ пака → { key, id, name, themes }
	const names = new Map(); // скелет названия → { skel, packs: Set → [], groups: Set → число }

	for (const row of rows) {
		const key = packKey(row);
		const group = row.match_key || `#${row.id}`;
		const own = new Set();
		for (const round of normalizeRounds(row.rounds)) {
			for (const theme of round.themes) {
				const k = skel(theme.name);
				if (k.length < 2 || own.has(k)) continue;
				own.add(k);
				let th = byKey.get(k);
				if (!th) {
					th = { id: themes.length, skel: k, name: theme.name.trim(), packs: new Set(), groups: new Set() };
					byKey.set(k, th);
					themes.push(th);
				}
				th.packs.add(key);
				th.groups.add(group);
			}
		}
		const pack = packs.get(key);
		if (pack) pack.themes = Math.max(pack.themes, own.size);
		else packs.set(key, { key, id: row.id, name: row.name, themes: own.size });

		const nk = skel(row.name);
		if (nk.length >= 2) {
			let n = names.get(nk);
			if (!n) names.set(nk, n = { skel: nk, packs: new Set(), groups: new Set() });
			n.packs.add(key);
			n.groups.add(group);
		}
	}

	for (const th of themes) {
		const words = th.skel.split(' ');
		th.L = th.skel.length;
		th.nWords = words.length;
		th.allowed = allowedDist(th.L);
		th.distinctive = th.groups.size <= MAX_GROUPS && th.L >= 7 && (th.nWords >= 2 || th.L >= 10);
		// Искать в любом месте кадра — только длинные редкие: короткие
		// по кускам строк совпадают с чем попало (3.5 плана)
		th.free = th.distinctive && th.L >= 20 && th.nWords >= 3;
		th.prefix = null;
		if (th.free && th.L >= 40) {
			// Длинное название SIGame обрезает «…» — ищем ещё и по началу
			let acc = '';
			for (const w of words) { acc = acc ? `${acc} ${w}` : w; if (acc.length >= th.L * 0.7) break; }
			th.prefix = acc;
		}
		th.packs = [...th.packs];
		th.groups = th.groups.size;
	}

	// Триграммы → номера тем
	const lists = new Map();
	for (const th of themes) {
		th.grams = [...trigrams(th.skel)];
		for (const g of th.grams) {
			let a = lists.get(g);
			if (!a) lists.set(g, a = []);
			a.push(th.id);
		}
	}
	const postings = new Map();
	for (const [g, a] of lists) postings.set(g, Int32Array.from(a));
	// Сколько у темы «рабочих» триграмм — от этого считается доля при свободном поиске
	// и свои списки только для тем свободного поиска: по ним отбираются
	// кандидаты на весь текст кадра, и общие списки тут были бы в сотни раз длиннее
	const freeLists = new Map();
	for (const th of themes) {
		const rare = th.grams.filter(g => postings.get(g).length <= POSTING_CAP);
		th.rare = rare.length;
		if (th.free) {
			for (const g of rare) {
				let a = freeLists.get(g);
				if (!a) freeLists.set(g, a = []);
				a.push(th.id);
			}
		}
		delete th.grams;
	}
	const freePostings = new Map();
	for (const [g, a] of freeLists) freePostings.set(g, Int32Array.from(a));

	// Название пака на экране начала игры (twitch-streams.md, 5.3) — признак,
	// только если оно редкое: «Музыка», «Пакет», «Мультики» есть у десятков
	// паков и в чате встречаются сами по себе. Нечётко — внутри корзины
	// по первым трём буквам: OCR на крупном заголовке ошибается редко
	const nameKeys = new Map(), nameBuckets = new Map();
	for (const n of names.values()) {
		const words = n.skel.split(' ');
		n.packs = [...n.packs];
		n.groups = n.groups.size;
		n.L = n.skel.length;
		if (n.groups > MAX_NAME_GROUPS || n.L < 8 || (words.length < 2 && n.L < 10)) continue;
		// Короткому — не больше одной ошибки: «анимешки» в чате при допуске 2
		// становились паком «Анимешкисы»
		n.allowed = n.L <= 12 ? Math.min(1, allowedDist(n.L)) : allowedDist(n.L);
		nameKeys.set(n.skel, n);
		const b = n.skel.slice(0, 3);
		if (!nameBuckets.has(b)) nameBuckets.set(b, []);
		nameBuckets.get(b).push(n);
	}

	return {
		themes, byKey, packs, postings, freePostings,
		names: nameKeys,
		lookupName: s => lookupName(s, nameKeys, nameBuckets),
		ms: Date.now() - started,
		lookup: memoLookup(themes, byKey, postings),
	};
}

/** Название пака — опознающее, если оно не больше чем у двух разных паков. */
const MAX_NAME_GROUPS = 2;

function lookupName(s, keys, buckets) {
	if (s.length < 8) return null;
	const exact = keys.get(s);
	if (exact) return { name: exact, d: 0 };
	let best = null;
	for (const n of buckets.get(s.slice(0, 3)) || []) {
		if (!n.allowed || Math.abs(n.L - s.length) > n.allowed) continue;
		const d = lev(s, n.skel, n.allowed);
		if (d <= n.allowed && (!best || d < best.d)) best = { name: n, d };
	}
	return best;
}

/**
 * Ближайшая тема к строке: точное совпадение скелета или Левенштейн
 * в пределах допуска темы среди 40 лучших по триграммам. Перебирать все
 * 117 тыс. тем на каждую строку нельзя — recheck.mjs так шёл десять минут.
 *
 * Ответы запоминаются: одни и те же строки (чат, интерфейс, табло) повторяются
 * из кадра в кадр.
 */
function memoLookup(themes, byKey, postings) {
	const memo = new Map();
	return function lookup(s) {
		if (memo.has(s)) return memo.get(s);
		let best = byKey.has(s) ? { th: byKey.get(s), d: 0 } : null;
		const tol = allowedDist(s.length) + 1; // допуск темы может быть на знак шире
		if (!best && s.length >= 7) {
			const count = new Map();
			for (const g of trigrams(s)) {
				const a = postings.get(g);
				if (!a || a.length > POSTING_CAP) continue;
				for (const i of a) count.set(i, (count.get(i) || 0) + 1);
			}
			const cand = [...count.entries()].sort((x, y) => y[1] - x[1]).slice(0, 40);
			for (const [i] of cand) {
				const th = themes[i];
				if (!th.allowed || Math.abs(th.L - s.length) > th.allowed) continue;
				const max = Math.min(th.allowed, tol);
				const d = lev(s, th.skel, max);
				// lev отвечает max + 1, не досчитывая, — это «дальше допуска», а не расстояние
				if (d <= max &&(!best || d < best.d || (d === best.d && th.L > best.th.L))) best = { th, d };
			}
		}
		if (memo.size > 200000) memo.clear();
		memo.set(s, best);
		return best;
	};
}

export { POSTING_CAP };
