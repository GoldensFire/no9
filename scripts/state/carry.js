// Перенос своего из старой базы в новую: оценки и входы посетителей, разметка
// паков, сами паки, память об отправленном поисковикам.
//
// Отдельно от полки потому, что вопрос тут другой. Полка отвечает «где лежит
// и как туда попасть», а здесь — «что из здешнего нельзя потерять, когда база
// приезжает с полки чужой и свежей». Ответ у каждой таблицы свой, и списки
// его лежат в scripts/state/config.js.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
	ASSET, dbPath, force, MARKUP, MARKUP_TABLES, PERSONAL, prevPath, root, SENT, STAGE, TAG, WORK,
} from './config.js';
import { run, sqlPath } from './shelf.js';

const columnsOf = (db, schema, table) =>
	db.prepare('SELECT name FROM pragma_table_info(?, ?)').all(table, schema).map(row => row.name);

/**
 * Один и тот же ли это пак в двух базах.
 *
 * По source_key, а не по номеру строки, и это важно. Номер раздаёт AUTOINCREMENT
 * той базы, в которой пак завели, — то есть той машины, которая нашла его первой.
 * Обе машины ведут счёт от общей полки, но находят новое порознь, и стоит им
 * найти разное, как один и тот же номер окажется у разных паков. Разметку тогда
 * перенесло бы не туда, и заметить это было бы нечем.
 *
 * source_key — это документ ВК («doc-133214983_438981105»), то есть сам файл.
 * По нему пак узнаёт и индексатор (см. knownDocument в src/indexer/store.js), и он же
 * во всей базе неповторим.
 */
const SAME_PACK = 'src.packages.source_key = main.packages.source_key';

/**
 * Вернуть на место то, что принадлежит этой машине: входы, отметки, оценки
 * (см. PERSONAL). Приехавшая база везёт их слепком с прошлого раза, и без этого
 * шага каждая сверка выкидывала бы из-под пользователя его же вход.
 *
 * Строки, ссылающиеся на паки, которых в новой базе нет, отсеиваются: пак могли
 * убрать из обсуждения, и отметка «сыграно» на пустом месте не нужна никому.
 */
export function carryPersonal() {
	if (!fs.existsSync(prevPath)) {
		return;
	}

	const db = new DatabaseSync(dbPath);

	try {
		db.exec(`ATTACH '${sqlPath(prevPath)}' AS prev`);

		for (const table of PERSONAL) {
			const here = columnsOf(db, 'main', table);
			const there = columnsOf(db, 'prev', table);
			const shared = here.filter(column => there.includes(column));

			if (shared.length === 0) {
				continue;
			}

			const list = shared.map(column => `"${column}"`).join(', ');
			const filter = shared.includes('package_id')
				? ' WHERE package_id IN (SELECT id FROM main.packages)'
				: '';

			db.exec('BEGIN');
			db.exec(`DELETE FROM main."${table}"`);
			db.exec(`INSERT OR IGNORE INTO main."${table}" (${list}) SELECT ${list} FROM prev."${table}"${filter}`);
			db.exec('COMMIT');
		}

		db.exec('DETACH prev');
	} catch (error) {
		console.error(`Не вышло перенести здешние отметки и входы: ${error.message}`);
		console.error('База при этом целая — просто вход придётся повторить.');
	} finally {
		db.close();
	}
}

/**
 * Перенести в базу-приёмник ту разметку из базы-источника, которая там свежее
 * (см. MARKUP). Работает в обе стороны и обе стороны зовут её одинаково:
 * при подмене базы источник — отодвинутая здешняя, приёмник — приехавшая
 * с полки; при отправке наоборот.
 *
 * Сравниваются отметки времени, а не «пусто или нет»: пак, размеченный здесь
 * вчера, не должен затирать разметку, сделанную полкой сегодня. NULL у источника
 * не переносится никогда — это не «свежий пустой ответ», а «не спрашивали».
 *
 * Паки, которых в приёмнике нет, пропускаются молча: разметка без пака никому
 * не нужна, а перенос пака целиком — не дело этой руки.
 *
 * @returns {{name: string, moved: number}[]} что и сколько перенесено
 */
