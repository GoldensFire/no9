import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import {
	jsonOrDefault, authorsOrVk, buildAuthorKey, buildMatchKey, splitAuthors, repeatShareSql,
	PACK_KEY_INDEX_SQL, NAME_KEY_INDEX_SQL,
} from './keys.js';
import { isObsceneName } from './obscene.js';

// Ключи пака и чтение его полей лежат в keys.js: тот файл ничего не знает
// про node:sqlite, и его читает двойник сайта на Cloudflare Workers (см. cf/).
// Здесь они перевыпускаются наружу, чтобы остальной проект по-прежнему брал
// packKey и normalizeRounds отсюда.
export * from './keys.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 10000;

CREATE TABLE IF NOT EXISTS packages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	source_key TEXT NOT NULL UNIQUE,
	url TEXT NOT NULL,
	file_name TEXT,
	name TEXT,
	authors TEXT NOT NULL DEFAULT '[]',
	authors_key TEXT,
	match_key TEXT,
	-- Ярлыки из шапки пака. Больше не читаются и не пишутся: их проставляет
	-- сам автор, чем попало и как попало, и ни отбор, ни разметка, ни модель
	-- по ним не судят. Колонки оставлены как есть — со старыми значениями:
	-- переписать их пустотой значило бы прогнать через D1 одиннадцать тысяч
	-- строк ради поля, которого никто не спрашивает.
	tags TEXT NOT NULL DEFAULT '[]',
	tags_key TEXT,
	author_difficulty INTEGER,
	language TEXT,
	pack_date TEXT,
	pack_id TEXT,
	size INTEGER,
	question_count INTEGER,
	round_count INTEGER,
	theme_count INTEGER,
	content_stat TEXT NOT NULL DEFAULT '{}',
	rounds TEXT NOT NULL DEFAULT '[]',
	vk_topic TEXT,
	vk_comment INTEGER,
	vk_author TEXT,
	vk_author_url TEXT,
	vk_date TEXT,
	comment_text TEXT,
	status TEXT NOT NULL DEFAULT 'new',
	error TEXT,
	indexed_at INTEGER
);

CREATE INDEX IF NOT EXISTS ix_packages_status ON packages (status);

CREATE TABLE IF NOT EXISTS stats (
	package_id INTEGER PRIMARY KEY REFERENCES packages (id) ON DELETE CASCADE,
	started_games INTEGER NOT NULL DEFAULT 0,
	completed_games INTEGER NOT NULL DEFAULT 0,
	shown INTEGER NOT NULL DEFAULT 0,
	answered INTEGER NOT NULL DEFAULT 0,
	correct INTEGER NOT NULL DEFAULT 0,
	wrong INTEGER NOT NULL DEFAULT 0,
	right_percent REAL,
	take_percent REAL,
	level INTEGER,
	found INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS ix_stats_level ON stats (level);

CREATE TABLE IF NOT EXISTS played (
	package_id INTEGER PRIMARY KEY REFERENCES packages (id) ON DELETE CASCADE,
	marked_at INTEGER NOT NULL
);

/* Запланированное: паки, отобранные на будущий вечер.

   Отдельная таблица, а не колонка в played, потому что это не состояние одной
   отметки, а две разные: «во что играли» — прошлое, «во что собираемся» —
   будущее, и пак вполне бывает и там, и там (сыграли, хотим ещё раз). Устроена
   она ровно как played, и по той же причине без хозяина: дома отметки
   принадлежат установке (см. LOCAL_USER_ID). */
CREATE TABLE IF NOT EXISTS planned (
	package_id INTEGER PRIMARY KEY REFERENCES packages (id) ON DELETE CASCADE,
	marked_at INTEGER NOT NULL
);

/* Авторы пака по одному в строке: иначе «Кот» находится внутри «Котовский».

   canon_key и canon_name — тот же автор, сведённый к одному человеку: паки,
   выложенные с одной страницы ВК, подписаны одним человеком, как бы он себя
   в файле ни называл (см. mergeAuthors в src/indexer/authors.js). Пока шаг не прошёл,
   канон равен подписи.

   canon_account — номер той самой страницы ВК. По нему сайт узнаёт автора
   в лицо: вошедший через ВК получает подтверждённое авторство своих паков,
   не доказывая ничего отдельно (см. cf/src/library/authorship.js). */
CREATE TABLE IF NOT EXISTS pack_authors (
	package_id INTEGER NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
	author_key TEXT NOT NULL,
	author TEXT NOT NULL,
	canon_key TEXT,
	canon_name TEXT,
	canon_account TEXT,
	PRIMARY KEY (package_id, author_key)
);

CREATE INDEX IF NOT EXISTS ix_pack_authors_key ON pack_authors (author_key);

/* Отпечатки вопросов пака: по ним ищется списанное (см. src/plagiarism.js).

   Отдельной таблицей, а не колонкой в packages, по одной причине — наверх
   это не едет. Выгрузка в D1 берёт packages, stats и pack_authors (см. TABLES
   в scripts/export-d1.js), и лишняя колонка на тринадцать мегабайт означала бы
   тринадцать мегабайт в чужой оплаченной базе ради работы, которая целиком
   делается дома. Сайту нужен только вывод — метка, доля и ссылка на донора, —
   и он лежит в самих packages.

   Внутри — двоичная свёртка по двенадцать байт на вопрос: отпечаток и место
   в раундах (см. encodePrints). У пака сотня вопросов, у библиотеки миллион
   с лишним, и то же самое списком чисел в JSON весило бы вчетверо больше.

   parsed_at — когда разбирали пак, из которого свёртка сделана. По ней видно,
   что пак перезалили, а отпечатки остались от прежнего файла (см. fetchPrints
   в src/indexer/backfill.js).

   version — какого вида записи внутри: 1 — двенадцать байт, 2 — шестнадцать,
   с весом приложенных к вопросу файлов, 3 — те же шестнадцать, но снятые
   по нынешнему правилу: вопрос из одного имени файла, без текста и без ответа,
   записан нулём и в сравнение не идёт (см. MUTE в src/plagiarism.js). Хранится
   рядом, потому что по самой свёртке вид не узнать: длиной первый от второго
   не отличить — сорок восемь байт делится и на то, и на другое, — а второй
   от третьего не отличить ничем вовсе, у них разное правило при одной длине
   (см. PRINTS_VERSION в src/plagiarism.js). */
CREATE TABLE IF NOT EXISTS pack_prints (
	package_id INTEGER PRIMARY KEY REFERENCES packages (id) ON DELETE CASCADE,
	prints BLOB NOT NULL,
	questions INTEGER NOT NULL DEFAULT 0,
	parsed_at INTEGER,
	version INTEGER NOT NULL DEFAULT 1
);

/* Вошедшие через Discord. Ничего кроме имени и аватара не храним: сайту больше
   ничего и не нужно, а лишнее пришлось бы охранять. */
CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	discord_id TEXT NOT NULL UNIQUE,
	username TEXT NOT NULL,
	global_name TEXT,
	avatar TEXT,
	created_at INTEGER NOT NULL,
	seen_at INTEGER NOT NULL
);

