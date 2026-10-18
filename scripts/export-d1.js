// Выгрузка базы паков в SQL для заливки в D1.
//
// Ключи: --full   выгрузить всё заново, с заменой таблиц;
//        --commit запомнить, что выгруженное доехало (зовётся из deploy-cf.js).
//
// Что уезжает наверх: packages, stats, pack_formats, pack_authors — всё, что собирает
// индексатор. Что не уезжает никогда: users, sessions, ratings, blacklist,
// played. Это не наша база, а то, что накопили посетители, и живёт оно только
// в D1 (см. cf/schema.sql). Заливка их не трогает — иначе каждая выкладка
// стирала бы все оценки на сайте.
//
// ————— почему выгрузка неполная —————
//
// Раньше здесь каждый раз выкладывалось всё целиком, с заменой таблиц, и в
// комментарии стояло честное «база маленькая, разбираться, что изменилось, —
// отдельная работа ради экономии полуминуты». На полутысяче паков так и было.
//
// На пятнадцати тысячах то же самое означает двести мегабайт SQL каждую ночь
// и сорок пять тысяч записанных строк — при том, что за ночь меняется несколько
// сотен. У D1 записанные строки считаны по тарифу (сто тысяч в сутки на
// бесплатном), а сама заливка идёт кусками по паре мегабайт, каждый — отдельный
// поход к Cloudflare. Полная выгрузка перестала быть «полуминутой».
//
// Поэтому теперь база помнит, что именно она уже отправила: у каждой строки
// считается отпечаток, и наверх уходят только те, у которых он с прошлого раза
// изменился. Отпечатки живут в самой базе (таблица d1_sync) — вместе с ней они
// и путешествуют, а значит ночной обход в GitHub Actions знает ровно то же,
// что знал бы этот компьютер.
//
// Отпечатки записываются не при выгрузке, а после успешной заливки (--commit):
// сорвавшаяся выкладка не должна оставить базу в уверенности, что наверху лежит
// то, чего там нет.
//
// Когда всё равно выкладывается всё целиком:
//   • первый раз — отпечатков ещё нет;
//   • после правки таблиц — в D1 не хватает новой колонки, и одними INSERT
//     туда не попасть;
//   • по ключу --full — например, если базу в Cloudflare завели заново.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
// Отпечаток строки считается не здесь, а рядом: тем же счётом пользуется сверка
// с базой наверху, и разойтись им нельзя (см. scripts/deploy/rowhash.js)
import { digest, literal, rowHash, SKIP } from './deploy/rowhash.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = path.join(root, 'data', 'sibase.db');
const outPath = path.join(root, 'cf', 'data');

/**
 * Порядок важен: stats, pack_formats и pack_authors ссылаются на packages,
 * поэтому создаются позже него, а удаляются раньше.
 */
const TABLES = ['packages', 'stats', 'pack_formats', 'pack_authors'];

/**
 * Насколько длинным можно отпускать один запрос, байты. Считаем по объёму,
 * а не по числу строк: у пака вся его разбивка на раунды лежит одним полем,
 * и строки различаются по весу в сотни раз — «по двадцать штук» давало
 * то запрос на пару килобайт, то на полтораста.
 *
 * Полтораста и есть причина порога: D1 отказывается выполнять запрос длиннее
 * своего предела и отвечает «statement too long: SQLITE_TOOBIG». Здесь взято
 * с большим запасом — заливка от этого не медленнее, а упереться в предел
 * на паке с необычно подробной разбивкой не хочется.
 */
const MAX_STATEMENT = 48 * 1024;

/** Насколько разрастись куску, прежде чем начать следующий, байты. */
const CHUNK_SIZE = 2 * 1024 * 1024;

const full = process.argv.includes('--full');
const commit = process.argv.includes('--commit');


/** Пишет куски по мере наполнения: держать в памяти весь дамп незачем. */
class ChunkWriter {
	constructor(directory) {
		this.directory = directory;
		this.parts = [];
		this.size = 0;
		this.index = 0;
		this.files = [];
		this.total = 0;
	}

	write(text) {
		this.parts.push(text);
		this.size += Buffer.byteLength(text);
		this.total += Buffer.byteLength(text);

		if (this.size >= CHUNK_SIZE) {
			this.flush();
		}
	}