export function carryMarkup(from, into) {
	if (!fs.existsSync(from) || !fs.existsSync(into)) {
		return [];
	}

	const db = new DatabaseSync(into);
	const done = [];

	try {
		db.exec(`ATTACH '${sqlPath(from)}' AS src`);

		const here = columnsOf(db, 'main', 'packages');
		const there = columnsOf(db, 'src', 'packages');

		for (const part of MARKUP) {
			// Колонки, которые есть в обеих: базы бывают разного возраста, и та,
			// что постарше, попросту не знает про недавно заведённое.
			const shared = part.columns.filter(column => here.includes(column) && there.includes(column));

			if (!shared.includes(part.at)) {
				continue;
			}

			// Свежее — это строго новее. Равные отметки времени означают одну
			// и ту же работу, приехавшую двумя путями, и трогать её незачем.
			const fresher = `src.packages.${part.at} IS NOT NULL
				AND (main.packages.${part.at} IS NULL OR src.packages.${part.at} > main.packages.${part.at})`;

			const assign = shared.map(column => `"${column}" = (SELECT "${column}" FROM src.packages WHERE ${SAME_PACK})`);

			db.exec('BEGIN');

			db.exec(`
				UPDATE main.packages SET ${assign.join(', ')}
				WHERE EXISTS (SELECT 1 FROM src.packages WHERE ${SAME_PACK} AND ${fresher})
			`);

			const moved = db.prepare('SELECT changes() AS c').get().c;
			db.exec('COMMIT');

			if (moved > 0) {
				done.push({ name: part.name, moved });
			}
		}

		// Отдельные таблицы замеров (длительность пака, форматы медиа): связываются
		// с приёмником по source_key через packages, побеждает более свежая отметка.
		const shapeOf = (schema, table) => db
			.prepare(`SELECT sql FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`)
			.get(table)?.sql;

		for (const part of MARKUP_TABLES) {
			const shape = shapeOf('src', part.table);

			// В базе-источнике таблицы ещё нет (база старше её появления)
			if (!shape) {
				continue;
			}

			// В базе-приёмнике таблицы ещё нет (например, полка старее здешней базы) —
			// заводим по схеме источника, чтобы не потерять здешние замеры
			if (!shapeOf('main', part.table)) {
				db.exec(shape);
			}

			const hereTable = columnsOf(db, 'main', part.table);
			const thereTable = columnsOf(db, 'src', part.table);
			const shared = part.columns.filter(column => hereTable.includes(column) && thereTable.includes(column));

			if (!shared.includes(part.at) || !hereTable.includes('package_id') || !thereTable.includes('package_id')) {
				continue;
			}

			const refCol = part.refColumn && shared.includes(part.refColumn) ? part.refColumn : null;
			const list = ['package_id', ...shared].map(column => `"${column}"`).join(', ');
			const select = [
				'm.id',
				...shared.map(column => (column === refCol ? 'COALESCE(tm.id, m.id)' : `st."${column}"`)),
			].join(', ');
			const refJoin = refCol
				? `\n\t\t\t\tLEFT JOIN src.packages tp ON tp.id = st."${refCol}"\n\t\t\t\tLEFT JOIN main.packages tm ON tm.source_key = tp.source_key`
				: '';
			const set = shared.map(column => `"${column}" = excluded."${column}"`).join(', ');

			db.exec('BEGIN');

			const { changes } = db.prepare(`
				INSERT INTO main."${part.table}" (${list})
				SELECT ${select}
				FROM src."${part.table}" st
				JOIN src.packages sp ON sp.id = st.package_id
				JOIN main.packages m ON m.source_key = sp.source_key${refJoin}
				WHERE st."${part.at}" IS NOT NULL
				ON CONFLICT (package_id) DO UPDATE SET ${set}
				WHERE "${part.table}"."${part.at}" IS NULL OR excluded."${part.at}" > "${part.table}"."${part.at}"
			`).run();

			db.exec('COMMIT');

			const moved = Number(changes);

			if (moved > 0) {
				done.push({ name: part.name, moved });
			}
		}

		// Расход квоты — тоже общее знание, и терять его нельзя ни в какую сторону.
		// Считает Google по своим суткам и по всему ключу разом, а тратят ключ обе
		// машины; больший расход за день и есть правда о нём. Знай ночь про это,
		// она не потратила бы двадцать минут на запросы, которым заранее отказано.
		db.exec(`
			INSERT INTO main.gemini_usage (day, model, requests, quota_hits)
			SELECT day, model, requests, quota_hits FROM src.gemini_usage
			WHERE true
			ON CONFLICT (day, model) DO UPDATE SET
				requests = MAX(requests, excluded.requests),
				quota_hits = MAX(quota_hits, excluded.quota_hits)
		`);

		// Пределы моделей — то же самое, только свежесть тут по seen_at: это
		// не расход, а то, что Gemini сказал про модель, когда его в последний раз
		// об этом спросили. Колонки перечисляются не списком, а сверкой: unavailable
		// и note заведены позже самой таблицы, и в базе постарше их может не быть.
		const limitColumns = columnsOf(db, 'main', 'gemini_limits')
			.filter(column => columnsOf(db, 'src', 'gemini_limits').includes(column));

		if (limitColumns.includes('model') && limitColumns.includes('seen_at')) {
			const list = limitColumns.map(column => `"${column}"`).join(', ');
			const set = limitColumns.filter(column => column !== 'model')
				.map(column => `"${column}" = excluded."${column}"`).join(', ');

			db.exec(`
				INSERT INTO main.gemini_limits (${list}) SELECT ${list} FROM src.gemini_limits
				WHERE true
				ON CONFLICT (model) DO UPDATE SET ${set}
				WHERE excluded.seen_at > gemini_limits.seen_at
			`);
		}

		db.exec('DETACH src');
	} catch (error) {
		console.error(`Не вышло перенести разметку: ${error.message}`);
		console.error('База при этом целая, но часть разметки могла остаться только в старой копии.');
	} finally {
		db.close();
	}

	return done;
}

