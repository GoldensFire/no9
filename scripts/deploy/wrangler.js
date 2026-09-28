// Запуск wrangler: чем он доказывает, что он — это мы, как читаются его отказы
// и что делать, когда D1 занят импортом.
//
// Отдельно от самой заливки потому, что это про запуск чужой программы:
// переменные окружения, коды выхода, разбор ругани и советы человеку, что
// с этой руганью делать. Заливке отсюда нужны две вещи — execute() и ключи
// Cloudflare, — и больше про wrangler она знать не обязана.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DB_NAME, local, root } from './options.js';

/**
 * Секреты сюда не пишутся: сначала переменная окружения, потом файл в папке data.
 * Тот же порядок и те же файлы, что у остальных ключей проекта (см. src/config.js);
 * повторено здесь, а не взято оттуда, нарочно — этот скрипт запускается и в GitHub
 * Actions, где никакого config.js с его настройками не нужно вовсе.
 */
function readSecret(envName, fileName) {
	if (process.env[envName]) {
		return process.env[envName].trim();
	}

	try {
		return fs.readFileSync(path.join(root, 'data', fileName), 'utf8').trim();
	} catch {
		return '';
	}
}

/**
 * Чем wrangler будет доказывать, что он — это мы.
 *
 * Ключ нужен всем, кто выкладывает не руками, и здесь он давно не выручалка,
 * а то, на чём всё держится.
 *
 * Вход через браузер (`npx wrangler login`) для кнопки не годится. Пропуск
 * от него живёт час; продлить его wrangler может сам, но только когда его
 * запускают, и запущенный отсюда, из дочернего процесса без терминала, продлить
 * его смог не всегда. Со стороны это выглядит так: выложил сразу после входа —
 * прошло; вернулся через час — «In a non-interactive environment, it's necessary
 * to set a CLOUDFLARE_API_TOKEN». За 14 августа так сорвалось пять запусков
 * подряд, и все пять — уже после того, как час истёк. Сервер тут ни при чём:
 * один из сорвавшихся шёл из-под сервера, прожившего минуту.
 *
 * Постоянный ключ убирает всю эту механику разом: увидев его, wrangler не
 * читает ни файла с пропуском, ни чего бы то ни было ещё, и продлевать нечего.
 * Ночной обход в Actions живёт этим же ключом, только приезжает он туда
 * переменной из секретов репозитория.
 *
 * Кладётся в data/cloudflare-token.txt (папка под .gitignore, как и остальные
 * ключи). Переменная окружения старше файла — в Actions файла нет вовсе.
 *
 * Заводится на dash.cloudflare.com → My Profile → API Tokens → Create Token,
 * шаблон «Edit Cloudflare Workers», и в правах добавить D1 → Edit.
 */
export const CLOUDFLARE_ENV = {
	CLOUDFLARE_API_TOKEN: readSecret('CLOUDFLARE_API_TOKEN', 'cloudflare-token.txt'),
	// Номер учётной записи нужен только тогда, когда их у ключа несколько:
	// с одной wrangler определяет её сам. Пустое значение не передаём — иначе
	// wrangler примет пустую строку за ответ и станет искать учётную запись «».
	CLOUDFLARE_ACCOUNT_ID: readSecret('CLOUDFLARE_ACCOUNT_ID', 'cloudflare-account.txt'),
};

/**
 * Что говорить, когда wrangler не смог доказать, что он — это мы.
 *
 * Своё сообщение у него самое непонятное из всех («non-interactive environment»),
 * и по нему не догадаться, что делать. Здесь говорим прямо и в том порядке,
 * в каком это помогает.
 *
 * Порядок именно такой, а не обратный, потому что вход через браузер эту работу
 * не держит: пропуск от него живёт час, обновляется он только тогда, когда
 * wrangler запускают, и запущенный отсюда обновить его смог не всегда. Днём
 * 14 августа выкладка сорвалась пять раз подряд, и каждый раз — после того,
 * как час истёк; между ними, в пределах часа после входа, та же самая выкладка
 * прошла. Перезапуск сервера, который здесь советовался раньше, ни при чём:
 * сорвавшийся запуск шёл из-под сервера, прожившего минуту.
 *
 * Постоянный ключ снимает вопрос целиком: увидев его, wrangler не читает ни
 * файла с пропуском, ни чего бы то ни было ещё, и обновлять там нечего.
 */
