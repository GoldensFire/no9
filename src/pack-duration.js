// Расчёт длительности пака по content.xml и длительностям медиафайлов,
// а также оценка реального игрового времени партии при настройках SIOnline
// по умолчанию (Classic, 3 игрока, бот-ведущий, фальстарты включены,
// в финале играется 1 вопрос).
//
// Разделение на две величины:
//   1. contentSec (measurePackDurationDetail) — физическая длительность
//      материалов пака (текст, картинки, звук, видео, варианты ответа и показ
//      правильного ответа, с усреднением финала на 1 вопрос) + компактная
//      разбивка breakdown по компонентам и раундам.
//   2. playSec (estimatePlayDuration) — реалистичное время игры в SIOnline
//      поверх contentSec: объявление тем, выбор вопросов, 5-секундная полоска
//      обдумывания после каждого вопроса (если автор не задал свой таймер
//      в ответе), ввод и проверка ответа, спецвопросы и финальный раунд.
//
// Этот файл общий с Cloudflare Worker (cf/src/library/packs.js) и браузером:
// здесь нет и не должно быть node:-импортов и обращений к Buffer.

import { collectTexts, decodeXml, parseAttributes, splitByTag } from './siq.js';

/** Скорость чтения текста вопроса/ответа, знаков в секунду (SIOnline readingSpeed = 20). */
export const CHARS_PER_SEC = 20;

/** Время показа одной статичной картинки или HTML-элемента без явного таймера, с (SIOnline imageTime = 5). */
export const IMAGE_SEC = 5;

/** Фиксированная длительность простого текстового ответа, с (SIOnline timeForRightAnswer = 2). */
export const ANSWER_TEXT_SEC = 2;

/**
 * Стандартная полоска обдумывания/нажатия кнопки после вопроса, с
 * (SIOnline timeForThinkingOnQuestion = 5). Действует на каждом обычном вопросе,
 * если автор не поставил собственный таймер ответа.
 */
export const THINK_BAR_SEC = 5;

/** Длительность показа одной картинки среди вариантов ответа (А/Б/В/Г), с. */
export const OPTION_IMAGE_SEC = 2;

/**
 * Максимальная разумная длительность явного таймера для не-медиа (текст/картинка)
 * и авторского answerDuration, с (верхняя граница в редакторе SIQuester = 120 с).
 */
const NON_MEDIA_DUR_CAP_SEC = 120;

/** Потолок явного атрибута duration для неизмеренного аудио/видео файла, с. */
const UNMEASURED_MEDIA_DUR_CAP_SEC = 300;

/** Стандартное предельное значение поля времени в SIQuester (00:16:39 = 999 с — «не обрезать»). */
const SIQUESTER_MAX_DUR_ATTR = 999;

/** Средние по базе доли попыток и верных ответов — подставляются, когда статистики ещё нет. */
const DEFAULT_TAKE_RATE = 0.59;
const DEFAULT_RIGHT_RATE = 0.59;

const TRUE_SET = new Set(['true', '1', 'yes']);
const MEDIA_TYPES = new Set(['image', 'audio', 'video', 'html']);
const SILENT_TYPES = new Set(['say', 'oral']);

const PARAMS_OPEN = /<params\b[^>]*>/;
const SCENARIO_BLOCK = /<scenario\b[^>]*>([\s\S]*?)<\/scenario>/;
const RIGHT_BLOCK = /<right\b[^>]*>([\s\S]*?)<\/right>/;
const WRONG_BLOCK = /<wrong\b[^>]*>([\s\S]*?)<\/wrong>/;

/** Имя файла без percent-кодировки (локальная копия plainName, чтобы не тянуть src/duration.js в Worker). */
function plainName(name) {
	try {
		return decodeURIComponent(name);
	} catch {
		return name;
	}
}

/** Декодирует UTF-8 из строки или Uint8Array/Buffer без зависимости от глобального Buffer. */
function decodeUtf8(input) {
	if (typeof input === 'string') {
		return input;
	}

	if (input instanceof Uint8Array) {
		return new TextDecoder('utf-8').decode(input);
	}

	return String(input ?? '');
}

/**
 * Разбирает атрибут duration: «5», «5.0», «mm:ss», «hh:mm:ss».
 * @returns {number|null} секунды или null, если атрибут пустой/нечисловой
 */
