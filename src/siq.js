// Разбор content.xml из пака SIGame. Поддерживает формат 4 (atom) и 5 (item).

const ENTITIES = {
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&apos;': "'",
};

export function decodeXml(value) {
	return value
		.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
		.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
		.replace(/&(amp|lt|gt|quot|apos);/g, m => ENTITIES[m]);
}

export function parseAttributes(source) {
	const attributes = {};
	const pattern = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
	let match;

	while ((match = pattern.exec(source)) !== null) {
		attributes[match[1]] = decodeXml(match[2]);
	}

	return attributes;
}

export function collectTexts(source, tag) {
	const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
	const result = [];
	let match;

	while ((match = pattern.exec(source)) !== null) {
		const text = decodeXml(match[1]).replace(/<[^>]*>/g, '').trim();

		if (text) {
			result.push(text);
		}
	}

	return result;
}

/**
 * Куски, которые за столом никто не видит и не слышит как содержимое вопроса.
 *
 * «say» и «oral» — устный текст: то, что ведущий читает вслух, а на экране
 * не показывается вовсе. «marker» — не содержимое, а метка: всё, что стоит
 * после неё в сценарии, относится уже к ответу (см. questionSide).
 *
 * До сих пор все три попадали в «текст»: неизвестный вид считался текстом,
 * а эти три в списке видов не стояли. У пака, где ведущему расписаны реплики
 * к каждой картинке, полоска состава показывала текст там, где за столом
 * одни картинки.
 */
const SILENT_TYPES = new Set(['say', 'oral', 'marker']);

/** Как вид содержимого зовётся в формате 4 и как — в полоске состава. */
const CONTENT_TYPES = {
	'': 'text',
	text: 'text',
	image: 'image',
	// Формат 4 зовёт звук «voice», формат 5 — «audio»
	voice: 'audio',
	audio: 'audio',
	video: 'video',
	html: 'html',
};

/**
 * Из чего сделаны вопросы: сколько в них текста, картинок, звука, видео.
 *
 * Считается ТОЛЬКО по вопросу — по тому, что показывают, пока на него отвечают
 * (см. questionSide). Раньше считалось по всему, что нашлось внутри <question>,
 * и в полоску состава уезжала ответная часть: картинка, которую показывают
 * после ответа, сам ответ и варианты выбора. Полоска отвечает на вопрос
 * «из чего сделаны вопросы», и ответная картинка отвечает на него неправдой —
 * пак из одних текстовых вопросов с картинками-ответами выглядел наполовину
 * картиночным.
 *
 * Устный текст и метка ответа в счёт не идут вовсе (см. SILENT_TYPES).
 *
 * Годится и на теле темы, и на теле всего пака: и там, и там вопросы лежат
 * своими <question>, а больше здесь ничего и не нужно.
 */
function countContentTypes(body) {
	const stat = { text: 0, image: 0, audio: 0, video: 0, html: 0 };

	for (const question of splitByTag(body, 'question')) {
		const asked = questionSide(question.body);

		// Формат 5 держит содержимое в <item>, формат 4 — в <atom>
		for (const tag of ['item', 'atom']) {
			const pattern = new RegExp(`<${tag}\\b([^>]*)>`, 'g');
			let match;

			while ((match = pattern.exec(asked)) !== null) {
				const type = (parseAttributes(match[1]).type ?? '').trim().toLowerCase();

				if (SILENT_TYPES.has(type)) {
					continue;
				}

				// Незнакомый вид считаем текстом: новые виды в формат добавляют,
				// и терять из-за них целые вопросы не стоит
				stat[CONTENT_TYPES[type] ?? 'text']++;
			}
		}
	}

	return stat;
}

