// Где внутри записи искать SIGame и какие кадры снимать.
//
// Общий с Worker (cf/src/twitch-live.js тянет отсюда SIGAME_TITLE_RE и isSvoyakShow):
// ничего Node-специфичного (node:fs и т. д.) сюда тащить нельзя.
//
// Из TwitchFinder (plan.md, 6.6, 0.6, 0.9) с одним упрощением: OCR на раннере
// дешёвый (0,33 с на кадр, twitch-streams.md 3.6), поэтому внутри окон SIGame
// сразу берётся шаг 2 мин, без грубой сетки и уточнения.
//
//   chapters — у записи есть главы SIGame: смотрим их, края растягиваем,
//              пока на крайнем кадре видна игра (категорию включают позже,
//              чем начали играть, и выключают раньше, чем закончили);
//   whole    — глав нет, а категория записи SIGame: смотрим всю;
//   probe    — SIGame только в названии записи: редкая сетка по всей записи
//              и шаг 2 мин вокруг кадров, где видна игра;
//
// Поверх любого режима — густое начало игры (twitch-streams.md, 5.3): где
// сетка впервые увидела игру после кадра без неё, там игра только что
// началась. SIGame перед игрой показывает название пака и прокручивает
// темы раунда — это видно секунды, и шаг 2 мин такое не ловит. Поэтому
// вокруг каждого такого места кадры раз в 15 с.
//
//   null     — не смотрим: главы есть, а SIGame среди них нет (кусок
//              марафона, Codenames под чужой категорией — plan.md TF, 6.2.1).

/** Версия плана и сверки: другая — запись смотрится заново. */
export const PLAN_VERSION = 'v3';

export const STEP = 120;
export const COARSE = 600;
/** На сколько растягивается край главы за раз. */
export const STRETCH = 600;
/** Потолок кадров на запись — на случай двухсуточного марафона «весь в SIGame». */
export const MAX_FRAMES = 900;
const PAD = 120;

/** Густое начало игры: шаг, сколько до первого кадра с игрой и после. */
export const OPENING_STEP = 15;
const OPENING_BEFORE = STEP + OPENING_STEP;
const OPENING_AFTER = 45;
/** Не больше стольких начал на запись: марафон из десяти паков — не повод для тысячи кадров. */
const MAX_OPENINGS = 4;

/**
 * Кадры густого начала.
 *
 * @param {Array<[number, boolean]>} shots [время, видна ли игра] — уже снятые
 */
export function openings(shots) {
	const sorted = [...shots].sort((a, b) => a[0] - b[0]);
	const starts = [];
	for (let i = 0; i < sorted.length && starts.length < MAX_OPENINGS; i++) {
		const [t, sign] = sorted[i];
		if (!sign) continue;
		const prev = sorted[i - 1];
		if (prev && prev[1] && t - prev[0] <= 2 * STEP) continue;
		starts.push(t);
	}
	const out = [];
	for (const s of starts) {
		for (let t = s - OPENING_BEFORE; t < s + OPENING_AFTER; t += OPENING_STEP) out.push(t);
	}
	return out;
}

export const isSigame = name => /^si\s*game$/i.test(String(name || '').trim());

// Стримеры не всегда ставят категорию, а название обычно выдаёт игру
export const SIGAME_TITLE_RE = /\bsi\s*-?\s*game|(?:си)?си\s*-?\s*(?:г[еэ]йм|гам[еа])|сиш(?:еч)?к[ауеиой]|[сc]воя[\s/._-]*игра|[сc]вою[\s/._-]*игру|(?:по|в)\s+[сc]воей\s+игр|[сc]воя\s+большая\s+игра|[сc]вояк(?:а|у|ом|е|и)?|[сc]вояч[ое]?к/i;

