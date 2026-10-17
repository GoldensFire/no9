// Паки, снятые с публикации: забрать их список домой до сборки.
//
// Снимает пак хозяин сайта, кнопкой наверху, и список живёт только в D1
// (см. setPackHidden в cf/src/library/moderation.js и cf/hidden.sql). Дома про
// него не знает никто — и сборка, которая считает статику по домашней базе,
// считала снятые паки живыми.
//
// Заметнее всего это было в рейтинге авторов. Список /authors считается наверху,
// живым запросом, и снятых не видит; место под заголовком страницы автора
// считает сборка (см. authorRanking в scripts/build-web.js) — и видела. Два пака
// одного автора, снятые наверху, ставили его дома первым, а на сайте вторым,
// и страница автора спорила со списком авторов. Врали и все прочие готовые
// числа — total и колонка фильтров в prebuilt.json, а за ними и API хранилища.
// Теперь сборка открывает базу через openLibrary в scripts/build-web.js,
// и снятые там сняты для всех готовых ответов разом.
//
// Файлом в .wrangler/, а не строками в домашней базе: база уезжает на полку
// и в ночной обход, а этот список нужен одной сборке и только на этот раз.

import fs from 'node:fs';
import path from 'node:path';
import { root } from './options.js';
import { askRows } from './d1.js';

/** Где лежит список. Тот же путь читает scripts/build-web.js. */
export const HIDDEN_PACKS_FILE = path.join(root, '.wrangler', 'hidden-packs.json');

/**
 * Привезти ключи снятых паков. Не вышло — остаётся прошлая копия: рейтинг
 * поживёт со вчерашним списком до следующей выкладки, срывать из-за этого
 * всю выкладку несоразмерно.
 */
export async function pullHiddenPacks() {
	let rows;

	try {
		rows = await askRows('SELECT pack_key FROM hidden_packs');
	} catch (error) {
		console.log(`Снятые паки наверху прочитать не вышло (${error.message}). Беру прежний список.`);
		return;
	}

	const keys = rows.map(row => String(row.pack_key));

	fs.mkdirSync(path.dirname(HIDDEN_PACKS_FILE), { recursive: true });
	fs.writeFileSync(HIDDEN_PACKS_FILE, JSON.stringify(keys), 'utf8');
	console.log(`Снятых с публикации паков: ${keys.length}.`);
}
