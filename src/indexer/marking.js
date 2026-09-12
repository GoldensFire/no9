// Разметка паков моделью: тематики, проценты, краткие описания.
//
// Шага здесь три, но пишущее место одно — saveTopics. Так и надо: и «Тематики
// и проценты», и «Всё о паке» получают от модели один и тот же ответ (список
// тем с пометками) и обязаны разложить его по колонкам одинаково. Разведи их
// по разным файлам — и правило «главный предмет считается вот так» завелось бы
// в двух видах сразу.
//
// «Всё о паке» (refreshAnalysis) — это те же два шага, заданные одним запросом:
// суточный лимит Gemini считает запросы, а не темы, и общий вопрос про список
// тем незачем задавать дважды.

import {
	config, TOPICS_VERSION, OTHER_KINDS, GENRES, FORMS, ORIGINS, decadeName,
} from '../config.js';
import { db, normalizeRounds, repeatShare } from '../db.js';
import { activeModel, tokensLine } from '../gemini/api.js';
import { analyzePacks } from '../gemini/analyze.js';
import { classifyThemes } from '../gemini/themes.js';
import { describePack } from '../gemini/summary.js';
import { usageLine } from '../models.js';
import {
	listThemes, computeShares, toPrimary, computeFranchises, computeAreas, computeHolidays,
	computeOtherKinds, computeGenres, computeForms, computeDecades, computeOrigin,
} from '../topics.js';
import { geminiQuotaSpent, geminiReady, noteGeminiFailure } from './model.js';
import { reparse, resummary, retopics, upgrade } from './options.js';
import { drain } from './pipeline.js';
import { say } from './progress.js';
import { priorityOrderSql, queueNote, targetSql, weakerModelSql } from './queue.js';
import { audienceLine, languageLine, saveSummary, updateTopics } from './store.js';

/**
 * Считает по разметке тем всё, что хранится у пака, записывает это и рассказывает
 * в лог, что получилось.
 *
 * Отдельной работой, потому что разметка приходит двумя путями: своим шагом
 * (refreshTopics) и вместе с описанием одним запросом на всё (refreshAnalysis).
 * Считаться и записываться она обязана одинаково — что бы её ни принесло.
 *
 * @param {string} step от чьего имени писать в лог
 * @param {{labelled: number, mixed: number, repeats: number}} tally общий счёт шага
 */
