// Рабочее состояние базы: как оно ездит между этим компьютером и GitHub.
//
//   node scripts/state.js status   что лежит на полке и что здесь
//   node scripts/state.js sync     подогнать здешнее под полку (это делает запуск сайта)
//   node scripts/state.js pull     забрать полку к себе
//   node scripts/state.js push     отдать своё на полку
//   node scripts/state.js merge <файл>  влить разметку из другой копии базы
//
// Зачем это вообще. Ночной обход переехал в GitHub Actions, а там нет ничего
// постоянного: каждая ночь начинается с пустой машины, которая через двадцать
// минут исчезает вместе со всем, что на ней было. Базу негде хранить между
// запусками — значит, её надо привозить с собой и увозить обратно.
//
// Где она лежит между ночами: в приложении к отметке релиза в самом репозитории.
// Не в самом репозитории: база на пятнадцати тысячах паков весит под двести
// мегабайт, и складывать её в историю правок означало бы держать там каждую
// её ночную версию навсегда. Приложение же просто перезаписывается, и место
// занимает только последнее. Ключей для этого не нужно никаких: у Actions есть
// свой пропуск в собственный репозиторий.
//
// Что именно ездит:
//   data/sibase.db  — сама база;
//   data/thumbs     — готовые уменьшенные обложки.
//
// Оригиналы обложек (data/logos) не ездят: их семьдесят мегабайт на четыре сотни
// паков, то есть больше двух гигабайт на пятнадцать тысяч, — а нужны они ровно
// один раз, чтобы сделать уменьшенную копию. Копии и ездят; см. scripts/build-web.js.
//
// ── Кто здесь главный ──
//
// Полка. Не эта машина. Паки собирает ночной обход в облаке, и то, что лежит
// на полке, — это ровно то, из чего собран сайт. Поэтому здешняя база не «своя
// отдельная», а копия полки, и запуск сайта начинается со сверки (см. sync):
// разошлось — забираем полку. Прежняя здешняя база при этом не пропадает,
// а отодвигается в data/sibase.prev.db, — но идти в дело она больше не идёт.
//
// Обратный ход один и он же единственный: выкладка на сайт (scripts/deploy-cf.js)
// после удачной заливки сама кладёт базу на полку. То есть наверх уезжает не
// «что-то, над чем тут работали», а ровно то, что уже стоит на сайте.
//
// ── Чего «полка главная» не означает ──
//
// Что работу этой машины можно выбросить. Разметку делает не только полка:
// здесь запускают обновление базы, и это самая дорогая работа в проекте —
// не по времени, а по суточной квоте Gemini. Поэтому подмена базы её больше
// не выбрасывает, а переносит, и отправка на полку — не затирает, а сливает.
// Правило в обе стороны одно: у кого разметка свежее, того и ответ, кто бы
// её ни сделал (см. MARKUP, carryMarkup и mergeShelf ниже). Так же сливается
// и память об отправленном поисковикам: переобход в Яндексе шлют и ночь,
// и эта машина (см. SENT и carrySent).
//
// Всё остальное по-прежнему решает полка целиком: строки паков, статистика,
// авторы, отметка о выгрузке. Спорить тут не о чем — их собирает обход
// обсуждений, а он один и тот же с обеих сторон.
//
// ————— Из чего он собран —————
//
// Сам этот файл — только команды: status, sync, pull, push, merge. Всё,
// на чём они держатся, лежит рядом, в scripts/state/:
//
//   config.js  где что лежит, как называется и что считать своим
//   shelf.js   разговор с GitHub, метка полки, упаковка и распаковка
//   carry.js   перенос своего из старой базы в новую

import fs from 'node:fs';
import path from 'node:path';

import {
	ASSET, command, dbPath, force, prevPath, root, TAG, WORK,
} from './state/config.js';
import {
	assetId, contentOf, haveGh, localStamp, megabytes, pack, readMark,
	remoteAsset, requireGh, run, unpack, when, writeMark,
} from './state/shelf.js';
import { carryMarkup, carryPersonal, carrySent, mergeShelf, sayCarried } from './state/carry.js';