	/**
	 * Кусок можно закрыть только между запросами: разорванный посередине
	 * INSERT не выполнится ни целиком, ни по частям.
	 */
	flush() {
		if (this.parts.length === 0) {
			return;
		}

		this.index++;
		const name = `content-${String(this.index).padStart(3, '0')}.sql`;
		fs.writeFileSync(path.join(this.directory, name), this.parts.join(''), 'utf8');

		this.files.push(name);
		this.parts = [];
		this.size = 0;
	}
}

/**
 * Сколько значений отпускать в один запрос.
 *
 * Порога два, и меряют они разное. MAX_STATEMENT считает байты — от него
 * зависит, влезет ли запрос в предел длины. Это число считает сами значения,
 * и заведено оно по отказу D1: `DELETE ... WHERE package_id IN (…)` на девять
 * тысяч коротких номеров весит полсотни килобайт, то есть в предел длины
 * укладывается с запасом, — а SQLite отвечает на него «out of memory:
 * SQLITE_NOMEM». Дело не в объёме, а в числе слагаемых: каждое из них
 * разбирается в своё выражение, и на такой список у разбора кончается память.
 *
 * Пятьсот — с большим запасом от того места, где это началось. На вставках
 * порог не срабатывает почти никогда: там первым упирается объём.
 */
const MAX_VALUES = 500;

/**
 * Собирает длинный список значений в запросы не длиннее MAX_STATEMENT
 * и не шире MAX_VALUES.
 * Строка, которая одна перевалила за порог, всё равно уходит своим запросом:
 * разрезать её нечем, и пусть лучше D1 откажет на ней одной, чем мы молча
 * выбросим пак из выгрузки.
 */
function batched(writer, head, tail, values) {
	let batch = [];
	let length = 0;

	const flush = () => {
		if (batch.length > 0) {
			writer.write(`${head}${batch.join(',\n')}${tail};\n`);
			batch = [];
			length = 0;
		}
	};

	for (const value of values) {
		if (length > 0 && (length + value.length > MAX_STATEMENT || batch.length >= MAX_VALUES)) {
			flush();
		}

		batch.push(value);
		length += value.length + 2;
	}

	flush();
}

function openDatabase() {
	if (!fs.existsSync(dbPath)) {
		console.error(`Базы нет: ${dbPath}. Соберите её обычным запуском (npm run index).`);
		process.exit(1);
	}

	const db = new DatabaseSync(dbPath);

	db.exec(`
		CREATE TABLE IF NOT EXISTS d1_sync (
			tbl TEXT NOT NULL,
			row_id INTEGER NOT NULL,
			hash TEXT NOT NULL,
			PRIMARY KEY (tbl, row_id)
		);

		CREATE TABLE IF NOT EXISTS d1_pending (
			tbl TEXT NOT NULL,
			row_id INTEGER NOT NULL,
			hash TEXT NOT NULL,
			PRIMARY KEY (tbl, row_id)
		);

		CREATE TABLE IF NOT EXISTS d1_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	`);

	return db;
}

/**
 * Схема, какой она уедет наверх. Берётся из самой базы, а не пишется здесь
 * второй раз: колонки в packages дозаливаются по мере надобности (см. db.js),
 * и список, записанный тут, разошёлся бы с настоящим при первом же добавлении.
 */
function schemaOf(db, table) {
	const { sql } = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);

	const indexes = db.prepare(`
		SELECT name, sql FROM sqlite_master
		WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL
		ORDER BY name
	`).all(table);

	return { table: sql, indexes };
}

/** Имена указателей, записанные прошлой выкладкой. Испорченное читается как пустое. */
function nameList(value) {
	try {
		const parsed = JSON.parse(value ?? '[]');

		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** То же, но с «если ещё нет»: повторная заливка не должна спотыкаться. */
const ifMissing = sql => sql
	.replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS ')
	.replace(/^CREATE (UNIQUE )?INDEX /, 'CREATE $1INDEX IF NOT EXISTS ');

/**
 * Строки таблицы вместе с их отпечатками. Читаются потоком: пятнадцать тысяч
 * паков с разобранными раундами — это полтораста мегабайт, и поднимать их
 * в память все разом ради подсчёта отпечатков незачем.
 *
 * @param skip колонки, не входящие в отпечаток
 */
function* rowsWithHash(db, table, key, skip = []) {
	for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).iterate()) {
		const columns = Object.keys(row);

		yield {
			id: row[key],
			columns,
			row,
			hash: rowHash(row, skip),
		};
	}
}