/**
 * Где лежит то, что вопрос показывает: в самом паке или на чужом сервере.
 *
 * ————— зачем —————
 *
 * Пак — это архив, и обычно всё, что в нём показывают, лежит в нём же: вопрос
 * ссылается на файл именем («@Naruto.mp3»), а файл — рядом, в папке Audio.
 * Но формат разрешает и другое: вместо имени файла написать ссылку
 * («https://…/kadr.jpg»), и тогда в архиве нет ничего, кроме content.xml.
 *
 * Такой пак живёт ровно столько, сколько живут чужие ссылки, — то есть недолго.
 * Пак 4003 («-3 часа жизни») — 593 вопроса-картинки при архиве в двадцать
 * килобайт: ни одной картинки внутри нет, все до одной по ссылкам, и ни одна
 * уже не открывается. За столом это не пак, а 593 пустых экрана, но по всем
 * прочим признакам — обычный аниме-пак на десять раундов.
 *
 * Отличить его от настоящего можно только здесь, при разборе: наверху видно
 * лишь то, что вопрос картиночный. Поэтому считаются две вещи — сколько кусков
 * лежит в самом паке и сколько его покинуло.
 *
 * ————— что считается покинувшим пак —————
 *
 * Два случая, и они об одном и том же:
 *
 *   ссылка — содержимое названо адресом (http, https). Файла в паке нет
 *     и не было, пак опирается на чужой сервер;
 *   пропажа — назван файл, которого в оглавлении архива нет. Такой вопрос
 *     не покажет ничего ровно так же, как и умершая ссылка.
 *
 * Пропажа считается только тогда, когда оглавление архива и вправду дано.
 * Разбор без архива (шаги логотипов и спецвопросов) о содержимом не знает
 * ничего, и объявлять там пропавшими все файлы разом было бы неправдой.
 *
 * Считается, как и состав, ТОЛЬКО по вопросу: картинка, приложенная к ответу,
 * пак сломанным не делает — на ней уже всё сыграно.
 *
 * @param {string} body тело <rounds>
 * @param {Map<string, number>|null} mediaSizes оглавление архива (см. src/zip.js)
 * @returns {{own: number, offsite: number}}
 */
function countMediaRefs(body, mediaSizes) {
	const known = mediaSizes && mediaSizes.size > 0 ? mediaSizes : null;
	let own = 0;
	let offsite = 0;

	for (const question of splitByTag(body, 'question')) {
		const asked = questionSide(question.body);

		for (const piece of [...collectTexts(asked, 'item'), ...collectTexts(asked, 'atom')]) {
			if (/^https?:/i.test(piece)) {
				offsite++;
				continue;
			}

			if (!piece.startsWith('@') && !FILE_NAME.test(piece)) {
				continue;
			}

			// Имя без папки и в нижнем регистре — таким его знает оглавление
			const name = piece.replace(/^@/, '').split('/').pop().toLowerCase();

			if (known && !known.has(name)) {
				offsite++;
			} else {
				own++;
			}
		}
	}

	return { own, offsite };
}

/**
 * Виды спецвопросов и то, во что они сводятся. Формат 4 пишет вид отдельным
 * тегом (<type name="cat"/>), формат 5 — атрибутом самого вопроса
 * (<question type="secret">), и называются одни и те же вещи там по-разному:
 * «auction» пятой версии зовётся «stake», а «кот в мешке» — «secret».
 *
 * Всё, чего в списке нет, но что вопрос всё же чем-то помечен, попадает
 * в «прочие особые»: новые виды в формат добавляют, и молча терять их не стоит.
 */
const SPECIAL_TYPES = {
	auction: 'auction',
	stake: 'auction',
	stakeAll: 'auction',
	cat: 'cat',
	bagcat: 'cat',
	secret: 'cat',
	secretPublicPrice: 'cat',
	secretNoQuestion: 'cat',
	sponsored: 'noRisk',
	noRisk: 'noRisk',
	forAll: 'forAll',
};

/**
 * Сколько в паке особых вопросов и каких. Обычный вопрос вида не имеет вовсе
 * или помечен «simple» — такие не считаются.
 *
 * @returns {{total: number, byKind: Object<string, number>}}
 */
function countSpecials(body) {
	const byKind = {};
	let total = 0;

	for (const question of splitByTag(body, 'question')) {
		// Формат 5 держит вид в атрибуте вопроса, формат 4 — во вложенном теге.
		// Тег ищется от начала области, а она кончается на следующем вопросе,
		// так что чужой вид сюда не попадёт.
		const inner = /<type\b([^>]*)\/?>/.exec(question.body);
		const kind = ((question.attributes.type ?? '').trim()
			|| (inner ? (parseAttributes(inner[1]).name ?? '').trim() : ''));

		if (!kind || kind === 'simple') {
			continue;
		}

		const key = SPECIAL_TYPES[kind] ?? 'other';
		byKind[key] = (byKind[key] ?? 0) + 1;
		total++;
	}

	return { total, byKind };
}

