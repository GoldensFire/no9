// Разметка тем: что пришло от модели и во что это превращается.
//
// Всё здесь — про недоверие к ответу. Модель отвечает по схеме, но схема
// не мешает ей назвать жанр, которого нет в списке, десятилетие из будущего
// или категорию вместо произведения; каждое поле поэтому чистится своей
// проверкой, и непонятое отбрасывается молча.
//
// Что именно спрашивается — в theme-prompt.js; как это доедет до модели —
// в api.js.

import {
	config, DECADE_MIN, EXCLUSIVE_TOPIC_KEYS, HOLIDAY_KEYS, MUSIC_KEY, ORIGIN_KEYS,
	OTHER_KIND_KEYS, SPORT_KEY, isForm, isGenre,
} from '../config.js';
import { cleanArea, isCategoryName } from '../franchise.js';
import { ask, GeminiError } from './api.js';
import { buildPrompt, SCHEMA } from './theme-prompt.js';

async function askBatch(batch) {
	// Поиск нужен именно здесь: категория темы и есть тот ответ, ради которого
	// стоит сходить на shikimori — «это аниме или игра» по названию не видно
	const { value } = await ask(buildPrompt(batch), SCHEMA, { search: true });

	if (!Array.isArray(value)) {
		throw new GeminiError('ответ не является массивом', 0);
	}

	return value;
}

/**
 * Приводит название франшизы к тому виду, в каком его не стыдно показать.
 * Модель нет-нет да и вернёт «"Наруто"», «наруто (2002)» или «Наруто.» — а считать
 * повторы надо так, чтобы все три написания попали в одну кучу.
 */