/**
 * Расчистить наверху место под пачку паков: снести строки, которые сидят
 * на чужом ключе документа.
 *
 * Зачем это нужно. У packages два неповторимых поля: номер строки (id) и ключ
 * документа ВК (source_key UNIQUE). Наверх пак уезжает как «вставить, а если
 * такой номер уже есть — обновить», и про второй запрет такая вставка не знает
 * ничего: наткнувшись на чужой source_key, D1 отвечает отказом и бросает весь
 * файл целиком.
 *
 * А расходиться номерам есть от чего. Номера раздаёт AUTOINCREMENT той базы,
 * которая нашла пак первой, и база эта не одна: домашняя машина и оба обхода
 * в GitHub Actions ведут счёт от общей полки, но находят новое порознь. Стоит
 * паку пропасть из базы и найтись заново — а именно это и делает слияние полки,
 * когда домашняя машина кладёт поверх свою, более старую копию, — как тот же
 * самый файл получает новый номер. Наверху он при этом лежит под старым.
 *
 * Так и вышло в ночь на 20 августа 2026. Обход собрал базу за полтора часа
 * и сорвался на выкладке: «UNIQUE constraint failed: packages.source_key»
 * на шестьдесят шестом файле из шестидесяти шести. Отметки о доехавшем после
 * такого срыва не ставится (см. --commit), поэтому следующая же выкладка везла
 * наверх всю базу заново — сто тридцать мегабайт вместо пяти, — и срывалась
 * там же. Четыре часа обходов подряд не выложили ничего.
 *
 * Что здесь делается. Перед вставкой пачки сносится всё, что заняло её ключи
 * под другими номерами. Строка, попавшая под этот запрос, — заведомо чужая:
 * source_key во всей базе один, и раз мы сию секунду вставляем его под своим
 * номером, всякий другой номер при нём — след прежней нумерации. Своё этот
 * запрос не задевает никогда: номера пачки из него исключены поимённо.
 *
 * Стоит это дёшево. Поиск идёт по неповторимому указателю, а совпадений
 * в обычную ночь нет вовсе — то есть ни одной записанной строки, а они у D1
 * и считаны по тарифу. Статистика и авторы снесённой строки уходят за ней
 * по внешнему ключу, и это правильно: они принадлежали старому номеру.
 * Под новым номером пак для нас новый, и его строки уезжают этой же выкладкой.
 *
 * При полной выгрузке ничего этого не надо: там таблицы сносятся целиком,
 * и спорить за ключи не с кем.
 */
function writeGuard(writer, rows) {
	if (rows.length === 0) {
		return;
	}

	const keys = rows.map(row => literal(row.sourceKey)).join(',');
	const ids = rows.map(row => String(row.id)).join(',');

	writer.write(`DELETE FROM packages WHERE source_key IN (${keys}) AND id NOT IN (${ids});\n`);
}

/** Готовый INSERT … ON CONFLICT: обновляет всё, кроме ключа. */
function upsertHead(table, columns, key) {
	const assignments = columns
		.filter(column => column !== key)
		.map(column => `${column} = excluded.${column}`)
		.join(', ');

	return {
		head: `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n`,
		// Именно ON CONFLICT, а не INSERT OR REPLACE: замена — это удаление
		// и вставка, а удаление пака уносит за собой его статистику и авторов
		// по внешнему ключу. Обновление ничего за собой не тянет.
		tail: `\nON CONFLICT (${key}) DO UPDATE SET ${assignments}`,
	};
}

