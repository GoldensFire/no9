// Индексатор: собирает паки из обсуждений ВК, разбирает их и подтягивает статистику.
//
//   node src/indexer.js                 полный проход
//   node src/indexer.js --vk-only       только обойти обсуждения: новое и правки
//   node src/indexer.js --parse-only    только разобрать нерасобранные паки
//   node src/indexer.js --stats-only    только обновить статистику: все паки заново
//   node src/indexer.js --stats-new     статистика и сложность только у тех, у кого их нет
//   node src/indexer.js --topics-only   только определить тематики через Gemini
//   node src/indexer.js --summary-only  только составить краткие описания паков
//   node src/indexer.js --logos         только докачать логотипы
//   node src/indexer.js --specials      досчитать спецвопросы у старых паков
//   node src/indexer.js --prints        снять отпечатки вопросов у старых паков (по ним ищется списанное)
//   node src/indexer.js --durations    померить длительность медиафайлов (среднюю и самую большую)
//   node src/indexer.js --merge-authors свести подписи одного человека: паки с одной страницы ВК — один автор
//   node src/indexer.js --copies        пометить копии паков: на сайте остаётся самая ранняя выкладка
//   node src/indexer.js --plagiarism    пересмотреть, кто у кого списал: без сети, по отпечаткам вопросов
//   node src/indexer.js --reparse       разобрать заново уже разобранные паки
//   node src/indexer.js --retopics      переспросить Gemini даже про уже размеченные паки
//   node src/indexer.js --resummary     переписать уже готовые описания
//   node src/indexer.js --upgrade       переспросить то, что размечено моделью слабее нынешней
//   node src/indexer.js --recalc        пересчитать уровни и ярлыки по сохранённым данным, без сети
//   node src/indexer.js --steps=a,b     явный список шагов: vk, parse, stats, statsnew, topics, summary, logos, specials, prints, durations, authors, copies, plagiarism, recalc
//   node src/indexer.js --model=имя     разово взять другую модель Gemini
//   node src/indexer.js --fallback      кончились суточные запросы — перейти на запасную модель
//   node src/indexer.js --fallback=any  то же, но на любую другую, начиная с самой мощной
//   node src/indexer.js --gemini-models показать доступные модели Gemini
//   node src/indexer.js --gemini-usage  показать расход запросов за сегодня
//   node src/indexer.js --pages=5       ограничить число страниц обсуждения
//   node src/indexer.js --limit=20      ограничить число обрабатываемых паков
//   node src/indexer.js --jobs=8        сколько паков разбирать одновременно
//   node src/indexer.js --packs=12,34   работать только с этими паками (номера из адреса /pack/N)
//   node src/indexer.js --authors=А,Б   работать только с паками этих авторов
//   node src/indexer.js --fresh=3       только паки, выложенные за последние трое суток
//   node src/indexer.js --tail          обойти не тему целиком, а её хвост: то, чего прошлый такой обход не читал
//   node src/indexer.js --first=virgin  чем начинать очередь: fresh (свежие, по умолчанию),
//                                       virgin (совсем неразобранные, потом самые давние),
//                                       oldest (самые давние)
//   node src/indexer.js --force         не пропускать уже сделанное: всё заново
//   node src/indexer.js --retry         попробовать заново паки с ошибками
//   node src/indexer.js --serial        по-старому: шаги друг за другом, а не разом
//
// Шаги можно сочетать: --stats-only --topics-only сделает и то, и другое.
// Тем же пользуется страница обновления базы — см. web/update.html.
//
// ————— Точечное обновление —————
//
// `--packs=` и `--authors=` сужают все шаги, кроме обхода ВК, до перечисленных
// паков: «обнови вот этот пак» и «пройди заново по пакам вот этого автора».
// Обход обсуждений при этом не идёт вовсе — искать новое в теме ради одного пака
// незачем, а других способов сузить его нет: обсуждение не спрашивают по автору.
//
// Вместе с ними обычно нужен `--force`: шаги по своему устройству берут только
// то, чего в базе ещё нет, а точечное обновление затевают как раз ради того,
// чтобы переделать уже сделанное. Один ключ вместо четырёх галочек — та же
// «переделать заново», но сразу везде.
//
// ————— Почему шаги идут разом —————
//
// Раньше проход был лесенкой: обойти ВК, потом разобрать паки, потом статистика,
// потом Gemini. Каждая ступень ждала предыдущую целиком, и почти всё это время
// ничего не происходило — каждый шаг упирается в ожидание своего собеседника
// и ничем не мешает остальным. Обход ВК занимает канал на десяток минут, статистика
// стучится на vladimirkhil.com, Gemini считает своё, разбор ходит в хранилище ВК.
// Общего у них — только база, а она своя, местная и мгновенная.
//
// Теперь шаги — не ступени, а полосы: все начинаются сразу и разбирают работу
// по мере её появления. Пак, найденный в обсуждении на второй минуте, тут же
// уходит в разбор; разобранный — тут же в статистику и к модели. Полоса, у которой
// работа кончилась, не заканчивается, пока может прибыть новая: она ждёт и берёт
// добавку (см. drain в src/indexer/pipeline.js). Ключ --serial возвращает прежний порядок — иногда нужно
// именно по одному, чтобы разглядеть, что происходит.