function saveTopics(step, label, row, themes, marks, model, tally) {
	const { shares, questions } = computeShares(themes, marks);
	// Виды «прочего» считаются раньше ярлыка, потому что ярлык на них смотрит:
	// пак, у которого «прочее» почти всё и оно спортивное, — не солянка,
	// а спортпак (см. KIND_PACKS и toPrimary в topics.js)
	const kinds = computeOtherKinds(themes, marks);
	const { topic, share } = toPrimary(shares, questions, kinds);
	// Франшизы и области лежат одним списком, но означают разное: по франшизам
	// считаются повторы, по областям пак целиком про футбол получает подпись
	// (см. computeAreas в topics.js). Кто из них главный — решает доля: ярлык
	// пака про Вторую мировую берётся оттуда же, откуда ярлык пака про «Наруто»
	const repeats = computeFranchises(themes, marks);
	// Праздники едут третьей кучкой в тот же список: пак, сделанный к Новому
	// году или к Хеллоуину, — такой же «пак целиком про одно», как пак про
	// футбол, и мишень ему нужна ровно так же (см. computeHolidays в topics.js)
	const franchises = [...repeats, ...computeAreas(themes, marks), ...computeHolidays(themes, marks)]
		.sort((a, b) => b.share - a.share || b.themes - a.themes);
	const top = franchises[0] ?? null;
	// Жанры считаются от типа пака, поэтому строкой ниже toPrimary:
	// у солянки жанр называть не от чего, и список выйдет пустым
	const genres = computeGenres(themes, marks, topic);
	// Из чего пак сделан по носителю: манга или манхва, кино или сериалы.
	// Спрашивается у двух тематик, и обе — те, у которых ярлык до сих пор
	// молчал о главном (см. FORMS в settings.js)
	const { forms, coverage: formCoverage } = computeForms(themes, marks, topic);
	// Когда вышло названное в паке и откуда оно родом. Считается у всех паков
	// и хранится тоже у всех: показывать это или нет, решает сайт по типу пака
	// (десятилетия у «прочего» смысла не имеют, происхождение — у аниме),
	// а пересчёт порогов и ярлыков модель переспрашивать не должен
	const { decades, coverage: decadeCoverage } = computeDecades(themes, marks);
	const { origins, coverage: originCoverage } = computeOrigin(themes, marks);

	updateTopics.run(
		JSON.stringify(shares ?? {}),
		topic,
		share,
		JSON.stringify(franchises),
		top?.name ?? null,
		top?.share ?? null,
		// Доля повторов хранится готовой: по ней отбирает галочка «мало повторов»,
		// и считать её на лету из этого же JSON выходит впятеро дороже самой
		// выдачи (см. repeatShare в keys.js)
		repeatShare(franchises, config.subjectPackShare),
		JSON.stringify(kinds),
		JSON.stringify(genres),
		genres.length > 0 ? topic : null,
		JSON.stringify(forms),
		forms.length > 0 ? topic : null,
		formCoverage,
		JSON.stringify(decades),
		decadeCoverage,
		JSON.stringify(origins),
		originCoverage,
		Date.now(),
		model,
		row.id,
	);

	if (topic && topic !== 'mixed') {
		tally.labelled++;
	} else if (topic === 'mixed') {
		tally.mixed++;
	}

	if (repeats.length > 0) {
		tally.repeats++;
	}

	const percents = Object.entries(shares ?? {})
		.filter(([key, v]) => key !== 'other' && v > 0)
		.sort((a, b) => b[1] - a[1])
		.map(([key, v]) => `${key} ${Math.round(v * 100)}%`)
		.join(', ');

	// Повторы — вторая строка: в одну с процентами они не влезают. Области
	// в неё не идут: повтором они не считаются, и место им в строке ниже
	const repeated = repeats
		.map(f => `${f.name} ×${f.themes}`)
		.join(', ');

	// Мишень пака: и область («Футбол»), и праздник («Новый год»). Обе отвечают
	// на один вопрос — «про что этот пак весь», — и в логе им место одной строкой
	const areas = franchises
		.filter(f => f.kind !== 'work')
		.map(f => `${f.name} ${Math.round(f.share * 100)}%`)
		.join(', ');

	say(step, `${label} «${row.name}»: ${percents || 'ничего тематического'} -> ${topic ?? 'мало вопросов'}`);

	if (repeated) {
		say(step, `      повторы: ${repeated}`);
	}

	if (areas) {
		say(step, `      предмет: ${areas}`);
	}

	// Чем оказалось «прочее»: без этой строки в логе видно только
	// «прочего 40%», а сорок процентов чего — непонятно
	if (kinds.length > 0) {
		say(step, `      прочее: ${kinds.map(kind => `${OTHER_KINDS[kind.key]} ${Math.round(kind.share * 100)}%`).join(', ')}`);
	}

	// Чем этот музпак отличается от соседнего: рэп внутри или опенинги
	if (genres.length > 0) {
		const names = GENRES[topic].list;
		say(step, `      ${GENRES[topic].question.toLowerCase()} `
			+ genres.map(genre => `${names[genre.key]} ${Math.round(genre.share * 100)}%`).join(', '));
	}

	// Из чего пак сделан по носителю. Покрытие рядом по той же причине, что
	// у годов: «манхва 100%» по одной теме из тридцати — это не про пак
	if (forms.length > 0) {
		const names = FORMS[topic].list;
		say(step, `      ${FORMS[topic].question.toLowerCase()} `
			+ forms.map(form => `${names[form.key]} ${Math.round(form.share * 100)}%`).join(', ')
			+ ` (по ${Math.round(formCoverage * 100)}% тематики)`);
	}

	// Каких лет пак и чьё в нём содержимое. Покрытие пишется рядом нарочно:
	// «нулевые 60%» по четверти пака и по всему паку — это разные утверждения,
	// и в логе они обязаны различаться
	if (decades.length > 0) {
		say(step, `      годы: ${decades.map(d => `${decadeName(d.key)} ${Math.round(d.share * 100)}%`).join(', ')}`
			+ ` (по ${Math.round(decadeCoverage * 100)}% пака)`);
	}

	if (origins.length > 0) {
		say(step, `      откуда: ${origins.map(o => `${ORIGINS[o.key]} ${Math.round(o.share * 100)}%`).join(', ')}`
			+ ` (по ${Math.round(originCoverage * 100)}% пака)`);
	}
}