/** Одной строкой: что перенеслось. Молчит, когда переносить было нечего. */
export function sayCarried(done, where) {
	if (done.length > 0) {
		console.log(`Перенесено ${where}: ${done.map(part => `${part.name} — ${part.moved} паков`).join(', ')}.`);
	}
}

/**
 * Перенести с полки паки, которых здесь нет вовсе, — вместе с их статистикой
 * и авторами.
 *
 * Раньше этого не делалось, и на месте переноса стояло рассуждение: перенос
 * строки пака тянет за собой авторов, статистику и отметку о выгрузке, делать
 * это вслепую опаснее, чем не делать, а пропавший пак всё равно найдётся —
 * обсуждение читается заново каждый час.
 *
 * Найдётся он и вправду. Беда в том, чем он найдётся: новой строкой с новым
 * номером. Номера раздаёт AUTOINCREMENT (см. SAME_PACK), и «тот же файл под
 * другим номером» — это не мелочь учёта, а две поломки разом.
 *
 * Первая: наверху этот пак уже лежит под прежним номером, и заливка, вставляя
 * его под новым, натыкается на запрет повторов по source_key. Весь файл
 * отвергается целиком, а с ним и вся ночная работа (см. writeGuard
 * в scripts/export-d1.js — там же и разбор ночи на 20 августа 2026).
 *
 * Вторая: пак теряет всё, что было сделано по нему до пропажи. Он приходит
 * заново со статусом «new» — без разбора, без разметки, без описания, — и его
 * заново разбирают, заново размечают и заново описывают, тратя на это ту самую
 * суточную квоту Gemini, которой всегда не хватает. А если разобрать не успеют
 * (у ежечасного обхода на первый проход пять минут), пак так и повиснет
 * невидимой строкой. Ровно это случилось с «Своей охотой» из сообщения 902:
 * 20 августа она была разобрана ночью, потеряна при слиянии, найдена заново
 * в 15:31, не разобрана по сроку — и провисела в базе двое суток.
 *
 * Поэтому теперь переносится и сама строка. Номер сохраняется, если он здесь
 * свободен, — а он свободен почти всегда: обе машины считают от общей полки,
 * и расходятся их номера только на том, что каждая нашла сама. Занят — пак
 * заводится под новым, и это по-прежнему лучше, чем потерять его совсем.
 */