/* Входы. В базе лежит не сам ключ из куки, а его хеш: утёкшая база не должна
   давать возможности войти чужим именем. */
CREATE TABLE IF NOT EXISTS sessions (
	token_hash TEXT PRIMARY KEY,
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS ix_sessions_expires ON sessions (expires_at);

/* Оценки паков по десятибалльной шкале. Ключ пака — общий для всех его копий
   (см. packKey): один и тот же пак нередко выложен в обсуждение не раз, и делить
   оценки между копиями значило бы никогда не набрать порога показа. */
CREATE TABLE IF NOT EXISTS ratings (
	pack_key TEXT NOT NULL,
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	score INTEGER NOT NULL,
	rated_at INTEGER NOT NULL,
	PRIMARY KEY (pack_key, user_id)
);

CREATE INDEX IF NOT EXISTS ix_ratings_user ON ratings (user_id);

/* Настройки, которые ставятся из окна сайта, а не правкой файла: выбранная модель
   и тому подобное. Здесь, а не в config.js, потому что их меняют на ходу, и знать
   о них должен и сайт, и ночной обход, который запускается сам по себе. */
CREATE TABLE IF NOT EXISTS app_settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

/* Сколько запросов к каждой модели потрачено за сутки. Считаем сами: сколько
   осталось от бесплатного лимита, Gemini не рассказывает никаким методом —
   про лимит он сообщает единственным способом, отказом, когда тот уже кончился.

   Сутки тут тихоокеанские: квоты Google сбрасываются в полночь по Лос-Анджелесу,
   и «сегодня» по местным часам разошлось бы со сбросом на полдня (см. quotaDay). */
CREATE TABLE IF NOT EXISTS gemini_usage (
	day TEXT NOT NULL,
	model TEXT NOT NULL,
	requests INTEGER NOT NULL DEFAULT 0,
	quota_hits INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (day, model)
);

/* Что мы узнали про модель на деле, а не из списка: суточный предел, названный
   самим Gemini в отказе (429 приносит QuotaFailure с quotaValue), и отказ работать
   вовсе — старые модели закрывают для новых ключей, и по списку доступных этого
   не видно никак (см. src/models.js). Живёт отдельно от расхода: расход про
   сегодня, а это знание о модели, и терять его при смене суток незачем. */
CREATE TABLE IF NOT EXISTS gemini_limits (
	model TEXT PRIMARY KEY,
	day_limit INTEGER,
	seen_at INTEGER NOT NULL
);

/* Личный чёрный список: kind = 'author' (author_key) или 'pack' (pack_key).
   Общего ЧС нет намеренно — это не модерация, а «не показывайте мне вот это». */
CREATE TABLE IF NOT EXISTS blacklist (
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	value TEXT NOT NULL,
	label TEXT NOT NULL DEFAULT '',
	added_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, kind, value)
);

/* Откуда взят отдельный вопрос: где он встретился раньше всего.
   Заводится только на заимствованное, поэтому таблица маленькая.

   Наверх не едет и ехать не должна. Даже при скромных пяти процентах
   заимствований это семьдесят тысяч строк — почти вся суточная норма записи
   в D1 ради подробности, которую сайту негде показать: мельче темы он
   не рисует ничего (см. roundsForApi в src/keys.js). Место ей — страница
   обновления базы, то есть у владельца.

   Заполнять её станет этап 1, когда у паков появятся отпечатки вопросов
   (question_fp); заведена она здесь заранее, чтобы правка схемы, требующая
   полной перезаливки в D1, случилась один раз, а не два. */
CREATE TABLE IF NOT EXISTS question_origin (
	package_id INTEGER NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
	ord INTEGER NOT NULL,
	source_id INTEGER NOT NULL,
	PRIMARY KEY (package_id, ord)
);
`);

/**
 * Хозяин отметок, сделанных без входа. Отметка «сыграно» ничьей учётной записи
 * не требует, и чёрный список на своей машине — тоже (см. config.localBlacklist);
 * но лежать ему всё равно надо под каким-то пользователем, иначе связь с таблицей
 * users не позволит его записать. Это и есть тот пользователь: не Discord, а сама
 * установка. Строка заводится один раз и живёт пустой, пока в неё не запишут.
 *
 * Номер отрицательный не для красоты: настоящие номера раздаёт AUTOINCREMENT
 * с единицы, а ноль в JS ложен, и любая проверка «есть ли хозяин» молча решала
 * бы, что его нет.
 */
export const LOCAL_USER_ID = -1;

db.prepare(`
	INSERT OR IGNORE INTO users (id, discord_id, username, global_name, avatar, created_at, seen_at)
	VALUES (?, 'local', 'Этот компьютер', NULL, NULL, ?, ?)