/** Раскладывает темы паков по тематикам и считает доли. */
export async function refreshTopics() {
	if (!geminiReady('topics')) {
		return;
	}

	// Разметка старее нынешних правил считается отсутствующей: доли в ней означают
	// не то же самое, что теперь (см. TOPICS_VERSION).
	const weaker = weakerModelSql('topics_model');
	const condition = retopics
		? ''
		: `AND (p.topics_at IS NULL OR p.topics_version < ${TOPICS_VERSION}${weaker.where})`;
	const target = targetSql();
	const priority = priorityOrderSql('topics');
	const pending = db.prepare(`
		SELECT p.id, p.name, p.rounds FROM packages p
		WHERE p.status = 'ok' AND p.rounds <> '[]' ${condition}${target.where}
		ORDER BY ${priority.order}
	`);

	const params = [...(retopics ? [] : weaker.params), ...target.params, ...priority.params];
	const queue = pending.all(...params);

	say('topics', `через ${activeModel()}${queueNote()}: паков без разметки ${queue.length}`
		+ `${upgrade ? ' (считая размеченные моделью послабее)' : ''}. ${usageLine(activeModel())}`);

	// Паки, разобранные старой версией, хранят только названия тем — по ним модель угадывает плохо
	const withoutSamples = queue.filter(row => !normalizeRounds(row.rounds).some(r => r.themes.some(t => t.sample))).length;

	if (withoutSamples > queue.length / 5) {
		say('topics', `у ${withoutSamples} паков нет образцов ответов: сначала стоит выполнить node src/indexer.js --parse-only --reparse`);
	}

	const tally = { labelled: 0, mixed: 0, repeats: 0 };

	await drain({
		step: 'topics',
		jobs: Math.max(1, config.geminiJobs),
		stop: () => geminiQuotaSpent,
		take: () => pending.all(...params),
		work: async (row, bar) => {
			const themes = listThemes(row.id, normalizeRounds(row.rounds));
			const label = bar.label();

			// Тем нет вовсе — размечать нечего, но отметиться шаг обязан. Пока он
			// молча уходил, такой пак стоял в очереди каждую ночь до скончания
			// века и каждую же ночь молча из неё выпадал: на сайте он числился
			// «Без разметки», а в логе не было ни строчки о том, почему. Теперь
			// он размечается пустотой — «смотрели, смотреть нечего»
			if (themes.length === 0) {
				saveTopics('topics', label, row, themes, new Map(), activeModel(), tally);
				return;
			}

			const model = activeModel();

			try {
				const marks = await classifyThemes(themes);
				saveTopics('topics', label, row, themes, marks, model, tally);
			} catch (error) {
				say('topics', `${label} «${row.name}»: ${error.message}`);

				// Ключ, модель или кончившиеся лимиты — дальше будет то же самое.
				// Кроме одного случая: кончившиеся сутки переживаются переходом
				// на запасную модель (см. noteGeminiFailure в src/indexer/model.js)
				noteGeminiFailure('topics', error, model);
			}
		},
	});

	say('topics', `ярлык получили ${tally.labelled} паков, солянок ${tally.mixed}, `
		+ `с повторами франшиз ${tally.repeats}. ${usageLine(activeModel())}`);
}

/**
 * Просит модель описать каждый пак одной строкой: о чём он вообще.
 *
 * Описание составляется всем разобранным пакам без исключения — в том числе тем,
 * под которыми в обсуждении уже написано целое сочинение. Это разные вещи и стоят
 * они на карточке порознь: авторский текст — слова выложившего, как он их написал,
 * а эта строка — то, что в паке на самом деле, по ответам его вопросов. Первое
 * бывает и на десять абзацев, и «всем привет, вот пак», и рассказывает скорее
 * о поводе, чем о содержимом.
 */