export function parseDurAttr(raw) {
	if (raw === null || raw === undefined) {
		return null;
	}

	const text = String(raw).trim();

	if (!text) {
		return null;
	}

	if (text.includes(':')) {
		const parts = text.split(':').map(Number);

		if (parts.some(part => !Number.isFinite(part) || part < 0)) {
			return null;
		}

		let seconds = 0;

		for (const part of parts) {
			seconds = seconds * 60 + part;
		}

		return seconds;
	}

	const value = Number(text);

	return Number.isFinite(value) ? value : null;
}

/**
 * Верхнеуровневые <param> внутри <params>…</params> одного вопроса.
 *
 * Считается с глубиной, потому что <param name="answerOptions" type="group">
 * держит внутри вложенные <param> для каждого варианта ответа: обычный
 * нежадный поиск обрезал бы группу на первом же </param> и потерял хвост.
 */
function extractParams(questionBody) {
	const open = PARAMS_OPEN.exec(questionBody);

	if (!open) {
		return [];
	}

	const pattern = /<param\b([^>]*?)(\/?)>|<\/param>|<\/params>/g;
	pattern.lastIndex = open.index + open[0].length;

	const params = [];
	let depth = 0;
	let current = null;
	let match;

	while ((match = pattern.exec(questionBody)) !== null) {
		const token = match[0];

		if (token === '</params>') {
			if (depth === 0) {
				break;
			}

			continue;
		}

		if (token === '</param>') {
			if (depth === 0) {
				continue;
			}

			depth--;

			if (depth === 0 && current) {
				params.push({
					attributes: current.attributes,
					body: questionBody.slice(current.start, match.index),
				});
				current = null;
			}

			continue;
		}

		const selfClosing = match[2] === '/';

		if (depth === 0) {
			const attributes = parseAttributes(match[1]);

			if (selfClosing) {
				params.push({ attributes, body: '' });
			} else {
				current = { attributes, start: pattern.lastIndex };
				depth = 1;
			}
		} else if (!selfClosing) {
			depth++;
		}
	}

	return params;
}

/**
 * Элементы <item> внутри одного <param> формата 5.
 * Поддерживает и парные <item>…</item>, и самозакрывающиеся <item …/>.
 */
function extractItems(paramBody) {
	const pattern = /<item\b([^>]*?)(?:\/>|>([\s\S]*?)<\/item>)/g;
	const items = [];
	let match;

	while ((match = pattern.exec(paramBody)) !== null) {
		const attrs = parseAttributes(match[1]);
		const rawValue = match[2] !== undefined
			? decodeXml(match[2]).replace(/<[^>]*>/g, '').trim()
			: '';
		const rawType = (attrs.type ?? 'text').trim().toLowerCase() || 'text';
		const isSilent = SILENT_TYPES.has(rawType);
		const type = isSilent ? 'text' : (rawType === 'voice' ? 'audio' : rawType);
		const placement = isSilent ? 'replic' : (attrs.placement ?? '').trim().toLowerCase();
		// Нестандартные v5-паки иногда указывают локальный файл ведущей «@» без isRef="True"
		const hasAt = MEDIA_TYPES.has(type) && rawValue.startsWith('@');
		const isRef = TRUE_SET.has((attrs.isRef ?? 'false').trim().toLowerCase()) || hasAt;
		const raw = hasAt ? rawValue.slice(1) : rawValue;
		const waitFalse = (attrs.waitForFinish ?? 'true').trim().toLowerCase() === 'false';
		const durAttr = parseDurAttr(attrs.duration);

		items.push({ type, raw, isRef, placement, waitFalse, durAttr });
	}

	return items;
}

/**
 * Атомы сценария формата 4 (<scenario><atom>) в том же виде, что и элементы v5.
 *
 * Правила совпадают с SIQuester Question.Upgrade() и _scenario_items в SI-HYX:
 *   • первый <atom type="marker"/> делит сценарий на вопрос и ответ,
 *     повторные маркеры пропускаются;
 *   • say/oral — устная реплика ведущего (placement="replic");
 *   • voice — фоновое аудио (type="audio", placement="background");
 *   • time="-1" — одновременный показ со следующим (waitFalse=true);
 *   • time="N" (N > 0) — явная длительность в секундах;
 *   • ведущая «@» означает ссылку на файл внутри архива.
 */
