// Какие темы библиотеки видны на одном кадре.
//
// Сопоставление v3 из TwitchFinder (plan.md, 6.3 и 0.8), переложенное
// со словаря в три сотни тем на всю библиотеку (twitch-streams.md, 5.1):
//
//   - кандидаты только со структурой: заголовок «Тема, цена», строка табло
//     (тема и цены), ячейка табло из строк друг под другом, строка без чисел;
//     сравнивается «хвост» кандидата — название стоит в конце строки, а перед
//     ним бывает мусор на месте эмодзи;
//   - нечёткое сравнение через триграммы (index.lookup), а не перебором;
//   - свободный поиск по всему тексту кадра — только длинные редкие темы;
//   - побеждает лучшее совпадение: два совпадения на одних словах кадра
//     не живут вместе.
//
// Что из найденного считать паком, решает src/twitch/verdict.js.

import { allowedDist, findApprox, hasLetters, lev, norm, preText, skelOf, trigrams } from './text.js';

// Фразы интерфейса SIGame (SIOnline, localization.ts, ru). Вырезаются
// из строк до сравнения: «Для ответа на вопрос…», «следующий вопрос» давали
// ложную тему «Вопрос» на трёх десятках кадров каждой записи.
const STOP_PHRASES = [
	'для ответа на вопрос', 'нажимайте на кнопку', 'после загорания рамки', 'следующий вопрос',
	'комментарии к вопросу', 'правильный ответ', 'правильные ответы', 'неправильный ответ',
	'неправильные ответы', 'темы раунда', 'игра окончена', 'вопрос со ставкой', 'вопрос с секретом',
	'вопрос для всех', 'вопрос для себя', 'ответ игрока', 'без ставки', 'передать ход', 'снять вопрос',
	'время на ответ', 'напишите ответ', 'введите ответ', 'верен ли ответ', 'пакет вопросов',
	'источники вопроса', 'авторы вопроса', 'жалоба на вопрос', 'выбор вопроса',
	// экран сведений об игре
	'автор игры владимир хиль',
].map(s => skelOf(norm(s)).split(' '));

// Одиночные слова интерфейса — вырезаются, только когда строка из них и состоит
const STOP_WORDS = new Set(['вопрос', 'ответ', 'пас', 'раунд', 'финал', 'тема', 'ставка', 'дальше']);

const MAX_TAIL = 12;

/**
 * Левая граница привязанного совпадения: соседа нет, или в нём нет букв,
 * или это один знак (мусор от эмодзи: «Ф», «Ш», «J»), или до трёх знаков
 * с цифрой («1.»). Иначе «на вопрос» становилось темой «Вопрос».
 */
function leftOk(tok) {
	if (!tok) return true;
	const w = tok.raw;
	return !hasLetters(w) || w.length === 1 || (w.length <= 3 && /\d/.test(w));
}

/**
 * Тема из 2–3 слов при равном числе слов: каждое слово отличается
 * не больше чем на свой допуск. Иначе весь допуск уходил на одно слово:
 * «аниме по отрывку» засчитывалось как «Аниме по отзыву».
 */
function wordsOk(seen, th) {
	if (th.nWords < 2 || th.nWords > 3) return true;
	const a = seen.split(' '), b = th.skel.split(' ');
	if (a.length !== b.length) return true;
	for (let i = 0; i < b.length; i++) {
		if (!hasLetters(b[i])) continue;
		const allow = Math.max(1, allowedDist(b[i].length));
		if (lev(a[i], b[i], allow) > allow) return false;
	}
	return true;
}

/**
 * @param {Array<{text:string, bbox?:{x0,y0,x1,y1}}>} rawLines строки OCR
 * @param {ReturnType<import('./index.js').buildIndex>} index
 * @returns {{matches: Array<{th, d, kind, seen}>, names: Array<{name, d, seen}>, sign: boolean, struct: boolean, iface: boolean}}
 */