`).run(LOCAL_USER_ID, Date.now(), Date.now());

// Дозаливка колонок в базы, созданные более ранней версией
const existingColumns = new Set(db.prepare(`PRAGMA table_info(packages)`).all().map(c => c.name));

for (const [name, definition] of [
	['tags_key', 'TEXT'],
	['topic_shares', `TEXT NOT NULL DEFAULT '{}'`],
	['primary_topic', 'TEXT'],
	['primary_share', 'REAL'],
	['topics_at', 'INTEGER'],
	['logo_file', 'TEXT'],
	['logo_state', 'TEXT'],
	['vk_ts', 'INTEGER'],
	// Версия правил разметки, по которым посчитаны доли: 1 — до появления мультфильмов
	['topics_version', 'INTEGER NOT NULL DEFAULT 1'],
	// Краткая суть пака от модели: «Вселенная Гарри Поттера», «Логотипы компаний»
	['summary', 'TEXT'],
	['summary_at', 'INTEGER'],
	// Кому пак: возраст аудитории промежутком и доля мужчин в процентах (женщины —
	// остальное до ста). Спрашивается тем же запросом, что и описание, и по тому же
	// списку тем. Это не статистика игроков — её не знает никто, — а оценка модели
	// по содержимому пака: по годам вышедших игр и фильмов, по интернет-культуре.
	['audience_from', 'INTEGER'],
	['audience_to', 'INTEGER'],
	['audience_male', 'INTEGER'],
	// «Про аудиторию уже спрашивали». Отдельно от значений, потому что модель
	// иногда не отвечает вовсе: без этой отметки такой пак переспрашивался бы
	// каждую ночь до скончания века. Отдельно от summary_at — потому что паки,
	// описанные до появления аудитории, надо переспросить ровно один раз.
	['audience_at', 'INTEGER'],
	// Франшизы, встретившиеся в паке больше одного раза: [{name, themes, questions, share}]
	['franchises', `TEXT NOT NULL DEFAULT '[]'`],
	// Чем оказалось «прочее»: [{key, questions, share}] — стримеры, история, спорт.
	// Только то, что взяло порог otherKindShare: остальное на карточке не пишется
	['other_kinds', `TEXT NOT NULL DEFAULT '[]'`],
	// Жанры внутри тематики пака: [{key, questions, share}] — рэп, исекай, шутеры.
	// Только у паков, которые чем-то одним и являются, и только то, что взяло
	// порог genreShare (см. computeGenres в src/topics.js)
	['genres', `TEXT NOT NULL DEFAULT '[]'`],
	// Из чьего списка эти жанры. Обычно то же, что primary_topic, но храним рядом:
	// пересчёт порогов (--recalc) меняет ярлык пака, не переспрашивая модель,
	// и без этой колонки жанры музпака, ставшего аниме-паком, читались бы
	// по чужому списку — «rap» превратился бы в невнятный ключ без имени
	['genre_topic', 'TEXT'],
	// Из чего пак сделан по носителю: [{key: 'manhwa', questions, share}] —
	// сколько в манга-паке манги, манхвы и маньхуа, сколько в кинопаке кино
	// и сериалов. Верхняя полоска карточки делит этим свой главный кусок:
	// «Манга и манхва 100%» не говорило ничего (см. computeForms в topics.js).
	// form_topic — из чьего списка эти ключи, ровно как genre_topic; покрытие —
	// какую часть своей тематики модель сумела разложить: делить полоску
	// по одной теме из тридцати нельзя
	['forms', `TEXT NOT NULL DEFAULT '[]'`],
	['form_topic', 'TEXT'],
	['form_coverage', 'REAL'],
	// Самая частая из них — вынесена отдельно, чтобы по ней можно было искать и сортировать
	['franchise_top', 'TEXT'],
	['franchise_top_share', 'REAL'],
	// Спецвопросы: сколько всего и каких — {auction: 4, cat: 2}. NULL значит
	// «пак разобран до того, как их научились считать», и это не то же самое,
	// что ноль: сайт про такой пак ничего не пишет, а не обещает, что их нет.
	['special_count', 'INTEGER'],
	['special_stat', 'TEXT'],
	// «Файл в сообщении подменили — разобрать заново». Отдельный признак, а не
	// возврат в состояние «новый»: пока новый разбор не готов, пак должен остаться
	// на сайте с прежним описанием. Снимается любым исходом разбора, удачным
	// или нет, — иначе сломанный файл переспрашивался бы каждую ночь до скончания
	// века (см. scanVk и parsePackages в indexer.js).
	['recheck', 'INTEGER NOT NULL DEFAULT 0'],
	// Язык пака по его тексту, а не по полю в файле. Поле в файле ставит редактор
	// (там по умолчанию язык системы автора), и по нему английских паков в базе
	// выходило больше, чем их есть на свете, а половина числилась «без указания».
	// Модель называет язык по вопросам, темам и ответам (см. LANGUAGE_RULES
	// в src/gemini/summary.js), и сайт предпочитает её ответ, а на поле из файла падает
	// только там, где модель промолчала. NULL — «ещё не спрашивали».
	['language_ai', 'TEXT'],
	// Когда вышло то, из чего собран пак: [{key: 1990, questions, share}].
	// Рядом — какой частью пака эта разбивка посчитана: у вопроса про столицы
	// года нет, и полоска, собранная по одной десятой пака, врала бы уверенно
	['decades', `TEXT NOT NULL DEFAULT '[]'`],
	['decade_coverage', 'REAL'],
	// Откуда родом названное: [{key: 'su', questions, share}] — с тем же покрытием
	// и по той же причине. Спрашивается у всех, показывается у музыки и кино
	['origins', `TEXT NOT NULL DEFAULT '[]'`],
	['origin_coverage', 'REAL'],
	// Какой моделью размечен пак и какой описан. Нужны, чтобы слабую разметку
	// можно было потом переспросить у сильной модели, не трогая уже хорошую
	// (см. --upgrade в indexer.js). NULL значит «размечено до появления колонки».
	['topics_model', 'TEXT'],
	['summary_model', 'TEXT'],
	// Какая часть вопросов пака приходится на повторы франшиз. Число выводимое —
	// оно целиком считается из franchises, — но лежит готовым нарочно: по нему
	// отбирает галочка «мало повторов», а колонка фильтров спрашивает это пять
	// раз кряду. Считать его на лету значило бы обходить json_each по всей
	// таблице шесть раз на каждое нажатие (см. repeatShare в keys.js).
	['repeat_share', 'REAL'],
	// Кто у кого списал (см. src/plagiarism.js). Метка стоит только у тех паков,
	// у кого нашёлся хоть один чужой вопрос: NULL в plagiarism_kind — это
	// «ничего не нашлось», а вовсе не «проверен и чист», и сайт про такой пак
	// не пишет ничего. Значения: pack — копия одного пака, compiled — солянка
	// из чужих, partial — заметная доля чужого при своём костяке, trace —
	// единичные чужие вопросы.
	['plagiarism_kind', 'TEXT'],
	// Какая часть своих вопросов нашлась у соседей. Своих — то есть без общих
	// мест: вопрос, стоящий в пяти паках, ничей (см. plagiarismCommonPacks)
	['plagiarism_share', 'REAL'],
	// Сколько в паке чужих вопросов — числом, а не долей. Доля на этот вопрос
	// не отвечает, а спрашивают именно его: «на скольких чужих сыграют».
	// По нему же отбирает фильтр «чужих вопросов хотя бы столько-то», и лежит
	// число готовым по той же причине, что и repeat_share: складывать его
	// на лету пришлось бы обходом всей таблицы на каждое нажатие.
	// NULL — «ничего не нашлось»
	['plagiarism_questions', 'INTEGER'],
	// Откуда взято: [{id, name, n, share}], до пяти доноров от крупного к мелкому.
	// Название донора лежит рядом с номером нарочно — адрес его страницы
	// складывается из номера и названия (см. packSlug в src/slug.js), и без
	// названия карточке пришлось бы ходить в D1 за каждым донором отдельно.
	// Заполняется только у отмеченных паков: одиннадцать строк по паре сотен
	// байт, вес на базу нулевой
	['plagiarism_sources', `TEXT NOT NULL DEFAULT '[]'`],
	// Когда проверяли. По ней видно, чей приговор устарел после переразбора
	// (см. шаг plagiarism в indexer.js); наверх она едет, но в отпечаток строки
	// не входит — иначе каждая ночь увозила бы в D1 всю базу целиком
	// (см. scripts/export-d1.js)
	['plagiarism_at', 'INTEGER'],
	// Сколько тянется медиа в паке, секунды: среднее по файлам и самый длинный
	// (см. src/duration.js). Спрашивают про это не из любопытства — тема из шести
	// песен по полторы минуты идёт девять минут, и пак из тридцати таких тем
	// за вечер не играется. NULL — «ещё не мерили» или «мерить нечего»:
	// у пака из одних картинок длительности нет и быть не может, и подставлять
	// вместо неё ноль значило бы назвать его самым коротким в библиотеке
	['media_avg', 'REAL'],
	['media_max', 'REAL'],
	// Сколько медиафайлов в паке и по скольким из них посчитаны эти два числа.
	// Разница между ними — файлы неизвестного формата, сжатые в архиве или
	// не приехавшие; молчать о ней нельзя, иначе среднее по трём файлам из сорока
	// выглядит средним по паку
	['media_total', 'INTEGER'],
	['media_files', 'INTEGER'],
	// Когда мерили. По ней шаг набирает очередь: пак, перезалитый после
	// измерения, меряется заново (см. fetchDurations в src/indexer/backfill.js)
	['media_at', 'INTEGER'],
	// Где лежит то, что вопросы показывают: в самом паке или за его пределами
	// (см. countMediaRefs в src/siq.js). Пара чисел, а не доля: доля выводится
	// из них делением, а вот «сколько всего кусков» она не расскажет, а спросить
	// про это хочется — «пятьсот картинок по мёртвым ссылкам» и «две» это
	// разные новости.
	//
	// Заведено ради паков вроде 4003 («-3 часа жизни»): 593 вопроса-картинки
	// при архиве в двадцать килобайт — ни одной картинки внутри, все по чужим
	// ссылкам, и ни одна уже не открывается. По всем прочим признакам это
	// обычный аниме-пак на десять раундов, а за столом — 593 пустых экрана.
	//
	// NULL — «ещё не считали»: пак разобран до появления правила. Это не то же
	// самое, что ноль, и сайт про такой пак не пишет ничего
	['media_own', 'INTEGER'],
	['media_offsite', 'INTEGER'],
	// Когда сам файл появился в ВК — не когда выложено сообщение. Файл под
	// сообщением заменяют, а сообщение датой не двигается, и без этой колонки
	// под постом трёхлетней давности мог лежать пак этого месяца, объявляющий
	// первоисточником себя. Позднее из двух и есть возраст содержимого
	// (см. contentTs в src/plagiarism.js). NULL — «неизвестно»: со страницы
	// обсуждения дату файла не узнать, её отдаёт только API
	['file_ts', 'INTEGER'],
	// Краткое описание пака на остальных языках сайта. Спрашивается тем же
	// запросом, что и русское (см. SUMMARY_RULES в src/gemini/summary.js): переводить
	// готовую строку отдельным заходом значило бы платить вторым запросом
	// за то, что модель и так держит в голове, разобрав пак
	['summary_en', 'TEXT'],
	['summary_uk', 'TEXT'],
	['summary_kk', 'TEXT'],
	// Номер пака, копией которого этот является. Ставится вместе со статусом
	// «copy» (см. markCopies в src/indexer/copies.js): один и тот же пак выложен
	// в обсуждение по нескольку раз, и на сайте ему место одно — самое раннее.
	// Номер хранится, чтобы копию было к чему вернуть, если старший пак умрёт
	['copy_of', 'INTEGER'],
	// Непристойно ли название пака: мат, порнография, брань (см. src/obscene.js).
	//
	// Пак от этого никуда не девается — он остаётся на сайте, в выдаче и в поиске
	// по сайту. Меняется одно: его страница просит поисковик себя не
	// индексировать и не едет в карту сайта (см. injectPackMeta в src/meta/pack.js
	// и buildSitemap в src/meta/sitemap.js). Это не то же самое, что снятие
	// с публикации через status='hidden'.
	//
	// Колонка, а не проверка на месте, — потому что название меняется раз
	// в жизни пака, а страница его открывается тысячи раз, и наверху за каждую
	// прочитанную строку платят по тарифу
	['obscene', 'INTEGER NOT NULL DEFAULT 0'],
]) {
	if (!existingColumns.has(name)) {
		db.exec(`ALTER TABLE packages ADD COLUMN ${name} ${definition}`);

		// Только что добавленную долю повторов сразу и заполняем. Иначе она
		// осталась бы пустой у всей базы до ближайшего полного пересчёта разметки,
		// то есть месяцами, — а галочка «мало повторов» всё это время показывала бы
		// вместо ровных паков всю базу подряд. Считается один раз, четверть секунды
		// на одиннадцати тысячах паков, и больше к этому возвращаться не приходится
		if (name === 'repeat_share') {
			db.exec(`UPDATE packages SET repeat_share = ${repeatShareSql(config.subjectPackShare, 'packages')}`);
		}

		// И приговор по названию — тоже сразу, и по той же причине, что и доля
		// выше. Иначе колонка стояла бы нулями до ближайшего `--recalc`, то есть
		// до тех пор, пока его кто-нибудь не попросит руками: в ночном списке
		// пересчёта нет (см. STEPS в src/indexer/steps.js). А нули здесь означают
		// «все названия приличные» — то есть ровно то, из-за чего колонка
		// и заведена, осталось бы несделанным.
		//
		// Проверка эта на строках, а не на SQL, поэтому идёт перебором: два
		// десятка правил на одиннадцать тысяч названий — доли секунды, и второй
		// раз сюда уже не заходят
		if (name === 'obscene') {
			markObscene();
		}
	}
}

/**
 * Проставить признак «непристойное название» по всей базе.
 *
 * Живёт здесь, а не в шаге пересчёта, потому что зовут её двое: дозаливка
 * колонки выше — один раз в жизни базы, и сам пересчёт — всякий раз, когда
 * правили список слов (см. recalcObscene в src/indexer/recalc.js). Правило
 * при этом обязано быть одно: разойдись они — и половина базы судилась бы
 * по вчерашнему списку.
 *
 * Пишется только то, что изменилось: у D1 записанные строки идут по тарифу,
 * а меняется здесь три сотни названий из одиннадцати тысяч.
 *
 * @param {string} where сужение до названных поимённо паков — кусок SQL
 *   от targetSql, написанный через псевдоним `p` (см. src/indexer/queue.js)
 * @param {Array} params его подстановки
 * @returns {{marked: number, cleared: number}} скольким поставили и скольким сняли
 */
export function markObscene(where = '', params = []) {
	const rows = db.prepare(`SELECT p.id, p.name, p.file_name, p.obscene
		FROM packages p WHERE 1 = 1${where}`).all(...params);
	const update = db.prepare('UPDATE packages SET obscene = ? WHERE id = ?');

	let marked = 0;
	let cleared = 0;

	for (const row of rows) {
		// Название, а нет его — имя файла: ровно то, что покажет заголовок
		// вкладки и что уедет в карту сайта (см. packName в src/meta/pack.js)
		const bad = isObsceneName(row.name ?? row.file_name) ? 1 : 0;

		if (bad === (row.obscene ?? 0)) {
			continue;
		}

		update.run(bad, row.id);

		if (bad) {
			marked++;
		} else {
			cleared++;
		}
	}

	return { marked, cleared };
}

// Дозаливка колонок в список авторов
{
	const columns = new Set(db.prepare(`PRAGMA table_info(pack_authors)`).all().map(c => c.name));

	for (const [name, definition] of [
		// Под каким именем этот автор считается одним человеком.
		//
		// Подпись внутри файла — не человек, а надпись. Один и тот же человек
		// подписывается то «Vieldy», то «vieldy_», то именем своей команды,
		// и в топе авторов он стоял столькими строками, сколько написаний
		// придумал. Между тем видно, что это один человек: паки выложены
		// с одной и той же страницы ВК.
		//
		// Отсюда две колонки рядом с подписью: author_key остаётся тем, что
		// написано в файле (по нему пак и находится по ссылке с карточки),
		// а canon_key — тем, кто это на самом деле. Считает их шаг authors
		// (см. mergeAuthors в src/indexer/authors.js); пока он не прошёл, канон равен
		// подписи, и всё работает ровно как раньше
		['canon_key', 'TEXT'],
		['canon_name', 'TEXT'],

		// Номер страницы ВК, с которой этот человек выкладывает свои паки, —
		// или пусто, если такой страницы одной не набралось.
		//
		// Считается тем же шагом и по тому же правилу, что и канон: страница
		// достаётся человеку, только если все его подписи ведут на неё одну
		// (см. mergeAuthors в src/indexer/authors.js). Иначе бы человек,
		// перевыложивший чужой пак, забрал бы себе и чужого автора.
		//
		// Зачем это в базе, а не считается на месте. По этой колонке сайт
		// узнаёт своего: вошедший через ВК получает подтверждённое авторство
		// тех подписей, у которых здесь стоит номер его страницы
		// (см. cf/src/library/authorship.js). Считать это наверху значило бы
		// на каждый вход поднимать всю таблицу подписей, а у D1 прочитанные
		// строки идут по тарифу.
		//
		// Номер, а не адрес: адрес у одного и того же человека бывает двух
		// видов — vk.com/id123 и vk.com/короткое_имя, — а ВК при входе
		// называет только номер, и сравнивать с адресом его нечем
		['canon_account', 'TEXT'],
	]) {
		if (!columns.has(name)) {
			db.exec(`ALTER TABLE pack_authors ADD COLUMN ${name} ${definition}`);
		}
	}

	// Пустой канон — это «шаг authors ещё не проходил», и означает он «сам себе
	// человек». Заполняется здесь один раз, а не остаётся NULL, чтобы запросам
	// сайта не приходилось помнить про этот случай
	db.exec('UPDATE pack_authors SET canon_key = author_key, canon_name = author WHERE canon_key IS NULL');

	// Указатель заводится здесь, а не в схеме наверху: там он стоял бы рядом
	// с CREATE TABLE IF NOT EXISTS, то есть выполнялся бы на старой таблице,
	// где колонки ещё нет, — и весь модуль падал бы на первом же запуске
	db.exec('CREATE INDEX IF NOT EXISTS ix_pack_authors_canon ON pack_authors (canon_key)');

	// А этот — ради одного вопроса, который задаёт каждый вход через ВК: «какие
	// подписи принадлежат вот этой странице». Без него он обходил бы всю таблицу
	// подписей — двадцать тысяч строк, считанных по тарифу D1, на каждый вход
	db.exec('CREATE INDEX IF NOT EXISTS ix_pack_authors_account ON pack_authors (canon_account)');
}

// Дозаливка колонок в свёртку отпечатков
{
	const columns = new Set(db.prepare(`PRAGMA table_info(pack_prints)`).all().map(c => c.name));

	for (const [name, definition] of [
		// Какого вида свёртка: 1 — двенадцать байт на вопрос, 2 — шестнадцать,
		// с весом приложенных файлов (см. PRINTS_VERSION в src/plagiarism.js).
		// Различить их по длине нельзя — сорок восемь байт делится и на то,
		// и на другое, — поэтому вид записан рядом. Единица по умолчанию: всё,
		// что снято до появления колонки, снято старым видом
		['version', 'INTEGER NOT NULL DEFAULT 1'],
	]) {
		if (!columns.has(name)) {
			db.exec(`ALTER TABLE pack_prints ADD COLUMN ${name} ${definition}`);
		}
	}
}

// Дозаливка колонок в таблицу знаний о моделях
{
	const columns = new Set(db.prepare(`PRAGMA table_info(gemini_limits)`).all().map(c => c.name));

	for (const [name, definition] of [
		// Модель отказалась работать с этим ключом насовсем: «no longer available
		// to new users». Проверить это заранее нельзя — в списке доступных моделей
		// такая выглядит совершенно обычной
		['unavailable', 'INTEGER NOT NULL DEFAULT 0'],
		['note', 'TEXT'],
	]) {
		if (!columns.has(name)) {
			db.exec(`ALTER TABLE gemini_limits ADD COLUMN ${name} ${definition}`);
		}
	}
}

// Сообщение обсуждения целиком: по нему индексатор сверяет, не поменялось ли
// то, что в нём написано и приложено (см. scanVk). Без указателя эта сверка
// означала бы обход всей таблицы на каждое сообщение обсуждения.
db.exec('CREATE INDEX IF NOT EXISTS ix_packages_comment ON packages (vk_topic, vk_comment)');

db.exec('CREATE INDEX IF NOT EXISTS ix_packages_topic ON packages (primary_topic)');
db.exec('CREATE INDEX IF NOT EXISTS ix_packages_franchise ON packages (franchise_top)');
db.exec('CREATE INDEX IF NOT EXISTS ix_packages_vk_ts ON packages (vk_ts)');

// Указатели «покрывающие»: в них лежит и то, по чему ищут (status), и то, что
// при этом спрашивают. Разница не в поиске, а в том, что после него не нужно
// поднимать саму строку пака, — а строка эта тяжёлая: в ней лежат разобранные
// раунды, и весит она килобайты. Колонка слева считает типы, языки и темы
// по всей базе разом, и на каждый такой подсчёт база поднимала все строки
// целиком ради одного короткого поля. Теперь ответ целиком лежит в указателе.
//
// Те же указатели уезжают и в D1: выгрузка берёт их из этой базы (см.
// scripts/export-d1.js), а наверху они дороже вдвойне — там читанные строки
// не просто время, а расход по тарифу.
db.exec('CREATE INDEX IF NOT EXISTS ix_packages_ok_topic ON packages (status, primary_topic)');
// Язык считается по двум колонкам сразу: сперва тот, что назвала модель, и лишь
// потом тот, что записан в файле (см. LANG_SQL в src/server/filters.js). Обе лежат в одном
// указателе, чтобы подсчёт по всей базе по-прежнему собирался, не поднимая строк.
//
// Указатель со старым набором колонок сносится: «если ещё нет» существующий
// не трогает, и база, заведённая прошлой версией, осталась бы с указателем
// без language_ai — то есть подсчёт языков поднимал бы все строки целиком.
{
	const langIndex = 'ix_packages_ok_lang';
	const known = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).get(langIndex)?.sql ?? '';

	if (known && !known.includes('language_ai')) {
		db.exec(`DROP INDEX ${langIndex}`);
	}

	db.exec(`CREATE INDEX IF NOT EXISTS ${langIndex} ON packages (status, language_ai, language)`);
}
// Ярлыки из шапки пака (<tag> в content.xml) больше не читаются вовсе,
// и указатель по ним не нужен: по нему не спрашивают ни отбор, ни колонка
// фильтров, ни счёт (см. tags в CREATE TABLE выше). Снимается он здесь,
// а не забывается молча: указатель, оставшийся от снятого правила, ездит
// в D1 вместе со схемой и стоит места на каждой строке.
db.exec('DROP INDEX IF EXISTS ix_packages_ok_tags');

// Отбор «скрыть плагиат» в выдаче: по этому указателю он и работает. Метка стоит
// у считаных паков, а спрашивают её у всей библиотеки на каждое нажатие галочки —
// то есть ответ должен собираться из указателя, не поднимая строк.
db.exec('CREATE INDEX IF NOT EXISTS ix_packages_plagiarism ON packages (status, plagiarism_kind)');

// Отбор «чужих вопросов хотя бы столько-то» — сосед предыдущего и по той же
// причине: число стоит у считаных паков, а спрашивают его у всей библиотеки
// на каждое движение в списке фильтров.
db.exec('CREATE INDEX IF NOT EXISTS ix_packages_stolen ON packages (status, plagiarism_questions)');
db.exec('CREATE INDEX IF NOT EXISTS ix_packages_ok_vk_ts ON packages (status, vk_ts)');

// Одинаково названные паки одного автора: сколько их, столько строк статистики
// сервис SIGame сложил в одну кучу (см. STATS_TWINS в src/server/packs.js).
// Число это спрашивается подзапросом у каждого пака страницы, и колонки в нём
// две — сам ключ и «пак ещё на сайте».
//
// Обе они лежат здесь, и порядок в указателе именно такой — ключ первым, —
// потому что искать по нему. Указатель по одному match_key тут не годился:
// дома, где по базе прошёлся ANALYZE, планировщик брал его сам, а в D1 таблицу
// никто не мерил, и там он выбирал ix_packages_stolen — то есть на каждый пак
// страницы обходил все одиннадцать тысяч оставшихся. Две дюжины паков в выдаче
// стоили 263 448 прочитанных строк и секунду ожидания; с этим указателем —
// 72 строки и миллисекунда, и это самая дорогая строка тарифа D1, какая
// на сайте была.
//
// Прежний ix_packages_match отсюда и снесён (ниже): этот накрывает его целиком —
// поиск по одному match_key идёт по левой колонке.
db.exec('CREATE INDEX IF NOT EXISTS ix_packages_match_ok ON packages (match_key, status)');

// Дополнительные типы паков — те, что целиком про один предмет (см. subjectPackShare).
// Колонка слева считает их по всей базе, и обе колонки, по которым идёт отбор,
// лежат прямо здесь: ответ собирается из указателя, не поднимая строк.
db.exec('CREATE INDEX IF NOT EXISTS ix_packages_ok_subject ON packages (status, franchise_top, franchise_top_share)');

// Ключ пака — не колонка, а выражение: номер оставшегося пака, то есть copy_of,
// а нет его — свой собственный номер (см. PACK_KEY_SQL в keys.js). Так и задумано:
// один и тот же файл нередко выложен в обсуждение не по разу, лежит в базе
// несколькими строками с разными номерами, а отметка «сыграно», оценка и чёрный
// список у него одни на все копии — они про пак, а не про строку.
//
// Платой за это был обход всей таблицы на каждый вопрос «а что это за пак».
// Причём обход с подъёмом каждой строки целиком: ключ считался из двух её
// полей, а в строке пака лежат разобранные раунды — килобайты на пак. Страница
// профиля спрашивала так четыре раза кряду, и на пятнадцати тысячах паков это
// были не миллисекунды, а секунды; наверху те же строки ещё и считаны по тарифу
// D1 (см. getProfile в cf/src/library/profile.js).
//
// Указатель по выражению годится не везде. В соединении «JOIN packages ON
// <ключ> = pack_key» SQLite его не видит вовсе и обходит таблицу по-прежнему —
// ни прямо, ни через подзапрос его туда не завести. Годится он там, где ключ
// сравнивается с подставленным значением: «<ключ> IN (?, ?, …)». На этом
// и построены запросы, которые спрашивают паки по ключам, — профиль и опознание
// списка файлом.
//
// Причём назван он в них прямо, через INDEXED BY: здесь по базе проходил ANALYZE
// и планировщик выбирает его сам, а в D1 таблицу никто не мерил, и там он без
// подсказки берёт ix_packages_status, то есть обходит всё (см. packsByKeys
// в cf/src/library/profile.js). Отсюда же и «IF NOT EXISTS» без всяких условий: запрос
// с INDEXED BY на базе без этого указателя не выполнится вообще.
//
// ————— и почему он ещё и сносится —————
//
// «CREATE INDEX IF NOT EXISTS» на существующем имени не делает ничего — даже
// если выражение под ним стало другим. А оно менялось: ключ пака раньше
// складывался из идентификатора файла и названия, теперь это номер оставшегося
// пака (см. packKey в keys.js). База, заведённая прежней версией, осталась бы
// с указателем по старому выражению — а запрос с INDEXED BY на такой указатель
// не выполнится вовсе: «no query solution». То есть страница профиля просто
// перестала бы открываться.
//
// Поэтому выражение сверяется с записанным в самой базе, и при расхождении
// указатель перекладывается. Стоит это секунду на одиннадцати тысячах строк
// и случается ровно один раз — при первом запуске после правки правила.
{
	const wanted = `CREATE INDEX ix_packages_pack_key ON packages (${PACK_KEY_INDEX_SQL})`;
	const known = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ix_packages_pack_key'`).get()?.sql;

	if (known && known.replace(/\s+/g, ' ').trim() !== wanted.replace(/\s+/g, ' ').trim()) {
		db.exec('DROP INDEX ix_packages_pack_key');
	}
}