function authAdvice() {
	console.error('');
	console.error('Если написано про non-interactive environment или CLOUDFLARE_API_TOKEN —');
	console.error('дело во входе в Cloudflare, а не в самой выкладке.');
	console.error('');
	console.error('Как чинить насовсем — положить постоянный ключ в data/cloudflare-token.txt:');
	console.error('  dash.cloudflare.com → My Profile → API Tokens → Create Token,');
	console.error('  шаблон «Edit Cloudflare Workers», в правах добавить D1 → Edit.');
	console.error('Ключ не протухает, и эта ошибка больше не повторится.');
	console.error('');
	console.error('Разово, до следующего раза:  npx wrangler login');
	console.error('Пропуск от входа живёт час — выкладка после него пройдёт, следующая');
	console.error('может и не пройти.');
}

/**
 * Код выхода, годный для показа. Windows отдаёт упавшему процессу не код,
 * а номер исключения — 3221226505 и подобные восьмизначные числа. Сам wrangler
 * этим и заканчивает: сказав про вход, он валится внутри себя («Assertion
 * failed: !(handle->flags & UV_HANDLE_CLOSING)»), и наверх уезжает не «1»,
 * а бессмыслица, по которой на странице обновления не понять ничего.
 */
function exitCode(status) {
	return status === null || status === undefined || status >= 0xc0000000 ? 1 : status;
}

/** Конец всему: сказать, на чём споткнулись, и уйти с годным кодом. */
function fail(command, args, status) {
	console.error(`\nСорвалось на: ${command} ${args.join(' ')}`);

	if (args[0] === 'wrangler' && !CLOUDFLARE_ENV.CLOUDFLARE_API_TOKEN) {
		authAdvice();
	}

	process.exit(exitCode(status));
}

/**
 * Запуск программы. Сорвалась — уносит с собой всю выкладку.
 *
 * Ключ `soft` это отменяет: вместо выхода вернётся то, чем программа ругалась,
 * и решать, что с этим делать, будет вызвавший (см. execute — там ждут чужую
 * заливку и пробуют снова).
 *
 * Ругань при `soft` печатается не самой программой, а нами: перехватить её
 * иначе нельзя. Появляется она поэтому разом, по концу работы. На вид выкладки
 * это не влияет — ошибок там несколько строк, а ход самой заливки идёт первым
 * потоком и по-прежнему уходит в лог сразу, строка за строкой.
 */
export function run(command, args, { soft = false } = {}) {
	console.log(`\n$ ${command} ${args.join(' ')}`);

	const passed = Object.fromEntries(Object.entries(CLOUDFLARE_ENV).filter(([, value]) => value));

	const result = spawnSync(command, args, {
		cwd: root,
		stdio: soft ? ['inherit', 'inherit', 'pipe'] : 'inherit',
		shell: process.platform === 'win32',
		env: { ...process.env, ...passed },
	});

	const complaint = result.stderr ?? Buffer.alloc(0);

	if (soft) {
		process.stderr.write(complaint);
	}

	if (result.status === 0) {
		return null;
	}

	if (!soft) {
		fail(command, args, result.status);
	}

	return { status: result.status, complaint: complaint.toString('utf8') };
}

/**
 * Проверка пропуска до того, как начнётся долгая работа.
 *
 * Раньше выкладка узнавала о протухшем пропуске последней: сначала пересобирались
 * три тысячи обложек, потом выгружалась база — и только потом первый же поход
 * к Cloudflare отвечал «non-interactive environment». Несколько минут работы
 * впустую, а сказанное в самом конце ещё и тонуло в выводе.
 *
 * Спрашиваем список баз D1 — один запрос, самый дешёвый из тех, что вообще
 * требуют пропуска. Заодно он подновляет пропуск: сходив к Cloudflare, wrangler
 * меняет часовой пропуск на новый, и следующим шагам достаётся свежий час,
 * а не его остаток.
 *
 * Не `whoami`, хотя он и напрашивается: без пропуска тот честно печатает
 * «You are not authenticated», но заканчивается нулём — то есть удачей. Такая
 * проверка пропускала бы дальше ровно тот случай, ради которого поставлена.
 *
 * С постоянным ключом проверять нечего: он не протухает, и лишний поход к
 * Cloudflare ничего бы не сказал.
 */