export function analyzeFrame(rawLines, index) {
	const lines = [];
	let seq = 0, struct = false, iface = false;

	for (const ln of rawLines) {
		const pre = preText(ln.text).replace(/\s+/g, ' ').trim();
		if (!pre) continue;
		const words = norm(pre).split(' ').filter(Boolean);
		if (!words.length) continue;
		const toks = words.map(w => ({ w: skelOf(w), raw: w, id: seq++, cut: false }));

		for (const ph of STOP_PHRASES) {
			for (let i = 0; i + ph.length <= toks.length; i++) {
				let ok = true;
				for (let k = 0; k < ph.length; k++) if (toks[i + k].w !== ph[k]) { ok = false; break; }
				if (ok) { for (let k = 0; k < ph.length; k++) toks[i + k].cut = true; iface = true; }
			}
		}
		const meaningful = toks.filter(t => !t.cut && hasLetters(t.raw) && t.raw.length > 1);
		if (meaningful.length === 1 && STOP_WORDS.has(meaningful[0].w)) { meaningful[0].cut = true; iface = true; }

		let kind = null, head = null;
		const hm = pre.match(/^(.*?\S)\s*[,，]\s*(\d{2,5})\b/);
		const bm = hm ? null : pre.match(/^(.*?\S)\s+(\d{2,5})((?:\s+\d{2,5}){1,})/);
		if (hm) {
			kind = 'header'; head = hm[1];
			if (+hm[2] % 10 === 0 && hasLetters(hm[1])) struct = true;
		} else if (bm) {
			kind = 'board'; head = bm[1];
			const prices = [bm[2], ...bm[3].trim().split(/\s+/)].map(Number);
			if (prices.every(p => p % 10 === 0) && hasLetters(bm[1])) struct = true;
		} else if (!/\d{2}/.test(pre)) {
			kind = 'plain';
		}
		let cand = null;
		if (kind) {
			const k = head == null ? toks.length : norm(head).split(' ').filter(Boolean).length;
			cand = { kind, toks: toks.slice(0, k) };
		}
		lines.push({ toks, cand, bbox: ln.bbox || null });
	}

	// Кандидаты — куски между вырезанными фразами
	const cands = [];
	const pushSegments = (kind, toks) => {
		let seg = [];
		for (const t of toks) {
			if (t.cut) { if (seg.length) cands.push({ kind, toks: seg }); seg = []; }
			else seg.push(t);
		}
		if (seg.length) cands.push({ kind, toks: seg });
	};
	for (const l of lines) if (l.cand) pushSegments(l.cand.kind, l.cand.toks);

	// Ячейка табло: длинное название переносится на 2–3 строки. Строки
	// друг под другом, одного кегля и перекрытые по горизонтали — одна ячейка
	const boxed = lines.filter(l => l.cand && l.bbox && l.cand.toks.length);
	const below = new Map();
	for (const a of boxed) {
		if (a.cand.kind !== 'plain') continue;
		const ha = a.bbox.y1 - a.bbox.y0, wa = a.bbox.x1 - a.bbox.x0;
		let best = null, bestGap = Infinity;
		for (const b of boxed) {
			if (b === a) continue;
			const hb = b.bbox.y1 - b.bbox.y0, wb = b.bbox.x1 - b.bbox.x0;
			const hMax = Math.max(ha, hb);
			if (Math.min(ha, hb) / hMax < 0.6) continue;
			const gap = b.bbox.y0 - a.bbox.y1;
			if (gap < -0.3 * hMax || gap > 0.9 * hMax) continue;
			const ov = Math.min(a.bbox.x1, b.bbox.x1) - Math.max(a.bbox.x0, b.bbox.x0);
			if (ov < 0.3 * Math.min(wa, wb)) continue;
			if (gap < bestGap) { bestGap = gap; best = b; }
		}
		if (best) below.set(a, best);
	}
	// Название пака: строка целиком (без фраз интерфейса и слова «пакет»
	// впереди) или две-три строки ячейки — длинное название переносится
	const nameCands = [];
	const nameOf = toks => {
		let ws = toks.filter(t => !t.cut && t.w).map(t => t.w);
		if (ws[0] === 'пакет' || ws[0] === 'пак') ws = ws.slice(1);
		const s = ws.join(' ');
		if (s.length >= 8 && s.length <= 120) nameCands.push({ s, seen: toks.map(t => t.raw).join(' ') });
	};
	for (const l of lines) nameOf(l.toks);
	for (const a of below.keys()) {
		nameOf([...a.toks, ...below.get(a).toks]);
		const chain = [a];
		let cur = a;
		while (chain.length < 3 && below.has(cur)) {
			cur = below.get(cur);
			if (chain.includes(cur)) break;
			chain.push(cur);
			pushSegments('cell', chain.flatMap(l => l.cand.toks));
		}
	}

	// Привязанное сравнение: хвост кандидата из k слов
	const found = [];
	for (const c of cands) {
		const T = c.toks.length;
		let s = '';
		for (let k = 1; k <= Math.min(T, MAX_TAIL); k++) {
			s = k === 1 ? c.toks[T - 1].w : `${c.toks[T - k].w} ${s}`;
			if (s.length < 4) continue;
			if (s.length > 160) break;
			const hit = index.lookup(s);
			if (!hit || Math.abs(hit.th.nWords - k) > 1) continue;
			if (!leftOk(c.toks[T - k - 1])) continue;
			if (hit.d && !wordsOk(s, hit.th)) continue;
			const win = c.toks.slice(T - k);
			found.push({ th: hit.th, d: hit.d, len: hit.th.L, kind: c.kind, ids: win.map(t => t.id), seen: win.map(t => t.raw).join(' ') });
		}
	}

	// Свободный поиск по всему тексту кадра — длинные редкие темы. Кандидаты
	// отбираются долей своих триграмм, нашедшихся в кадре
	const docToks = lines.flatMap(l => l.toks);
	if (docToks.length && index.freePostings.size) {
		let text = '';
		const charTok = [];
		docToks.forEach((t, i) => {
			if (i) { text += ' '; charTok.push(-1); }
			// Вырезанная фраза интерфейса — заглушкой: иначе свободный поиск
			// находил в ней тему «Автор игры - Владимир Хиль»
			const w = t.cut ? '#' : t.w;
			text += w;
			for (let k = 0; k < w.length; k++) charTok.push(t.cut ? -1 : i);
		});
		const count = new Map();
		for (const g of trigrams(text)) {
			const a = index.freePostings.get(g);
			if (a) for (const i of a) count.set(i, (count.get(i) || 0) + 1);
		}
		const anchored = new Set(found.map(f => f.th.id));
		for (const [i, n] of count) {
			const th = index.themes[i];
			if (anchored.has(i) || th.rare < 5) continue;
			const share = n / th.rare;
			let hit = null, kind = 'free', len = th.L;
			if (share >= 0.7) {
				hit = findApprox(th.skel, text, th.allowed);
				if (hit && hit.d && !wordsOk(text.slice(hit.s, hit.e).trim(), th)) hit = null;
			}
			// По началу — строже: с допуском целой темы начало длинного названия
			// находилось в строке правил канала (d = 9 на 60 знаков)
			if (!hit && th.prefix && share >= 0.55) {
				hit = findApprox(th.prefix, text, Math.floor(0.08 * th.prefix.length));
				kind = 'prefix'; len = th.prefix.length;
			}
			if (!hit) continue;
			const ids = new Set();
			for (let j = hit.s; j < hit.e; j++) if (charTok[j] >= 0) ids.add(charTok[j]);
			if (!ids.size) continue;
			const toks = [...ids].map(k => docToks[k]);
			found.push({ th, d: hit.d, len, kind, ids: toks.map(t => t.id), seen: toks.map(t => t.raw).join(' ') });
		}
	}

	// Побеждает лучшее совпадение: на одних словах кадра остаётся более
	// точное (меньше d/L), при равенстве — более длинное
	found.sort((a, b) => (a.d / a.len) - (b.d / b.len) || b.len - a.len);
	const usedTok = new Set(), usedTheme = new Set(), matches = [];
	for (const f of found) {
		if (usedTheme.has(f.th.id)) continue;
		if (f.ids.some(id => usedTok.has(id))) continue;
		f.ids.forEach(id => usedTok.add(id));
		usedTheme.add(f.th.id);
		matches.push({ th: f.th, d: f.d, kind: f.kind, seen: f.seen.slice(0, 120) });
	}
	// Признак «на кадре SIGame». Не «нашлась хоть какая-то тема»: со всей
	// библиотекой тема находится почти в любой строке чата
	const sign = struct || iface || matches.some(m => m.th.distinctive);

	const names = [], seenName = new Set();
	for (const c of nameCands) {
		const hit = index.lookupName?.(c.s);
		if (!hit || seenName.has(hit.name.skel)) continue;
		seenName.add(hit.name.skel);
		names.push({ name: hit.name, d: hit.d, seen: c.seen.slice(0, 120) });
	}
	return { matches, names, sign, struct, iface };
}