db.exec(`CREATE INDEX IF NOT EXISTS ix_packages_pack_key ON packages (${PACK_KEY_INDEX_SQL})`);

// Ключ названия — половина match_key до перевода строки, то есть тоже выражение,
// а не колонка (см. NAME_KEY_SQL в src/keys.js). По нему опознаётся список
// паков, принесённый файлом: «вот двести названий, что из них есть в базе».
//
// Указателя по этому выражению не было, и обходился он дорого. Названия
// в запросе не сужали ничего: на каждую пачку из девяноста имён база брала
// ix_packages_stolen, то есть обходила все паки со status = 'ok' — одиннадцать
// тысяч строк — и на каждой считала SUBSTR. Один запрос с девятью тысячами
// имён стоил около миллиона прочитанных строк D1: пять таких подряд, без входа
// и без печенья, съедали суточный запас, на котором сайт уже ложился.
//
// Потолок на число названий теперь стоит там же, в matchList, а указатель
// убирает и сам обход: пачка из девяноста имён — это девяносто заглядываний
// вместо одиннадцати тысяч строк.
//
// Колонки в таком порядке — ключ первым, — потому что искать по нему; status
// стоит второй, чтобы «пак ещё на сайте» решалось прямо в указателе, не поднимая
// строки. Ровно так же устроен ix_packages_match_ok выше.
//
// Назван он в запросах прямо, через INDEXED BY, и по той же причине, что
// и ix_packages_pack_key: дома по базе проходил ANALYZE и планировщик берёт
// его сам, а в D1 таблицу никто не мерил, и там он без подсказки выбирает
// что попало. Отсюда же сверка выражения с записанным в базе: запрос с INDEXED BY
// на указатель по СТАРОМУ выражению не выполнится вовсе — «no query solution», —
// и опознание списка просто перестало бы работать.
{
	const wanted = `CREATE INDEX ix_packages_name_key ON packages (${NAME_KEY_INDEX_SQL}, status)`;
	const known = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ix_packages_name_key'`).get()?.sql;

	if (known && known.replace(/\s+/g, ' ').trim() !== wanted.replace(/\s+/g, ' ').trim()) {
		db.exec('DROP INDEX ix_packages_name_key');
	}
}