/** Разбивает кусок XML на области по открывающему тегу. */
export function splitByTag(source, tag) {
	const pattern = new RegExp(`<${tag}\\b([^>]*)>`, 'g');
	const starts = [];
	let match;

	while ((match = pattern.exec(source)) !== null) {
		starts.push({ attributes: parseAttributes(match[1]), start: match.index + match[0].length });
	}

	return starts.map((item, i) => ({
		attributes: item.attributes,
		body: source.slice(item.start, i + 1 < starts.length ? starts[i + 1].start : source.length),
	}));
}

/**
 * Варианты выбора вопроса — та самая табличка «А, Б, В, Г», из которой за столом
 * выбирают ответ. Формат 5 держит их группой параметров:
 *
 *   <param name="answerOptions" type="group">
 *     <param name="А" type="content"><item type="text">Наруто</item></param>
 *     …
 *
 * Нежадный поиск закрывающего тега здесь не годится: внутри группы у каждого
 * варианта свой <param>, и первый же </param> закрыл бы не её, а первый вариант.
 * Поэтому теги считаются с глубиной.
 *
 * Возвращается содержимое группы — то есть все варианты разом. Кому из них
 * верить, отсюда не видно и не нужно: в выжимку темы едут все (см. buildSample).
 */
const OPTIONS_PARAM = /<param\b[^>]*\bname="answerOptions"[^>]*>/;

function answerOptions(questionBody) {
	const start = OPTIONS_PARAM.exec(questionBody);

	if (!start) {
		return '';
	}

	const from = start.index + start[0].length;
	const pattern = /<param\b[^>]*>|<\/param>/g;
	pattern.lastIndex = from;

	let depth = 1;
	let match;

	while ((match = pattern.exec(questionBody)) !== null) {
		if (match[0] === '</param>') {
			depth--;

			if (depth === 0) {
				return questionBody.slice(from, match.index);
			}
		} else if (!match[0].endsWith('/>')) {
			depth++;
		}
	}

	// Группа не закрыта — берём всё, что за ней осталось: у последнего вопроса
	// темы тело и так тянется до конца куска (см. splitByTag)
	return questionBody.slice(from);
}

const FILE_NAME = /\.(jpe?g|png|gif|webp|bmp|mp3|wav|ogg|m4a|opus|mp4|webm|mov|avi|mkv)$/i;

/**
 * Имя вложенного файла бывает говорящим («Naruto - Blue Bird.mp3»), а бывает мусором
 * из цифр и хешей. Второе только зашумит выжимку.
 */
function meaningfulFileName(value) {
	const name = value.replace(/^@/, '').replace(FILE_NAME, '').trim();
	const letters = (name.match(/\p{L}/gu) ?? []).length;

	if (letters < 4 || letters / name.length <= 0.5 || name.length > 60) {
		return '';
	}

	// Хеши и идентификаторы ВК: длинная строка без единого пробела
	if (!name.includes(' ') && name.length > 16) {
		return '';
	}

	return name;
}

/**
 * Короткая выжимка темы: ответы плюс тексты вопросов. По ней потом определяется
 * тематика, поэтому важна не полнота, а разнообразие. Ответы вроде «A», «B», «Правда»
 * ничего не говорят, и тогда вес смещается на сами вопросы.
 */
function buildSample(themeBody) {
	const answers = collectTexts(themeBody, 'answer').filter(t => t.length >= 3);

	// Варианты выбора — тоже ответы, и в выжимке им место рядом с ответами,
	// а не в общей куче содержимого.
	//
	// У вопроса с вариантами в <right> лежит одна буква («А»), а не название:
	// сам ответ написан в табличке вариантов. Буква короче трёх знаков и строкой
	// выше отсеивается — то есть у темы, целиком собранной из таких вопросов,
	// ответов не оказывалось вовсе, и модель размечала её по одним лишь текстам
	// вопросов. Между тем за столом называют именно эти строки: чтобы ответить
	// «в каком аниме нет демонов», надо знать все четыре названные тайтла,
	// а не одно (см. правила для w в src/gemini/theme-prompt.js).
	const options = splitByTag(themeBody, 'question')
		.flatMap(question => collectTexts(answerOptions(question.body), 'item'))
		.filter(text => text.length >= 3);

	// Формат 5 держит содержимое в item, формат 4 — в atom
	const questions = [...collectTexts(themeBody, 'item'), ...collectTexts(themeBody, 'atom')]
		.map(text => text.startsWith('@') || FILE_NAME.test(text) ? meaningfulFileName(text) : text)
		.filter(text => text && !/^https?:/i.test(text));

	const seen = [];
	const chosen = [];
	let length = 0;

	// «Вольт (2008)» и файл «Вольт2 (2008).jpg» — одно и то же, второй раз это не нужно.
	// Цифры выбрасываются: они чаще нумеруют файлы, чем различают ответы.
	const simplify = text => text.toLowerCase().replace(/[^\p{L}]+/gu, '');

	const take = (list, max) => {
		let taken = 0;

		for (const part of list) {
			if (taken >= max || length > 460) {
				break;
			}

			const flat = part.replace(/\s+/g, ' ').trim();
			const short = flat.length > 70 ? `${flat.slice(0, 70)}…` : flat;
			const key = simplify(short);

			// Совпадением считаем только длинные куски: «ад» внутри «адмирал» ничего не значит
			if (!key || seen.some(other => (other.includes(key) || key.includes(other)) && Math.min(other.length, key.length) >= 4)) {
				continue;
			}

			seen.push(key);
			chosen.push(short);
			length += short.length + 3;
			taken++;
		}
	};

	take(answers, 8);
	take(options, 6);
	take(questions, 6);

	return chosen.join(' / ').slice(0, 500);
}

