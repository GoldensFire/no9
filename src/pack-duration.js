// Расчёт полной длительности пака по content.xml и длительностям медиафайлов.
//
// Формула повторяет siq_duration.py и siquester/siq_package.py из SI-HYX:
// учитывается не только звук и видео, но и чтение текста, показ картинок,
// одновременный показ (waitForFinish="False" / time="-1"), фоновая музыка
// (placement="background") и время ответа.
//
// Разница с SI-HYX ровно одна, и она в пользу точности по сети:
//   • аудио/видео файлы измеряются по заголовкам всех форматов, которые знает
//     src/duration.js (MP3, MP4/M4A/MOV/AAC, Ogg/Opus, WAV, FLAC, WebM/MKV,
//     AVI, WMA/WMV), а не только MP3 и MP4;
//   • если какой-то аудио/видео файл измерить не вышло (сжатый MP4 с moov
//     в конце, FLV, обрыв), вместо нуля подставляется средняя длина измеренных
//     медиафайлов этого же пака — чтобы пак из полусотни сжатых песен
//     не выходил пятиминутным (а если ни один не измерился, остаётся 0).
//
// Node-специфичного здесь нет: чистый разбор XML и арифметика.

import { collectTexts, decodeXml, parseAttributes, splitByTag } from './siq.js';
import { plainName } from './duration.js';

/** Скорость чтения текста вопроса/ответа, знаков в секунду. */
export const CHARS_PER_SEC = 20;

/** Время показа одной статичной картинки или HTML-элемента без явного таймера, с. */
export const IMAGE_SEC = 5;

/** Фиксированная длительность обычного текстового ответа (когда нет сложного), с. */
export const ANSWER_TEXT_SEC = 3;

/** Типовая пауза на обдумывание, вычитаемая из явного таймера ответа, с. */
export const ANSWER_THINK_DEDUCT_SEC = 5;

const TRUE_SET = new Set(['true', '1', 'yes']);
const MEDIA_TYPES = new Set(['image', 'audio', 'video', 'html']);
const SILENT_TYPES = new Set(['say', 'oral']);

const PARAMS_OPEN = /<params\b[^>]*>/;
const SCENARIO_BLOCK = /<scenario\b[^>]*>([\s\S]*?)<\/scenario>/;
const RIGHT_BLOCK = /<right\b[^>]*>([\s\S]*?)<\/right>/;
const WRONG_BLOCK = /<wrong\b[^>]*>([\s\S]*?)<\/wrong>/;

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
 *   • say/oral — устная реплика ведущего (placement="replic", 0 с);
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
 * Ищет измеренную длительность медиафайла по имени из content.xml.
 *
 * Сначала смотрит точный путь с папкой (Audio/… или Video/…), затем имя
 * без папки. Если файл не удалось измерить по заголовку, подставляет среднюю
 * длину измеренных файлов этого же пака (или 0, если измеренных нет вовсе).
 */
function lookupMediaSeconds(type, rawName, byFile, fallbackSec) {
	if (byFile && byFile.size > 0 && rawName) {
		const clean = plainName(rawName.replace(/^@/, '')).replace(/\\/g, '/').trim().toLowerCase();

		if (clean) {
			const basename = clean.split('/').pop();
			const folder = type === 'video' ? 'video' : 'audio';

			const hit = byFile.get(clean)
				?? byFile.get(`${folder}/${basename}`)
				?? byFile.get(basename);

			if (Number.isFinite(hit) && hit > 0) {
				return hit;
			}
		}
	}

	return fallbackSec;
}

/** Длительность одного элемента вопроса или ответа, секунды. */
function itemSeconds(item, byFile, fallbackSec) {
	if (item.durAttr !== null) {
		return Math.max(0, item.durAttr);
	}

	if (item.isRef && (item.type === 'video' || item.type === 'audio')) {
		return lookupMediaSeconds(item.type, item.raw, byFile, fallbackSec);
	}

	if (item.type === 'image' || item.type === 'html') {
		return IMAGE_SEC;
	}

	if (item.type === 'text' && item.placement !== 'replic') {
		return item.raw ? item.raw.length / CHARS_PER_SEC : 0;
	}

	return 0;
}