function extractScenarioAtoms(questionBody) {
	const scenario = SCENARIO_BLOCK.exec(questionBody);

	if (!scenario) {
		return { qItems: [], aItems: [] };
	}

	const qItems = [];
	const aItems = [];
	const pattern = /<atom\b([^>]*?)(?:\/>|>([\s\S]*?)<\/atom>)/g;
	let side = 'question';
	let seenMarker = false;
	let match;

	while ((match = pattern.exec(scenario[1])) !== null) {
		const attrs = parseAttributes(match[1]);
		const atype = (attrs.type ?? 'text').trim().toLowerCase() || 'text';

		if (atype === 'marker') {
			if (!seenMarker) {
				seenMarker = true;
				side = 'answer';
			}

			continue;
		}

		const rawValue = match[2] !== undefined
			? decodeXml(match[2]).replace(/<[^>]*>/g, '').trim()
			: '';
		const isRef = rawValue.startsWith('@');
		const raw = isRef ? rawValue.slice(1) : rawValue;
		const parsedTime = Number.parseInt((attrs.time ?? '0').trim(), 10);
		const atomTime = Number.isFinite(parsedTime) ? parsedTime : 0;
		const waitFalse = atomTime === -1;
		const durAttr = atomTime > 0 ? atomTime : null;
		const isSilent = SILENT_TYPES.has(atype);
		const type = isSilent ? 'text' : (atype === 'voice' ? 'audio' : atype);
		const placement = isSilent ? 'replic' : (atype === 'voice' ? 'background' : '');

		const item = { type, raw, isRef, placement, waitFalse, durAttr };

		if (side === 'question') {
			qItems.push(item);
		} else {
			aItems.push(item);
		}
	}

	return { qItems, aItems };
}

/**
 * Ищет точную измеренную длительность медиафайла по имени из content.xml.
 * Возвращает секунды (> 0) или null, если файл не удалось измерить.
 */
function lookupExactMediaSeconds(type, rawName, byFile) {
	if (!byFile || byFile.size === 0 || !rawName) {
		return null;
	}

	const clean = plainName(rawName.replace(/^@/, '')).replace(/\\/g, '/').trim().toLowerCase();

	if (!clean) {
		return null;
	}

	const basename = clean.split('/').pop();
	const folder = type === 'video' ? 'video' : 'audio';

	const hit = byFile.get(clean)
		?? byFile.get(`${folder}/${basename}`)
		?? byFile.get(basename);

	return Number.isFinite(hit) && hit > 0 ? hit : null;
}

/**
 * Длительность одного элемента вопроса или ответа, секунды.
 *
 * В SIOnline аудио и видео никогда не зацикливаются (loop = false, остановка по
 * onMediaEnded): явный duration в XML может только обрезать длинный файл, но не
 * способен растянуть 30-секундный трек на полчаса. Опечатки SIQuester вроде
 * 00:30:00 (вместо 00:00:30) и заглушка 00:16:39 (999 с — «не обрезать») здесь
 * отсекаются и считаются в stats.cappedAttrs.
 */
function itemSeconds(item, byFile, fallbackSec, stats) {
	if (item.placement === 'replic') {
		return 0;
	}

	if (item.isRef && (item.type === 'video' || item.type === 'audio')) {
		const mediaSec = lookupExactMediaSeconds(item.type, item.raw, byFile);

		if (item.durAttr !== null) {
			if (Math.round(item.durAttr) === SIQUESTER_MAX_DUR_ATTR) {
				stats.cappedAttrs++;
				return mediaSec ?? fallbackSec;
			}

			if (mediaSec !== null) {
				if (item.durAttr > mediaSec + 1) {
					stats.cappedAttrs++;
				}

				return Math.max(0, Math.min(item.durAttr, mediaSec));
			}

			if (item.durAttr > UNMEASURED_MEDIA_DUR_CAP_SEC) {
				stats.cappedAttrs++;
				return fallbackSec > 0 ? Math.min(fallbackSec, UNMEASURED_MEDIA_DUR_CAP_SEC) : NON_MEDIA_DUR_CAP_SEC;
			}

			return Math.max(0, item.durAttr);
		}

		return mediaSec ?? fallbackSec;
	}

	let defaultSec = 0;

	if (item.type === 'image' || item.type === 'html') {
		defaultSec = IMAGE_SEC;
	} else if (item.type === 'text') {
		defaultSec = item.raw ? item.raw.length / CHARS_PER_SEC : 0;
	}

	if (item.durAttr !== null) {
		if (Math.round(item.durAttr) === SIQUESTER_MAX_DUR_ATTR) {
			stats.cappedAttrs++;
			return defaultSec;
		}

		const cap = Math.max(defaultSec, NON_MEDIA_DUR_CAP_SEC);

		if (item.durAttr > cap) {
			stats.cappedAttrs++;
			return cap;
		}

		return Math.max(0, item.durAttr);
	}

	return defaultSec;
}