/** Преобладающий тип содержимого темы: по нему видно музыкальные и видео-темы. */
function dominantMedia(themeBody) {
	const stat = countContentTypes(themeBody);
	const media = [['audio', stat.audio], ['video', stat.video], ['image', stat.image]];
	const total = stat.text + stat.image + stat.audio + stat.video;
	const [type, count] = media.sort((a, b) => b[1] - a[1])[0];

	return total > 0 && count / total > 0.4 ? type : '';
}

/**
 * Правильные ответы вопроса. Берутся только из <right>: в <wrong> лежат
 * неверные, и складывать их вместе значило бы считать разными два одинаковых
 * вопроса, у одного из которых автор дописал пару неправильных вариантов.
 */
const RIGHT_BLOCK = /<right\b[^>]*>([\s\S]*?)<\/right>/;

/**
 * Тело вопроса без всего, что вопросом не является: без ответной части и без
 * обвязки спецвопроса.
 *
 * ————— зачем —————
 *
 * По содержимому вопроса считается отпечаток, а по отпечаткам ищется списанное
 * (см. src/plagiarism.js). Раньше в отпечаток шло всё, что нашлось внутри
 * <question> целиком, — а внутри лежит не только сам вопрос.
 *
 * Формат 5 держит вопрос в <param name="question">, а рядом, в тех же <params>,
 * стоит ответная часть <param name="answer"> — картинка или ролик, который
 * показывают после ответа. Формат 4 держит и то, и другое одним <scenario>,
 * разделяя их <atom type="marker">: всё, что после метки, — тоже ответная часть.
 * И там, и там это уезжало в отпечаток наравне с текстом вопроса, а значит,
 * один и тот же вопрос, к которому двое приложили разные картинки ответа,
 * отпечатки давал разные — и списавший выходил чистым.
 *
 * Обвязка спецвопроса — там же и рядом. Кот в мешке несёт с собой название
 * своей темы, цену и способ передачи (<param name="theme">, «price»,
 * «selectionMode»), аукцион и «без риска» — свои пометки. Всё это про правила
 * розыгрыша, а не про то, что спрашивают: обычный вопрос, превращённый
 * в кота, — это тот же вопрос, и совпадать он обязан по-прежнему. Ровно
 * об этом и просили: спецвопрос плагиатом быть не мешает.
 *
 * Что остаётся: у формата 5 — содержимое <param name="question">, у формата 4 —
 * <scenario> до метки. Не нашлось ни того, ни другого (бывает у «кота без
 * вопроса») — берётся всё тело как раньше: пустой отпечаток хуже неточного.
 */
const QUESTION_PARAM = /<param\b[^>]*\bname="question"[^>]*>([\s\S]*?)<\/param>/g;
const SCENARIO_BLOCK = /<scenario\b[^>]*>([\s\S]*?)<\/scenario>/;
const ANSWER_MARKER = /<atom\b[^>]*\btype="marker"[^>]*>/;

function questionSide(questionBody) {
	const asked = [...questionBody.matchAll(QUESTION_PARAM)].map(match => match[1]);

	if (asked.length > 0) {
		return asked.join(' ');
	}

	const scenario = SCENARIO_BLOCK.exec(questionBody);

	if (scenario) {
		return scenario[1].split(ANSWER_MARKER)[0];
	}

	return questionBody;
}