// Просмотры YouTube-шоу «Свояк», инди-разработка («делаю свою игру»),
// испанский спам по «sigame» и кастомные лобби других игр:
// не тратить кадры probe, если категория не SIGame
export const SVOYAK_SHOW_RE = /(?<![а-яё])(?:смотрим|смотрю|смотр[иеэ]м|реакт|реакция|разбор)(?![а-яё]).*свояк|(?<![а-яё])свояк(?![а-яё]).*(?:смотр[иеэю]|реакт|ковал[ьяею]|сатир|малащенко|шоу)/i;
const GAMEDEV_TITLE_RE = /(?<![а-яё])(?:с?дела[юел]\S*|созда[юёл]\S*|разрабатыва\S*|пиш[уе]\S*|выпусти\S*|выпуска\S*|тестиру\S*|показыва\S*|делаем)\s+свою\s+игру|свою\s+игру.*(?:steam|стим|roblox|роблокс|геймджем|game\s*jam)/i;
const SPANISH_SIGAME_RE = /\bsigame\s+(?:en|a|por|titok|tiktok)\b|\b(?:porfa|hola|gente)\b.*\bsigame\b/i;
const CUSTOM_LOBBY_RE = /\b(?:5\s*[/xхвv]\s*5|ability\s+draft|renodx|dlss)\b/i;
const STRICT_SIGAME_NAME_RE = /\bsi\s*-?\s*game|(?:си)?си\s*-?\s*(?:г[еэ]йм|гам[еа])|сиш(?:еч)?к[ауеиой]/i;
const STRICT_SIGAME_RE = /\bsi\s*-?\s*game|(?:си)?си\s*-?\s*(?:г[еэ]йм|гам[еа])|сиш(?:еч)?к[ауеиой]|[сc]вояк(?:а|у|ом|е|и)?|[сc]вояч[ое]?к/i;

export function isSvoyakShow(video) {
	if (isSigame(video?.game)) return false;
	const title = video?.title || '';
	if (SVOYAK_SHOW_RE.test(title) || GAMEDEV_TITLE_RE.test(title) || SPANISH_SIGAME_RE.test(title)) return true;
	if (CUSTOM_LOBBY_RE.test(title) && !STRICT_SIGAME_NAME_RE.test(title)) return true;
	if (/^software and game development$/i.test(String(video?.game || '').trim()) && !STRICT_SIGAME_RE.test(title)) return true;
	return false;
}

/** Слить пересекающиеся отрезки. */
export function merge(ranges) {
	return ranges
		.filter(([a, b]) => b > a)
		.sort((x, y) => x[0] - y[0])
		.reduce((acc, r) => {
			const last = acc.at(-1);
			if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
			else acc.push([...r]);
			return acc;
		}, []);
}

/**
 * @returns {{mode: 'chapters'|'whole'|'probe', windows: Array<[number, number]>}|{mode: null, reason: string}}
 */
export function windowsOf(video) {
	const len = video.length;
	const chapters = video.chapters || [];
	const sig = chapters.filter(c => isSigame(c.game));
	if (sig.length) {
		return { mode: 'chapters', windows: merge(sig.map(c => [Math.max(0, c.from - PAD), Math.min(len, c.from + c.len + PAD)])) };
	}
	if (video.liveWindows?.length) {
		const live = merge(video.liveWindows.map(([a, b]) => [Math.max(0, a), Math.min(len, b)]));
		if (live.length) return { mode: 'chapters', windows: live };
	}
	const titled = SIGAME_TITLE_RE.test(video.title) && !isSvoyakShow(video);
	if (chapters.length) {
		return (titled || isSigame(video.game))
			? { mode: 'probe', windows: [[0, len]] }
			: { mode: null, reason: 'главы есть, SIGame среди них нет' };
	}
	if (isSigame(video.game)) return { mode: 'whole', windows: [[0, len]] };
	if (titled) return { mode: 'probe', windows: [[0, len]] };
	return { mode: null, reason: 'ни категории, ни главы, ни названия SIGame' };
}

/** Кадры сеткой с шагом step внутри окон. */
export function grid(windows, step) {
	const out = [];
	for (const [a, b] of windows) {
		for (let t = a + Math.min(30, (b - a) / 2); t < b; t += step) out.push(Math.round(t));
	}
	return out;
}

/** Что записать в plan_key: чем смотрели. */
export function planKey(mode, variant) {
	return [PLAN_VERSION, mode, STEP, mode === 'probe' ? COARSE : 0, OPENING_STEP, variant].join('/');
}