function showStatus() {
	const here = localStamp();
	const there = remoteAsset();
	const mark = readMark();

	console.log(here
		? `Здесь:  ${megabytes(here.size)}, ${when(here.at)}`
		: 'Здесь:  базы нет');

	console.log(there
		? `На полке: ${megabytes(there.size)}, ${when(there.updatedAt)}`
		: `На полке: ничего (отметки «${TAG}» с приложением нет)`);

	if (there && here) {
		console.log(mark && mark.id === assetId(there)
			? 'Сходится: здешняя база — это полка, то есть то же, что на сайте.'
			: 'Разошлось: здешняя база не с этой полки. Подогнать — npm run sync');
	}

	return { here, there, mark };
}

function pull() {
	requireGh();
	const there = remoteAsset();

	if (!there) {
		console.error('На полке ничего нет. Первый свёрток кладётся отсюда: node scripts/state.js push');
		process.exit(1);
	}

	console.log(`Забираю ${megabytes(there.size)} от ${when(there.updatedAt)}…`);

	fs.mkdirSync(path.join(root, 'data'), { recursive: true });
	fs.rmSync(path.join(root, WORK), { force: true });

	if (run('gh', ['release', 'download', TAG, '--pattern', ASSET, '--output', WORK, '--clobber']).code !== 0) {
		console.error('Не вышло скачать.');
		process.exit(1);
	}

	unpack();
	carryPersonal();

	// Разметку, сделанную здесь, приехавшая база не отменяет: у кого свежее,
	// того и ответ (см. MARKUP). Без этой строки всякая сверка выбрасывала бы
	// всё, что здесь размечено с прошлого раза, — молча и целиком.
	sayCarried(carryMarkup(prevPath, dbPath), 'из здешней базы');

	// Так же и с тем, что здесь отправили поисковикам: переобход шлёт Яндексу
	// и ночь, и эта машина, и приехавшая база здешнего не знает (см. SENT)
	carrySent(prevPath, dbPath);

	writeMark(there);

	fs.rmSync(path.join(root, WORK), { force: true });

	// Считаем паки в обеих: в отодвинутой прежней и в приехавшей. Прежнюю читаем
	// после подмены нарочно — к этому времени её журнал слит в неё саму, и открыть
	// её на чтение можно чем угодно; до подмены рядом с ней лежал живой WAL.
	const before = contentOf(prevPath);
	const after = contentOf(dbPath);

	if (before && after) {
		console.log(`Было: ${before.ready} разобранных паков из ${before.packs}. `
			+ `Стало: ${after.ready} из ${after.packs}.`);

		// Здешнее оказалось богаче приехавшего — значит, тут работали и наверх это
		// не уехало. Молчать нельзя: файл с прежней базой рядом, но сам о себе
		// он не расскажет, а через день его затрёт следующая сверка.
		if (before.ready > after.ready) {
			console.log('');
			console.log('Внимание: здесь было разобрано больше, чем приехало с полки.');
			console.log(`Прежняя база отодвинута в ${path.relative(root, prevPath)} — она никуда не делась.`);
			console.log('Если наверх надо было увезти именно её, верните файл на место и выложите: npm run deploy');
		}
	}

	console.log('Готово. База и обложки — те же, что на сайте.');
}

function push() {
	const here = localStamp();

	if (!here) {
		console.error('Базы нет: класть на полку нечего.');
		process.exit(1);
	}

	requireGh();
	const there = remoteAsset();
	const mark = readMark();

	// Полка сменилась с тех пор, как здешняя база с неё приехала: пока здесь
	// работали, ежечасный или ночной обход сложил туда своё. Отправить наше как
	// есть — значит стереть это чужое; отказаться — значит потерять своё, потому
	// что здешнее рано или поздно перетрёт ближайшая сверка. Оба исхода были
	// в живую (см. MARKUP), поэтому здесь теперь не отказ, а слияние.
	const moved = Boolean(there) && (mark
		? mark.id !== assetId(there)
		// Отметки нет вовсе (первый раз, чужая машина, руками положенная база) —
		// судим по старинке, по времени файла.
		: here.at < new Date(there.updatedAt));

	if (moved && force) {
		console.log(`Полка ушла вперёд (свёрток от ${when(there.updatedAt)}), но велено затереть её как есть.`);
	} else if (moved) {
		console.log(`Полка ушла вперёд (свёрток от ${when(there.updatedAt)}). Сливаю с ней здешнее…`);
		mergeShelf();
	}

	console.log('Складываю свёрток…');
	pack(WORK);

	const file = path.join(root, WORK);
	console.log(`Свёрток: ${megabytes(fs.statSync(file).size)}. Отправляю…`);

	// Отметки может ещё не быть — заводим. Черновик нарочно: это не выпуск
	// программы, а служебная полка, и в списке релизов ей делать нечего.
	if (!there && run('gh', ['release', 'view', TAG], { quiet: true }).code !== 0) {
		run('gh', ['release', 'create', TAG,
			'--title', 'Рабочее состояние базы',
			'--notes', 'Свёрток с базой и обложками для ночного обхода. Собирается scripts/state.js, руками сюда ничего класть не надо.',
			'--latest=false',
		]);
	}

	if (run('gh', ['release', 'upload', TAG, WORK, '--clobber']).code !== 0) {
		console.error('Не вышло отправить.');
		process.exit(1);
	}

	fs.rmSync(file, { force: true });

	// Что уехало — то теперь и лежит на полке, и здешняя база помечается им же:
	// иначе следующая сверка сочла бы полку чужой и забрала бы обратно то самое,
	// что мы только что отсюда отправили.
	const uploaded = remoteAsset();

	if (uploaded) {
		writeMark(uploaded);
	}

	console.log('Готово.');
}

