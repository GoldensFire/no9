// Как мы разговариваем с Gemini: ключ, выбранная модель, очередь запросов
// и один ответ строгим JSON.
//
// Здесь нет ни единого слова о паках и темах — только доставка. Очередь тут
// главное: у модели два предела разом, запросы в минуту и токены в минуту,
// и оба считаются здесь одним местом (см. takeTurn). Разведи это по шагам —
// и каждый упирался бы в предел сам, не зная про соседей.
//
// Что именно спрашивать, решают соседние файлы:
//
//   theme-prompt.js  текст запроса про темы пака и схема ответа
//   themes.js        разметка тем: категории, жанры, годы, повторы
//   summary.js       краткое описание пака, аудитория и язык
//   analyze.js       всё о паке одним запросом
//   translate.js     перевод строк самого сайта

import { config } from '../config.js';
import {
	currentModel, modelInfo, noteRequest, noteQuotaHit, noteUnavailable,
	searchRefused, noteSearchRefused,
} from '../models.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Есть ли ключ. Без него шаг с тематиками просто пропускается. */
export function hasGemini() {
	return Boolean(config.geminiKey);
}

/**
 * Модель этого запуска. По умолчанию та, что выбрана на странице обновления
 * (она лежит в базе), но ключ --model= перебивает выбор на один раз, не меняя
 * его для ночного обхода.
 */
let chosen = null;

export function useModel(id) {
	chosen = id || null;
}

export function activeModel() {
	return chosen ?? currentModel();
}

export class GeminiError extends Error {
	constructor(message, status, options = {}) {
		super(message);
		this.name = 'GeminiError';
		this.status = status;
		/**
		 * Повторять бессмысленно: неверный ключ, неизвестная модель или кончившиеся
		 * лимиты. По этому признаку индексатор бросает шаг целиком, а не идёт
		 * с той же ошибкой по всем оставшимся пакам (см. quota).
		 */
		this.fatal = options.fatal ?? false;
		/** Суточные лимиты кончились: ждать бесполезно до самой смены суток. */
		this.quota = options.quota ?? false;
		/** Через сколько миллисекунд Gemini разрешает повторить запрос, если сказал. */
		this.retryAfterMs = options.retryAfterMs ?? null;
		/** Суточный предел, названный самим Gemini в отказе. */
		this.dayLimit = options.dayLimit ?? null;
	}
}

/**
 * Сколько Gemini просит подождать. При лимитах он присылает RetryInfo
 * («retryDelay»: «37s»), и это куда честнее нашей лесенки пауз.
 */
function retryDelayFrom(error) {
	for (const detail of error?.details ?? []) {
		const delay = /^(\d+(?:\.\d+)?)s$/.exec(String(detail.retryDelay ?? ''));

		if (delay) {
			return Math.round(Number(delay[1]) * 1000);
		}
	}

	return null;
}

/**
 * Какой именно лимит кончился и чему он равен.
 *
 * Отказ 429 приходит на два разных повода, и путать их дорого. Минутный лимит
 * отпускает через десяток секунд — надо просто подождать. Суточный не отпустит
 * до полуночи в Калифорнии, и ждать его означает потерять ночь. Раньше различить
 * их было нечем, и всякий 429 после трёх попыток объявлялся концом суток.
 *
 * На самом деле Gemini говорит прямо: в подробностях отказа лежит QuotaFailure,
 * а в нём quotaId вида «GenerateRequestsPerDayPerProjectPerModel-FreeTier»
 * и quotaValue — то самое число, которого мы не знали. Отсюда же берётся точный
 * суточный предел модели (см. noteQuotaHit в models.js).
 *
 * @returns {{perDay: boolean, dayLimit: number|null}}
 */
function quotaFailureFrom(error) {
	let perDay = false;
	let dayLimit = null;

	for (const detail of error?.details ?? []) {
		for (const violation of detail.violations ?? []) {
			const id = String(violation.quotaId ?? '') + String(violation.quotaMetric ?? '');
			const value = Number(violation.quotaValue);

			if (/per_?day/i.test(id)) {
				perDay = true;

				if (Number.isFinite(value) && value > 0) {
					dayLimit = value;
				}
			}
		}
	}

	return { perDay, dayLimit };
}