function carryPacks(from, into) {
	const nothing = { packs: 0, relocated: 0, renumbered: 0, collisions: [] };

	if (!fs.existsSync(from) || !fs.existsSync(into)) {
		return nothing;
	}

	const db = new DatabaseSync(into);
	let packs = 0;
	let relocated = 0;
	let renumbered = 0;
	const collisions = [];

	try {
		// Временно выключаем проверку внешних ключей на время переноса id
		// локального неопубликованного пака в рамках одной транзакции.
		db.exec('PRAGMA foreign_keys = OFF');
		db.exec(`ATTACH '${sqlPath(from)}' AS src`);

		// Общие колонки: базы бывают разного возраста, и та, что постарше,
		// попросту не знает про недавно заведённое (то же правило, что
		// в carryMarkup)
		const shared = table => {
			const there = columnsOf(db, 'src', table);
			return columnsOf(db, 'main', table).filter(column => there.includes(column));
		};

		const packColumns = shared('packages');

		if (!packColumns.includes('source_key') || !packColumns.includes('id')) {
			return nothing;
		}

		const quoted = columns => columns.map(column => `"${column}"`).join(', ');
		const holes = columns => columns.map(() => '?').join(', ');

		const strangers = db.prepare(`
			SELECT ${quoted(packColumns)} FROM src.packages s
			WHERE NOT EXISTS (SELECT 1 FROM main.packages m WHERE m.source_key = s.source_key)
			ORDER BY s.id ASC
		`).all();

		if (strangers.length === 0) {
			return nothing;
		}

		const hasTable = (schema, name) => Boolean(
			db.prepare(`SELECT 1 AS yes FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`).get(name),
		);

		// Все локальные таблицы, ссылающиеся на packages.id через package_id
		// (stats, pack_authors, pack_formats, pack_duration, pack_prints, played, planned, question_origins).
		const childTables = db.prepare(`
			SELECT name FROM main.sqlite_master
			WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
		`).all()
			.map(row => row.name)
			.filter(name => columnsOf(db, 'main', name).includes('package_id'));

		const hasCopyOf = columnsOf(db, 'main', 'packages').includes('copy_of');
		const checkSynced = hasTable('main', 'd1_sync')
			? db.prepare(`SELECT 1 AS yes FROM main.d1_sync WHERE tbl = 'packages' AND row_id = ?`)
			: null;
		const checkPinged = hasTable('main', 'indexnow_sent')
			? db.prepare(`SELECT 1 AS yes FROM main.indexnow_sent WHERE url LIKE ? OR url LIKE ? LIMIT 1`)
			: null;

		const isPublishedLocally = id => Boolean(
			checkSynced?.get(id)
			|| checkPinged?.get(`%/pack/${id}-%`, `%/pack/${id}`),
		);

		const maxMain = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM main.packages').get().m;
		const maxSrc = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM src.packages').get().m;
		let nextFreeId = Math.max(maxMain, maxSrc) + 1;

		const keepNumber = db.prepare(`INSERT INTO main.packages (${quoted(packColumns)}) VALUES (${holes(packColumns)})`);
		const numberTaken = db.prepare('SELECT id, source_key, name FROM main.packages WHERE id = ?');
		const movePackId = db.prepare('UPDATE main.packages SET id = ? WHERE id = ?');
		const moveCopyOf = hasCopyOf ? db.prepare('UPDATE main.packages SET copy_of = ? WHERE copy_of = ?') : null;
		const hasSteamTarget = hasTable('main', 'pack_steam')
			&& columnsOf(db, 'main', 'pack_steam').includes('target_package_id');
		const moveSteamTarget = hasSteamTarget
			? db.prepare('UPDATE main.pack_steam SET target_package_id = ? WHERE target_package_id = ?')
			: null;
		const moveChildren = childTables.map(name => db.prepare(`UPDATE main."${name}" SET package_id = ? WHERE package_id = ?`));

		const relocateLocal = (oldId, newId) => {
			movePackId.run(newId, oldId);
			moveCopyOf?.run(newId, oldId);
			moveSteamTarget?.run(newId, oldId);
			for (const stmt of moveChildren) {
				stmt.run(newId, oldId);
			}
		};

		// Статистика, авторы, длительность, форматы и связка Steam — по номеру пака
		const carryChild = table => {
			const columns = shared(table);

			if (!columns.includes('package_id')) {
				return null;
			}

			return {
				table,
				columns,
				take: db.prepare(`SELECT ${quoted(columns)} FROM src."${table}" WHERE package_id = ?`),
				put: db.prepare(`INSERT OR REPLACE INTO main."${table}" (${quoted(columns)}) VALUES (${holes(columns)})`),
			};
		};

		const packChildren = ['stats', 'pack_authors', 'pack_duration', 'pack_formats', 'pack_steam']
			.map(carryChild)
			.filter(Boolean);

		const findTargetInMain = db.prepare(`
			SELECT m.id FROM src.packages sp
			JOIN main.packages m ON m.source_key = sp.source_key
			WHERE sp.id = ?
		`);

		const move = (row, columns, fromId, toId) => columns.map(column => {
			if (column === 'package_id') {
				return toId;
			}

			if (column === 'target_package_id') {
				if (row[column] === fromId) {
					return toId;
				}

				return findTargetInMain.get(row[column])?.id ?? toId;
			}

			return row[column];
		});

		db.exec('BEGIN');

		for (const row of strangers) {
			const occupant = numberTaken.get(row.id);
			let id = row.id;

			if (!occupant) {
				keepNumber.run(...packColumns.map(column => row[column]));
			} else if (!isPublishedLocally(row.id)) {
				// Полка главная: её пак уже на сайте (D1 / IndexNow), а локальный
				// двойник ещё не выкладывался. Сдвигаем локальный на свободный номер,
				// чтобы опубликованный URL /pack/<id>-<slug> никогда не менялся.
				const freshId = nextFreeId++;
				relocateLocal(row.id, freshId);
				keepNumber.run(...packColumns.map(column => row[column]));
				relocated++;
			} else {
				// Обе машины успели независимо выложить разные паки под одним id:
				// не переписываем локальный опубликованный id молча, но предупреждаем
				// громко, чтобы конфликт не прошёл незамеченным.
				id = nextFreeId++;
				keepNumber.run(...packColumns.map(column => (column === 'id' ? id : row[column])));
				renumbered++;
				collisions.push({ shelfId: row.id, assignedId: id, localName: occupant.name, shelfName: row.name });
			}

			for (const child of packChildren) {
				for (const item of child.take.all(row.id)) {
					child.put.run(...move(item, child.columns, row.id, id));
				}
			}

			packs++;
		}

		if (hasTable('main', 'sqlite_sequence')) {
			db.prepare(`UPDATE main.sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'packages'`)
				.run(nextFreeId - 1);
		}

		db.exec('COMMIT');
		db.exec('DETACH src');
	} catch (error) {
		try {
			db.exec('ROLLBACK');
		} catch {
			// откатывать было нечего — значит, до начала записи дело и не дошло
		}

		console.error(`Не вышло перенести паки с полки: ${error.message}`);
		console.error('База при этом целая; пропавшие паки подберёт ближайший обход обсуждений.');

		return nothing;
	} finally {
		db.close();
	}

	return { packs, relocated, renumbered, collisions };
}

