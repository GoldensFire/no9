// Отпечаток строки таблицы: одно правило на выгрузку и на сверку.
//
// Выгрузка считает отпечаток каждой строки и по нему решает, отправлять её
// наверх или нет (см. scripts/export-d1.js). Сверка спрашивает обратное:
// «эту строку выгрузка отправит сама или пройдёт мимо?» — и ответить на это
// можно только тем же самым отпечатком (см. scripts/deploy/drift.js).
//
// Порознь эти два счёта жить не могут. Разойдись они хоть на пробел — и сверка
// начнёт считать отправленным то, что не отправится, или наоборот; заметить
// такое нечем, потому что обе стороны при этом работают и не жалуются.
// Поэтому правило лежит здесь одно, а не переписано в двух местах похоже.

import crypto from 'node:crypto';

/**
 * Значение в виде литерала SQL. Строки экранируются удвоением апострофа —
 * так же, как это делает сам SQLite в .dump.
 */
export function literal(value) {
	if (value === null || value === undefined) {
		return 'NULL';
	}

	if (typeof value === 'number') {
		return Number.isFinite(value) ? String(value) : 'NULL';
	}

	if (typeof value === 'bigint') {
		return String(value);
	}

	if (value instanceof Uint8Array) {
		return `x'${Buffer.from(value).toString('hex')}'`;
	}

	return `'${String(value).replace(/'/g, "''")}'`;
}

/** Отпечаток строки. Шестнадцати знаков хватает: совпадение случайным не бывает. */
export const digest = text => crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);

/**
 * Колонки, не входящие в отпечаток, — по таблице на список.
 *
 * plagiarism_at выброшен нарочно, и это не мелочь. Проверка на плагиат — полный
 * пересмотр базы каждую ночь (см. checkPlagiarism в src/indexer/plagiarism.js),
 * и отметку «проверен» получают все одиннадцать тысяч паков, даже когда приговор
 * ни у кого не изменился. Входи она в отпечаток, каждая ночь увозила бы наверх
 * всю библиотеку целиком — одиннадцать тысяч записанных строк из суточных ста
 * тысяч бесплатного тарифа, ради одного числа, которого сайт не показывает.
 * Наверх колонка при этом уезжает, просто не считается изменением — ровно как
 * updated_at у статистики.
 */
export const SKIP = {
	packages: ['plagiarism_at'],
	stats: ['updated_at'],
	// Пересмотренный пак с теми же форматами наверх не едет: изменилось одно время
	pack_formats: ['checked_at'],
};

/**
 * Отпечаток одной строки, как её отдал SQLite.
 *
 * @param {object} row строка целиком (SELECT *)
 * @param {string[]} skip колонки, не входящие в отпечаток (см. SKIP)
 */
export function rowHash(row, skip = []) {
	return digest(Object.keys(row).filter(column => !skip.includes(column))
		.map(column => literal(row[column])).join(' '));
}