export async function refreshSummaries() {
	if (!geminiReady('summary')) {
		return;
	}

	const weaker = weakerModelSql('summary_model');
	// Паку, описанному до появления оценки аудитории или вопроса про язык, вопрос
	// задаётся заново: спрашиваются они тем же запросом, что и описание,
	// и переспросить его — единственный способ их получить (см. audience_at
	// и language_ai в db.js)
	const condition = resummary
		? ''
		: `AND (p.summary_at IS NULL OR p.audience_at IS NULL OR p.language_ai IS NULL${weaker.where})`;
	const target = targetSql();
	const priority = priorityOrderSql('summary');
	const pending = db.prepare(`
		SELECT p.id, p.name, p.rounds, p.comment_text, p.language FROM packages p
		WHERE p.status = 'ok' ${condition}${target.where}
		ORDER BY ${priority.order}
	`);

	const params = [...(resummary ? [] : weaker.params), ...target.params, ...priority.params];

	say('summary', `через ${activeModel()}${queueNote()}: паков без описания ${pending.all(...params).length}`
		+ `${upgrade ? ' (считая описанные моделью послабее)' : ''}. ${usageLine(activeModel())}`);

	let described = 0;
	let silent = 0;

	await drain({
		step: 'summary',
		jobs: Math.max(1, config.geminiJobs),
		stop: () => geminiQuotaSpent,
		take: () => pending.all(...params),
		work: async (row, bar) => {
			const themes = listThemes(row.id, normalizeRounds(row.rounds));
			const label = bar.label();

			const model = activeModel();

			try {
				const { summary, translations, audience, language } = await describePack({
					name: row.name ?? '',
					about: row.comment_text ?? '',
					themes,
				});

				saveSummary(row, model, summary, audience, language, translations);

				if (summary) {
					described++;
				} else {
					silent++;
				}

				say('summary', `${label} «${row.name}»: ${summary || 'сказать нечего'}`);
				say('summary', `      ${audienceLine(audience)}`);
				say('summary', `      ${languageLine(language, row.language)}`);
			} catch (error) {
				say('summary', `${label} «${row.name}»: ${error.message}`);

				noteGeminiFailure('summary', error, model);
			}
		},
	});

	say('summary', `описание получили ${described} паков${silent ? `, сказать нечего про ${silent}` : ''}. ${usageLine(activeModel())}`);
}

/**
 * Сколько вопросов в теме, у которой это число не записано.
 *
 * Такие темы остались от старого разбора (в базе у них questions = 0), а размер
 * пачки без них считался бы неверно: пак из тридцати «пустых» тем выглядел бы
 * невесомым и уезжал бы к модели вместе с десятком таких же. Пять с небольшим —
 * среднее по всей базе (480 тысяч вопросов на 88 тысяч тем).
 */
const QUESTIONS_PER_THEME = 5;

/**
 * Чем пак тяжёл для модели: сколько в нём тем и сколько вопросов.
 * Считается по сохранённым раундам, не разбирая их в темы целиком, — нужно это
 * только затем, чтобы набрать пачку по размеру (см. groupForAnalysis).
 */
function packWeight(row) {
	let themes = 0;
	let questions = 0;

	for (const round of normalizeRounds(row.rounds)) {
		for (const theme of round.themes) {
			themes++;
			questions += theme.questions > 0 ? theme.questions : QUESTIONS_PER_THEME;
		}
	}

	return { themes, questions };
}

