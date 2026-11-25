// Карта «файл → раунд, тема, вопрос, сторона» по content.xml.
//
// Модерации 18+ нужно знать про каждую картинку и каждый ролик, где именно
// в паке их покажут: без этого находку не к чему привязать, а причину на сайте
// не из чего собрать (nsfw-moderation.md, раздел 6). Разбор в src/siq.js этого
// не даёт: он считает отпечатки и смотрит только сторону вопроса, а на стриме
// показывают и ответ — картинка ответа ровно так же попадает в эфир.
//
// Только Node тут ни при чём, но в Worker этот файл не ездит: читает он
// content.xml, которого наверху нет.

import { collectTexts, decodeXml, keptTheme, parseAttributes, splitByTag } from '../siq.js';

/** Что показывают: по типу куска, а когда тип не назван — по расширению. */
const KIND_BY_TYPE = { image: 'image', video: 'video', voice: 'audio', audio: 'audio', html: 'html' };

const KIND_BY_EXT = [
	[/\.(jpe?g|png|gif|webp|bmp|avif|jfif)$/i, 'image'],
	[/\.(mp4|webm|mov|avi|mkv|m4v|wmv)$/i, 'video'],
	[/\.(mp3|wav|ogg|m4a|opus|flac|aac)$/i, 'audio'],
];

/** В какой папке архива лежит файл такого вида. */
export const FOLDERS = { image: 'Images', video: 'Video', audio: 'Audio', html: 'Html' };

const PIECE = /<(item|atom)\b([^>]*)>([\s\S]*?)<\/\1>/g;
const QUESTION_PARAM = /<param\b[^>]*\bname="question"[^>]*>([\s\S]*?)<\/param>/g;
const ANSWER_PARAM = /<param\b[^>]*\bname="answer"[^>]*>([\s\S]*?)<\/param>/g;
const SCENARIO_BLOCK = /<scenario\b[^>]*>([\s\S]*?)<\/scenario>/;
const ANSWER_MARKER = /<atom\b[^>]*\btype="marker"[^>]*>/;
const RIGHT_BLOCK = /<right\b[^>]*>([\s\S]*?)<\/right>/;

/**
 * Делит тело вопроса на то, что показывают до ответа, и то, что после.
 * Формат 5 держит стороны разными <param>, формат 4 — одним <scenario>
 * с меткой посередине (см. questionSide в src/siq.js: там нужна одна сторона,
 * здесь обе).
 */
function sides(questionBody) {
	const asked = [...questionBody.matchAll(QUESTION_PARAM)].map(match => match[1]);

	if (asked.length > 0) {
		return {
			question: asked.join(' '),
			answer: [...questionBody.matchAll(ANSWER_PARAM)].map(match => match[1]).join(' '),
		};
	}

	const scenario = SCENARIO_BLOCK.exec(questionBody);

	if (scenario) {
		const [before, ...after] = scenario[1].split(ANSWER_MARKER);
		return { question: before, answer: after.join(' ') };
	}

	return { question: questionBody, answer: '' };
}

/** Куски одной стороны: текст отдельно, файлы отдельно. */
function pieces(source) {
	const text = [];
	const files = [];

	for (const match of source.matchAll(PIECE)) {
		const type = (parseAttributes(match[2]).type ?? 'text').toLowerCase();
		const value = decodeXml(match[3]).replace(/<[^>]*>/g, '').trim();

		if (!value || type === 'marker') {
			continue;
		}

		const name = value.replace(/^@/, '');
		const kind = KIND_BY_TYPE[type] ?? KIND_BY_EXT.find(([pattern]) => pattern.test(name))?.[1];

		if (!kind) {
			text.push(value);
			continue;
		}

		// Чужая ссылка: файла в архиве нет, а что по ней лежит сегодня —
		// проверке не подчиняется. Едет в карту с пометкой, чтобы пак получил
		// «часть содержимого по ссылкам»
		files.push({ file: name, kind, offsite: /^https?:\/\//i.test(name) });
	}

	return { text: text.join(' '), files };
}

/**
 * @param {Buffer} buffer содержимое content.xml
 * @returns {{round: number, roundName: string, theme: number, themeName: string,
 *   question: number, price: string, text: string, answer: string,
 *   side: 'question'|'answer', file: string, kind: string, offsite: boolean}[]}
 *   строка на каждое упоминание файла; номера раунда и темы — те же, что
 *   у parseContentXml (пустые темы выброшены тем же keptTheme)
 */
export function mediaMap(buffer) {
	let xml = buffer.toString('utf8');

	if (xml.charCodeAt(0) === 0xfeff) {
		xml = xml.slice(1);
	}

	const start = xml.indexOf('<rounds');
	const body = start > 0 ? xml.slice(start) : xml;
	const map = [];

	splitByTag(body, 'round').forEach((round, roundIndex) => {
		let themeIndex = 0;

		for (const theme of splitByTag(round.body, 'theme')) {
			if (!keptTheme(theme)) {
				continue;
			}

			splitByTag(theme.body, 'question').forEach((question, questionIndex) => {
				const { question: asked, answer: shown } = sides(question.body);
				const right = RIGHT_BLOCK.exec(question.body);
				const front = pieces(asked);
				const back = pieces(shown);

				const place = {
					round: roundIndex,
					roundName: round.attributes.name ?? `Раунд ${roundIndex + 1}`,
					theme: themeIndex,
					themeName: theme.attributes.name || `Тема ${themeIndex + 1}`,
					question: questionIndex,
					price: question.attributes.price ?? '',
					text: front.text,
					answer: right ? collectTexts(right[1], 'answer').join(' / ') : '',
				};

				for (const file of front.files) {
					map.push({ ...place, side: 'question', ...file });
				}

				for (const file of back.files) {
					map.push({ ...place, side: 'answer', ...file });
				}
			});

			themeIndex++;
		}
	});

	return map;
}