db.exec(`CREATE INDEX IF NOT EXISTS ix_packages_name_key ON packages (${NAME_KEY_INDEX_SQL}, status)`);

// Журнал WAL растёт, пока его никто не подрезает, а подрезать его мешает любой
// открытый читатель — то есть сам сайт, который держит базу открытой сутками.
// Здесь он ещё никем не открыт, и это единственный надёжный миг всё сложить
// обратно в базу: к 6 МБ базы успевало накопиться 9 МБ журнала, и каждый обход
// таблицы шёл сначала по нему. Не вышло (базу занял индексатор) — не беда,
// вернётся ошибка занятости, и всё продолжит работать как прежде.
try {
	db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
} catch {
	// база занята другим процессом — журнал подрежется в другой раз
}

// Следы прежних попыток считать популярность за период: сначала по разнице числа
// игр, потом по дате из самого файла пака. Теперь период считается по времени
// появления пака в обсуждении (vk_ts), и ни то, ни другое больше не нужно.
db.exec('DROP TABLE IF EXISTS stats_history');
db.exec('DROP INDEX IF EXISTS ix_packages_date');

// Указатель по одному match_key: его место занял ix_packages_match_ok,
// у которого та же левая колонка и вдобавок status (см. выше).
db.exec('DROP INDEX IF EXISTS ix_packages_match');