/** К какой корзине breakdown отнести тип элемента. */
function bucketOf(type) {
	if (type === 'audio') {
		return 'audio';
	}

	if (type === 'video') {
		return 'video';
	}

	if (type === 'image' || type === 'html') {
		return 'image';
	}

	return 'text';
}

/**
 * Длительность последовательности элементов с учётом одновременного показа
 * и фонового аудио, плюс разбивка по видам контента (text/image/audio/video)
 * и устным репликам (replicSec).
 */
function contentDurationDetail(items, byFile, fallbackSec, stats) {
	const fg = [];
	const bg = [];
	let replicSec = 0;

	for (const item of items) {
		if (item.placement === 'replic') {
			if (item.raw) {
				replicSec += item.raw.length / CHARS_PER_SEC;
			}

			continue;
		}

		if (item.placement === 'background') {
			bg.push(item);
		} else {
			fg.push(item);
		}
	}

	const groups = [];
	let current = [];

	for (const item of fg) {
		current.push(item);

		if (item.waitFalse) {
			continue;
		}

		groups.push(current);
		current = [];
	}

	if (current.length > 0) {
		groups.push(current);
	}

	let fgTotal = 0;
	const fgBuckets = { text: 0, image: 0, audio: 0, video: 0 };

	for (const group of groups) {
		const media = group.filter(item => MEDIA_TYPES.has(item.type));
		const pool = media.length > 0 ? media : group;
		let longest = 0;
		let winner = null;

		for (const item of pool) {
			const seconds = itemSeconds(item, byFile, fallbackSec, stats);

			if (seconds > longest) {
				longest = seconds;
				winner = item;
			}
		}

		fgTotal += longest;

		if (winner && longest > 0) {
			fgBuckets[bucketOf(winner.type)] += longest;
		}
	}

	let bgTotal = 0;
	const bgBuckets = { text: 0, image: 0, audio: 0, video: 0 };

	for (const item of bg) {
		const seconds = itemSeconds(item, byFile, fallbackSec, stats);
		bgTotal += seconds;

		if (seconds > 0) {
			bgBuckets[bucketOf(item.type)] += seconds;
		}
	}

	if (bgTotal > fgTotal) {
		return { total: bgTotal, buckets: bgBuckets, replicSec };
	}

	return { total: fgTotal, buckets: fgBuckets, replicSec };
}

/**
 * Длительность последовательности элементов с учётом одновременного показа
 * и фонового аудио (публичная обёртка для совместимости).
 */
export function contentDuration(items, byFile, fallbackSec = 0) {
	return contentDurationDetail(items, byFile, fallbackSec, { cappedAttrs: 0 }).total;
}

/** Длительность последовательного вывода вариантов ответа (А/Б/В/Г), секунды. */
function optionsDuration(optionItems, byFile, fallbackSec, stats) {
	let total = 0;

	for (const item of optionItems) {
		if (item.type === 'image' || item.type === 'html') {
			total += OPTION_IMAGE_SEC;
		} else if (item.type === 'text') {
			if (item.raw) {
				total += item.raw.length / CHARS_PER_SEC;
			}
		} else if (item.isRef && (item.type === 'audio' || item.type === 'video')) {
			total += itemSeconds(item, byFile, fallbackSec, stats);
		}
	}

	return total;
}

/** Есть ли у вопроса обычный текстовый правильный ответ (<right><answer>). */
function hasPlainAnswer(questionBody) {
	const right = RIGHT_BLOCK.exec(questionBody);
	const rightTexts = right ? collectTexts(right[1], 'answer') : [];

	if (rightTexts.length > 0) {
		return true;
	}

	const wrong = WRONG_BLOCK.exec(questionBody);
	const wrongTexts = wrong ? collectTexts(wrong[1], 'answer') : [];

	if (wrongTexts.length === 0) {
		return collectTexts(questionBody, 'answer').length > 0;
	}

	return false;
}

/**
 * Разбор одного вопроса: чистый контент вопроса, варианты ответа, показ ответа,
 * устные реплики и наличие авторского таймера ответа.
 *
 * Если автор явно задал таймер ответа (<param name="answerDuration">,
 * <question duration="…"> или <param name="answer" duration="…">), то
 * стандартная 5-секундная полоска обдумывания на этом вопросе не работает —
 * вместо неё действует таймер автора.
 */
