// Запись в базу: заготовленные запросы и то, что вокруг них.
//
// Всё, что обход пишет о паке, лежит здесь одним местом — не ради порядка,
// а потому что в одну и ту же строку packages пишут сразу несколько шагов,
// и запрос у них обязан быть один и тот же: разбор и досчёт отпечатков
// сохраняют свёртку вопросов одинаково, иначе один затирал бы работу другого.
//
// Заготовки (db.prepare) считаются один раз при загрузке: за ночь их зовут
// десятки тысяч раз.

import { LANGUAGE_NAMES, TOPICS_VERSION } from '../config.js';
import { db } from '../db.js';
import { countPrints, encodePrints, PRINTS_VERSION } from '../plagiarism.js';

export const insertPackage = db.prepare(`
	INSERT OR IGNORE INTO packages
		(source_key, url, file_name, vk_topic, vk_comment, vk_author, vk_author_url, vk_date, vk_ts,
			file_ts, comment_text, status)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')
`);

/**
 * Ссылка на документ протухла — берём свежую. Заодно записывается и дата самого
 * файла: обход ходит по всей теме, а дата эта приходит в том же ответе даром,
 * и другого способа узнать её у уже записанного пака нет (docs.getById чужие
 * документы не отдаёт вовсе). COALESCE — чтобы обход со страницы, где даты нет,
 * не стирал то, что уже узнано через API.
 */
export const refreshLink = db.prepare(`
	UPDATE packages SET url = ?, file_name = ?, file_ts = COALESCE(?, file_ts) WHERE source_key = ?
`);

// ————— сверка с обсуждением: что в сообщении поменялось с прошлого раза —————

/** Всё, что мы уже знаем про это сообщение обсуждения. */
export const knownInComment = db.prepare(`
	SELECT id, source_key, name, file_name, comment_text, status
	FROM packages WHERE vk_topic = ? AND vk_comment = ?
`);

/** Есть ли такой документ в базе вообще — хоть под этим сообщением, хоть под другим. */
export const knownDocument = db.prepare('SELECT id FROM packages WHERE source_key = ?');

/**
 * Живые паки одной темы обсуждения — все, каким бы сообщением они ни были
 * выложены. По ним после ПОЛНОГО обхода темы видно, чьё сообщение исчезло:
 * пак, номера сообщения которого нет среди прочитанных, в обсуждении больше
 * не лежит (см. missingComments в scanVk).
 *
 * Похоронённые и мёртвые не спрашиваются по той же причине, что и в syncComment:
 * их и так не показывают, и хоронить их второй раз незачем.
 */
export const knownInTopic = db.prepare(`
	SELECT id, vk_comment, name, file_name, source_key
	FROM packages WHERE vk_topic = ? AND status <> 'gone' AND status <> 'dead'
`);

/**
 * Сообщение переписали: у пака меняется описание, но не он сам. Заодно
 * обновляются имя и время автора — сообщение могли перенести или подписать иначе.
 */
export const refreshComment = db.prepare(`
	UPDATE packages SET comment_text = ?, vk_author = ?, vk_author_url = ?, vk_date = ?, vk_ts = ?
	WHERE id = ?
`);

/**
 * Файл в сообщении подменили: тот же пак выложен заново, обычно с исправлениями.
 * Ссылка и ключ переезжают на новый документ, а сам пак помечается к пересборке.
 *
 * Разметка сбрасывается нарочно: тематики и краткое описание считались по прежнему
 * содержимому, и оставлять их — значит подписать новый пак старыми словами. Сами
 * значения при этом остаются на месте, а не обнуляются: пока не приехали новые,
 * пусть на карточке будет прошлогоднее описание, а не пустота.
 *
 * Строка остаётся «ok», если была ею: пак не должен пропадать с сайта на сутки
 * из-за того, что автор перезалил файл. Мёртвой ссылке, наоборот, дают новый шанс.
 *
 * Дата файла переезжает вместе с ключом, и это здесь главное: сообщение своей
 * даты не меняет, а содержимое под ним теперь другое и другого возраста. Без
 * этой строки перезалитый вчера пак так и числился бы паком трёхлетней давности
 * и объявлял бы первоисточником себя (см. contentTs в src/plagiarism.js).
 */
export const rebindDocument = db.prepare(`
	UPDATE packages SET
		source_key = ?, url = ?, file_name = ?, file_ts = ?,
		recheck = 1, error = NULL, topics_at = NULL, summary_at = NULL,
		status = CASE WHEN status = 'ok' THEN 'ok' ELSE 'new' END
	WHERE id = ?
`);

