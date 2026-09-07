// Пересчёт по тому, что уже лежит в базе: уровни сложности и ярлыки паков.
//
// Ни сети, ни модели — применяет нынешние пороги из настроек к сохранённым
// числам. Нужен после правки порогов: разметку при этом никто не переспрашивает,
// меняется только то, как из неё делаются выводы.

import { config, MISC_KEY } from '../config.js';
import { db, jsonOrDefault, markObscene, refreshStatsTwins, repeatShare } from '../db.js';
import { OFFSITE_SHARE_SQL } from '../keys.js';
import { toLevel } from '../stats.js';
import { toPrimary } from '../topics.js';
import { isCategoryName } from '../franchise.js';
import { say } from './progress.js';
import { targetSql } from './queue.js';

/** Пересчитывает уровни по уже сохранённым числам — нужен после правки порогов в настройках. */
function recalcLevels() {
	// Названные поимённо паки пересчитываются одни: точечное обновление не должно
	// трогать соседей — даже пересчётом, который ничего не портит
	const target = targetSql();
	const only = target.where
		? ` AND package_id IN (SELECT p.id FROM packages p WHERE 1 = 1${target.where})`
		: '';

	const rows = db.prepare(`SELECT package_id, started_games, completed_games, shown, answered, correct, wrong,
		right_percent, take_percent FROM stats WHERE found = 1${only}`).all(...target.params);
	const update = db.prepare('UPDATE stats SET level = ? WHERE package_id = ?');

	let changed = 0;

	for (const row of rows) {
		const level = toLevel({
			startedGames: row.started_games,
			shown: row.shown,
			takePercent: row.take_percent,
			// Без доли правильных ответов пересчёт терял ступень за неточные ответы
			// и расходился с тем, что считает db.js при запуске
			rightPercent: row.right_percent,
		});

		update.run(level, row.package_id);

		if (level !== null) {
			changed++;
		}
	}

	say('recalc', `уровни: обработано ${rows.length}, оценку получили ${changed}`);
}

/**
 * Пак, который весь про это: вес названного, стоящего в КАЖДОЙ теме пака,
 * поднимается до всего пака.
 *
 * Обычно вес названного в ответах считает разметка (см. countNamed в topics.js),
 * и пересчитать её без модели нельзя: в базе от разметки остались одни готовые
 * числа, а какое имя в какой теме прозвучало, не записано нигде. Один случай
 * всё же считается точно, и это как раз тот, ради которого правило и заведено:
 * названное стоит во ВСЕХ темах пака. Тогда темы, которыми оно занято, — это все
 * темы, и вопросов в них ровно столько, сколько вопросов в паке. Гадать не о чем.
 *
 * Ради этого случая правило и меняли. Пак 14934 («Для потных любителей
 * War Thunder») — семнадцать тем, War Thunder назван в каждой; семнадцать
 * упоминаний по вопросу дали 19% пака, и «пак по War Thunder» порога не взял.
 * Так же терялись «Знатокам соулслайков» (25 тем из 25) и «Книжные персонажи
 * вселенной Джорджа Мартина» (12 из 12).
 *
 * Неполное покрытие — четыре пятых тем, но не все — здесь не трогается нарочно.
 * Там точного ответа нет: какие именно темы заняты, неизвестно, а вопросов
 * в темах разное число. Такой пак дождётся модели и посчитается как следует
 * (см. subjectThemeShare в src/settings.js).
 */
function wholePack(row, item) {
	const themes = row.theme_count ?? 0;
	const questions = row.question_count ?? 0;

	if (item.kind === 'area' || themes < config.franchiseMinThemes
		|| item.themes !== themes || (item.questions ?? 0) >= questions) {
		return item;
	}

	return { ...item, questions, share: 1 };
}