function cleanFranchise(value) {
	const name = String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^[«"'(]+|[»"'.,)]+$/g, '')
		.replace(/\s*\(\d{4}\)$/, '')
		.trim();

	// «Нет», «неизвестно», «-» — способы модели сказать «франшизы тут нет»
	if (name.length < 2 || /^(нет|none|n\/a|неизвестно|разное|различные)$/i.test(name)) {
		return '';
	}

	// Тематика пака произведением не бывает. Модель кладёт «Games», «Movies»,
	// «Cinema», «Видеоигры» и в поле произведения тоже, и оттуда они идут прямо
	// в повторы: «пак возвращается к Games четыре раза» означает ровно «в паке
	// есть игры», то есть ничего (см. isCategoryName в franchise.js)
	if (isCategoryName(name)) {
		return '';
	}

	return name.slice(0, 60);
}

/**
 * Сколько произведений берём из одной темы. Тема-угадайка называет их по числу
 * вопросов — шесть-восемь, — и всё, что длиннее дюжины, это уже не список
 * названного, а перечисление всего, что модели вспомнилось.
 */
const WORKS_LIMIT = 12;

/**
 * Произведения, названные в ответах темы. Чистятся тем же правилом, что и предмет
 * темы: написания должны сходиться, иначе повтор не соберётся.
 */
function cleanWorks(value) {
	if (!Array.isArray(value)) {
		return [];
	}

	const seen = new Map();

	for (const item of value) {
		const name = cleanFranchise(item);

		// Формат и площадка произведением не являются — «Опенинг» в каждой второй
		// теме склеил бы пак-угадайку в одну выдуманную франшизу
		if (name && !seen.has(name.toLowerCase())) {
			seen.set(name.toLowerCase(), name);
		}
	}

	return [...seen.values()].slice(0, WORKS_LIMIT);
}

/**
 * Разметка темы, про которую модель ничего не сказала.
 *
 * Помечена отдельным полем нарочно. По самой разметке «прочее от модели»
 * и «модель промолчала» неразличимы, а разница между ними огромная: первое —
 * ответ, второе — его отсутствие. По этой пометке считается marked, и пак,
 * где не разобралась ни одна тема, переспрашивается, а не записывается солянкой
 * из ничего (см. analyzePack).
 */
const UNMARKED = {
	unmarked: true,
	category: 'other',
	music: false,
	franchise: '',
	franchiseEn: '',
	area: '',
	areaEn: '',
	works: [],
	kind: '',
	holiday: '',
	genres: [],
	musicGenres: [],
	forms: [],
	decades: [],
	origins: [],
};

/**
 * Список «ключ — сколько раз» из ответа модели: жанры темы, жанры её музыки
 * и происхождение названного. Чужие ключи отсеиваются здесь же — проверять
 * их снаружи было бы поздно.
 *
 * @param {Array} value что ответила модель
 * @param {(key: string) => boolean} allow годится ли ключ
 */
function cleanCounted(value, allow) {
	if (!Array.isArray(value)) {
		return [];
	}

	const counts = new Map();

	for (const item of value) {
		const key = String(item?.k ?? '').trim();
		const count = Math.round(Number(item?.n));

		if (!allow(key) || !Number.isFinite(count) || count <= 0) {
			continue;
		}

		counts.set(key, (counts.get(key) ?? 0) + count);
	}

	return [...counts.entries()].map(([key, count]) => ({ key, count }));
}

/**
 * Десятилетия из ответа модели. Всё, что раньше DECADE_MIN, сваливается в него
 * же: пак с вопросом про Шаляпина не заслуживает отдельного куска «1900-е»
 * толщиной в волос.
 *
 * Будущее отсекается: год «2090» — это не десятилетие, а промах модели.
 */
function cleanDecades(value) {
	if (!Array.isArray(value)) {
		return [];
	}

	const limit = Math.floor(new Date().getFullYear() / 10) * 10;
	const counts = new Map();

	for (const item of value) {
		const year = Math.round(Number(item?.d));
		const count = Math.round(Number(item?.n));

		if (!Number.isFinite(year) || !Number.isFinite(count) || count <= 0 || year > limit) {
			continue;
		}

		const decade = Math.max(DECADE_MIN, Math.floor(year / 10) * 10);
		counts.set(decade, (counts.get(decade) ?? 0) + count);
	}

	// Поля зовутся key и count, как у жанров, а не decade: вес темы делит между
	// названным одна и та же арифметика (см. spread в topics.js), и разные
	// имена полей означали бы, что она молча ничего не насчитает
	return [...counts.entries()].map(([key, count]) => ({ key, count }));
}

/**
 * Область темы в двух написаниях, уже отсеянная и переведённая.
 *
 * Оба написания живут одной парой и умирают тоже парой: countNamed связывает
 * их между собой как одну сущность (см. computeAreas в topics.js), и оставь
 * мы «Cinema» после выброшенного «Кино» — область вернулась бы через заднюю
 * дверь, только по-английски.
 */
function areaOf(answer) {
	const area = cleanArea(cleanFranchise(answer?.a));
	const areaEn = cleanArea(cleanFranchise(answer?.ae), false);

	return area || areaEn
		? { area: area || areaEn, areaEn: areaEn || area }
		: { area: '', areaEn: '' };
}

/** Происхождение названного: те же «ключ — сколько раз», что у жанров. */
const cleanOrigins = value => cleanCounted(value, key => ORIGIN_KEYS.includes(key));

/**
 * Кому какой ответ: раскладывает объекты ответа по темам, которые их вызвали.
 *
 * По номеру темы (поле i), пока номера сходятся, и по порядку, когда не сошлись.
 * Второе — не запасной путь на всякий случай, а починка настоящей беды: одним
 * запросом уезжает несколько паков (см. analyzePacks), нумерация тем у каждого
 * своя и начинается с нуля, и модель на втором-третьем паке нет-нет да и продолжит
 * сквозной счёт первого. Номера тогда не попадают ни в одну тему — и пак, целиком
 * разобранный моделью, доставался нам пустым: ни одной размеченной темы, «прочее»
 * на весь пак, ярлык «солянка» и записанная дата разметки, после которой пак
 * в очередь больше не встанет. Так испортилось около каждого пятого пака.
 *
 * Порядок — надёжная опора, потому что о нём и просит запрос: «по объекту
 * на каждую тему, в том же порядке, в каком темы даны». Берётся он, только когда
 * ответов ровно столько же, сколько тем: иначе непонятно, где именно модель
 * пропустила тему, и подставлять ответы наугад хуже, чем не подставлять.
 *
 * Номера считаются сошедшимися, только если каждый попадает в свою тему и все они
 * разные. Проверка строгая нарочно: сдвинутая на единицу нумерация (1..n вместо
 * 0..n-1) прошла бы частичную проверку и молча приписала каждой теме ответ соседней.
 */
function alignAnswers(batch, answers) {
	const spots = answers.map(answer => Number(answer?.i));
	const byNumber = spots.every(at => Number.isInteger(at) && at >= 0 && at < batch.length)
		&& new Set(spots).size === spots.length;
	const inOrder = answers.length === batch.length;

	return answers.map((answer, index) => ({
		theme: byNumber ? batch[spots[index]] : (inOrder ? batch[index] : undefined),
		answer,
	}));
}

/**
 * Сколько тем модель и вправду разобрала: остальным разметка досталась
 * от молчания (см. UNMARKED).
 */
export function marked(marks) {
	let count = 0;

	for (const mark of marks.values()) {
		if (mark.unmarked !== true) {
			count++;
		}
	}

	return count;
}

/**
 * Раскладывает ответы модели по ключам тем и отсеивает всё, чего в списках нет.
 *
 * Вынесено отдельно, потому что ответ про темы приходит двумя путями: своим
 * запросом (classifyThemes) и вместе с описанием пака одним запросом на всё
 * (analyzePack). Проверять чужие слова оба должны совершенно одинаково.
 *
 * @param {Array} batch темы в том порядке, в каком они уехали к модели
 * @param {Array} answers объекты ответа
 * @param {Map} result куда складывать
 */
export function collectMarks(batch, answers, result = new Map()) {
	for (const { theme, answer } of alignAnswers(batch, answers)) {
		if (theme && EXCLUSIVE_TOPIC_KEYS.includes(answer.c)) {
			result.set(theme.key, {
				category: answer.c,
				music: answer.m === true,
				// Предмет спрашивается у всех категорий, но предметом теперь
				// считается только произведение: пак целиком про Вархаммер —
				// такой же пак про одно, как аниме-пак про «Наруто», а вот
				// «История» и «Футбол» — это не то, к чему пак возвращается
				franchise: cleanFranchise(answer.f),
				// Второе написание нужно не для показа, а чтобы связать между собой
				// темы, названные по-разному (см. franchise.js)
				franchiseEn: cleanFranchise(answer.fe),
				// Область — предмет тех тем, у которых произведения нет вовсе:
				// «Футбол», «Вторая мировая война», «Столицы». Считается врозь
				// от франшиз: в повторы такое не идёт, а подпись паку целиком
				// про одно даёт (см. computeAreas в topics.js).
				//
				// cleanArea поверх общей чистки убирает две беды разом: область,
				// повторяющую ярлык пака («Кино» у кинопака, «Игры» у игропака,
				// «Эрудиция» у солянки), и английское слово там, где его читает
				// человек («erudition» вместо «Эрудиция»)
				...areaOf(answer),
				// Всё, что в теме прозвучало, а не только то, чему она посвящена
				// целиком. Из этого и складываются настоящие повторы пака: тема
				// про «Эдиты» ни одному произведению не посвящена, но ДжоДжо
				// в ней названо — и это пятое упоминание ДжоДжо за пак
				works: cleanWorks(answer.w),
				// Вид «прочего»: чем эта общая куча оказалась на деле — стримерами,
				// историей, спортом. У остальных категорий вида нет и быть не должно
				kind: answer.c === 'other' && OTHER_KIND_KEYS.includes(answer.k) ? answer.k : '',
				// Праздник, по поводу которого тему сделали. Спрашивается у всех
				// категорий и ни с чем не спорит: новогодняя тема про кино
				// остаётся темой про кино, а праздник у неё сверх того
				// (см. computeHolidays в topics.js и HOLIDAYS в names.js)
				holiday: HOLIDAY_KEYS.includes(answer.h) ? answer.h : '',
				// Носитель темы: манга или манхва, фильм или сериал. Отсюда делится
				// верхняя полоска карточки — тот её кусок, который у манга-пака
				// занимает всё и до сих пор не говорил ничего (см. computeForms
				// в topics.js)
				forms: cleanCounted(answer.fs, key => isForm(answer.c, key)),
				// Жанры внутри тематики: чем один аниме-пак отличается от другого.
				// Списком с числами, а не по одному: тема-угадайка называет восемь
				// разных вещей восьми разных жанров, и отдавать её вес одному
				// значило врать (см. computeGenres в topics.js). Годятся только
				// ключи из списка своей категории — «detective» у категории games
				// означал бы, что модель ответила невпопад. У спортивных тем в том
				// же поле едет вид спорта: спорт не категория, а вид «прочего»,
				// и список у него свой (см. GENRES.sport в settings.js)
				genres: cleanCounted(answer.gs, key => isGenre(
					answer.c === 'other' && answer.k === SPORT_KEY ? SPORT_KEY : answer.c,
					key,
				)),
				// Жанры музыки спрашиваются отдельно и живут отдельно: тема
				// с опенингами — это и аниме (genres), и анисонг (musicGenres)
				musicGenres: answer.m === true ? cleanCounted(answer.gms, key => isGenre(MUSIC_KEY, key)) : [],
				// Когда вышло названное в теме и откуда оно родом. Из первого
				// складывается полоска десятилетий, из второго — полоска
				// происхождения: советское, российское, украинское, иностранное
				decades: cleanDecades(answer.y),
				origins: cleanOrigins(answer.og),
			});
		}
	}

	// Темы, по которым модель промолчала, считаем неопределёнными
	for (const theme of batch) {
		if (!result.has(theme.key)) {
			result.set(theme.key, { ...UNMARKED });
		}
	}

	return result;
}

/**
 * Раскладывает темы по категориям.
 * @param {Array<{key: string, name: string, sample: string, media: string}>} themes
 * @param {object} options onProgress — колбэк (сделано, всего)
 * @returns {Promise<Map<string, {category: string, music: boolean, franchise: string}>>} ключ темы -> разметка
 */
export async function classifyThemes(themes, options = {}) {
	const result = new Map();
	let done = 0;

	const process = async batch => {
		if (batch.length === 0) {
			return;
		}

		let answers;

		try {
			answers = await askBatch(batch);

			// Ответ пришёл короче вопроса: модель уперлась в предел длины ответа
			// и оборвалась на середине списка. Прежде это молчание засчитывалось
			// как «тема ни о чём» (см. ниже) — то есть пак, у которого не влезла
			// половина тем, честно получал сорок процентов «прочего» и становился
			// солянкой из ничего. Заметить это можно только здесь и только так:
			// ответ при этом совершенно правильный, просто неполный.
			if (answers.length < batch.length && batch.length > 1) {
				throw new GeminiError(`ответ оборван: ${answers.length} тем из ${batch.length}`, 0);
			}
		} catch (error) {
			// Ответ мог не влезть в лимит — делим пачку и пробуем ещё раз.
			// Но не тогда, когда отвечать уже нечем: на кончившихся лимитах
			// деление пополам только умножало запросы, каждый из которых заведомо
			// получит тот же отказ.
			if (batch.length > 1 && !error.fatal) {
				const middle = Math.ceil(batch.length / 2);
				await process(batch.slice(0, middle));
				await process(batch.slice(middle));
				return;
			}

			throw error;
		}

		collectMarks(batch, answers, result);

		done += batch.length;

		if (options.onProgress) {
			options.onProgress(done, themes.length);
		}
	};

	// Пауз между пачками здесь больше нет: темп держит общая очередь запросов
	// (см. takeTurn), и она считает всех сразу, а не каждого работника по себе
	for (let i = 0; i < themes.length; i += config.geminiBatchSize) {
		await process(themes.slice(i, i + config.geminiBatchSize));
	}

	return result;
}