/**
 * Пак переехал в другое сообщение: тот же самый файл, новое место в обсуждении.
 *
 * Так выглядит перевыкладка. Автор удаляет своё сообщение и пишет заново —
 * поправив опечатку, добавив ссылку на другие свои паки, перенеся пак повыше, —
 * и прикладывает тот же самый документ. Для ВК это новое сообщение с новым
 * номером; для нас — прежний пак, потому что документ у него тот же, а документ
 * во всей базе неповторим (source_key UNIQUE).
 *
 * Без этого запроса случай кончался похоронами. Пак остаётся привязанным
 * к номеру, которого в теме больше нет, полный обход не находит этот номер
 * среди прочитанных и хоронит пак как удалённый (см. missingComments), — а сам
 * файл при этом лежит в теме двумя сообщениями ниже и прекрасно открывается.
 * Ожить пак тоже не может: оживление ищет строку по номеру сообщения, а строка
 * записана на старый. Так и вышло с паком «Ночные посиделки №85»: сообщение 937
 * удалили, тот же файл выложили сообщением 939, и на сайте пака не стало вовсе.
 *
 * Заодно переезжает и всё, что о сообщении известно: текст (это описание пака
 * на карточке), подпись и дата. Дата особенно: по ней считается свежесть,
 * и пак, перевыложенный сегодня, обязан быть сегодняшним.
 *
 * Похороненный при этом оживает — ровно так же, как в markBack: «new» значит
 * «разобрать заново», а не «показать как есть».
 */
export const rebindComment = db.prepare(`
	UPDATE packages SET
		vk_comment = ?, vk_author = ?, vk_author_url = ?, vk_date = ?, vk_ts = ?, comment_text = ?,
		status = CASE WHEN status = 'gone' THEN 'new' ELSE status END,
		error = CASE WHEN status = 'gone' THEN NULL ELSE error END
	WHERE id = ?
`);

/** Файл из сообщения убрали. Не удаляем: вернут — оживёт, а оценки к нему привязаны. */
export const markGone = db.prepare(`UPDATE packages SET status = 'gone', error = ? WHERE id = ?`);

/** Файл вернули на место. */
export const markBack = db.prepare(`UPDATE packages SET status = 'new', error = NULL WHERE id = ?`);

/**
 * Приговор по названию стоит здесь, рядом с самим названием, и это не удобство,
 * а единственное место, где он не разъедется с ним. Название пака приезжает
 * из его файла и меняется ровно тогда, когда автор перезаливает пак, — то есть
 * этим самым запросом. Считай его где-нибудь ещё — и пак, переименованный
 * из «хуйни» в «Кино и музыку», ходил бы с прежней пометкой до ближайшего
 * пересчёта, которого никто не просил (см. src/obscene.js).
 */
export const updateParsed = db.prepare(`
	UPDATE packages SET
		name = ?, authors = ?, authors_key = ?, match_key = ?, author_difficulty = ?,
		language = ?, pack_date = ?, pack_id = ?, size = ?, question_count = ?, round_count = ?,
		theme_count = ?, special_count = ?, special_stat = ?, content_stat = ?, rounds = ?,
		media_own = ?, media_offsite = ?, logo_file = ?, logo_state = ?, obscene = ?,
		status = 'ok', error = NULL, recheck = 0, indexed_at = ?
	WHERE id = ?
`);

export const updateFailed = db.prepare(`UPDATE packages SET status = ?, error = ?, recheck = 0, indexed_at = ? WHERE id = ?`);

/**
 * Пометку «разобрать заново» снимает любой исход разбора, в том числе неудачный.
 * Иначе пак, который перезалили сломанным, просился бы в очередь каждую ночь
 * и никогда бы из неё не выходил.
 */
export const clearRecheck = db.prepare('UPDATE packages SET recheck = 0 WHERE id = ?');
export const updateUrl = db.prepare('UPDATE packages SET url = ? WHERE id = ?');
export const updateLogo = db.prepare('UPDATE packages SET logo_file = ?, logo_state = ? WHERE id = ?');
export const updateTopics = db.prepare(`
	UPDATE packages SET topic_shares = ?, primary_topic = ?, primary_share = ?,
		franchises = ?, franchise_top = ?, franchise_top_share = ?, repeat_share = ?, other_kinds = ?,
		genres = ?, genre_topic = ?,
		forms = ?, form_topic = ?, form_coverage = ?,
		decades = ?, decade_coverage = ?, origins = ?, origin_coverage = ?,
		topics_at = ?, topics_model = ?, topics_version = ${TOPICS_VERSION} WHERE id = ?
`);