/**
 * Общий на всех темп обращений к модели.
 *
 * Шаги теперь идут одновременно, и тематики с описаниями стучатся к Gemini
 * вдвоём, каждый ещё и несколькими работниками. Пауза «поспать после запроса»
 * такое не удерживает вовсе: считает она только своего работника, а лимит
 * у модели общий и минутный. Поэтому очередь одна на весь процесс: каждый
 * запрос занимает ближайшее свободное окошко, а окошки расставлены по минутному
 * пределу выбранной модели.
 */
let nextSlot = 0;

/**
 * Третий предел Gemini — токены в минуту, и до недавнего времени он нас не касался.
 *
 * Пока в запросе ехало пять паков, запрос весил тысяч десять токенов: пятнадцать
 * таких в минуту — это полтораста тысяч из двухсот пятидесяти, и упереться было
 * не во что. Теперь пачка набирается по вопросам (см. analyzeQuestionBatch),
 * весит вчетверо больше, и минутный предел по токенам стал ближе минутного
 * предела по запросам: пятнадцать запросов по тридцать тысяч — это четыреста
 * тысяч токенов, то есть отказ.
 *
 * Поэтому очередь считает не только запросы, но и токены. Каждый занятый слот
 * записывается сюда вместе со своей ценой, а цена сперва оценивается по длине
 * запроса и тут же уточняется настоящей — Gemini называет её в ответе
 * (usageMetadata). Слоты старше минуты выбрасываются: предел скользящий.
 */
const tokenLog = [];

/**
 * Сколько токенов приходится на знак запроса. Считать это самим незачем и нечем —
 * токенизатор чужой и для кириллицы недобрый (около трёх знаков на токен, а не
 * четырёх, как для латиницы). Поэтому число не задано, а выучивается: после
 * каждого ответа оно подтягивается к тому, что Gemini насчитал на самом деле.
 * Начальное значение — оценка сверху, чтобы первые запросы не проскочили мимо счёта.
 */
let tokensPerChar = 0.45;

/** Какую долю минутного предела занимаем. Остаток — запас на промах оценки. */
const TOKEN_BUDGET = 0.85;

/** Цена запроса в токенах: то, что уедет, плюс то, что приедет обратно. */
function guessTokens(chars) {
	return Math.ceil(chars * tokensPerChar * 1.25);
}

/** Сколько токенов потрачено в минуту, кончающуюся моментом at. */
function tokensAround(at) {
	let sum = 0;

	for (const entry of tokenLog) {
		if (entry.at > at - 60_000) {
			sum += entry.tokens;
		}
	}

	return sum;
}

/**
 * Занимает ближайшее окошко, в которое влезает запрос такой цены.
 * @param {number} tokens во сколько токенов он обойдётся по оценке
 * @returns {Promise<{at: number, tokens: number}>} запись очереди: после ответа
 *   в неё кладётся настоящая цена вместо оценки
 */
async function takeTurn(tokens) {
	const info = modelInfo(activeModel());
	const perMinute = info.rpm || 10;
	const gap = Math.max(config.geminiMinGapMs, Math.round(60_000 / perMinute));
	const budget = (info.tpm || 250_000) * TOKEN_BUDGET;
	const now = Date.now();

	let at = Math.max(now, nextSlot);

	// Отодвигаем, пока в минуту вокруг выбранного момента не поместится и этот
	// запрос. Каждый шаг переносит начало минуты за самый старый занятый слот,
	// поэтому цикл конечен: слоты кончаются
	while (tokensAround(at) + tokens > budget) {
		const oldest = tokenLog
			.filter(entry => entry.at > at - 60_000)
			.reduce((first, entry) => (entry.at < first.at ? entry : first), { at });

		if (oldest.at >= at) {
			break;
		}

		at = oldest.at + 60_001;
	}

	nextSlot = at + gap;

	const entry = { at, tokens };
	tokenLog.push(entry);

	while (tokenLog.length > 0 && tokenLog[0].at <= at - 60_000) {
		tokenLog.shift();
	}

	if (at > now) {
		await sleep(at - now);
	}

	return entry;
}

/** Отодвигает очередь целиком: раз уж уперлись в минутный лимит, ждать всем. */
function holdBack(ms) {
	nextSlot = Math.max(nextSlot, Date.now() + ms);
}