if (existingColumns.has('pack_date_iso')) {
	db.exec('ALTER TABLE packages DROP COLUMN pack_date_iso');
}

const VK_MONTHS = {
	янв: 0, фев: 1, мар: 2, апр: 3, мая: 4, май: 4, июн: 5,
	июл: 6, авг: 7, сен: 8, окт: 9, ноя: 10, дек: 11,
};

/**
 * Время сообщения ВК из того вида, в каком его показывает страница обсуждения:
 * «7 авг 2026 в 13:51», «12 июл в 21:33» (год опущен — значит текущий),
 * «сегодня в 0:34», «вчера в 20:26». Возвращает миллисекунды или null.
 *
 * Через VK API этого разбора не нужно — там время приходит числом (см. vkapi.js),
 * но без ключа обсуждения читаются как обычные страницы, и другого источника нет.
 *
 * @param at к какому моменту относятся «сегодня» и «вчера»: строку разбираем
 *   тогда же, когда прочитали страницу, поэтому по умолчанию это «сейчас».
 */
export function parseVkDate(raw, at = Date.now()) {
	const text = (raw ?? '').trim().toLowerCase();

	if (!text) {
		return null;
	}

	// Не \bв\s+…: \b в JS считает границу слова по латинице, и перед кириллическим
	// «в» её нет — время просто не находилось, а у всех сообщений выходил полдень.
	const time = /(?:^|\s)в\s+(\d{1,2}):(\d{2})/.exec(text);
	const hours = time ? Number(time[1]) : 12;
	const minutes = time ? Number(time[2]) : 0;

	const relative = /^(сегодня|вчера)/.exec(text);

	if (relative) {
		const day = new Date(at);
		day.setHours(hours, minutes, 0, 0);

		if (relative[1] === 'вчера') {
			day.setDate(day.getDate() - 1);
		}

		return day.getTime();
	}

	const parts = /^(\d{1,2})\s+([а-яё]+)\.?(?:\s+(\d{4}))?/.exec(text);

	if (!parts) {
		return null;
	}

	const month = VK_MONTHS[parts[2].slice(0, 3)];

	if (month === undefined) {
		return null;
	}

	const year = parts[3] ? Number(parts[3]) : new Date(at).getFullYear();

	return new Date(year, month, Number(parts[1]), hours, minutes).getTime();
}