/** Пересчитывает ярлыки паков по сохранённым долям — нужен после правки порога. */
function recalcTopics() {
	const target = targetSql();
	const rows = db.prepare(`SELECT p.id, p.topic_shares, p.question_count, p.theme_count, p.franchises,
			p.repeat_share, p.genre_topic, p.form_topic, p.other_kinds
		FROM packages p WHERE p.topics_at IS NOT NULL${target.where}`).all(...target.params);
	const update = db.prepare('UPDATE packages SET primary_topic = ?, primary_share = ?, franchise_top = ?, franchise_top_share = ? WHERE id = ?');

	// Жанры пересчитать без модели нельзя вовсе: они считаются по разметке тем,
	// а в базе от неё остались одни доли. Поэтому у пака, сменившего тип, жанры
	// убираются, а сам пак встаёт обратно в очередь к модели (topics_version = 0):
	// жанры музыки под подписью «какой жанр аниме» — не полбеды, а прямое враньё.
	// Доли и ярлык при этом остаются на месте, и до переспроса пак выглядит как
	// прежде, только без жанров.
	const dropGenres = db.prepare(`UPDATE packages SET genres = '[]', genre_topic = NULL, topics_version = 0 WHERE id = ?`);

	// То же самое и с носителями, и по той же причине: «Сериалы 60%» в верхней
	// полоске пака, переставшего быть кинопаком, читались бы как доля манги
	const dropForms = db.prepare(`UPDATE packages SET forms = '[]', form_topic = NULL, form_coverage = NULL, topics_version = 0 WHERE id = ?`);

	// Область, повторяющая ярлык пака, из сохранённого вычищается прямо здесь,
	// не дожидаясь модели.
	//
	// Дождаться её тут нельзя по времени: суточного лимита хватает на сотни
	// паков при базе в тысячи, и «Cinema», «Movies», «Games» и «Erudition»
	// простояли бы в списке «Пак целиком про одно» ещё месяцы — четырьмя
	// строками по полсотни паков в каждой, ничего не говорящими о паках.
	// А сказать про них нечего и по существу: «пак целиком про кино» — это
	// в точности кинопак, ярлык которого стоит рядом (см. NOT_AREAS
	// в franchise.js). Английские названия оттуда же и той же природы.
	//
	// Переспрашивать модель ради этого не надо: убирается лишняя строка,
	// а не считается новая, — и убрать её можно по тому, что уже записано.
	// Доля повторов пересчитывается вместе со списком: она из него и считается,
	// и разойдись они — галочка «мало повторов» отбирала бы по вчерашнему списку
	const rewriteFranchises = db.prepare('UPDATE packages SET franchises = ?, repeat_share = ? WHERE id = ?');

	let labelled = 0;
	let dropped = 0;
	let cleaned = 0;
	// Паки, у которых предмет занял весь пак: до правила он весил упоминаниями
	// и порога «пака про одно» не брал (см. wholePack)
	let whole = 0;

	for (const row of rows) {
		const shares = jsonOrDefault(row.topic_shares, null);
		// Виды «прочего» уже посчитаны и лежат в базе: по ним пак, который весь
		// про спорт, получает свой ярлык, не дожидаясь модели
		const { topic, share } = toPrimary(shares, row.question_count ?? 0, jsonOrDefault(row.other_kinds, []));

		const stored = jsonOrDefault(row.franchises, []);
		// Проверяется по названию, а не по виду записи. Вид («область» или
		// «произведение») появился не сразу, и у записей постарше его нет вовсе;
		// а главное — модель кладёт «Games» и «Movies» в оба поля одинаково,
		// и произведением такое не становится (см. isCategoryName в franchise.js)
		const shrunk = stored.filter(f => !isCategoryName(f.name));
		const kept = shrunk.map(f => wholePack(row, f));

		// Доля повторов сверяется со списком всегда, а не только когда список
		// сам изменился, — и это правка ошибки, а не осторожность.
		//
		// Считается она из franchises и хранится готовым числом (см. repeatShare
		// в src/keys.js), но переписывалась только вместе с самим списком.
		// Между тем разойтись они могут и без правки списка: правило счёта
		// менялось — «область» перестала считаться повтором, появился порог
		// собственного предмета пака, — а число, посчитанное по прежнему правилу,
		// так и осталось лежать. На 3024 паках из 10 860 оно расходилось
		// с franchises, у 687 было занижено, — и галочка «мало повторов»
		// пропускала их как ровные. Пак 12223 («Вопросы SIGAME»): в базе 0,087,
		// на деле 0,248 при пороге 0,1.
		//
		// Сравнение по числу, а не «пересчитать и записать всем подряд»: писать
		// одиннадцать тысяч строк ради полутора тысяч изменившихся — это лишняя
		// заливка в D1 при каждой выкладке (см. rowhash в scripts/deploy/).
		const repeats = repeatShare(kept, config.subjectPackShare);
		const drifted = Math.abs(repeats - (row.repeat_share ?? 0)) > 0.0005;

		if (JSON.stringify(kept) !== JSON.stringify(stored) || drifted) {
			rewriteFranchises.run(JSON.stringify(kept), repeats, row.id);

			if (shrunk.length !== stored.length) {
				cleaned++;
			}

			if (kept.some((item, at) => item !== shrunk[at])) {
				whole++;
			}
		}

		// Сами франшизы пересчитать без модели нельзя — она называет их по темам, —
		// но какая из сохранённых главная, видно и так
		const top = kept
			.filter(f => f.themes >= config.franchiseMinThemes)
			.sort((a, b) => b.questions - a.questions)[0] ?? null;

		update.run(topic, share, top?.name ?? null, top?.share ?? null, row.id);

		// «Солянка» и «Другое» ярлыком не считаются: первая говорит «намешано»,
		// второе — «размечать нечего», и ни то, ни другое не про содержимое
		if (topic && topic !== 'mixed' && topic !== MISC_KEY) {
			labelled++;
		}

		if (row.genre_topic && row.genre_topic !== topic) {
			dropGenres.run(row.id);
			dropped++;
		}

		if (row.form_topic && row.form_topic !== topic) {
			dropForms.run(row.id);
		}
	}

	say('recalc', `тематики: обработано ${rows.length}, ярлык получили ${labelled}`
		+ `${dropped > 0 ? `, у ${dropped} сменился тип — жанры переспросим` : ''}`
		+ `${cleaned > 0 ? `, у ${cleaned} убрана область, повторявшая ярлык` : ''}`
		+ `${whole > 0 ? `, у ${whole} предмет назван во всех темах — это паки про одно` : ''}`);
}