function questionDetail(question, byFile, fallbackSec, stats) {
	const params = extractParams(question.body);
	const qItems = [];
	const aItems = [];
	const optionItems = [];
	let anyParamItems = false;
	let answerBlockDur = parseDurAttr(question.attributes.duration);
	let answerDurationParam = null;

	for (const param of params) {
		const pname = (param.attributes.name ?? '').trim();

		if (pname === 'answer' && answerBlockDur === null) {
			answerBlockDur = parseDurAttr(param.attributes.duration);
		}

		if (pname === 'answerDuration') {
			const rawVal = decodeXml(param.body).replace(/<[^>]*>/g, '').trim();
			const parsed = parseDurAttr(rawVal);

			if (parsed !== null) {
				answerDurationParam = parsed;
			}

			continue;
		}

		if (pname === 'answerOptions') {
			optionItems.push(...extractItems(param.body));
			continue;
		}

		if (pname === 'answerType' || pname === 'answerDeviation') {
			continue;
		}

		const items = extractItems(param.body);

		if (items.length > 0) {
			anyParamItems = true;
		}

		if (pname === 'question') {
			qItems.push(...items);
		} else if (pname === 'answer') {
			aItems.push(...items);
		}
	}

	// Формат 4 держит содержимое в <scenario><atom>. Разбираем его, только если
	// из <params> содержимого не набралось (переходный формат отдаёт приоритет params)
	if (!anyParamItems) {
		const scenario = extractScenarioAtoms(question.body);
		qItems.push(...scenario.qItems);
		aItems.push(...scenario.aItems);
	}

	// Отсеиваем заглушку 999 с на уровне блока ответа / answerDuration
	if (answerBlockDur !== null && Math.round(answerBlockDur) === SIQUESTER_MAX_DUR_ATTR) {
		stats.cappedAttrs++;
		answerBlockDur = null;
	}

	let customThinkSec = 0;
	let hasAnswerDuration = false;

	if (answerDurationParam !== null) {
		if (Math.round(answerDurationParam) === SIQUESTER_MAX_DUR_ATTR) {
			stats.cappedAttrs++;
		} else if (answerDurationParam > 0) {
			hasAnswerDuration = true;

			if (answerDurationParam > NON_MEDIA_DUR_CAP_SEC) {
				stats.cappedAttrs++;
				customThinkSec = NON_MEDIA_DUR_CAP_SEC;
			} else {
				customThinkSec = answerDurationParam;
			}
		}
	}

	const qRes = contentDurationDetail(qItems, byFile, fallbackSec, stats);
	const optDur = optionItems.length > 0 ? optionsDuration(optionItems, byFile, fallbackSec, stats) : 0;
	let replicSec = qRes.replicSec;
	let aDur;

	if (answerBlockDur !== null) {
		if (answerBlockDur > NON_MEDIA_DUR_CAP_SEC) {
			stats.cappedAttrs++;
			aDur = NON_MEDIA_DUR_CAP_SEC;
		} else {
			aDur = Math.max(0, answerBlockDur);
		}
	} else {
		const aRes = contentDurationDetail(aItems, byFile, fallbackSec, stats);
		aDur = aRes.total;
		replicSec += aRes.replicSec;

		const hasAnswerContent = aItems.some(
			item => (item.placement !== 'replic' && Boolean(item.raw)) || MEDIA_TYPES.has(item.type),
		);

		if (!hasAnswerContent && hasPlainAnswer(question.body)) {
			aDur += ANSWER_TEXT_SEC;
		}
	}

	// Автор поставил таймер в ответе (answerDuration или duration на вопросе/блоке ответа) —
	// стандартные 5 секунд полоски обдумывания на этом вопросе не добавляются
	const hasCustomTimer = hasAnswerDuration || answerBlockDur !== null;

	return {
		total: qRes.total + optDur + aDur,
		buckets: qRes.buckets,
		answerSec: aDur,
		optionsSec: optDur,
		replicSec,
		hasCustomTimer,
		customThinkSec,
	};
}

/**
 * Чистая длительность пака и подробная разбивка по компонентам и раундам.
 *
 * Для финального раунда (type="final") в content входит средняя длительность
 * ОДНОГО вопроса финала — по умолчанию в SIOnline (playAllQuestionsInFinalRound=false)
 * играется только одна оставшаяся тема.
 *
 * @param {Buffer|Uint8Array|string} xmlBuffer содержимое content.xml
 * @param {{byFile?: Map<string, number>, median?: number|null, average?: number|null}|null} [media]
 *        результат measureMedia(archive) из src/duration.js
 * @returns {{duration: number, breakdown: object}}
 */