/**
 * Слить память об отправленном поисковикам (см. SENT) из базы-источника
 * в базу-приёмник: по каждому адресу остаётся та запись, где отправка позже.
 *
 * Зовётся там же, где carryMarkup, и в ту же сторону: при подмене базы источник —
 * отодвинутая здешняя, при отправке на полку — полочная.
 *
 * @returns {number} сколько адресов перенесено
 */
export function carrySent(from, into) {
	if (!fs.existsSync(from) || !fs.existsSync(into)) {
		return 0;
	}

	const db = new DatabaseSync(into);
	let moved = 0;

	try {
		db.exec(`ATTACH '${sqlPath(from)}' AS src`);

		const shapeOf = (schema, table) => db
			.prepare(`SELECT sql FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`)
			.get(table)?.sql;

		for (const table of SENT) {
			const shape = shapeOf('src', table);

			// Там не отправляли ни разу — сливать нечего
			if (!shape) {
				continue;
			}

			// Здесь не отправляли ни разу — заводим такую же таблицу, с тем же
			// ключом по адресу: без него слияние ниже не узнало бы повторов
			if (!shapeOf('main', table)) {
				db.exec(shape);
			}

			// «WHERE true» не лишнее: без него SQLite читает ON CONFLICT
			// как продолжение SELECT и отказывается разбирать запрос
			const { changes } = db.prepare(`
				INSERT INTO main."${table}" (url, stamp, sent_at)
				SELECT url, stamp, sent_at FROM src."${table}" WHERE true
				ON CONFLICT (url) DO UPDATE SET stamp = excluded.stamp, sent_at = excluded.sent_at
				WHERE excluded.sent_at > sent_at
			`).run();

			moved += Number(changes);
		}

		db.exec('DETACH src');
	} catch (error) {
		console.error(`Не вышло слить память об отправленном поисковикам: ${error.message}`);
		console.error('База при этом целая — просто часть адресов уйдёт на переобход повторно.');
	} finally {
		db.close();
	}

	if (moved > 0) {
		console.log(`Память об отправленном поисковикам: перенесено адресов — ${moved}.`);
	}

	return moved;
}