/**
 * Делит очередь на пачки, которые уедут к модели одним запросом.
 *
 * Главное число здесь — вопросы (analyzeQuestionBatch): цена запроса это цена
 * содержимого, а содержимое темы тем длиннее, чем больше в ней вопросов. Паками
 * мерить нельзя вовсе — пак бывает и на тридцать вопросов, и на тысячу двести,
 * и «пять паков» означало то восемь тысяч токенов, то шестьдесят.
 *
 * Рядом стоят два предохранителя: сколько паков (analyzePackBatch — тысяча
 * вопросов может набраться и двумя десятками крошечных) и сколько тем
 * (analyzeThemeBatch — в ответе по объекту на тему, и его длину считают темы).
 * Что кончится раньше, то и закрывает пачку.
 *
 * Пак, который один перебирает любой из пределов, едет один: разрезать пак между
 * запросами нельзя — описание и аудиторию модель называет по всему списку сразу.
 */
function groupForAnalysis(rows) {
	const maxPacks = Math.max(1, config.analyzePackBatch);
	const maxThemes = Math.max(1, config.analyzeThemeBatch);
	const maxQuestions = Math.max(1, config.analyzeQuestionBatch);
	const groups = [];
	let current = [];
	let themes = 0;
	let questions = 0;

	for (const row of rows) {
		const weight = packWeight(row);
		const full = current.length >= maxPacks
			|| themes + weight.themes > maxThemes
			|| questions + weight.questions > maxQuestions;

		if (current.length > 0 && full) {
			groups.push(current);
			current = [];
			themes = 0;
			questions = 0;
		}

		current.push(row);
		themes += weight.themes;
		questions += weight.questions;
	}

	if (current.length > 0) {
		groups.push(current);
	}

	return groups;
}

/**
 * Проценты категорий и краткое описание — одним запросом на несколько паков.
 *
 * Этим шагом заменяются оба предыдущих, когда выбраны они вместе (см. selectedSteps в src/indexer/steps.js).
 * Смысл замены — суточный лимит: он считает запросы, а не темы, и пак, стоивший
 * два запроса, стоит теперь один. Список тем при этом уезжает наверх один раз
 * вместо двух — то есть за ту же ночь бесплатный ключ проходит вдвое больше паков.
 *
 * Дальше та же мысль доведена до конца: раз считаются запросы, в одном запросе
 * едет сразу несколько паков (см. analyzePackBatch в config.js и analyzePacks
 * в src/gemini/analyze.js). Пятеро в запросе — это и впятеро больше паков за сутки,
 * и впятеро быстрее по минутам: минутный предел тоже считает запросы, и очередь
 * (см. takeTurn) расставляет их по четыре секунды друг от друга, сколько
 * работников ни поставь.
 *
 * Очередь общая: сюда берётся пак, которому не хватает хоть чего-то одного —
 * хоть разметки, хоть описания, — и получает он сразу оба. Спрашивать про
 * описание отдельно, когда список тем всё равно уже отправлен, было бы странно.
 */