export function measurePackDurationDetail(xmlBuffer, media = null) {
	let xml = decodeUtf8(xmlBuffer);

	if (xml.charCodeAt(0) === 0xfeff) {
		xml = xml.slice(1);
	}

	const roundsStart = xml.indexOf('<rounds');

	if (roundsStart < 0) {
		return {
			duration: 0,
			breakdown: {
				content: 0,
				regularQ: 0,
				finalQ: 0,
				finalThemes: 0,
				finalAvg: 0,
				textSec: 0,
				imageSec: 0,
				audioSec: 0,
				videoSec: 0,
				answerSec: 0,
				optionsSec: 0,
				replicSec: 0,
				thinkQ: 0,
				customThinkQ: 0,
				customThinkSec: 0,
				rounds: [],
				cappedAttrs: 0,
			},
		};
	}

	const body = xml.slice(roundsStart);
	const byFile = media?.byFile ?? null;
	// Медиана устойчива к одному длинному файлу-выбросу; среднее остаётся запасным
	const fallbackSec = Number.isFinite(media?.median) && media.median > 0
		? media.median
		: (Number.isFinite(media?.average) && media.average > 0 ? media.average : 0);

	const stats = { cappedAttrs: 0 };
	const buckets = { text: 0, image: 0, audio: 0, video: 0 };
	const roundDurations = [];
	let totalContent = 0;
	let answerSec = 0;
	let optionsSec = 0;
	let replicSec = 0;
	let regularQ = 0;
	let finalQ = 0;
	let finalThemes = 0;
	let finalSumAll = 0;
	let thinkQ = 0;
	let customThinkQ = 0;
	let customThinkSec = 0;

	for (const round of splitByTag(body, 'round')) {
		const isFinal = (round.attributes.type ?? '').trim().toLowerCase() === 'final';
		const roundBuckets = { text: 0, image: 0, audio: 0, video: 0 };
		let roundSum = 0;
		let roundAnswer = 0;
		let roundOptions = 0;
		let roundReplic = 0;
		let roundQ = 0;
		let roundThemes = 0;

		for (const theme of splitByTag(round.body, 'theme')) {
			const questions = splitByTag(theme.body, 'question');

			if (questions.length > 0 || (theme.attributes.name ?? '').trim()) {
				roundThemes++;
			}

			for (const question of questions) {
				const q = questionDetail(question, byFile, fallbackSec, stats);
				roundSum += q.total;
				roundAnswer += q.answerSec;
				roundOptions += q.optionsSec;
				roundReplic += q.replicSec;
				roundBuckets.text += q.buckets.text;
				roundBuckets.image += q.buckets.image;
				roundBuckets.audio += q.buckets.audio;
				roundBuckets.video += q.buckets.video;
				roundQ++;

				if (!isFinal) {
					if (q.hasCustomTimer) {
						customThinkQ++;
						customThinkSec += q.customThinkSec;
					} else {
						thinkQ++;
					}
				}
			}
		}

		if (isFinal) {
			finalQ += roundQ;
			finalThemes += roundThemes;
			finalSumAll += roundSum;

			// По умолчанию в SIOnline играется 1 вопрос финала: берём среднее
			const scale = roundQ > 0 ? 1 / roundQ : 0;
			const played = roundSum * scale;
			totalContent += played;
			buckets.text += roundBuckets.text * scale;
			buckets.image += roundBuckets.image * scale;
			buckets.audio += roundBuckets.audio * scale;
			buckets.video += roundBuckets.video * scale;
			answerSec += roundAnswer * scale;
			optionsSec += roundOptions * scale;
			replicSec += roundReplic * scale;
			roundDurations.push(Math.round(played));
		} else {
			regularQ += roundQ;
			totalContent += roundSum;
			buckets.text += roundBuckets.text;
			buckets.image += roundBuckets.image;
			buckets.audio += roundBuckets.audio;
			buckets.video += roundBuckets.video;
			answerSec += roundAnswer;
			optionsSec += roundOptions;
			replicSec += roundReplic;
			roundDurations.push(Math.round(roundSum));
		}
	}

	const duration = Math.max(0, Math.round(totalContent));
	const finalAvg = finalQ > 0 ? finalSumAll / finalQ : 0;

	return {
		duration,
		breakdown: {
			content: duration,
			regularQ,
			finalQ,
			finalThemes,
			finalAvg: Math.round(finalAvg),
			textSec: Math.round(buckets.text),
			imageSec: Math.round(buckets.image),
			audioSec: Math.round(buckets.audio),
			videoSec: Math.round(buckets.video),
			answerSec: Math.round(answerSec),
			optionsSec: Math.round(optionsSec),
			replicSec: Math.round(replicSec),
			thinkQ,
			customThinkQ,
			customThinkSec: Math.round(customThinkSec),
			rounds: roundDurations,
			cappedAttrs: stats.cappedAttrs,
		},
	};
}

