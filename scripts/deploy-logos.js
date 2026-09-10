// Обложки — наверх, без остального сайта.
//
// ————— зачем отдельная команда —————
//
// Обложки ездили наверх статикой главного Worker'а, а её собирает
// scripts/build-web.js, которому нужен сам сайт: web/, cf/src/, src/meta/.
// В публичном репозитории их нет намеренно, поэтому ночной и ежечасный обход
// в Actions статику не собирают и `wrangler deploy` не запускают вовсе
// (см. dbOnly в scripts/deploy/options.js). Выходило так: строку пака обход
// клал в D1 каждый час, а картинку не мог положить никогда — она ждала
// выкладки из дома. Пак 21554 нашёлся 30 августа 2026 в 14:54 совсем готовым,
// вместе с уменьшенной копией в data/thumbs, и всё равно висел на сайте
// квадратом с буквой, пока сайт не выложили руками.
//
// Здесь нужны ровно две вещи: папка data/thumbs, которая приезжает с полки
// вместе с базой (см. scripts/state/shelf.js), и wrangler. Ни страниц,
// ни стилей, ни кода Worker'а — потому эта команда и работает в Actions.
//
// ————— почему это не стоит ни запроса —————
//
// Выкладывается Worker, который за самими обложками не просыпается: файл,
// который в "assets" нашёлся, Cloudflare отдаёт сам, не доходя до "main",
// и в счёт обращений такое не идёт вовсе. Код у него есть, но всего на один
// случай — «такой обложки нет» (см. cf/logos/src/index.js). Отдавать обложки кодом — из R2, из KV, откуда
// угодно — значило бы платить за каждую: два десятка на странице выдачи,
// тридцать тысяч просмотров в день — шестьсот тысяч обращений при суточном
// пределе в сто тысяч. Кэш тут не помощник: ответ из кэша Worker'а считается
// наравне с тем, ради которого Worker просыпался.
//
// Адрес обложки при этом не меняется: Worker стоит не на своём имени, а на
// маршруте firepacks.net/logos/thumb/* — тот точнее, чем хост целиком, и потому
// срабатывает раньше главного сайта (см. "routes" в cf/logos/wrangler.jsonc).
// Значит, ни logoUrl в src/logo.js, ни ссылка из cf/src/library/packs.js,
// ни og:image страницы пака трогать не пришлось.

import fs from 'node:fs';
import path from 'node:path';

import { local, root, thumbsPath } from './deploy/options.js';
import { run, sleep } from './deploy/wrangler.js';
import { siteOrigin } from './deploy/site.js';
import { logoUrl } from '../src/logo.js';

/**
 * Собрать папку и показать, что уехало бы, — не трогая ни Cloudflare, ни сайт.
 * Ключ для проверки руками: тестов в проекте нет, а посмотреть, что именно
 * складывается наверх, надо уметь без выкладки.
 */
const dryRun = process.argv.includes('--dry-run');

/**
 * Положить обложки не своему Worker'у, а в статику главного — в cf/public.
 *
 * Нужно это дважды. Первое — местная проверка: `wrangler dev` поднимает один
 * Worker и маршрутов между двумя не разыгрывает, так что по /logos/thumb/
 * не нашлось бы ничего, и проверка врала бы про сайт квадратами с буквами
 * на каждой карточке. Второе — запасной ход выкладки: не вышло отправить
 * обложки своим Worker'ом, а главный сейчас поедет наверх без них — пусть
 * увезёт их с собой, как возил раньше (см. logos в scripts/deploy-cf.js).
 *
 * Одного этого мало, и в этом вся затея: cf/public собирает
 * scripts/build-web.js, которого в Actions нет.
 */
const intoSite = local || process.argv.includes('--into-site');

/** Конфиг маленького Worker'а и папка, которую он отдаёт. */
const CONFIG = path.join('cf', 'logos', 'wrangler.jsonc');
const publicPath = path.join(root, 'cf', 'logos', 'public');

/**
 * Куда внутри папки ложатся файлы. Не «как удобнее», а как просят: статику
 * Cloudflare ищет по пути запроса от корня папки, и обложка, которую просят
 * по /logos/thumb/21554.avif, обязана лежать в logos/thumb/21554.avif.
 * Отсюда и лишние две ступени вложенности — благодаря им адрес остался прежним.
 */