/**
 * Длительность последовательности элементов с учётом одновременного показа
 * и фонового аудио (см. content_duration в SI-HYX/siq_duration.py).
 *
 * Элементы с waitFalse=true склеиваются со следующим в одну группу;
 * если в группе есть медиа (image/audio/video/html), текст рядом не считается
 * и берётся максимум среди медиа; иначе — максимум по группе.
 * Фоновые элементы (placement="background") складываются отдельно и идут
 * параллельно переднему плану: итог = max(передний план, фон).
 */
export function contentDuration(items, byFile, fallbackSec) {
	const fg = [];
	const bg = [];

	for (const item of items) {
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

	for (const group of groups) {
		const media = group.filter(item => MEDIA_TYPES.has(item.type));
		const pool = media.length > 0 ? media : group;
		let longest = 0;

		for (const item of pool) {
			const seconds = itemSeconds(item, byFile, fallbackSec);

			if (seconds > longest) {
				longest = seconds;
			}
		}

		fgTotal += longest;
	}

	let bgTotal = 0;

	for (const item of bg) {
		bgTotal += itemSeconds(item, byFile, fallbackSec);
	}

	return Math.max(fgTotal, bgTotal);
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

/** Длительность одного вопроса: содержимое вопроса + ответ, секунды. */
function questionDuration(question, byFile, fallbackSec) {
	const params = extractParams(question.body);
	const qItems = [];
	const aItems = [];
	let anyParamItems = false;
	let answerTime = parseDurAttr(question.attributes.duration);

	for (const param of params) {
		const pname = (param.attributes.name ?? '').trim();

		if (pname === 'answer' && answerTime === null) {
			answerTime = parseDurAttr(param.attributes.duration);
		}

		if (pname === 'answerType' || pname === 'answerOptions') {
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

	const qDur = contentDuration(qItems, byFile, fallbackSec);
	let aDur;

	if (answerTime !== null) {
		aDur = Math.max(0, answerTime - ANSWER_THINK_DEDUCT_SEC);
	} else {
		aDur = contentDuration(aItems, byFile, fallbackSec);
		const hasAnswerContent = aItems.some(item => item.raw || MEDIA_TYPES.has(item.type));

		if (!hasAnswerContent && hasPlainAnswer(question.body)) {
			aDur += ANSWER_TEXT_SEC;
		}
	}

	return qDur + aDur;
}

/**
 * Полная длительность пака, целые секунды.
 *
 * @param {Buffer|string} xmlBuffer содержимое content.xml
 * @param {{byFile?: Map<string, number>, average?: number|null}|null} [media]
 *        результат measureMedia(archive) из src/duration.js
 * @returns {number} секунды (целое, >= 0)
 */
export function measurePackDuration(xmlBuffer, media = null) {
	let xml = Buffer.isBuffer(xmlBuffer) ? xmlBuffer.toString('utf8') : String(xmlBuffer ?? '');

	if (xml.charCodeAt(0) === 0xfeff) {
		xml = xml.slice(1);
	}

	const roundsStart = xml.indexOf('<rounds');

	if (roundsStart < 0) {
		return 0;
	}

	const body = xml.slice(roundsStart);
	const byFile = media?.byFile ?? null;
	const fallbackSec = Number.isFinite(media?.average) && media.average > 0 ? media.average : 0;

	let total = 0;

	for (const round of splitByTag(body, 'round')) {
		for (const theme of splitByTag(round.body, 'theme')) {
			for (const question of splitByTag(theme.body, 'question')) {
				total += questionDuration(question, byFile, fallbackSec);
			}
		}
	}

	return Math.max(0, Math.round(total));
}