/**
 * Убирает с сайта паки, которые наполовину и больше держатся на чужих ссылках,
 * и возвращает те, что перестали.
 *
 * ————— почему это приговор, а не пометка —————
 *
 * Пак — это архив, и обычно всё, что в нём показывают, лежит в нём же. Но формат
 * разрешает вместо имени файла написать ссылку на чужой сервер, и такой пак живёт
 * ровно столько, сколько живёт этот сервер. Пак 4003 («-3 часа жизни») — 593
 * вопроса-картинки при архиве в двадцать килобайт: ни одной картинки внутри, все
 * по ссылкам, и ни одна уже не открывается. По всем прочим признакам это обычный
 * аниме-пак: тематика, жанры, доли, повторы — всё посчитано и всё правда.
 * За столом — 593 пустых экрана.
 *
 * До сих пор сайт про такой пак говорил — красной долей на карточке, — но
 * показывал его наравне со всеми, оставляя решение тому, кто на карточку смотрит.
 * Мерка эта не по задаче. Библиотеку открывают, чтобы взять пак и сесть играть,
 * а пак, у которого половина вопросов не показывает ничего, за столом
 * не играется никак — сколько бы честных чисел ни стояло на его карточке.
 * Поэтому с половины он с сайта убирается (см. offsiteBrokenShare
 * в src/settings.js).
 *
 * ————— почему это здесь —————
 *
 * Потому что считается по тому, что уже лежит в базе, — ровно как уровни
 * и ярлыки выше. Числа «сколько своего, сколько чужого» снимает разбор
 * (см. countMediaRefs в src/siq.js), а порог живёт в настройках и меняется
 * без всякой сети; приговор по нему выносится и отменяется одним проходом.
 *
 * Отменяется — это не для красоты. Порог правят, и пак, убранный вчерашним
 * порогом, обязан вернуться сегодняшним; а ещё автор перезаливает пак с файлами
 * внутри, и тогда доля падает сама. Поэтому правило работает в обе стороны
 * и об обеих сообщает.
 *
 * Паки, про которых доля неизвестна вовсе (media_offsite IS NULL — разобранные
 * до появления правила и вообще без медиавопросов), не трогаются: убирать
 * по незнанию нельзя.
 */