/**
 * Сверка перед запуском сайта: здешняя база должна быть тем же, что на сайте.
 *
 * Правило одно и простое: сменилась полка — забираем полку. Всё остальное здесь
 * ради того, чтобы сверка никогда не мешала запуску. Нет gh, нет сети, пуста
 * полка — говорим об этом одной строкой и запускаемся на том, что есть: сайт
 * со вчерашней базой лучше, чем не открывшийся сайт.
 */
function sync() {
	if (!haveGh()) {
		console.log('Сверить базу с сайтом нечем: не установлен gh (winget install GitHub.cli).');
		console.log('Запускаюсь на здешней базе.');
		return;
	}

	const there = remoteAsset();

	if (!there) {
		console.log('Полка пуста или до GitHub не достучаться — запускаюсь на здешней базе.');
		return;
	}

	const mark = readMark();

	if (mark && mark.id === assetId(there) && fs.existsSync(dbPath)) {
		console.log(`База та же, что на сайте (полка от ${when(there.updatedAt)}).`);
		return;
	}

	console.log(fs.existsSync(dbPath)
		? 'База разошлась с сайтом — забираю с полки.'
		: 'Базы здесь нет — забираю с полки.');

	pull();
}

/**
 * Влить разметку из другой копии базы в здешнюю: `node scripts/state.js merge <файл>`.
 *
 * Рука, которой чинят уже случившееся. Обычно перенос идёт сам — при сверке
 * и при отправке на полку, — но копия с потерянной работой может лежать где
 * угодно: в data/sibase.prev.db (туда её отодвигает сверка), в старом свёртке,
 * на другой машине. Отсюда отдельная команда: скажи, откуда взять, — возьмёт.
 *
 * Правило то же самое, что и везде: переносится только то, что в названной
 * копии свежее здешнего. Испортить здешнюю разметку этим нельзя.
 */
function merge(file) {
	if (!file) {
		console.error('Скажите, из какой копии вливать: node scripts/state.js merge data/sibase.prev.db');
		process.exit(1);
	}

	const from = path.resolve(root, file);

	if (!fs.existsSync(from)) {
		console.error(`Нет такого файла: ${from}`);
		process.exit(1);
	}

	if (!fs.existsSync(dbPath)) {
		console.error('Здешней базы нет — вливать не во что.');
		process.exit(1);
	}

	const before = contentOf(dbPath);
	const done = carryMarkup(from, dbPath);

	if (done.length === 0) {
		console.log(`В ${path.relative(root, from)} нет разметки свежее здешней. Ничего не менял.`);
		return;
	}

	sayCarried(done, `из ${path.relative(root, from)}`);

	const after = contentOf(dbPath);

	if (before && after) {
		console.log(`Разобранных паков: было ${before.ready}, стало ${after.ready} (перенос их не трогает).`);
	}

	console.log('');
	console.log('Дальше это надо увезти наверх, иначе оно так и останется только здесь:');
	console.log('  npm run deploy');
}

if (command === 'status') {
	requireGh();
	showStatus();
} else if (command === 'sync') {
	sync();
} else if (command === 'pull') {
	pull();
} else if (command === 'push') {
	push();
} else if (command === 'merge') {
	merge(process.argv[3]);
} else {
	console.error(`Не знаю команды «${command}». Есть status, sync, pull, push и merge.`);
	process.exit(1);
}