/** Токены за последнюю минуту и предел модели — строкой для лога шага. */
export function tokensLine() {
	const limit = modelInfo(activeModel()).tpm || 250_000;
	const spent = tokensAround(Date.now());

	return `токенов за минуту: ${Math.round(spent / 1000)}К из ${Math.round(limit / 1000)}К`;
}

async function call(path, options = {}) {
	if (!config.geminiKey) {
		throw new GeminiError('нет ключа: положите его в data/gemini-key.txt или в переменную GEMINI_API_KEY', 0, { fatal: true });
	}

	const response = await fetch(`${config.geminiEndpoint}/${path}`, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			'x-goog-api-key': config.geminiKey,
			...options.headers,
		},
	});

	const text = await response.text();

	if (!response.ok) {
		let message = text.slice(0, 300);
		let retryAfterMs = null;
		let quota = { perDay: false, dayLimit: null };

		try {
			const error = JSON.parse(text).error;
			message = error?.message ?? message;
			retryAfterMs = retryDelayFrom(error);
			quota = quotaFailureFrom(error);
		} catch {
			// оставляем как есть
		}

		throw new GeminiError(message, response.status, {
			retryAfterMs,
			quota: quota.perDay,
			dayLimit: quota.dayLimit,
		});
	}

	return JSON.parse(text);
}