const inside = folder => path.join(folder, 'logos', 'thumb');

/** Статика главного Worker'а — куда обложки ложатся при --into-site. */
const sitePath = path.join(root, 'cf', 'public');

/**
 * Сколько обложке жить в браузере. Сутки — и это правка по живому случаю:
 * здесь стоял вечный кэш с immutable, и правило это Cloudflare прикладывает
 * не к файлу, а к адресу, включая ответ «такой обложки нет». А «нет» тут дело
 * обычное: строка пака уезжает в D1 одной выкладкой, картинка — следующей,
 * и всякий, кто открыл пак между ними, запоминал пустоту на год вперёд
 * и переспрашивать больше не приходил (паки 15915–15917 и 16554).
 *
 * Лишним расходом сутки не оборачиваются: ETag у файлов есть, и назавтра
 * браузеру приходит «не менялось» в несколько десятков байт. А тем, кто уже
 * успел запомнить год, помогает отпечаток в самой ссылке — LOGO_VERSION
 * в src/logo.js.
 *
 * Правило это жило в HEADERS в scripts/build-web.js, пока обложки уезжали
 * статикой главного Worker'а. Теперь их отдаёт этот, и правило переехало
 * вместе с ними: в чужой папке оно бы уже ничего не значило.
 */
const HEADERS = `# Собрано scripts/deploy-logos.js

/logos/thumb/*
  Cache-Control: public, max-age=86400
`;

/** Сколько раз спросить сайт про обложку и сколько ждать между попытками, с. */
const TRIES = [2, 3, 5, 10, 15];

/**
 * Собрать папку заново. Именно заново, а не «дописать недостающее»: обложки
 * паков, которых в базе больше нет, сборка выметает со склада
 * (см. `swept` в scripts/build-web.js), и папка, которую только дополняют,
 * держала бы их наверху вечно.
 *
 * Копируем, а не переносим: data/thumbs — единственный склад, из него же берут
 * домашний сайт и полка.
 *
 * @returns {number} сколько обложек сложено
 */
function collect(folder) {
	// Сносим только свою папку: cf/public собирает и вычищает
	// scripts/build-web.js, и снести её отсюда значило бы стереть весь сайт.
	if (folder === publicPath) {
		fs.rmSync(folder, { recursive: true, force: true });
	}

	fs.mkdirSync(inside(folder), { recursive: true });

	// Правило кэша — тоже только своей: в cf/public лежит свой _headers,
	// собранный scripts/build-web.js, и затирать его отсюда было бы разбоем.
	// Обложкам там оно и не нужно — их отдаёт не эта папка, а Worker выше.
	if (folder === publicPath) {
		fs.writeFileSync(path.join(folder, '_headers'), HEADERS, 'utf8');
	}

	// Только .avif, и не из брезгливости: имя копии оканчивается на .avif
	// (см. thumbName в src/logo.js), а всё прочее в этой папке — обрезки
	// от оборвавшегося уменьшения (.tmp-…, см. resizeInto в src/thumbs.js).
	const names = fs.readdirSync(thumbsPath).filter(name => name.endsWith('.avif'));

	for (const name of names) {
		fs.copyFileSync(path.join(thumbsPath, name), path.join(inside(folder), name));
	}

	// Крупных копий для чужих окон здесь нет и быть не должно: их собирает
	// сборка сайта и увозит статика главного Worker'а (см. previewPath
	// в scripts/build-web.js). Ночной обход сайт не собирает — а эта команда
	// работает и в нём, и папку она переписывает целиком: возьмись она возить
	// ещё и крупные копии, ночь сносила бы наверху те, которых у неё нет.
	return names.length;
}