//
// ————— Из чего он собран —————
//
// Сам этот файл — только сборка: разобрать ключи, завести полосы, запустить
// шаги и подвести итог. Всё остальное лежит рядом, в src/indexer/:
//
//   options.js    ключи командной строки: их читают все шаги подряд
//   progress.js   Track, say() и полоска для страницы обновления
//   queue.js      из чего складывается очередь шага и в каком она порядке
//   store.js      заготовленные запросы: всё, что обход пишет о паке
//   steps.js      расписание: имена шагов, кто кого кормит, кто кого ждёт
//   tail.js       докуда ежечасный обход дочитал обсуждения в прошлый раз
//   pipeline.js   drain(): полоса работы, у которой работа прибывает на ходу
//   vk-scan.js    обход обсуждений
//   parse.js      разбор архивов и логотипы
//   backfill.js   отпечатки, длительность, спецвопросы у старых паков
//   sistats.js    статистика с сервиса SIGame
//   model.js      кончившиеся лимиты Gemini и переход на запасную модель
//   marking.js    разметка моделью: тематики, описания, «всё о паке»
//   authors.js    один автор — один человек
//   copies.js     копии паков
//   plagiarism.js кто у кого списал
//   recalc.js     пересчёт уровней и ярлыков без сети

import { db } from './db.js';
import { hasGemini, activeModel, listModels } from './gemini/api.js';
import { discoverModels } from './gemini/discover.js';
import { usageLine, usageReport } from './models.js';
import { has, serial } from './indexer/options.js';
import { report, TAGS, Track, track, tracks } from './indexer/progress.js';
import { beginRun, isChosen, markFinished, selectedSteps } from './indexer/steps.js';
import { scanVk } from './indexer/vk-scan.js';
import { fetchLogos, hasThumb, parsePackages } from './indexer/parse.js';
import { fetchDurations, fetchPrints, fetchSpecials } from './indexer/backfill.js';
import { refreshStats } from './indexer/sistats.js';
import { refreshAnalysis, refreshSummaries, refreshTopics } from './indexer/marking.js';
import { mergeAuthors } from './indexer/authors.js';
import { markCopies } from './indexer/copies.js';
import { checkPlagiarism } from './indexer/plagiarism.js';
import { recalcAll } from './indexer/recalc.js';