const updateSummary = db.prepare(`
	UPDATE packages SET summary = ?, summary_at = ?, summary_model = ?,
		summary_en = COALESCE(?, summary_en),
		summary_uk = COALESCE(?, summary_uk),
		summary_kk = COALESCE(?, summary_kk),
		audience_from = ?, audience_to = ?, audience_male = ?, audience_at = ?,
		language_ai = COALESCE(?, NULLIF(language_ai, ''), '') WHERE id = ?
`);

/**
 * Записывает ответ модели про весь пак: описание и оценку аудитории.
 *
 * Обе вещи приезжают одним ответом (см. describePack и analyzePack), и пишутся
 * тоже разом. Отметка audience_at ставится и тогда, когда аудитории в ответе
 * не оказалось: спросили — значит, спросили, и переспрашивать каждую ночь
 * незачем.
 *
 * Так же и с языком, только отметка у него своя же колонка. NULL в language_ai
 * значит «ещё не спрашивали» — по нему пак и попадает в очередь; пустая строка
 * значит «спросили, а модель промолчала», и второй раз он в очередь не встаёт.
 * Сайту пустая строка и NULL — одно и то же: и там, и там он берёт язык
 * из файла (см. LANG_SQL в cf/src/library/filters.js).
 *
 * Описание приезжает сразу на четырёх языках сайта — тем же ответом и тем же
 * запросом (см. SUMMARY_LANGS в src/gemini/summary.js). Пустой перевод прежний
 * не стирает (COALESCE в самом запросе): у паков, описанных до этой правки,
 * переводы уже лежат от отдельного прохода (scripts/i18n.js summaries),
 * и промолчавшая модель не должна их обнулять.
 */
export function saveSummary(row, model, summary, audience, language = null, translations = null) {
	updateSummary.run(
		summary || null,
		Date.now(),
		model,
		translations?.en || null,
		translations?.uk || null,
		translations?.kk || null,
		audience?.from ?? null,
		audience?.to ?? null,
		audience?.male ?? null,
		Date.now(),
		// Промолчавшая про язык модель не должна стирать прошлый ответ: язык
		// у пака один и тот же от разбора к разбору, а «не сказала» — это
		// не «языка нет». Зато пустую строку она ставит, и это отметка
		// «спрашивали» (COALESCE в самом запросе)
		language,
		row.id,
	);
}

/** Аудитория строкой для лога: «18–25 лет, М 70% / Ж 30%». */
export const audienceLine = audience => (audience
	? `${audience.from}–${audience.to} лет, М ${audience.male}% / Ж ${100 - audience.male}%`
	: 'аудитория не названа');

/**
 * Язык пака строкой для лога: «язык: Русский (ru), в файле en-US».
 *
 * Строка эта нужна не для полноты отчёта. Язык — единственное, что модель
 * называет ВОПРЕКИ файлу: поле в самом паке ставит редактор, и стоит в нём
 * то, какая у автора Windows, — по нему английских паков в базе выходило
 * больше, чем их есть на свете (см. LANGUAGE_RULES в src/gemini/summary.js). Пока в логе
 * этого не было, проверить, не выдумывает ли модель, было нечем: в базе лежит
 * итог, а от чего он отличается — не видно. Поэтому рядом стоит и то,
 * что записано в файле: расхождение и есть весь смысл этой строки.
 *
 * Промолчавшая модель называется вслух тоже: пустая строка от неё значит
 * «спросили, а ответа нет», и молча пропускать это в логе нельзя — иначе
 * пак без языка выглядит паком, про который не спрашивали.
 */
export const languageLine = (language, fromFile) => {
	const own = fromFile ? `, в файле ${fromFile}` : ', в файле не указан';

	return language
		? `язык: ${LANGUAGE_NAMES[language] ?? language} (${language})${own}`
		: `язык: модель не назвала${own}`;
};
export const updateSpecials = db.prepare('UPDATE packages SET special_count = ?, special_stat = ? WHERE id = ?');

/**
 * Отпечатки вопросов пака (см. encodePrints в src/plagiarism.js).
 *
 * Пишутся двумя разными шагами и потому через ON CONFLICT: разбор кладёт их
 * заодно с самим паком, а шаг prints добирает те паки, что разобраны до его
 * появления. Кто из двоих успел позже, тот и прав — свёртка одна и та же,
 * считается она из одного и того же content.xml.
 */