const readSetting = db.prepare('SELECT value FROM app_settings WHERE key = ?');
const writeSetting = db.prepare(`
	INSERT INTO app_settings (key, value) VALUES (?, ?)
	ON CONFLICT (key) DO UPDATE SET value = excluded.value
`);

/** Настройка, поставленная из окна сайта. Не поставлена — вернётся fallback. */
export function getSetting(key, fallback = null) {
	return readSetting.get(key)?.value ?? fallback;
}

export function setSetting(key, value) {
	writeSetting.run(key, String(value));
}

const deleteAuthors = db.prepare('DELETE FROM pack_authors WHERE package_id = ?');
// Канон при вставке равен подписи: кто с кем один человек, решает отдельный
// шаг по всей базе разом (см. mergeAuthors в src/indexer/authors.js), и знать этого
// в момент разбора одного пака неоткуда
const insertAuthor = db.prepare(`
	INSERT OR IGNORE INTO pack_authors (package_id, author_key, author, canon_key, canon_name)
	VALUES (?, ?, ?, ?, ?)
`);

/**
 * Переписывает авторов пака. Вызывается после каждого разбора.
 *
 * Составная подпись разбирается на людей: «Vieldy,Pa4ok,Slime» — это трое,
 * и в таблице им место по строке на каждого (см. splitAuthors). Иначе паки
 * Vieldy по его имени не находились, а в топе авторов такое сочетание стояло
 * отдельной строкой, никак не связанной с самими Vieldy и Pa4ok.
 *
 * В самой колонке packages.authors подпись при этом остаётся ровно такой, как
 * записана в файле: по ней пак ищется в сервисе статистики SIGame, и там его
 * знают именно под ней (см. fetchPackageStats).
 */