/**
 * Чистая длительность пака, целые секунды (обёртка для совместимости).
 *
 * @param {Buffer|Uint8Array|string} xmlBuffer содержимое content.xml
 * @param {{byFile?: Map<string, number>, median?: number|null, average?: number|null}|null} [media]
 * @returns {number} секунды (целое, >= 0)
 */
export function measurePackDuration(xmlBuffer, media = null) {
	return measurePackDurationDetail(xmlBuffer, media).duration;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Извлекает сведения о финальном раунде из массива rounds (запасной путь без breakdown). */
function finalFromRounds(rounds) {
	if (!Array.isArray(rounds) || rounds.length === 0) {
		return { finalThemes: 0, finalQ: 0, totalThemes: 0 };
	}

	let finalThemes = 0;
	let finalQ = 0;
	let totalThemes = 0;

	for (const round of rounds) {
		const themes = Array.isArray(round?.themes) ? round.themes : [];
		totalThemes += themes.length;

		if (String(round?.type ?? '').toLowerCase() === 'final') {
			finalThemes += themes.length;

			for (const theme of themes) {
				finalQ += Number(theme?.questions) || 0;
			}
		}
	}

	return { finalThemes, finalQ, totalThemes };
}

/**
 * Оценка реалистичного времени партии при настройках SIOnline по умолчанию
 * (Classic, 3 игрока, бот-ведущий, falseStart=true, 1 вопрос в финале).
 *
 * Учитывает:
 *   • чистый контент пака (contentSec);
 *   • прокрутку тем игры и объявление тем каждого раунда + предзагрузку;
 *   • выбор вопросов на табло (timeForChoosingQuestion = 30 с → ~3.5 с);
 *   • 5-секундную полоску обдумывания (timeForThinkingOnQuestion = 5 с) на каждом
 *     обычном вопросе БЕЗ авторского таймера в ответе — и авторский таймер вместо
 *     неё на вопросах с явным answerDuration;
 *   • ввод и проверку ответа + повторную попытку при неверном ответе;
 *   • спецвопросы (кот в мешке, аукцион/ставка, для всех, без риска);
 *   • финальный раунд (вычёркивание тем, ставки, 45 с раздумий, проверка).
 *
 * Работает как по полному breakdown из pack_duration, так и по старым строкам
 * без breakdown (используя packMeta.contentSec, questionCount, rounds и specialStat).
 *
 * @param {object|null} breakdown разобранный JSON из pack_duration.breakdown
 * @param {object} [packMeta] { contentSec, questionCount, roundCount, themeCount, specialStat, rounds }
 * @param {object|null} [stats] { takePercent, rightPercent, shown }
 * @param {object} [options] { pace?: 'fast'|'normal'|'stream', falseStart?: boolean, playAllFinal?: boolean }
 * @returns {{total: number, content: number, overhead: number}|null}
 */
export function estimatePlayDuration(breakdown, packMeta = {}, stats = null, options = {}) {
	const baseContent = Number.isFinite(breakdown?.content)
		? breakdown.content
		: (Number.isFinite(packMeta?.contentSec) ? packMeta.contentSec : null);

	if (baseContent === null || baseContent <= 0) {
		return null;
	}

	const pace = options.pace ?? 'normal';
	const falseStart = options.falseStart !== false;
	const playAllFinal = options.playAllFinal === true;

	const fromRounds = finalFromRounds(packMeta?.rounds);
	const hasBreakdown = Boolean(breakdown && typeof breakdown === 'object');

	const finalThemes = hasBreakdown && Number.isFinite(breakdown.finalThemes)
		? breakdown.finalThemes
		: fromRounds.finalThemes;
	const finalQ = hasBreakdown && Number.isFinite(breakdown.finalQ)
		? breakdown.finalQ
		: fromRounds.finalQ;
	const finalAvg = hasBreakdown && Number.isFinite(breakdown.finalAvg)
		? breakdown.finalAvg
		: 0;
	const regularQ = hasBreakdown && Number.isFinite(breakdown.regularQ)
		? breakdown.regularQ
		: Math.max(0, (Number(packMeta?.questionCount) || 0) - finalQ);

	// Сколько обычных вопросов идут со стандартной 5-секундной полоской обдумывания
	const thinkQ = hasBreakdown && Number.isFinite(breakdown.thinkQ)
		? breakdown.thinkQ
		: regularQ;
	const customThinkSec = hasBreakdown && Number.isFinite(breakdown.customThinkSec)
		? breakdown.customThinkSec
		: 0;

	const roundCount = (hasBreakdown && Array.isArray(breakdown.rounds) && breakdown.rounds.length > 0)
		? breakdown.rounds.length
		: (Number(packMeta?.roundCount) || (Array.isArray(packMeta?.rounds) ? packMeta.rounds.length : 0));
	const themeCount = Number(packMeta?.themeCount) || fromRounds.totalThemes;

	const reliableStats = stats && (stats.shown === undefined || stats.shown === null || stats.shown >= 30);
	const pTake = reliableStats && Number.isFinite(stats.takePercent)
		? clamp(stats.takePercent / 100, 0.05, 0.98)
		: DEFAULT_TAKE_RATE;
	const pRight = reliableStats && Number.isFinite(stats.rightPercent)
		? clamp(stats.rightPercent / 100, 0.05, 0.98)
		: DEFAULT_RIGHT_RATE;

	let effectiveContent = baseContent;

	if (playAllFinal && finalQ > 1 && finalAvg > 0) {
		effectiveContent += (finalQ - 1) * finalAvg;
	}

	// Без фальстартов игроки жмут кнопку, не дожидаясь конца текста/аудио/видео
	if (!falseStart) {
		const answerPart = hasBreakdown && Number.isFinite(breakdown.answerSec) ? breakdown.answerSec : 0;
		const questionPart = Math.max(0, effectiveContent - answerPart);
		effectiveContent = answerPart + questionPart * 0.7;
	}

	// 1. Старт игры и раундов (TableGameThemes + TableRoundThemes + предзагрузка)
	const intros = (themeCount > 0 ? Math.max(3, themeCount) + 1 : 0)
		+ 1.9 * themeCount
		+ 4 * roundCount;

	// 2. Выбор вопроса на табло (~3.5 с при лимите 30 с)
	const selection = 3.5 * regularQ;

	// 3. Полоска обдумывания после вопроса:
	//    • на вопросах без авторского таймера: стандартные 5 с (сгорают целиком при пропуске,
	//      ~половина + 0.3 с окна buttonsAccepting при нажатии);
	//    • на вопросах с явным answerDuration: таймер автора вместо стандартных 5 с;
	//    • на вопросах с явным duration на блоке ответа: время уже в content, 5 с не добавляем.
	const defaultThinkPerQ = falseStart
		? (1 - pTake) * THINK_BAR_SEC + pTake * (THINK_BAR_SEC / 2 + 0.3)
		: (1 - pTake) * THINK_BAR_SEC;
	const customThinkWeight = falseStart ? ((1 - pTake) + pTake * 0.5) : (1 - pTake);
	const thinking = thinkQ * defaultThinkPerQ + customThinkSec * customThinkWeight;

	// 4. Ввод ответа, вердикт ведущего и повторная попытка при неверном ответе
	const answering = regularQ * pTake * (6.5 + (1 - pRight) * 3.0);

	// 5. Системные переходы между вопросами (тема/цена, возврат на табло)
	const transitions = 1.5 * regularQ;

	// 6. Доплата за спецвопросы сверх обычного цикла
	const sp = packMeta?.specialStat ?? {};
	const specials = (Number(sp.cat) || 0) * 12
		+ (Number(sp.auction) || 0) * 22
		+ (Number(sp.forAll) || 0) * 30
		+ (Number(sp.noRisk) || 0) * 5
		+ (Number(sp.other) || 0) * 10;

	// 7. Финальный раунд (вычёркивание тем + ставки + 45 с раздумий + проверка ответов)
	let finalOverhead = 0;

	if (finalThemes > 0 || finalQ > 0) {
		finalOverhead = playAllFinal
			? Math.max(1, finalQ) * (12 + 35 + 15)
			: Math.max(0, finalThemes - 1) * 5 + 12 + 35 + 15;
	}

	let overhead = intros + selection + thinking + answering + transitions + specials + finalOverhead;

	if (pace === 'fast') {
		overhead *= 0.85;
	} else if (pace === 'stream') {
		// Живой ведущий и голосовые обсуждения в Discord/на стриме: +30% к партии
		const streamTotal = (effectiveContent + overhead) * 1.3;
		overhead = streamTotal - effectiveContent;
	}

	const contentRounded = Math.max(0, Math.round(effectiveContent));
	const overheadRounded = Math.max(0, Math.round(overhead));

	return {
		total: contentRounded + overheadRounded,
		content: contentRounded,
		overhead: overheadRounded,
	};
}