export async function refreshAnalysis() {
	if (!geminiReady('analyze')) {
		return;
	}

	const weakTopics = weakerModelSql('topics_model');
	const weakSummary = weakerModelSql('summary_model');
	const needTopics = retopics
		? '1'
		: `(p.topics_at IS NULL OR p.topics_version < ${TOPICS_VERSION}${weakTopics.where})`;
	// language_ai IS NULL — «про язык не спрашивали ни разу». Отдельным условием,
	// потому что паки, описанные до появления вопроса про язык, иначе не встали бы
	// в очередь никогда: summary_at и audience_at у них давно проставлены
	const needSummary = resummary
		? '1'
		: `(p.summary_at IS NULL OR p.audience_at IS NULL OR p.language_ai IS NULL${weakSummary.where})`;
	const target = targetSql();
	const priority = priorityOrderSql('analyze');

	// comment_text — это то, что автор написал под паком в обсуждении: единственное
	// место, где сказано, что он задумывал. Модели оно уходит подсказкой, а не
	// истиной: в описании бывает «чистое аниме» у пака, где треть тем про игры
	// (см. PACK_CONTEXT в src/gemini/summary.js)
	const pending = db.prepare(`
		SELECT p.id, p.name, p.rounds, p.comment_text, p.language FROM packages p
		WHERE p.status = 'ok' AND (${needTopics} OR ${needSummary})${target.where}
		ORDER BY ${priority.order}
	`);

	const params = [
		...(retopics ? [] : weakTopics.params),
		...(resummary ? [] : weakSummary.params),
		...target.params,
		...priority.params,
	];

	say('analyze', `через ${activeModel()}${queueNote()}: паков без разметки или описания ${pending.all(...params).length}`
		+ `${upgrade ? ' (считая размеченные моделью послабее)' : ''}. `
		+ `Спрашиваю одним запросом про ${config.analyzeQuestionBatch} вопросов сразу `
		+ `(это сколько паков придётся — от одного до ${config.analyzePackBatch}). `
		+ usageLine(activeModel()));

	const tally = { labelled: 0, mixed: 0, repeats: 0 };
	let described = 0;
	let silent = 0;
	let split = 0;

	await drain({
		step: 'analyze',
		jobs: Math.max(1, config.geminiJobs),
		stop: () => geminiQuotaSpent,
		take: () => pending.all(...params),
		group: groupForAnalysis,
		work: async (rows, bar) => {
			const packs = rows.map(row => ({
				row,
				themes: listThemes(row.id, normalizeRounds(row.rounds)),
				label: bar.label(),
			}));

			const model = activeModel();

			try {
				const answers = await analyzePacks(packs.map(pack => ({
					name: pack.row.name ?? '',
					about: pack.row.comment_text ?? '',
					themes: pack.themes,
				})));

				packs.forEach(({ row, themes, label }, index) => {
					const answer = answers[index];

					// Пак без разобранных тем описание всё равно получает — по названию
					// и тегам, — а вот доли считать не из чего. Отметиться шаг обязан
					// и тогда: без записи такой пак встаёт в очередь каждую ночь
					// и каждую же ночь молча из неё выпадает (см. refreshTopics)
					saveTopics('analyze', label, row, themes, themes.length > 0 ? answer.marks : new Map(), model, tally);

					saveSummary(row, model, answer.summary, answer.audience, answer.language, answer.translations);

					if (answer.summary) {
						described++;
					} else {
						silent++;
					}

					say('analyze', `${themes.length > 0 ? '     ' : `${label} «${row.name}»:`} `
						+ `описание: ${answer.summary || 'сказать нечего'}`);

					// Кому этот пак: возраст и пол — оценка модели по содержимому,
					// а не статистика игроков (см. AUDIENCE_RULES в src/gemini/summary.js)
					say('analyze', `      ${audienceLine(answer.audience)}`);

					// Какой язык модель насчитала этому паку. Стоит рядом
					// с аудиторией и по той же причине: и то, и другое — её
					// суждение, а не запись из файла (см. languageLine в src/indexer/store.js)
					say('analyze', `      ${languageLine(answer.language, row.language)}`);

					// Что модель искала в поиске. Строка нужна не для красоты: по ней
					// видно, гуглит ли она то, о чём пак, — или само шуточное название
					// темы, из которого не следует ничего (см. SOURCES в src/gemini/theme-prompt.js)
					if (answer.queries?.length > 0) {
						say('analyze', `      искала: ${answer.queries.slice(0, 6).join(' | ')}`);
					}

					// Одним запросом не вышло — пак разобран по-старому, двумя.
					// Считаем такие: если их много, стоит уменьшить паки, а не гадать
					if (answer.split) {
						split++;
						say('analyze', `      одним запросом не вышло (${answer.reason}), спросил двумя`);
					}
				});
			} catch (error) {
				// Ошибка тут одна на всю пачку: паки в ней разбираются одним
				// запросом, и отказ означает, что не разобран ни один
				say('analyze', `${packs.map(pack => `${pack.label} «${pack.row.name}»`).join(', ')}: ${error.message}`);

				noteGeminiFailure('analyze', error, model);
			}
		},
	});

	say('analyze', `ярлык получили ${tally.labelled} паков, солянок ${tally.mixed}, `
		+ `с повторами франшиз ${tally.repeats}; описание получили ${described}`
		+ `${silent ? `, сказать нечего про ${silent}` : ''}`
		+ `${split ? `. Двумя запросами пришлось спросить про ${split}` : ''}. `
		+ `${usageLine(activeModel())}; ${tokensLine()}`);
}