function recalcOffsite() {
	const target = targetSql();

	// Псевдоним нужен: доля считается одним и тем же куском SQL и дома, и наверху,
	// а написан он через `p.` (см. OFFSITE_SHARE_SQL в src/keys.js)
	const hide = db.prepare(`UPDATE packages AS p SET status = 'offsite'
		WHERE p.status = 'ok' AND ${OFFSITE_SHARE_SQL} >= ?${target.where}`);

	const show = db.prepare(`UPDATE packages AS p SET status = 'ok'
		WHERE p.status = 'offsite' AND COALESCE(${OFFSITE_SHARE_SQL}, 0) < ?${target.where}`);

	const hidden = hide.run(config.offsiteBrokenShare, ...target.params).changes;
	const back = show.run(config.offsiteBrokenShare, ...target.params).changes;

	const unknown = db.prepare(`SELECT COUNT(*) AS c FROM packages p
		WHERE p.status = 'ok' AND p.media_offsite IS NULL${target.where}`).get(...target.params).c;

	say('recalc', `чужие ссылки: убрано с сайта ${hidden}, возвращено ${back}`
		+ `${unknown > 0 ? `, не считано ещё у ${unknown} паков` : ''}`);
}

/**
 * Непристойные названия: пересуд по нынешнему списку слов.
 *
 * Сам приговор ставит разбор, когда читает название из файла (см. updateParsed
 * в src/indexer/store.js), и после него пересчитывать нечего — название с тех
 * пор не менялось. Пересчёт нужен на другой случай: правили список слов.
 * Список этот живой — в него дописывают то, по чему поисковик привёл на сайт
 * очередной раз, — и всякая правка обязана дойти до уже разобранной библиотеки,
 * иначе новое слово работало бы только на паках, выложенных после него.
 *
 * Работает в обе стороны, как и чужие ссылки выше: слово, убранное из списка
 * как слишком широкое, обязано вернуть свои паки в индекс. Ради этого пересчёт
 * и смотрит на все паки подряд, а не на одни помеченные.
 *
 * Ни сети, ни модели — одни строки; на всей библиотеке это доли секунды.
 */
function recalcObscene() {
	const target = targetSql();
	const { marked, cleared } = markObscene(target.where, target.params);
	const total = db.prepare(`SELECT COUNT(*) AS c FROM packages p
		WHERE p.obscene = 1${target.where}`).get(...target.params).c;

	say('recalc', `непристойные названия: закрыто от индексации ${marked}, `
		+ `открыто обратно ${cleared}, всего под запретом ${total}`);
}

/**
 * Сколько у каждого пака тёзок — паков, названных автором так же и потому
 * посчитанных сервисом статистики в одну кучу.
 *
 * Стоит в пересчёте, а не в разборе, потому что число это общее: выложили
 * пятнадцатый «Вопрос SIGame» — и у четырнадцати прежних оно поменялось, хотя
 * их самих никто не трогал. Сужения до названных поимённо паков здесь нет
 * по той же причине (см. refreshStatsTwins в src/db.js).
 *
 * По нему делится число игр в порядке выдачи: без него «популярные за всё
 * время» открывались десятком паков одного автора, у которых на карточках
 * стоит одно и то же число.
 */
function recalcTwins() {
	const changed = refreshStatsTwins();

	say('recalc', `тёзки по названию: число игр поделено заново у ${changed} паков`);
}

/** Общий пересчёт по сохранённым данным: и уровни, и ярлыки, и чужие ссылки, и названия. */
export function recalcAll() {
	recalcLevels();
	recalcTopics();
	recalcOffsite();
	recalcObscene();
	recalcTwins();
}