/** Список моделей, доступных ключу. */
export async function listModels() {
	const data = await call('models');

	return (data.models ?? [])
		.filter(model => (model.supportedGenerationMethods ?? []).includes('generateContent'))
		.map(model => ({ name: model.name.replace(/^models\//, ''), title: model.displayName }));
}

/**
 * Как попросить модель думать в полную силу.
 *
 * Раньше здесь стояло обратное — «не думай»: раскладка тем по категориям считалась
 * задачей без рассуждений, а рассуждения стоят токенов и времени. На деле задача
 * ровно наоборот: решить, аниме это или манга, вычислить жанр темы-угадайки
 * по восьми чужим друг другу названиям, свести «Наруто Шиппуден» и «Наруто»
 * в одно — всё это и есть рассуждение, и на «низком» уровне модель отвечала
 * первым, что пришло в голову. Поэтому уровень теперь наибольший, и платим мы
 * за него сознательно: суточный предел бесплатного ключа считает ЗАПРОСЫ,
 * а не токены, так что думать дольше — почти бесплатно.
 *
 * Просится это по-разному. У Gemini 3 и новее — thinkingLevel: 'high'
 * (thinkingBudget там отвергается с невнятным «Request contains an invalid
 * argument», без единого слова про thinking). У Gemini 2.x — thinkingBudget,
 * и вместо числа ставится -1: это «думай сколько нужно, потолок свой знаешь сам».
 * Числом потолок задавать нельзя — он у каждой модели свой, и превышение
 * отвергается тем же невнятным 400.
 */
function thinkingConfig() {
	const version = Number.parseFloat(/gemini-(\d+(?:\.\d+)?)/.exec(activeModel())?.[1] ?? '0');
	return version >= 3 ? { thinkingLevel: 'high' } : { thinkingBudget: -1 };
}

/**
 * Поиск и чтение страниц, которыми модель дополняет то, чего не знает сама.
 *
 * Вещи это разные, и дают их по-разному. `urlContext` — открыть названный адрес;
 * он есть у бесплатного ключа и работает всегда. `googleSearch` — настоящий поиск
 * с грундингом; у бесплатного ключа его нет вовсе, и узнаётся это не отказом
 * «нельзя», а внезапным 429 «кончилась квота» на первом же запросе — при том, что
 * суточная квота самой модели цела и не тронута. Принять этот отказ за конец
 * суток означало бы остановить весь ночной обход из-за инструмента, которого
 * у нас и так нет (см. ask: 429 при поиске сначала выключает поиск, а не сутки).
 *
 * Оттого и адреса в SOURCES выбраны так, чтобы поиск был не нужен: страница
 * выдачи DuckDuckGo и поиск по Википедии открываются самим url_context, и модель
 * ищет через них, даже когда googleSearch недоступен.
 *
 * Все три выключателя щёлкаются сами, по первому отказу, и на весь запуск.
 */
let searchOff = searchRefused();
let browseOff = false;
let searchSchemaOff = false;

/** Пользуемся ли внешними источниками в этом запросе. */
const grounded = search => Boolean(search) && config.geminiSearch !== false && !(searchOff && browseOff);

/** Инструменты этого запроса — из тех, что ещё не выключились отказом. */
function groundingTools() {
	const tools = [];

	if (!searchOff) {
		tools.push({ googleSearch: {} });
	}

	if (!browseOff) {
		tools.push({ urlContext: {} });
	}

	return tools;
}

/** Куда модель ходила: и запросы в поиск, и открытые страницы — одним списком для лога. */
function groundingTrace(candidate) {
	const queries = candidate?.groundingMetadata?.webSearchQueries ?? [];
	const urls = (candidate?.urlContextMetadata?.urlMetadata ?? [])
		.filter(item => item.urlRetrievalStatus === 'URL_RETRIEVAL_STATUS_SUCCESS')
		.map(item => item.retrievedUrl);

	return [...queries, ...urls];
}

/**
 * Ответ без схемы приходит обычным текстом, и модель нет-нет да и обернёт его
 * в ```json. Достаём из строки первый же объект или массив.
 */
function parseLoose(text) {
	const clean = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();

	try {
		return JSON.parse(clean);
	} catch {
		// оставляем как есть: попробуем вырезать из середины
	}

	const start = clean.search(/[[{]/);
	const end = Math.max(clean.lastIndexOf(']'), clean.lastIndexOf('}'));

	if (start === -1 || end <= start) {
		throw new GeminiError(`ответ не разобрать как JSON: ${clean.slice(0, 200)}`, 0);
	}

	return JSON.parse(clean.slice(start, end + 1));
}

/**
 * @returns {Promise<{value: any, queries: string[]}>} разобранный ответ и то,
 *   что модель искала в поиске: по этому списку видно, гуглит ли она нужное
 */
async function askOnce(prompt, schema, options = {}) {
	const search = grounded(options.search);
	const withSchema = Boolean(schema) && !(search && searchSchemaOff);

	const body = {
		contents: [{
			role: 'user',
			parts: [{
				text: withSchema
					? prompt
					: `${prompt}\n\nОтветь одним только JSON — без пояснений до и после и без разметки \`\`\`.`,
			}],
		}],
		generationConfig: {
			temperature: 0,
			...(withSchema ? { responseMimeType: 'application/json', responseSchema: schema } : {}),
			...(options.withThinking ? {} : { thinkingConfig: thinkingConfig() }),
		},
		...(search ? { tools: groundingTools() } : {}),
	};

	const model = activeModel();
	const payload = JSON.stringify(body);
	const slot = await takeTurn(guessTokens(payload.length));

	// Расход отмечается до ответа, а не после: в лимит запрос попадает уже тем,
	// что ушёл, и отказ по нему — такая же потраченная попытка, как удача
	noteRequest(model);

	const data = await call(`models/${model}:generateContent`, {
		method: 'POST',
		body: payload,
	});

	// Сколько запрос стоил на самом деле. Оценка в очереди заменяется этим числом,
	// а сама оценка подтягивается к нему — следующие запросы считаются точнее
	const spent = Number(data.usageMetadata?.totalTokenCount);

	if (Number.isFinite(spent) && spent > 0) {
		slot.tokens = spent;
		tokensPerChar = tokensPerChar * 0.8 + (spent / 1.25 / payload.length) * 0.2;
	}

	const candidate = data.candidates?.[0];
	const text = (candidate?.content?.parts ?? []).map(part => part.text ?? '').join('');

	if (!text) {
		throw new GeminiError(`пустой ответ (${candidate?.finishReason ?? 'без причины'})`, 0);
	}

	return {
		value: withSchema ? JSON.parse(text) : parseLoose(text),
		queries: groundingTrace(candidate),
	};
}

/**
 * Модель иногда не понимает thinkingConfig — тогда пробуем без него и запоминаем.
 * Про сам thinkingConfig в ответе может не быть ни слова (см. thinkingConfig),
 * поэтому поводом отказаться от него считаем любой первый 400.
 */
let allowThinkingOff = true;

/**
 * Сколько ждать после отказа по лимиту. Обычно Gemini сам говорит сколько
 * (RetryInfo), но иногда молчит — тогда лесенка пауз, ограниченная сверху:
 * ждать минутами по три раза на каждый пак дороже, чем бросить шаг.
 */
const MAX_QUOTA_WAIT_MS = 30_000;

/** Пауза после «модель перегружена», умножается на номер попытки: 15 с, 30 с. */
const OVERLOAD_WAIT_MS = 15_000;

/** Отказ «модель перегружена»: дело не в нас и не в лимитах, а в чужом всплеске. */
function isOverloaded(error) {
	return error.status === 503 || /high demand|overloaded|UNAVAILABLE/i.test(error.message ?? '');
}

export async function ask(prompt, schema, options = {}) {
	let lastError = null;

	for (let attempt = 1; attempt <= config.geminiRetries; attempt++) {
		try {
			return await askOnce(prompt, schema, { ...options, withThinking: !allowThinkingOff });
		} catch (error) {
			lastError = error;

			// Попытки, потраченные на то, чтобы выяснить, чего эта модель не умеет,
			// в счёт повторов не идут: каждый выключатель щёлкается один раз за
			// запуск, а вот повторов на настоящую ошибку иначе не осталось бы вовсе
			if ((error.status === 400 || error.status === 429) && grounded(options.search)) {
				// Поиска у бесплатного ключа нет, и говорит он об этом отказом
				// «кончилась квота» — при нетронутой суточной квоте самой модели.
				// Поэтому первым делом снимается он: если дело и вправду в сутках,
				// тот же отказ придёт и без поиска, и разберётся с ним общий разбор
				// 429 ниже. Иначе одного этого хватало, чтобы объявить ночь
				// законченной, не разметив ни единого пака.
				if (!searchOff) {
					searchOff = true;
					noteSearchRefused();
					attempt--;
					continue;
				}

				if (error.status === 400 && !searchSchemaOff && schema) {
					searchSchemaOff = true;
					attempt--;
					continue;
				}

				if (error.status === 400) {
					browseOff = true;
					attempt--;
					continue;
				}
			}

			if (allowThinkingOff && error.status === 400) {
				allowThinkingOff = false;
				attempt--;
				continue;
			}

			// Ключ или запрос неверны — повторять бессмысленно
			if (error.status === 400 || error.status === 401 || error.status === 403 || error.status === 404) {
				// Модель закрыли для новых ключей — по списку доступных этого не видно,
				// узнаётся только так. Запоминаем, чтобы на странице обновления она
				// была видна закрытой, а не выглядела рабочей до следующей ночи
				if (/no longer available|is not found|not supported|has been deprecated/i.test(error.message)) {
					noteUnavailable(activeModel(), error.message);
				}

				error.fatal = true;
				throw error;
			}

			// Кончились лимиты. Какие именно — сказано в самом отказе (см.
			// quotaFailureFrom): суточный не отпустит до полуночи в Калифорнии,
			// и ждать его бессмысленно — шаг бросается сразу, вместе с ним
			// запоминается названный предел. Минутный отпускает через десяток
			// секунд: отодвигаем общую очередь и пробуем снова.
			if (error.status === 429) {
				if (error.quota) {
					noteQuotaHit(activeModel(), error.dayLimit);
					error.fatal = true;
					throw error;
				}

				const wait = Math.min(error.retryAfterMs ?? config.geminiDelayMs * attempt * 4, MAX_QUOTA_WAIT_MS);
				holdBack(wait);

				if (attempt < config.geminiRetries) {
					await sleep(wait);
					continue;
				}

				// Про какой лимит речь, Gemini так и не сказал. Считаем суточным:
				// три отказа подряд с ожиданием — это уже не минутная заминка
				noteQuotaHit(activeModel());
				error.fatal = true;
				error.quota = true;
				throw error;
			}

			// Модель перегружена («This model is currently experiencing high
			// demand», 503 UNAVAILABLE). Всплеск у Google длится десятки секунд,
			// и прежние паузы в две-пять секунд он переживал целиком: 18.11.2026
			// пак 21817 так и уехал на сайт без разметки — три отказа подряд
			// за восемь секунд. Ждём дольше, а не сдавшись — помечаем отказ,
			// чтобы шаг мог спросить другую модель (см. overloadSwitch
			// в src/indexer/model.js)
			if (isOverloaded(error)) {
				error.overloaded = true;

				if (attempt < config.geminiRetries) {
					await sleep(OVERLOAD_WAIT_MS * attempt);
				}

				continue;
			}

			if (attempt < config.geminiRetries) {
				await sleep(config.geminiDelayMs * attempt * 2);
			}
		}
	}

	throw lastError;
}
