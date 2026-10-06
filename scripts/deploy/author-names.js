// Ники, выбранные авторами на сайте: забрать домой до сборки и вернуть
// наверх после заливки паков.
//
// ————— зачем два хода —————
//
// Выбирает автор наверху, и выбор его лежит в D1 (см. src/author-names.js).
// А имя автора на карточке, в адресе его страницы и в карте сайта собирает
// сборка статики — дома, по домашней базе (см. writeAuthorPacks
// в scripts/build-web.js). Не привези выкладка выбор домой, сборка звала бы
// человека прежним именем до скончания века.
//
// Обратный ход — по той же причине, что и у снятых с публикации паков
// (см. cf/hidden.sql): заливка переписывает строки подписей домашними, и
// выбор, сделанный, пока шла выкладка, дома ещё неизвестен. Его надо вернуть.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { root } from './options.js';
import { askRows, pour } from './d1.js';
import { APPLY_CHOSEN_NAMES_SQL, AUTHOR_NAMES_TABLE_SQL } from '../../src/author-names.js';

/**
 * Привезти выборы из базы наверху в домашнюю и сразу записать их в имена
 * авторов: сборка, которая идёт следом, читает уже их.
 *
 * Не вышло прочитать — ничего страшного: дома остаётся прошлая копия,
 * и автор поживёт с прежним именем до следующей выкладки. Срывать из-за этого
 * всю выкладку было бы несоразмерно. Самая первая выкладка сюда и попадает:
 * таблицы наверху ещё нет, её заведёт схема, которая идёт позже.
 */
export async function pullAuthorNames() {
	let rows;

	try {
		rows = await askRows('SELECT vk_id, name, user_id, updated_at FROM author_names');
	} catch (error) {
		console.log(`Ники авторов наверху прочитать не вышло (${error.message}). Беру прежние.`);
		return;
	}

	const db = new DatabaseSync(path.join(root, 'data', 'sibase.db'));

	try {
		db.exec(AUTHOR_NAMES_TABLE_SQL);
		db.exec('BEGIN');

		try {
			// Копия целиком, а не дописывание: выбор, который автор сменил,
			// должен смениться и здесь, а не лечь рядом вторым
			db.exec('DELETE FROM author_names');

			const insert = db.prepare('INSERT INTO author_names (vk_id, name, user_id, updated_at) VALUES (?, ?, ?, ?)');

			for (const row of rows) {
				insert.run(String(row.vk_id), String(row.name), row.user_id ?? null, row.updated_at ?? 0);
			}

			const changed = db.prepare(APPLY_CHOSEN_NAMES_SQL).run().changes;

			db.exec('COMMIT');
			console.log(`Ники, выбранные авторами: ${rows.length}; строк подписей с новым именем ${changed}.`);
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		}
	} finally {
		db.close();
	}
}

/**
 * Вернуть выборы в имена авторов наверху — сразу за заливкой паков.
 *
 * Текст запроса общий с домом и с сайтом (см. APPLY_CHOSEN_NAMES_SQL), поэтому
 * файл не лежит в cf/, как hidden.sql, а пишется перед заливкой: два
 * одинаковых запроса в двух местах разошлись бы при первой же правке.
 */
export async function pushAuthorNames() {
	const file = path.join(root, '.wrangler', 'author-names.sql');

	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${APPLY_CHOSEN_NAMES_SQL.trim()};\n`, 'utf8');

	try {
		await pour(file);
	} finally {
		fs.rmSync(file, { force: true });
	}
}