/**
 * Содержимое одного вопроса, разобранное на три части: сам вопрос, имена
 * приложенных к нему файлов и правильный ответ.
 *
 * Ради поиска списанного (см. src/plagiarism.js). Тексты вопросов в базе
 * не хранятся — они весят больше всего остального пака вместе взятого, —
 * а хранится восьмибайтный отпечаток вот этих трёх частей: он отвечает
 * на единственный вопрос, который тут задают, «стоял ли ровно этот вопрос
 * в чужом паке раньше».
 *
 * Части разделены нарочно, а не склеены в одну строку прямо здесь: склейку
 * с разделителями делает тот, кто считает отпечаток, и делает одинаково
 * для всех — иначе «вопрос без файла» и «файл без вопроса» с одинаковым
 * ответом сошлись бы в один отпечаток.
 *
 * Имя файла в счёт входит на равных с текстом. У медиавопроса текста нет вовсе
 * («что это за песня?» задаёт сам файл), и без имени файла все такие вопросы
 * одного пака различались бы только ответом. А имя это как раз и переезжает
 * из пака в пак нетронутым: перекладывают папку Audio целиком.
 *
 * Формат 4 держит содержимое в <atom>, формат 5 — в <item>; и там, и там
 * ссылка на файл пишется с собачкой впереди («@Naruto.mp3»).
 */
function questionParts(questionBody, mediaSizes) {
	const asked = questionSide(questionBody);
	const pieces = [...collectTexts(asked, 'item'), ...collectTexts(asked, 'atom')];
	const text = [];
	const media = [];
	let mediaBytes = 0;

	for (const piece of pieces) {
		if (piece.startsWith('@') || FILE_NAME.test(piece)) {
			const name = piece.replace(/^@/, '');
			media.push(name);
			// Вес файла из оглавления архива. Ноль — «в архиве такого файла нет»
			// или «разбирали без архива»: это неизвестность, а не пустота,
			// и толкуется она в пользу совпадения (см. sameWeight в plagiarism.js)
			mediaBytes += mediaSizes?.get(name.split('/').pop().toLowerCase()) ?? 0;
		} else {
			text.push(piece);
		}
	}

	const right = RIGHT_BLOCK.exec(questionBody);

	return {
		text: text.join(' '),
		media: media.join(' '),
		answer: right ? collectTexts(right[1], 'answer').join(' ') : '',
		// Сумма, а не список: вопросу с двумя файлами всё равно нужно одно число,
		// а сумма расходится ровно тогда же, когда разошёлся бы любой из двух
		mediaBytes,
	};
}

/**
 * Все вопросы пака подряд, каждый со своим местом в раундах.
 *
 * Место (номер раунда и номер темы) едет рядом с содержимым потому, что метку
 * «взято отсюда» сайт ставит теме, а не вопросу: мельче темы он ничего
 * не показывает (см. roundsForApi в src/keys.js). Считается плагиат по вопросам,
 * а показывается по темам — и связывает одно с другим как раз это место.
 */
function collectQuestions(body, mediaSizes) {
	const questions = [];

	splitByTag(body, 'round').forEach((round, roundIndex) => {
		// Номер темы считается своим счётчиком, а не местом в разборе: пустую
		// тему parseRounds выбрасывает, и порядковый номер после неё съезжает.
		// Разойдись эти два счёта — и метка «взято отсюда» встала бы не на ту
		// тему. Отбор здесь обязан слово в слово повторять отбор parseRounds —
		// он для того и вынесен в keptTheme
		let themeIndex = 0;

		for (const theme of splitByTag(round.body, 'theme')) {
			if (!keptTheme(theme)) {
				continue;
			}

			for (const question of splitByTag(theme.body, 'question')) {
				questions.push({ round: roundIndex, theme: themeIndex, ...questionParts(question.body, mediaSizes) });
			}

			themeIndex++;
		}
	});

	return questions;
}

/**
 * Сколько вопросов в теме. Считается по открывающим тегам: содержимое темы
 * тут не разбирается, а число нужно и разбору, и отбору ниже.
 */
const themeQuestions = themeBody => (themeBody.match(/<question[\s>]/g) ?? []).length;