/**
 * Забрать с полки одну только базу — во временное место, не трогая здешнюю, —
 * и влить из неё в здешнюю то, чего здесь нет: разметку посвежее (carryMarkup),
 * паки, которых здесь нет вовсе (carryPacks), и память об отправленном
 * поисковикам (carrySent). Нужно перед отправкой, когда полка успела уйти
 * вперёд: то, что мы сейчас положим, не должно стереть чужую работу.
 */
export function mergeShelf() {
	const stage = path.join(root, STAGE);
	fs.rmSync(stage, { recursive: true, force: true });
	fs.rmSync(path.join(root, WORK), { force: true });

	try {
		if (run('gh', ['release', 'download', TAG, '--pattern', ASSET, '--output', WORK, '--clobber']).code !== 0) {
			console.error('Не вышло скачать полку для слияния. Отправка отменена: лучше ничего, чем поверх чужого.');
			process.exit(1);
		}

		fs.mkdirSync(stage, { recursive: true });

		// Только база: обложки полки здешним не мешают и сливать их незачем —
		// они и так складываются, а не подменяются (разворачивается свёрток
		// поверх, ничего не удаляя).
		if (run('tar', ['-xzf', WORK, '-C', STAGE, 'data/sibase.db']).code !== 0) {
			console.error('Не вышло развернуть полку для слияния. Отправка отменена.');
			process.exit(1);
		}

		const shelfDb = path.join(stage, 'data', 'sibase.db');
		sayCarried(carryMarkup(shelfDb, dbPath), 'с полки');

		const carried = carryPacks(shelfDb, dbPath);

		if (carried.packs > 0) {
			const notes = [];
			if (carried.relocated > 0) {
				notes.push(`сдвинуто локальных неопубликованных паков: ${carried.relocated} — чтобы не ломать URL полки`);
			}
			if (carried.renumbered > 0) {
				notes.push(`перенумеровано с полки: ${carried.renumbered} — оба id уже публиковались!`);
			}
			console.log(`Забрано с полки паков, которых здесь не было: ${carried.packs}`
				+ `${notes.length > 0 ? ` (${notes.join('; ')})` : ''}.`);
			for (const item of carried.collisions) {
				console.warn(`  [!] Конфликт опубликованных ID #${item.shelfId} → #${item.assignedId}:`
					+ ` дома «${item.localName ?? '?'}», на полке «${item.shelfName ?? '?'}»`);
			}
		}

		carrySent(shelfDb, dbPath);
	} finally {
		fs.rmSync(stage, { recursive: true, force: true });
		fs.rmSync(path.join(root, WORK), { force: true });
	}
}
