// Как строка кадра и название темы приводятся к одному виду и как они
// сравниваются нечётко.
//
// Перенесено из TwitchFinder (Desktop/TwitchFinder, plan.md, разделы 10.5
// и 6.3) без изменений по сути: нормализация там проверена на всех названиях
// тем, а допуск и поиск — на трёх сотнях записей.
//
// Применяется одинаково к темам библиотеки (src/twitch/index.js) и к тексту
// OCR (src/twitch/match.js): разойдись они хоть в одной букве, точное
// совпадение перестало бы быть точным.

const KEYCAP = /[0-9#*]️?⃣/gu;
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}︎️‍⃣\u{E0020}-\u{E007F}]/gu;

/** Без эмодзи, NFKC, нижний регистр, ё → е. Знаки препинания ещё на месте. */
export function preText(s) {
	return String(s ?? '').replace(KEYCAP, ' ').replace(EMOJI, ' ').normalize('NFKC').toLowerCase().replace(/ё/g, 'е');
}

/** Только буквы и цифры, слова через один пробел. */
export function norm(s) {
	return preText(s).replace(/[^0-9a-zа-я]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Латиница, похожая на кириллицу, и цифры 0/3 → кириллица. OCR путает их
// постоянно («Ha вопрос», «3везды»), а стримеры пишут темы вперемешку.
const SKELETON = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у', u: 'и', n: 'п', r: 'г', 3: 'з', 0: 'о' };

/** «Скелет» уже нормализованной строки. */
export function skelOf(normalized) {
	return normalized.replace(/[abcehkmoptxyunr30]/g, ch => SKELETON[ch]);
}

export const skel = s => skelOf(norm(s));

export const hasLetters = w => /[a-zа-я]/.test(w);

/**
 * Допуск по Левенштейну от длины скелета. Короткие — только точно:
 * при допуске 1 на шесть знаков «вопросы» становились темой «Вопрос».
 */
export function allowedDist(L) {
	return L <= 6 ? 0 : L <= 9 ? 1 : L <= 15 ? 2 : Math.floor(0.15 * L);
}

let rowA = new Uint16Array(256), rowB = new Uint16Array(256);

/** Расстояние Левенштейна; больше max — возвращает max + 1, не досчитывая. */
export function lev(a, b, max) {
	const n = a.length, m = b.length;
	if (Math.abs(n - m) > max) return max + 1;
	if (m + 1 > rowA.length) { rowA = new Uint16Array(m + 64); rowB = new Uint16Array(m + 64); }
	let prev = rowA, cur = rowB;
	for (let j = 0; j <= m; j++) prev[j] = j;
	for (let i = 1; i <= n; i++) {
		cur[0] = i;
		let rowMin = i;
		const ca = a.charCodeAt(i - 1);
		for (let j = 1; j <= m; j++) {
			const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1));
			cur[j] = v;
			if (v < rowMin) rowMin = v;
		}
		if (rowMin > max) return max + 1;
		const t = prev; prev = cur; cur = t;
	}
	return prev[m];
}

/**
 * Лучшее нечёткое вхождение pat в text (Селлерс с отсечением Укконена).
 * Начало и конец не на границе слова стоят по +1 — так «фильм имени…»
 * не цепляется к хвосту «…медиа имени…».
 *
 * @returns {{d:number, s:number, e:number}|null} e — не включительно
 */
export function findApprox(pat, text, max) {
	const m = pat.length, n = text.length;
	if (!m || !n) return null;
	const BIG = 1 << 20;
	let col = new Int32Array(m + 1), src = new Int32Array(m + 1);
	let ncol = new Int32Array(m + 1), nsrc = new Int32Array(m + 1);
	for (let i = 0; i <= m; i++) { col[i] = i; src[i] = 0; }
	let lact = Math.min(m, max + 1);
	let best = null;
	for (let j = 1; j <= n; j++) {
		const cj = text.charCodeAt(j - 1);
		// Пустой образец, кончающийся на j, — вхождение, начатое с j-го знака:
		// бесплатно, только если там начинается слово
		ncol[0] = text.charCodeAt(j - 1) === 32 ? 0 : 1;
		nsrc[0] = j;
		const top = Math.min(m, lact + 1);
		for (let i = 1; i <= top; i++) {
			let v = col[i - 1] + (pat.charCodeAt(i - 1) === cj ? 0 : 1), s = src[i - 1];
			const up = ncol[i - 1] + 1;
			if (up < v) { v = up; s = nsrc[i - 1]; }
			if (i <= lact) {
				const left = col[i] + 1;
				if (left < v) { v = left; s = src[i]; }
			}
			ncol[i] = v; nsrc[i] = s;
		}
		for (let i = top + 1; i <= m; i++) ncol[i] = BIG;
		lact = top;
		while (lact > 0 && ncol[lact] > max) lact--;
		if (top === m) {
			const total = ncol[m] + (j === n || text.charCodeAt(j) === 32 ? 0 : 1);
			if (total <= max && (!best || total < best.d)) best = { d: total, s: nsrc[m], e: j };
		}
		let t = col; col = ncol; ncol = t;
		t = src; src = nsrc; nsrc = t;
	}
	return best;
}

/** Триграммы строки с пробелом по краям. */
export function trigrams(s) {
	const out = new Set();
	const p = ` ${s} `;
	for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
	return out;
}