const savePrints = db.prepare(`
	INSERT INTO pack_prints (package_id, prints, questions, parsed_at, version)
	VALUES (?, ?, ?, ?, ?)
	ON CONFLICT (package_id) DO UPDATE SET
		prints = excluded.prints,
		questions = excluded.questions,
		parsed_at = excluded.parsed_at,
		version = excluded.version
`);

/** Свёртка отпечатков и число вопросов в ней — одним местом для обоих шагов. */
export function storePrints(packageId, questions) {
	const prints = encodePrints(questions);
	const count = countPrints(prints);
	savePrints.run(packageId, prints, count, Date.now(), PRINTS_VERSION);
	return count;
}

/**
 * Раунды и темы пака — из разбора, который шаг отпечатков и так сделал.
 *
 * ————— зачем шагу отпечатков трогать раунды —————
 *
 * Он читает content.xml целиком, а темы из него достаются даром — и с ними
 * разбирается разом сразу два накопленного.
 *
 * Первое: тема без названия. Раньше разбор её выбрасывал, и паки, у которых
 * имена темам не проставлены, лежали в базе с нулём тем — то есть без разметки
 * навсегда (см. keptTheme в src/siq.js). Теперь такие темы есть, но взяться
 * им у старых паков неоткуда: переразбор — это скачивание всей библиотеки.
 *
 * Второе, и оно важнее: номера тем. Метка «взято отсюда» стоит на теме
 * по её номеру (см. src/plagiarism.js), а номера у пака со смесью названных
 * и безымянных тем теперь другие. Оставить старые раунды рядом с новыми
 * отпечатками — значит показать улику на чужой теме.
 *
 * ————— почему сбрасывается разметка —————
 *
 * Только у тех паков, у кого тем стало больше или меньше. Доли тематик считались
 * по прежнему набору тем, и пак, у которого половина тем была невидимой, размечен
 * по половине себя. Пак, у которого число тем не изменилось, не трогается вовсе:
 * переспрашивать модель про всю библиотеку было бы и незачем, и не на что.
 */
const updateRounds = db.prepare(`
	UPDATE packages SET
		rounds = ?, round_count = ?, theme_count = ?, question_count = ?,
		special_count = ?, special_stat = ?, content_stat = ?,
		media_own = ?, media_offsite = ?,
		topics_at = CASE WHEN theme_count = ? THEN topics_at END
	WHERE id = ?
`);

/** @returns {boolean} стало ли тем больше или меньше — только у таких сброшена разметка */
export function storeRounds(row, parsed) {
	const changed = (row.theme_count ?? 0) !== parsed.themeCount;

	updateRounds.run(
		JSON.stringify(parsed.rounds),
		parsed.roundCount,
		parsed.themeCount,
		parsed.questionCount,
		parsed.specialCount,
		JSON.stringify(parsed.specialStat),
		JSON.stringify(parsed.contentStat),
		// Где лежит показываемое: в паке или по чужим ссылкам. Считается только
		// там, где дано оглавление архива, — без него пропавший файл не отличить
		// от лежащего на месте (см. countMediaRefs в src/siq.js)
		parsed.mediaRefs?.own ?? null,
		parsed.mediaRefs?.offsite ?? null,
		parsed.themeCount,
		row.id,
	);

	return changed;
}

const updateDurations = db.prepare(`
	UPDATE packages SET media_avg = ?, media_max = ?, media_total = ?, media_files = ?, media_at = ?
	WHERE id = ?
`);

/**
 * Длительность медиа пака — одним местом для разбора и для своего шага.
 *
 * Пак без медиафайлов записывается тоже, пустыми числами: «мерили, мерить
 * нечего» — это ответ, и без него такой пак попадал бы в очередь каждую ночь
 * до скончания века.
 */
export function storeDurations(packageId, media) {
	updateDurations.run(
		media.average,
		media.longest,
		media.total,
		media.files,
		Date.now(),
		packageId,
	);
}

export const upsertStats = db.prepare(`
	INSERT INTO stats (package_id, started_games, completed_games, shown, answered, correct, wrong,
		right_percent, take_percent, level, found, updated_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT (package_id) DO UPDATE SET
		started_games = excluded.started_games,
		completed_games = excluded.completed_games,
		shown = excluded.shown,
		answered = excluded.answered,
		correct = excluded.correct,
		wrong = excluded.wrong,
		right_percent = excluded.right_percent,
		take_percent = excluded.take_percent,
		level = excluded.level,
		found = excluded.found,
		updated_at = excluded.updated_at
`);