/**
 * Обложка самого позднего пака на складе. Ею и проверяем: если чего наверху
 * и нет, так это обложки пака, разобранного этим самым обходом полминуты
 * назад, — то есть ровно того случая, ради которого всё это заведено.
 *
 * По номеру пака, а не по времени файла, и это правка по живому случаю.
 * Имя копии — это номер пака (см. thumbName в src/logo.js), номера раздаются
 * по возрастанию, и самый большой — это и есть последний найденный пак.
 * Времени же файла верить нельзя: склад приезжает с полки свёртком, tar
 * проставляет времена по-своему, и проверка раз за разом спрашивала про один
 * и тот же давно лежащий там файл. Спрашивать про заведомо доехавшее —
 * значит не спрашивать вовсе.
 */
function newest(names) {
	let best = null;
	let top = -1;

	for (const name of names) {
		const id = Number.parseInt(name, 10);

		if (Number.isFinite(id) && id > top) {
			top = id;
			best = name;
		}
	}

	return best ?? names[0] ?? null;
}

/**
 * Спросить сайт, отдаётся ли обложка. Не «команда прошла», а «картинка видна»:
 * между выложенным Worker'ом и работающим маршрутом есть разница, и заметить
 * её должны мы, а не посетитель.
 *
 * Отвечает на вопрос «маршрут вообще стоит?» — а он один на все три тысячи
 * обложек, поэтому и хватает одной.
 */
async function visible(name) {
	const origin = await siteOrigin();

	if (!origin) {
		console.log('Адрес сайта не спросился — проверить обложку нечем.');
		return true;
	}

	const address = `${origin}${logoUrl(name)}`;

	for (let attempt = 0; ; attempt += 1) {
		let complaint;

		try {
			const response = await fetch(address, { method: 'HEAD', headers: { 'Cache-Control': 'no-cache' } });

			if (response.ok) {
				console.log(`Обложки на месте: ${address}`);
				return true;
			}

			complaint = `${response.status}`;
		} catch (error) {
			complaint = error.message;
		}

		if (attempt === TRIES.length) {
			console.error('');
			console.error(`Обложка не отдаётся (${complaint}): ${address}`);
			console.error('');
			console.error('Worker выложен, значит дело в маршруте: /logos/thumb/* на firepacks.net');
			console.error('должен вести на firepacks-logos. Посмотреть, что там стоит:');
			console.error('  npx wrangler deployments list -c cf/logos/wrangler.jsonc');
			console.error('Если маршрута нет, а сам Worker есть — у ключа Cloudflare не хватает');
			console.error('права Zone → Workers Routes → Edit (шаблон «Edit Cloudflare Workers»');
			console.error('его даёт; урезанный вручную ключ — нет).');
			return false;
		}

		const wait = TRIES[attempt];
		console.log(`Обложка ещё не отдаётся (${complaint}) — ждём ${wait} с и пробуем снова.`);
		sleep(wait);
	}
}

async function main() {
	if (!fs.existsSync(thumbsPath)) {
		console.log('Склада обложек нет (data/thumbs) — выкладывать нечего.');
		return;
	}

	const folder = intoSite ? sitePath : publicPath;
	const count = collect(folder);

	if (count === 0) {
		console.log('На складе нет ни одной обложки — выкладывать нечего.');
		return;
	}

	const weight = fs.readdirSync(inside(folder))
		.reduce((sum, name) => sum + fs.statSync(path.join(inside(folder), name)).size, 0);

	console.log(`Обложек: ${count} (${(weight / 1024 / 1024).toFixed(1)} МБ).`);

	if (intoSite) {
		console.log('Обложки положены в статику главного Worker\'а (cf/public) — своим Worker\'ом не отправляем.');
		return;
	}

	// Наверх уедут не все три тысячи, а только те, которых там ещё нет: файлы
	// на стороне Cloudflare узнаются по содержимому, и обычная ночь отправляет
	// одну-две картинки. Отсюда и весь расчёт: обложка нового пака оказывается
	// на сайте за те же секунды, что и его строка в D1.
	run('npx', ['wrangler', 'deploy', '-c', CONFIG, ...(dryRun ? ['--dry-run'] : [])]);

	if (dryRun) {
		console.log('\nПроверка: папка собрана, наверх ничего не отправлено.');
		return;
	}

	const check = newest(fs.readdirSync(thumbsPath).filter(name => name.endsWith('.avif')));

	if (!await visible(check)) {
		process.exit(1);
	}
}

await main();