/**
 * Идёт ли тема в счёт.
 *
 * Раньше в счёт шли только названные темы, и на этом молча терялись целые паки.
 * Имя теме ставить необязательно, и его не ставят: «Chillout 14», «Музпак 2
 * от Чева», «Пак по значкам Steam» — сотня с лишним вопросов, все темы без
 * имён, а в базе у пака ноль тем. Дальше он выпадал из разметки целиком: шаг
 * тематик берёт темы пака, не находит ни одной и молча уходит (см. refreshTopics
 * в src/indexer/marking.js) — пак навсегда оставался без ярлыка, без жанров и без
 * повторов, то есть «Без разметки» на сайте.
 *
 * Между тем разметке имя темы и не нужно: она смотрит на выжимку ответов
 * (см. buildSample), а название темы в «Своей игре» и у названных-то шуточное.
 * Поэтому тема идёт в счёт, если в ней есть хоть один вопрос, — а имя ей, если
 * его нет, даётся по месту, ровно как раунду строкой ниже.
 *
 * Совсем пустая тема (ни имени, ни вопросов) выбрасывается по-прежнему:
 * это остаток редактирования, за столом его не было.
 */
export const keptTheme = theme => Boolean(theme.attributes.name) || themeQuestions(theme.body) > 0;

function parseRounds(body) {
	const rounds = [];
	const regions = splitByTag(body, 'round');

	for (let i = 0; i < regions.length; i++) {
		const themes = [];

		for (const theme of splitByTag(regions[i].body, 'theme')) {
			if (!keptTheme(theme)) {
				continue;
			}

			themes.push({
				name: theme.attributes.name || `Тема ${themes.length + 1}`,
				questions: themeQuestions(theme.body),
				media: dominantMedia(theme.body),
				sample: buildSample(theme.body),
			});
		}

		rounds.push({
			name: regions[i].attributes.name ?? `Раунд ${i + 1}`,
			type: regions[i].attributes.type ?? '',
			themes,
		});
	}

	return rounds;
}

/**
 * Разбирает content.xml.
 *
 * @param {Buffer} buffer содержимое content.xml
 * @param {Map<string, number>} [mediaSizes] вес вложенных файлов по имени
 *        без папки (см. mediaSizes в src/zip.js). Нужен только отпечаткам
 *        вопросов: по весу отменяется совпадение, у которого сошлись имя файла
 *        и ответ, а сам файл разный. Без него разбор считает как раньше —
 *        вес у всех вопросов выходит нулевым, то есть неизвестным.
 */
export function parseContentXml(buffer, mediaSizes = null) {
	// SIQ пишется в UTF-8, но с BOM
	let xml = buffer.toString('utf8');

	if (xml.charCodeAt(0) === 0xfeff) {
		xml = xml.slice(1);
	}

	const packageMatch = /<package\b([^>]*)>/.exec(xml);

	if (!packageMatch) {
		throw new Error('в content.xml нет элемента package');
	}

	const attributes = parseAttributes(packageMatch[1]);
	const roundsStart = xml.indexOf('<rounds');
	const header = roundsStart > 0 ? xml.slice(0, roundsStart) : xml;
	const body = roundsStart > 0 ? xml.slice(roundsStart) : '';

	const rounds = parseRounds(body);
	const questionCount = (body.match(/<question[\s>]/g) ?? []).length;
	const specials = countSpecials(body);
	const difficulty = parseInt(attributes.difficulty ?? '', 10);

	return {
		name: (attributes.name ?? '').trim(),
		id: attributes.id ?? null,
		version: attributes.version ?? null,
		date: attributes.date ?? null,
		language: attributes.language ?? null,
		// Логотип лежит в архиве как Images/<имя>, обычно в percent-кодировке
		logo: attributes.logo ? attributes.logo.replace(/^@/, '') : null,
		authorDifficulty: Number.isFinite(difficulty) ? difficulty : null,
		authors: collectTexts(header, 'author'),
		rounds,
		roundCount: rounds.length,
		themeCount: rounds.reduce((sum, round) => sum + round.themes.length, 0),
		questionCount,
		// Аукционы, коты в мешке и вопросы без риска: их считают отдельно, потому
		// что пак с двумя десятками котов играется совсем не так, как обычный
		specialCount: specials.total,
		specialStat: specials.byKind,
		contentStat: countContentTypes(body),
		// Сколько кусков вопросов лежит в самом паке, а сколько его покинуло:
		// по этой паре видно пак, который весь держится на чужих ссылках
		// и потому уже не играется (см. countMediaRefs)
		mediaRefs: countMediaRefs(body, mediaSizes),
		// Содержимое вопросов — единственное, что отсюда не попадает в саму базу:
		// из него считается восьмибайтный отпечаток на вопрос, и хранится он
		// (см. encodePrints в src/plagiarism.js и таблицу pack_prints в src/db.js)
		questions: collectQuestions(body, mediaSizes),
	};
}