export function saveAuthors(packageId, authors) {
	deleteAuthors.run(packageId);

	for (const author of splitAuthors(authors)) {
		const key = buildAuthorKey(author);

		if (key) {
			insertAuthor.run(packageId, key, author.trim(), key, author.trim());
		}
	}
}

// Дозаливка подписи автора тем, кто разобран до того, как её научились брать
// из ВК (см. authorsOrVk в keys.js). Разбирать пак заново ради одного поля
// незачем: имя и фамилия лежат в той же строке, в vk_author.
{
	const nameless = db.prepare(`
		SELECT id, name, vk_author FROM packages
		WHERE (authors = '[]' OR authors IS NULL OR TRIM(COALESCE(authors_key, '')) = '')
			AND TRIM(COALESCE(vk_author, '')) <> ''
	`).all();

	if (nameless.length > 0) {
		const update = db.prepare('UPDATE packages SET authors = ?, authors_key = ?, match_key = ? WHERE id = ?');

		for (const row of nameless) {
			const authors = authorsOrVk([], row.vk_author);

			update.run(JSON.stringify(authors), authors.join(', '), buildMatchKey(row.name, authors), row.id);
			saveAuthors(row.id, authors);
		}
	}
}

// Одноразовая заливка таблицы авторов для паков, разобранных до её появления
{
	const missing = db.prepare(`
		SELECT p.id, p.authors FROM packages p
		WHERE p.status = 'ok' AND p.authors <> '[]'
			AND NOT EXISTS (SELECT 1 FROM pack_authors a WHERE a.package_id = p.id)
	`).all();

	for (const row of missing) {
		saveAuthors(row.id, jsonOrDefault(row.authors, []));
	}
}

// Разбор составных подписей для паков, записанных до того, как их научились
// разбирать: «Vieldy,Pa4ok,Slime» лежало в таблице одной строкой. Переписываем
// только тех, у кого разбор что-то меняет, — сравнением набора ключей: перебирать
// полторы тысячи паков дешевле, чем оставить половину авторов ненажимаемыми,
// а переиндексация ради этого не нужна вовсе, подпись уже лежит в базе.
{
	const rows = db.prepare(`
		SELECT p.id, p.authors,
			(SELECT GROUP_CONCAT(a.author_key, CHAR(10)) FROM (
				SELECT author_key FROM pack_authors WHERE package_id = p.id ORDER BY author_key
			) a) AS stored
		FROM packages p
		WHERE p.status = 'ok' AND p.authors <> '[]'
	`).all();

	let fixed = 0;

	for (const row of rows) {
		const wanted = splitAuthors(jsonOrDefault(row.authors, []))
			.map(buildAuthorKey)
			.filter(Boolean)
			.sort()
			.join('\n');

		if (wanted !== (row.stored ?? '')) {
			saveAuthors(row.id, jsonOrDefault(row.authors, []));
			fixed++;
		}
	}

	if (fixed > 0) {
		console.log(`Составных подписей авторов разобрано: ${fixed}.`);
	}
}

// Время сообщения для паков, собранных до появления колонки. Заново обходить
// обсуждение не нужно: строка вида «7 авг 2026 в 13:51» всё это время лежала
// в vk_date. «Сегодня» и «вчера» в ней считаются от того дня, когда пак попал
// в базу, а не от сегодняшнего: тогда эта строка и была написана.
{
	const rows = db.prepare(`
		SELECT id, vk_date, indexed_at FROM packages
		WHERE vk_ts IS NULL AND vk_date IS NOT NULL AND vk_date <> ''
	`).all();

	if (rows.length > 0) {
		const update = db.prepare('UPDATE packages SET vk_ts = ? WHERE id = ?');

		for (const row of rows) {
			update.run(parseVkDate(row.vk_date, row.indexed_at ?? Date.now()), row.id);
		}
	}
}

// Уровень сложности пересчитывается при запуске: пороги живут в config.js, и правка
// руками должна сразу отражаться на сайте, а не ждать следующего обхода статистики.
// Правило то же, что в stats.js: toLevel().
{
	const minGames = Number(config.minGamesForDifficulty);
	const minShown = Number(config.minShownForDifficulty);
	const { easy, medium, hard } = config.difficultyThresholds;

	// Ступень вниз за низкую долю правильных ответов — то же правило, что в toLevel():
	// отвечать решаются, но отвечают мимо, и пак труднее, чем показывает процент попыток.
	const levelCase = `CASE
		WHEN take_percent IS NULL THEN NULL
		WHEN started_games < ${minGames} THEN NULL
		WHEN shown < ${minShown} THEN NULL
		ELSE MAX(1, (CASE
			WHEN take_percent > ${Number(easy)} THEN 4
			WHEN take_percent >= ${Number(medium)} THEN 3
			WHEN take_percent >= ${Number(hard)} THEN 2
			ELSE 1
		END) - (CASE
			WHEN right_percent IS NOT NULL AND right_percent < ${Number(config.hardRightPercent)} THEN 1
			ELSE 0
		END))
	END`;

	db.exec(`UPDATE stats SET level = ${levelCase} WHERE level IS NOT (${levelCase})`);
}