export function checkAuth() {
	if (local || CLOUDFLARE_ENV.CLOUDFLARE_API_TOKEN) {
		return;
	}

	console.log('\n───── Пропуск Cloudflare ─────');

	const result = spawnSync('npx', ['wrangler', 'd1', 'list', '--json'], {
		cwd: root,
		stdio: ['ignore', 'pipe', 'pipe'],
		shell: process.platform === 'win32',
		env: { ...process.env },
	});

	if (result.status === 0) {
		console.log('Пропуск на месте и подновлён. Час на выкладку есть.');
		return;
	}

	console.error('Пропуска нет: Cloudflare нас не узнаёт, и отправлять наверх нечем.');
	console.error('Ничего не тронуто — ни дома, ни на сайте.');
	authAdvice();

	process.exit(1);
}

/**
 * Чем ругается D1, когда по базе уже льют — не мы.
 *
 * Заливка файла у D1 не мгновенна: файл кладётся на его сторону, а дальше база
 * какое-то время переваривает его сама, и вторую такую работу она в это время
 * не начинает. Отвечает при этом отказом: «Currently processing a long-running
 * import. Cannot start another import until that completes or times out».
 *
 * Ждать приходится не себя, а другого: база в Cloudflare одна, а отправляют
 * в неё двое — этот компьютер и ежечасный обход в GitHub Actions (см.
 * .github/workflows/hourly.yml). Общая очередь у обходов есть, но стережёт
 * она полку с базой, а не D1, и на здешнюю выкладку не распространяется вовсе.
 * Поэтому «отправить на сайт» в начале часа рано или поздно попадает ровно
 * в ту минуту, когда наверху переваривается чужая заливка.
 *
 * Раньше это валило всю выкладку целиком — со всеми уже собранной статикой,
 * выгруженной базой и залитыми до срыва кусками, — хотя ничего не сломалось
 * и делать надо было ровно одно: подождать. 20 августа так и вышло, на первом
 * же куске из семи.
 *
 * Своих импортов у выкладки больше нет (см. шапку файла), но чужие никуда
 * не делись: пока наверху переваривается импорт, D1 отвечает этим отказом
 * на любой запрос, в том числе на обычный INSERT. Поэтому ждать и повторять
 * умеют оба пути — и заливка запросами, и заливка файлом.
 *
 * «Not currently importing anything» — оттуда же, но с другого конца. Так
 * отвечает D1, когда wrangler начал импорт и пошёл спрашивать «готово?»,
 * а спрашивать уже нечего: импорт закончился (или его потеряли) раньше первого
 * вопроса. Для wrangler это ошибка — `pollUntilComplete` бросает её наружу
 * и уносит с собой всю выкладку, — а на деле это гонка, и лечится она тем же
 * самым: подождать и повторить. Повтор ничего не портит: кусок уже лежит
 * на стороне D1 и узнаётся по отпечатку, а сами запросы переносят повтор
 * спокойно (INSERT … ON CONFLICT DO UPDATE, см. scripts/export-d1.js).
 * 20 августа выкладка встала ровно на этом, на третьем куске из девяти.
 */
export const IMPORT_BUSY = /long-running import|another import|not currently importing/i;

/**
 * Сколько ждать перед следующей попыткой, секунды. Сначала коротко — чужая
 * заливка обычно идёт кусками по паре мегабайт и переваривается быстро; дальше
 * длиннее, потому что если уж не успело, то там что-то большое. Всего около
 * четверти часа: не дождались за это время — дело не в очереди, и врать про
 * «сейчас пройдёт» не стоит.
 */
export const BUSY_WAITS = [15, 30, 60, 120, 240, 300];