function main() {
	const db = openDatabase();

	if (commit) {
		// Доехало: то, что было заявлено, теперь и есть наверху.
		db.exec('DELETE FROM d1_sync');
		db.exec('INSERT INTO d1_sync (tbl, row_id, hash) SELECT tbl, row_id, hash FROM d1_pending');
		db.exec('DELETE FROM d1_pending');

		// Отпечатки схемы и указателей — туда же и по той же причине. Пока он ставился прямо
		// при выгрузке, одна сорвавшаяся выкладка калечила все следующие: схема
		// наверху оставалась старой, а база уже считала, что сообщила о новой,
		// и вместо «выложить целиком» собирала CREATE TABLE IF NOT EXISTS —
		// в существующую старую таблицу, где новой колонки нет. Заливка после
		// этого падала на первом же паке («table packages has no column named …»),
		// и сама выправиться не могла: каждая следующая выгрузка приходила
		// к тому же выводу.
		for (const key of ['tables', 'indexes', 'index_names']) {
			db.prepare(`
				INSERT OR REPLACE INTO d1_meta (key, value)
				SELECT ?, value FROM d1_meta WHERE key = ?
			`).run(key, `${key}_pending`);

			db.prepare(`DELETE FROM d1_meta WHERE key = ?`).run(`${key}_pending`);
		}

		// Отпечаток по старым правилам — таблицы вместе с указателями. Сравнивать
		// его больше не с чем, и лежать ему незачем.
		db.exec(`DELETE FROM d1_meta WHERE key IN ('schema', 'schema_pending')`);

		console.log('Отмечено: выгруженное доехало.');
		db.close();
		return;
	}

	fs.rmSync(outPath, { recursive: true, force: true });
	fs.mkdirSync(outPath, { recursive: true });

	const schemas = Object.fromEntries(TABLES.map(table => [table, schemaOf(db, table)]));

	// Отпечатка два, и это не мелочь. Новая колонка в таблице значит «выкладывай
	// всё заново»: наверху её нет, и одними INSERT туда не попасть. Новый указатель
	// не значит ничего подобного — CREATE INDEX IF NOT EXISTS уходит наверх в конце
	// каждой выгрузки, любой. А считался он до сих пор той же «правкой схемы»
	// и тянул за собой всю базу вставками ради одной строчки DDL.
	const tableHash = digest(TABLES.map(table => schemas[table].table).join('\n'));
	const indexes = TABLES.flatMap(table => schemas[table].indexes);
	const indexHash = digest(indexes.map(index => index.sql).join('\n'));
	// Ключ 'tables' новый: под старыми правилами тот же отпечаток лежал в 'schema'
	// и считался вместе с указателями, то есть с нынешним не сравним никак.
	// Пустое значение здесь читается как «неизвестно» и полной выкладки не требует —
	// таблицы от разделения отпечатка не изменились, а изменись они по-настоящему,
	// это была бы уже другая правка, со своим новым отпечатком таблиц.
	const knownTables = db.prepare(`SELECT value FROM d1_meta WHERE key = 'tables'`).get()?.value ?? null;
	const knownIndexes = db.prepare(`SELECT value FROM d1_meta WHERE key = 'indexes'`).get()?.value ?? null;
	const synced = db.prepare('SELECT COUNT(*) AS c FROM d1_sync').get().c;

	const reasons = [];

	if (full) {
		reasons.push('попросили ключом --full');
	}

	if (synced === 0) {
		reasons.push('наверху ещё ничего нашего нет');
	}

	if (knownTables !== null && knownTables !== tableHash) {
		reasons.push('поменялась схема таблиц');
	}

	const whole = reasons.length > 0;
	console.log(whole ? `Выгружаю всё целиком: ${reasons.join(', ')}.` : 'Выгружаю только изменившееся.');

	const writer = new ChunkWriter(outPath);
	writer.write('-- Собрано scripts/export-d1.js. Править руками нечего: файл переписывается целиком.\n');

	// Прежнее состояние: что, по нашим сведениям, уже лежит наверху
	const before = new Map(TABLES.map(table => [table, new Map()]));

	if (!whole) {
		for (const row of db.prepare('SELECT tbl, row_id, hash FROM d1_sync').iterate()) {
			before.get(row.tbl)?.set(row.row_id, row.hash);
		}
	}

	db.exec('DELETE FROM d1_pending');
	const remember = db.prepare('INSERT OR REPLACE INTO d1_pending (tbl, row_id, hash) VALUES (?, ?, ?)');

	if (whole) {
		// Заменяем целиком — старое сносим в обратном порядке, чтобы не спорить
		// с внешними ключами
		for (const table of [...TABLES].reverse()) {
			writer.write(`DROP TABLE IF EXISTS ${table};\n`);
		}
	}

	/** Что напечатать в конце: по строчке на таблицу. */
	const report = [];

	// ————— чего наверху быть уже не должно —————

	if (!whole) {
		const alive = {
			packages: new Set(db.prepare('SELECT id FROM packages').all().map(row => row.id)),
			stats: new Set(db.prepare('SELECT package_id FROM stats').all().map(row => row.package_id)),
			pack_formats: new Set(db.prepare('SELECT package_id FROM pack_formats').all().map(row => row.package_id)),
			pack_authors: new Set(db.prepare('SELECT DISTINCT package_id FROM pack_authors').all().map(row => row.package_id)),
		};

		for (const table of [...TABLES].reverse()) {
			const key = table === 'packages' ? 'id' : 'package_id';
			const stale = [...before.get(table).keys()].filter(id => !alive[table].has(id));

			if (stale.length > 0) {
				batched(writer, `DELETE FROM ${table} WHERE ${key} IN (`, ')', stale.map(String));
				report.push(`  ${table}: удаляется наверху ${stale.length}`);
			}
		}
	}

	// ————— packages, stats и pack_formats —————

	// Какие колонки в отпечаток не входят — и почему их две, — сказано там же,
	// где считается сам отпечаток (см. SKIP в scripts/deploy/rowhash.js).
	for (const [table, key] of [['packages', 'id'], ['stats', 'package_id'], ['pack_formats', 'package_id']]) {
		const skip = SKIP[table] ?? [];

		if (whole) {
			writer.write(`${schemas[table].table};\n`);
		} else {
			writer.write(`${ifMissing(schemas[table].table)};\n`);
		}

		const known = before.get(table);
		const changed = [];
		// Пары «номер строки — ключ документа» тех паков, что уходят в этой пачке.
		// Нужны только packages и только при неполной выгрузке (см. guard ниже)
		const guard = table === 'packages' && !whole ? [] : null;
		let head = null;
		let tail = null;
		let seen = 0;
		let sent = 0;

		/** Отдать накопленную пачку: сперва расчистить ей место, потом вставить. */
		const flush = () => {
			if (changed.length === 0) {
				return;
			}

			if (guard) {
				writeGuard(writer, guard.splice(0));
			}

			batched(writer, head, tail, changed.splice(0));
		};

		for (const item of rowsWithHash(db, table, key, skip)) {
			seen++;
			remember.run(table, item.id, item.hash);

			if (known.get(item.id) === item.hash) {
				continue;
			}

			if (!head) {
				({ head, tail } = upsertHead(table, item.columns, key));
			}

			sent++;
			changed.push(`(${item.columns.map(column => literal(item.row[column])).join(',')})`);
			guard?.push({ id: item.id, sourceKey: item.row.source_key });

			// Не копим весь список в памяти: на полной выгрузке это была бы вся база
			if (changed.length >= 500) {
				flush();
			}
		}

		flush();

		report.push(`  ${table}: в базе ${seen}, наверх уходит ${sent}`);
	}

	// ————— авторы —————
	//
	// У этой таблицы нет своего постоянного номера строки: ключ составной,
	// а порядковый номер SQLite раздаёт заново после каждого разбора пака
	// (список авторов переписывается целиком — см. saveAuthors). Поэтому
	// сравниваем не строки, а пака целиком: изменился его список авторов —
	// наверху он стирается и пишется заново.

	writer.write(`${whole ? schemas.pack_authors.table : ifMissing(schemas.pack_authors.table)};\n`);

	const authorsOf = new Map();

	// Канон едет наверх наравне с подписью: по нему сайт и считает автора одним
	// человеком (см. mergeAuthors в src/indexer/authors.js). Без него топ авторов наверху
	// сходится в одну строку с пустым именем — все canon_key там NULL
	//
	// Вместе с ним едет и номер страницы ВК: по нему сайт узнаёт автора в лицо,
	// когда тот входит через ВК (см. cf/src/library/authorship.js).
	//
	// Колонки здесь перечислены поимённо, а не звёздочкой, — и новая колонка
	// таблицы сама сюда не попадает. Добавлять её надо в трёх местах разом:
	// в этот запрос, в отпечаток ниже и в сам INSERT. Пропустишь отпечаток —
	// наверх не уедет ничего (строки не будут считаться изменившимися);
	// пропустишь INSERT — уедут NULL. И то и другое расходится с домашней базой
	// молча, потому что дома всё останется целым
	const authorsQuery = 'SELECT package_id, author_key, author, canon_key, canon_name, canon_account'
		+ ' FROM pack_authors ORDER BY package_id, author_key';

	for (const row of db.prepare(authorsQuery).iterate()) {
		if (!authorsOf.has(row.package_id)) {
			authorsOf.set(row.package_id, []);
		}

		authorsOf.get(row.package_id).push(row);
	}

	const known = before.get('pack_authors');
	const redo = [];

	for (const [packageId, list] of authorsOf) {
		const hash = digest(list.map(row => `${row.author_key}${row.author}${row.canon_key}${row.canon_name}${row.canon_account}`).join(' '));
		remember.run('pack_authors', packageId, hash);

		if (known.get(packageId) !== hash) {
			redo.push({ packageId, list });
		}
	}

	if (redo.length > 0) {
		if (!whole) {
			batched(writer, 'DELETE FROM pack_authors WHERE package_id IN (', ')', redo.map(item => String(item.packageId)));
		}

		batched(
			writer,
			'INSERT OR REPLACE INTO pack_authors (package_id, author_key, author, canon_key, canon_name, canon_account) VALUES\n',
			'',
			redo.flatMap(item => item.list.map(row => `(${literal(row.package_id)},${literal(row.author_key)},${literal(row.author)},${literal(row.canon_key)},${literal(row.canon_name)},${literal(row.canon_account)})`)),
		);
	}

	report.push(`  pack_authors: в базе ${authorsOf.size} паков с авторами, наверх уходит ${redo.length}`);

	// ————— указатели —————
	//
	// Ставятся последними: на пустой таблице они бесплатны, а на полной каждая
	// вставка перестраивала бы их по ходу дела. Наверху они дороже, чем дома, —
	// там прочитанные строки идут по тарифу (см. db.js).

	// Указатель, у которого поменялось само описание, «если ещё нет» не заменит:
	// наверху уже лежит указатель с этим именем, и CREATE молча ничего не сделает.
	// Поэтому при любой правке набора он сносится и ставится заново — и сносятся
	// заодно те, которых у нас больше нет. Строк это не читает и не пишет:
	// указатель считается из таблицы, а таблица наверху и так уже лежит.
	// Пока набор тот же — не трогаем ничего.
	if (knownIndexes !== null && knownIndexes !== indexHash && !whole) {
		const known = nameList(db.prepare(`SELECT value FROM d1_meta WHERE key = 'index_names'`).get()?.value);
		const gone = known.filter(name => !indexes.some(index => index.name === name));

		for (const name of [...gone, ...indexes.map(index => index.name)]) {
			writer.write(`DROP INDEX IF EXISTS ${name};\n`);
		}

		report.push(`  указатели: перекладываются заново (${indexes.length}), сносится лишних ${gone.length}`);
	}

	for (const index of indexes) {
		writer.write(`${ifMissing(index.sql)};\n`);
	}

	writer.flush();

	// Заявка, а не отметка: настоящей она станет в --commit, когда выгруженное
	// действительно доедет. До тех пор наверху, по нашим сведениям, прежняя схема.
	const claim = db.prepare(`INSERT OR REPLACE INTO d1_meta (key, value) VALUES (?, ?)`);

	claim.run('tables_pending', tableHash);
	claim.run('indexes_pending', indexHash);
	claim.run('index_names_pending', JSON.stringify(indexes.map(index => index.name)));
	const pending = db.prepare('SELECT COUNT(*) AS c FROM d1_pending').get().c;
	db.close();

	for (const line of report) {
		console.log(line);
	}

	console.log(`Выгружено ${(writer.total / 1024 / 1024).toFixed(1)} МБ в ${writer.files.length} файл(ов); наверху будет ${pending} строк.`);
}

main();