function printSummary() {
	const total = db.prepare('SELECT COUNT(*) AS c FROM packages').get().c;
	const parsed = db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE status = 'ok'`).get().c;
	const errors = db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE status = 'error'`).get().c;
	const deadLinks = db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE status = 'dead'`).get().c;
	const gone = db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE status = 'gone'`).get().c;
	// Паки, которые наполовину и больше держатся на чужих ссылках: на сайте
	// их нет, но в базе они есть и вернутся, если автор перезальёт пак
	// с файлами внутри (см. recalcOffsite в src/indexer/recalc.js)
	const offsite = db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE status = 'offsite'`).get().c;
	const waiting = db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE status = 'new'`).get().c;
	const withStats = db.prepare('SELECT COUNT(*) AS c FROM stats WHERE found = 1').get().c;
	const withLogo = db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE logo_state = 'ok'`).get().c;
	// Логотип по базе есть, а показать его нечем: строка пака уедет наверх
	// со ссылкой на обложку, которой на хостинге не окажется, — и посетитель
	// увидит квадрат с первой буквой названия. Считается по складу копий,
	// потому что в базе такому случаю пометки нет (см. fetchLogos в indexer/parse.js)
	const noThumb = db.prepare(`SELECT logo_file FROM packages WHERE logo_state = 'ok' AND logo_file IS NOT NULL`)
		.all().filter(row => !hasThumb(row.logo_file)).length;
	const described = db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE summary IS NOT NULL AND summary <> ''`).get().c;
	// Главный предмет — франшиза или область, что из них крупнее (см. saveTopics в src/indexer/marking.js)
	const withSubject = db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE franchise_top IS NOT NULL`).get().c;
	// Спецвопросы считаются при разборе: у паков, разобранных раньше, их число неизвестно
	const specials = db.prepare(`SELECT COUNT(*) AS c FROM packages WHERE status = 'ok' AND special_count IS NULL`).get().c;
	const levels = db.prepare('SELECT level, COUNT(*) AS c FROM stats WHERE level IS NOT NULL GROUP BY level ORDER BY level DESC').all();
	const topics = db.prepare('SELECT primary_topic, COUNT(*) AS c FROM packages WHERE primary_topic IS NOT NULL GROUP BY primary_topic ORDER BY c DESC').all();
	const byModel = db.prepare(`
		SELECT COALESCE(topics_model, 'до появления пометки') AS model, COUNT(*) AS c
		FROM packages WHERE topics_at IS NOT NULL GROUP BY model ORDER BY c DESC
	`).all();

	console.log('');
	console.log('=== Итого');
	console.log(`Паков в базе: ${total} (разобрано ${parsed}, мёртвых ссылок ${deadLinks}, с ошибками ${errors}`
		+ `${gone > 0 ? `, убрано из обсуждения ${gone}` : ''}`
		+ `${offsite > 0 ? `, на чужих ссылках ${offsite}` : ''}`
		+ `${waiting > 0 ? `, ждут разбора ${waiting}` : ''})`);
	console.log(`Есть статистика: ${withStats}. С логотипом: ${withLogo}`
		+ `${noThumb > 0 ? ` (показать нечем у ${noThumb} — их доделает шаг «логотипы»)` : ''}`
		+ `. С описанием: ${described}. С предметом: ${withSubject}.`);

	if (specials > 0) {
		console.log(`Спецвопросы не посчитаны у ${specials} паков: они разобраны раньше, чем их научились считать.`);
		console.log('  Посчитать: node src/indexer.js --specials');
	}

	const names = { 4: 'лёгкий', 3: 'средний', 2: 'сложный', 1: 'очень сложный' };

	for (const level of levels) {
		console.log(`  ${names[level.level]}: ${level.c}`);
	}

	if (topics.length > 0) {
		console.log('Тематики:');

		for (const topic of topics) {
			console.log(`  ${topic.primary_topic}: ${topic.c}`);
		}
	}

	if (byModel.length > 0) {
		console.log('Чем размечено:');

		for (const row of byModel) {
			console.log(`  ${row.model}: ${row.c}`);
		}
	}

	if (hasGemini()) {
		console.log(`Расход Gemini: ${usageLine(activeModel())} (${activeModel()})`);
	}
}

// ————— служебные ключи, после которых ничего не делается —————

if (has('--gemini-models')) {
	try {
		for (const model of await listModels()) {
			console.log(`${model.name.padEnd(40)} ${model.title ?? ''}`);
		}
	} catch (error) {
		console.error(`Не вышло получить список моделей: ${error.message}`);
	}

	process.exit(0);
}

if (has('--gemini-usage')) {
	const state = usageReport();
	console.log(`Расход за сутки ${state.day} (по тихоокеанскому времени: там сбрасываются квоты Google)`);

	for (const model of state.models) {
		const limit = model.limit === null ? 'предел неизвестен' : `${model.spent} из ${model.exact ? '' : '≈'}${model.limit}`;
		const state_ = model.unavailable ? ' — закрыта для этого ключа' : model.spentOut ? ' — лимит кончился' : '';
		console.log(`  ${model.current ? '*' : ' '} ${model.id.padEnd(26)} ${limit}${state_}`);
	}

	console.log('Звёздочкой отмечена выбранная модель. Точные пределы (без «≈») — те, что Gemini назвал сам, отказав.');
	process.exit(0);
}

/**
 * Что каждый шаг делает. Само расписание — имена, порядок, кто кого кормит —
 * лежит в indexer/steps.js: там оно нужно ещё и полосам работы, чтобы знать,
 * прибудет ли им добавка (см. drain в src/indexer/pipeline.js). Здесь только привязка ключа к работе,
 * и она обязана быть здесь: шаги и расписание иначе знали бы друг о друге
 * по кругу.
 */
const RUNNERS = {
	vk: scanVk,
	parse: parsePackages,
	stats: () => refreshStats('all'),
	statsnew: () => refreshStats('new'),
	topics: refreshTopics,
	summary: refreshSummaries,
	analyze: refreshAnalysis,
	logos: fetchLogos,
	specials: fetchSpecials,
	prints: fetchPrints,
	durations: fetchDurations,
	authors: mergeAuthors,
	copies: markCopies,
	plagiarism: checkPlagiarism,
	recalc: recalcAll,
};

// Не вышла ли у ключа модель новее тех, что в списке. Спрашивается раз в сутки
// и квоты не тратит: ListModels — метаданные, а не запрос к модели
// (см. discoverModels в src/gemini/discover.js). Стоит до самих шагов, чтобы
// найденное было видно и в очереди «переспросить размеченное послабее»,
// и на странице обновления, — а не со следующего запуска.
for (const found of await discoverModels()) {
	console.log(`У ключа появилась модель ${found} — вписал её в список разметчиков.`);
}

const steps = selectedSteps();

beginRun(steps);

for (const step of steps) {
	tracks.set(step.key, new Track(step.key));
}

report({ plan: steps.map(step => ({ key: step.key, name: step.name })) });

let broke = false;

/** Один шаг: дождаться тех, после кого положено, сделать своё, отметиться. */
async function runStep(step, waitFor) {
	await Promise.all(waitFor);
	report({ step: step.key, state: 'start' });

	try {
		await RUNNERS[step.key]();
	} catch (error) {
		broke = true;
		console.error(`[${TAGS[step.key]}] шаг сорвался: ${error.message}`);
	} finally {
		markFinished(step.key);
		track(step.key).finish();
	}
}

const started = new Map();

for (const step of steps) {
	// Ждать надо только тех, кого в этот запуск действительно позвали
	const waitFor = (step.after ?? [])
		.filter(key => isChosen(key))
		.map(key => started.get(key))
		.filter(Boolean);

	// Последовательный режим ждёт всех, кто уже запущен: это и есть прежний порядок
	started.set(step.key, runStep(step, serial ? [...started.values()] : waitFor));
}

await Promise.all(started.values());

printSummary();

// Сорвавшийся шаг не должен выглядеть удачным запуском: по коду выхода ночной
// обход решает, выкладывать ли собранное наверх (см. scripts/nightly.js).
if (broke) {
	process.exitCode = 1;
}