/** Подождать, ничего не делая. Здесь всё идёт по порядку и сплошняком, поэтому так. */
export function sleep(seconds) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

/**
 * Заливка файла SQL. Куда — решает --local: в местную копию или в настоящую базу.
 *
 * Наткнулись на чужую заливку — ждём и пробуем снова. Повторная попытка дешева:
 * файл на стороне D1 уже лежит, wrangler узнаёт его по отпечатку и второй раз
 * не отправляет («File already uploaded. Processing»).
 */
export function execute(file) {
	const args = ['wrangler', 'd1', 'execute', DB_NAME, local ? '--local' : '--remote', `--file=${file}`, '-y'];

	// Местная копия лежит рядом с проектом, и делить её не с кем: ждать там
	// нечего и некого, а лишний перехват вывода только запутает
	if (local) {
		run('npx', args);
		return;
	}

	for (let attempt = 0; ; attempt += 1) {
		const failure = run('npx', args, { soft: true });

		if (!failure) {
			return;
		}

		if (!IMPORT_BUSY.test(failure.complaint)) {
			fail('npx', args, failure.status);
		}

		if (attempt >= BUSY_WAITS.length) {
			console.error('');
			console.error('Наверху всё это время переваривается чужая заливка, и наша очередь так и не подошла.');
			console.error('Дома всё цело: отметка «доехало» не ставится до конца, и следующая отправка');
			console.error('пошлёт ровно те же строки. Проще всего — повторить попозже кнопкой');
			console.error('«Отправить на сайт заново».');

			fail('npx', args, failure.status);
		}

		const wait = BUSY_WAITS[attempt];

		console.log(`\nНаверху идёт другая заливка — скорее всего ежечасный обход.`);
		console.log(`Это не ошибка: ждём ${wait} с и пробуем снова (попытка ${attempt + 2}).`);

		sleep(wait);
	}
}

/**
 * Ключи входов для местной проверки. Наверху они лежат в секретах Cloudflare,
 * а `wrangler dev` их оттуда не видит и читает файл .dev.vars — поэтому при
 * проверке он собирается из тех же data/*.txt, которыми пользуется домашний
 * сайт.
 *
 * Без него вход на местной копии не работает вовсе: сайт, не видя ключей,
 * даже не спрашивает, кто пришёл, — и проверить оценки с отметками нечем.
 * Файл переписывается каждой проверкой и в облако не уезжает никогда.
 *
 * Входов два, и каждый заводится сам по себе: заведён один — работает один,
 * и это не поломка. У ВК при этом секрета нет вовсе — в VK ID его заменяет
 * PKCE (см. cf/src/auth/vk.js), — поэтому от него нужен только номер приложения.
 */
export function writeDevVars() {
	const found = [
		['DISCORD_CLIENT_ID', 'discord-client-id.txt'],
		['DISCORD_CLIENT_SECRET', 'discord-client-secret.txt'],
		['VK_CLIENT_ID', 'vk-client-id.txt'],
		// Привязка сообщением в сообщество (см. cf/src/auth/vk-community.js)
		['VK_GROUP_TOKEN', 'vk-group-token.txt'],
		['VK_CALLBACK_CONFIRM', 'vk-callback-confirm.txt'],
		['VK_CALLBACK_SECRET', 'vk-callback-secret.txt'],
	]
		.map(([name, file]) => [name, readSecret(name, file)])
		.filter(([, value]) => value);

	if (found.length === 0) {
		console.log('Ключей входа в data нет — вход на местной копии работать не будет.');
		return;
	}

	fs.writeFileSync(
		path.join(root, '.dev.vars'),
		`# Собрано scripts/deploy-cf.js для местной проверки. Наверху эти ключи живут\n`
		+ `# в секретах Cloudflare (npx wrangler secret put), а не в файлах.\n`
		+ `${found.map(([name, value]) => `${name}=${value}`).join('\n')}\n`,
		'utf8',
	);

	console.log(`Ключи входа для местной проверки записаны в .dev.vars: ${found.map(([name]) => name).join(', ')}`);
}
