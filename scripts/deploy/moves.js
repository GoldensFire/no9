// Триггеры журнала pack_moves: кто из паков ушёл из выдачи или вернулся в неё.
//
// Сам журнал описан в cf/schema.sql, читает его Worker (см. withPackMoves
// в cf/src/library/author-counts.js). Здесь только то, что его наполняет.
//
// ————— почему не в cf/schema.sql —————
//
// Две причины. Схема прогоняется до заливки паков, а полная заливка таблицу
// packages сносит и заводит заново — и триггеры уходят вместе с ней. Поэтому
// заводятся они после паков и после cf/hidden.sql: при полной заливке паки
// въезжают свежими, и возврат запрета снятым — это не уход из выдачи, а то,
// что сборка и так уже видела.
//
// И вторая: файлы выкладка режет на запросы по «;» (см. statementsOf
// в scripts/deploy/d1.js), а в теле триггера «;» стоит внутри. Здесь каждый
// запрос уходит целым.
//
// Заводятся они каждый раз заново, DROP и CREATE: так поправленный текст
// триггера доезжает наверх первой же выкладкой.

import { askRows } from './d1.js';

/** Сейчас в миллисекундах — так же, как все прочие времена в базе. */
const NOW = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";

/** Сколько живёт строка журнала: девяносто дней. Выкладка из дома бывает чаще. */
const KEEP = 90 * 24 * 60 * 60 * 1000;

/** Подписи пака одной строкой: «подпись␟канон␟имя» через ␞. */
const writersOf = id => `(
	SELECT group_concat(author_key || char(31) || COALESCE(canon_key, author_key) || char(31) || COALESCE(canon_name, author), char(30))
	FROM pack_authors WHERE package_id = ${id}
)`;

const STATEMENTS = [
	'DROP TRIGGER IF EXISTS tr_pack_moves_update',
	'DROP TRIGGER IF EXISTS tr_pack_moves_delete',

	// Смена статуса. Переходы мимо 'ok' («умер» → «похоронен») счёту
	// безразличны и в журнал не идут
	`CREATE TRIGGER tr_pack_moves_update AFTER UPDATE OF status ON packages
	WHEN OLD.status IS NOT NEW.status AND (OLD.status = 'ok' OR NEW.status = 'ok')
	BEGIN
		INSERT INTO pack_moves (id, at, was, now, writers, authors)
		VALUES (NEW.id, ${NOW}, OLD.status, NEW.status, ${writersOf('NEW.id')}, NEW.authors);
		DELETE FROM pack_moves WHERE at < ${NOW} - ${KEEP};
	END`,

	// Пак, удалённый живым: его строку заливка снесла, а счёт его помнит
	`CREATE TRIGGER tr_pack_moves_delete AFTER DELETE ON packages
	WHEN OLD.status = 'ok'
	BEGIN
		INSERT INTO pack_moves (id, at, was, now, writers, authors)
		VALUES (OLD.id, ${NOW}, 'ok', 'deleted', ${writersOf('OLD.id')}, OLD.authors);
	END`,
];

/** Завести триггеры наверху. Не вышло — выкладку не валим: счёт подождёт сборки. */
export async function createMoveTriggers() {
	try {
		for (const sql of STATEMENTS) {
			await askRows(sql);
		}

		console.log('Журнал ухода паков из выдачи ведётся.');
	} catch (error) {
		console.log(`Триггеры журнала завести не вышло (${error.message}). Число паков у авторов подождёт выкладки.`);
	}
}
