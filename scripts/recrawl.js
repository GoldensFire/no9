// Переобход: каждый день сказать Яндексу, какие страницы перечитать.
//
// Зачем это нужно отдельно от карты сайта и от IndexNow. Карта — это список
// «вот что у нас есть»; поисковик берёт из неё столько, сколько посчитает нужным,
// и молодому домену он отмеряет немного: в карте одиннадцать с лишним тысяч
// адресов, а в поиске Яндекса их меньше пяти тысяч. IndexNow — окрик «вот это
// сейчас изменилось», и он про изменения, а не про то, что лежит непрочитанным
// третий месяц. Переобход — третье и единственное, что действует на непрочитанное:
// названный в нём адрес Яндекс ставит в очередь на обход поимённо.
//
// Платится за это квотой: сто пятьдесят адресов в сутки, не больше, и неизрасходованное
// не копится — не отправил сегодня, значит потерял. Поэтому у этого файла ровно
// одна забота: каждый день выбрать те самые сто пятьдесят и потратить их целиком.
//
// Запускается двумя способами, и оба зовут одно и то же:
//   сам по себе  — `npm run recrawl` (и `npm run recrawl -- --dry`, чтобы
//                  посмотреть список, не тратя квоту);
//   каждую ночь  — последним шагом выкладки, сразу за IndexNow
//                  (см. scripts/deploy-cf.js). Своего задания в планировщике
//                  ему не нужно: ночной обход и так ходит каждые сутки.
//
// Ключ: data/yandex-webmaster-token.txt или переменная YANDEX_WEBMASTER_TOKEN —
// тот же порядок и та же папка, что у остальных ключей проекта (см. readSecret
// в scripts/deploy/wrangler.js). Заводится он на oauth.yandex.ru, право нужно
// одно: «Яндекс.Вебмастер: управление сайтами».
//
// Про Cloudflare здесь не знают ничего, кроме адреса сайта, и это нарочно:
// список адресов берётся готовой картой сайта по HTTP, а не сборкой её заново
// из D1, как это делает IndexNow. Ему иначе нельзя — он посылается в ту же
// секунду, когда база доехала наверх, и выложенная карта в этот миг ещё вчерашняя
// (Worker держит её сутки, см. SITEMAP_TTL). Переобходу, наоборот, вчерашняя
// карта ровно то, что нужно: он занимается не сегодняшним изменением,
// а накопившимся непрочитанным. Зато запускается он откуда угодно и без ключей
// Cloudflare вовсе.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { root } from './deploy/options.js';
import { siteOrigin } from './deploy/site.js';

const WEBMASTER_API = 'https://api.webmaster.yandex.net/v4';

/**
 * Сколько мест из суточной квоты отдаётся страницам, которые меняются каждый
 * день сами: главная, «свежее», топ и первые страницы разделов.
 *
 * Их около полутора сотен, и от квоты им нужна не вся она, а постоянство: каждая
 * должна попадать на переобход примерно раз в неделю, потому что ровно за неделю
 * список паков на ней успевает смениться заметно. Двадцать в сутки — это и есть
 * «раз в неделю каждой».
 *
 * Остальное уходит туда, где от переобхода толк больше: страницам, которых
 * в поиске ещё нет вовсе.
 */
const LIVE_BUDGET = 20;

/**
 * Сколько дней подряд один и тот же адрес не отправляется повторно.
 *
 * При одиннадцати тысячах адресов и ста пятидесяти в сутки полный круг занимает
 * два с половиной месяца, и упереться в этот срок неоткуда. Он здесь на случай,
 * когда адресов вдруг стало мало — скажем, карта сайта не собралась и приехала
 * куцей, — чтобы квота не ушла на десятикратную отправку одного и того же.
 */
const COOLDOWN_DAYS = 7;

/** Сколько ждать между запросами: у Вебмастера свой предел, и дразнить его незачем. */
const PACE_MS = 400;

const dry = process.argv.includes('--dry');

/**
 * Ключ Вебмастера. Порядок тот же, что у всех ключей проекта: сначала переменная
 * окружения, потом файл в data (папка под .gitignore).
 */
function readToken() {
	if (process.env.YANDEX_WEBMASTER_TOKEN) {
		return process.env.YANDEX_WEBMASTER_TOKEN.trim();
	}

	try {
		return fs.readFileSync(path.join(root, 'data', 'yandex-webmaster-token.txt'), 'utf8').trim();
	} catch {
		return '';
	}
}

/**
 * Запрос к Вебмастеру с разобранным ответом.
 *
 * Ошибки Вебмастера приезжают телом, а не кодом: HTTP 400 с {"error_message":…}
 * говорит куда больше, чем «400», — поэтому наружу отдаётся сообщение, а не код.
 */
async function ask(token, route, init = {}) {
	const response = await fetch(`${WEBMASTER_API}${route}`, {
		...init,
		headers: {
			Authorization: `OAuth ${token}`,
			...(init.body ? { 'Content-Type': 'application/json' } : {}),
			...init.headers,
		},
	});

	const body = await response.json().catch(() => null);

	if (!response.ok) {
		throw new Error(body?.error_message ?? `HTTP ${response.status}`);
	}

	return body;
}

/**
 * Чей это Вебмастер и какой из его сайтов наш.
 *
 * Сайтов у учётной записи два — firepacks.net и старое имя на workers.dev, —
 * и переобход нужен только главному: у страниц второго canonical стоит на первом
 * (см. ownHost в cf/src/index.js), и звать поисковика перечитывать их значило бы
 * тратить квоту на адреса, которые сами про себя говорят, что настоящие они
 * не здесь.
 */
async function findHost(token, origin) {
	const { user_id: user } = await ask(token, '/user/');
	const { hosts } = await ask(token, `/user/${user}/hosts`);
	const wanted = new URL(origin).host;
	const host = hosts.find(item => new URL(item.unicode_host_url ?? item.ascii_host_url).host === wanted);

	if (!host) {
		throw new Error(`Сайта ${wanted} в Вебмастере нет — добавьте и подтвердите права.`);
	}

	if (host.verified === false) {
		throw new Error(`Права на ${wanted} в Вебмастере не подтверждены.`);
	}

	return { user, host: host.host_id };
}

/** Обратно из HTML: карта сайта экранирует адреса, а слать их надо как есть. */
const unescapeHtml = text => text
	.replace(/&lt;/g, '<')
	.replace(/&gt;/g, '>')
	.replace(/&quot;/g, '"')
	.replace(/&amp;/g, '&');

/**
 * Все адреса сайта и когда каждый менялся — прямо из выложенной карты сайта.
 *
 * Второго списка адресов у сайта быть не должно, и здесь это соблюдается самым
 * прямым способом: читается ровно то, что сайт показывает поисковику. Разъехаться
 * с картой такой список не может по устройству.
 */
async function sitemapUrls(origin) {
	const response = await fetch(`${origin}/sitemap.xml`);

	if (!response.ok) {
		throw new Error(`карта сайта не отдалась: HTTP ${response.status}`);
	}

	const xml = await response.text();
	const found = [];

	for (const block of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
		const url = /<loc>([^<]+)<\/loc>/.exec(block[1])?.[1];

		if (url) {
			found.push({
				url: unescapeHtml(url),
				stamp: /<lastmod>([^<]+)<\/lastmod>/.exec(block[1])?.[1] ?? '',
			});
		}
	}

	return found;
}

/**
 * Какие страницы сайта уже лежат в поиске Яндекса.
 *
 * Ради этого списка всё и затевается: разница между картой сайта и им — это
 * и есть те несколько тысяч страниц, до которых робот не дошёл. Отдаётся он
 * сотнями, поэтому приходится обойти полсотни страниц ответа; это дёшево
 * и делается раз в сутки.
 *
 * Не отдался — не беда: возвращаем null, и очередь строится без него, по одной
 * только памяти об отправленном. Хуже, но не пусто.
 */
async function inSearch(token, user, host) {
	const known = new Set();
	const LIMIT = 100;

	try {
		for (let offset = 0; ; offset += LIMIT) {
			const page = await ask(token,
				`/user/${user}/hosts/${encodeURIComponent(host)}/search-urls/in-search/samples`
				+ `?limit=${LIMIT}&offset=${offset}`);

			for (const item of page.samples ?? []) {
				known.add(item.url);
			}

			if ((page.samples ?? []).length < LIMIT) {
				return known;
			}

			// Предел выборки у Вебмастера свой, и он ниже числа страниц в поиске
			// у большого сайта. Упёрлись — значит, дальше не покажут: отдаём то,
			// что набрали, вместо бесконечного хождения по кругу.
			if (offset > 100000) {
				return known;
			}
		}
	} catch (error) {
		console.log(`  Список страниц в поиске не отдался (${error.message}) — очередь строим без него.`);
		return null;
	}
}

/**
 * Что уже отправляли на переобход и когда.
 *
 * Лежит это в домашней базе, рядом с такой же памятью IndexNow (см. indexnow_sent
 * в scripts/deploy/indexnow.js), и по той же причине: база ездит между машинами
 * полкой (см. scripts/state.js), и отдельным файлом такая память не пережила бы
 * и первого переезда — сайт слал бы одни и те же двадцать адресов каждый день.
 */
function memory(db) {
	db.exec(`CREATE TABLE IF NOT EXISTS recrawl_sent (
		url TEXT PRIMARY KEY,
		stamp TEXT NOT NULL,
		sent_at INTEGER NOT NULL
	)`);

	const known = new Map();

	for (const row of db.prepare('SELECT url, stamp, sent_at FROM recrawl_sent').iterate()) {
		known.set(row.url, row);
	}

	return known;
}

/**
 * Страница, которая меняется каждый день сама: главная, «свежее», топ, первые
 * страницы разделов.
 *
 * Считается по одному только виду адреса, без похода в устройство сайта, и это
 * нарочно: файл должен запускаться там, где кода сайта нет вовсе. Отдельный пак
 * и страница автора меняются редко; вторая и дальше страницы раздела
 * (/topic/anime/37) — продолжение, а не сам раздел, и перечитывать их так же
 * часто незачем.
 */
function live(url, origin) {
	const path = url.slice(origin.length);

	if (path === '/' || path === '') {
		return true;
	}

	if (path.startsWith('/pack/') || path.startsWith('/author/')) {
		return false;
	}

	// Хвост номером — это «страница 37 раздела», а не сам раздел
	return !/\/\d+$/.test(path);
}

/**
 * Очередь на сегодня: что из сайта стоит назвать Яндексу первым.
 *
 * Порядок такой, и каждая ступень отвечает на свой вопрос.
 *
 * Первыми — «живые» страницы, по кругу и не больше LIVE_BUDGET за раз: они
 * в поиске давно, перечитывать их надо не ради попадания туда, а ради свежести
 * того, что там показано.
 *
 * Дальше — то, чего в поиске нет. Ради этого всё и делается: таких страниц
 * несколько тысяч, и ни карта сайта, ни IndexNow до них не достучались. Сначала
 * паки, свежие вперёд — пак, выложенный вчера, важнее пака 2021 года, которого
 * нет в поиске третий год; за ними всё прочее непрочитанное в порядке карты.
 *
 * Паки вперёд потому, что дата у них своя, а у страниц разделов — общая: карта
 * ставит им всем время самого свежего пака в библиотеке (см. stamp
 * в src/meta/sitemap.js), то есть сегодняшнее. Сортируй мы их вместе по дате —
 * и тридцать седьмая страница раздела «аниме» каждый день обгоняла бы вчерашний
 * пак, ничего про себя этим не сообщая. Важные страницы разделов сюда всё равно
 * не попадают: они разобраны ступенью выше.
 *
 * Последними — всё остальное по кругу, от давно не отправлявшихся к недавним:
 * это досыл, чтобы квота не пропадала в те дни, когда непрочитанного не осталось.
 *
 * На каждой ступени отсеиваются адреса, отправленные недавно (COOLDOWN_DAYS),
 * если только страница с тех пор не менялась.
 */
function queue(all, indexed, known, origin, room) {
	const cooling = Date.now() - COOLDOWN_DAYS * 86400_000;

	const ready = all.filter(item => {
		const seen = known.get(item.url);

		// Не отправляли вовсе, или страница с тех пор изменилась, или срок вышел
		return !seen || seen.stamp !== item.stamp || seen.sent_at < cooling;
	});

	const sentAt = item => known.get(item.url)?.sent_at ?? 0;
	const byOldest = (first, second) => sentAt(first) - sentAt(second);
	const byNewest = (first, second) => second.stamp.localeCompare(first.stamp);

	// В поиске нет — значит, робот до страницы не дошёл. Не знаем этого вовсе
	// (список не отдался) — считаем, что дошёл: тогда очередь выстроится
	// по одной памяти об отправленном, круг за кругом
	const missing = item => indexed !== null && !indexed.has(item.url);

	const lively = ready.filter(item => live(item.url, origin)).sort(byOldest).slice(0, LIVE_BUDGET);
	const taken = new Set(lively.map(item => item.url));

	const left = ready.filter(item => !taken.has(item.url) && missing(item));
	const isPack = item => item.url.startsWith(`${origin}/pack/`);

	const unseen = [
		...left.filter(isPack).sort(byNewest),
		...left.filter(item => !isPack(item)),
	];

	for (const item of unseen) {
		taken.add(item.url);
	}

	const rest = ready.filter(item => !taken.has(item.url)).sort(byOldest);

	return [...lively, ...unseen, ...rest].slice(0, room);
}

/** Поставить один адрес в очередь на переобход. */
async function submit(token, user, host, url) {
	return ask(token, `/user/${user}/hosts/${encodeURIComponent(host)}/recrawl/queue`, {
		method: 'POST',
		body: JSON.stringify({ url }),
	});
}

const wait = ms => new Promise(done => setTimeout(done, ms));

/**
 * Весь день целиком: спросить квоту, собрать очередь, потратить квоту, запомнить.
 *
 * Сорвалось — говорим и живём дальше, как и IndexNow. Переобход это ускорение,
 * а не условие: не отправили сегодня — Яндекс дойдёт до страниц сам, просто позже.
 */
export async function recrawl() {
	console.log('\n───── Переобход в Яндексе ─────');

	const token = readToken();

	if (!token) {
		console.log('Ключа Вебмастера нет — пропускаем.');
		console.log('Кладётся в data/yandex-webmaster-token.txt (oauth.yandex.ru, право «Яндекс.Вебмастер: управление сайтами»).');
		return;
	}

	const dbPath = path.join(root, 'data', 'sibase.db');

	if (!fs.existsSync(dbPath)) {
		console.log('Домашней базы нет — вспомнить, что уже отправляли, нечем. Пропускаем.');
		return;
	}

	const origin = await siteOrigin();

	if (!origin) {
		console.log('Адрес сайта не спросился — переобход отложен до следующего раза.');
		return;
	}

	const db = new DatabaseSync(dbPath);

	try {
		const { user, host } = await findHost(token, origin);
		const { daily_quota: daily, quota_remainder: room } = await ask(token,
			`/user/${user}/hosts/${encodeURIComponent(host)}/recrawl/quota`);

		console.log(`Квота на сегодня: ${room} из ${daily}.`);

		if (room <= 0) {
			console.log('Сегодня уже всё отправлено — ждём завтрашней.');
			return;
		}

		const all = await sitemapUrls(origin);
		const indexed = await inSearch(token, user, host);
		const known = memory(db);

		if (indexed) {
			const missing = all.filter(item => !indexed.has(item.url)).length;
			console.log(`Адресов в карте сайта: ${all.length}; из них нет в поиске Яндекса: ${missing}.`);
		} else {
			console.log(`Адресов в карте сайта: ${all.length}.`);
		}

		const today = queue(all, indexed, known, origin, room);

		if (today.length === 0) {
			console.log('Отправлять нечего: всё названное недавно и с тех пор не менялось.');
			return;
		}

		if (dry) {
			console.log(`\nОтправили бы ${today.length} адресов (--dry, квота не тронута):`);

			for (const item of today.slice(0, 20)) {
				console.log(`  ${item.url}`);
			}

			if (today.length > 20) {
				console.log(`  … и ещё ${today.length - 20}`);
			}

			return;
		}

		const remember = db.prepare(
			'INSERT OR REPLACE INTO recrawl_sent (url, stamp, sent_at) VALUES (?, ?, ?)',
		);

		let sent = 0;
		let failed = 0;

		for (const item of today) {
			try {
				await submit(token, user, host, item.url);
				remember.run(item.url, item.stamp, Date.now());
				sent++;
			} catch (error) {
				// Квота кончилась посреди отправки — это не ошибка, а конец дня:
				// остальное уедет завтра, и запомнили мы ровно то, что ушло
				if (/quota/i.test(error.message)) {
					console.log(`Квота кончилась на ${sent}-м адресе — остальное завтра.`);
					break;
				}

				failed++;

				// Одна отказавшая страница не повод бросать остальные сто сорок
				if (failed <= 3) {
					console.log(`  ${item.url} — ${error.message}`);
				}
			}

			await wait(PACE_MS);
		}

		console.log(`Отправлено на переобход: ${sent}`
			+ (failed > 0 ? `; не приняты: ${failed}` : ''));
	} catch (error) {
		console.error(`Переобход не отработал: ${error.message}`);
		console.error('На сам сайт это не влияет — Яндекс дойдёт до страниц по карте сайта.');
	} finally {
		db.close();
	}
}

// Запущен сам по себе (`npm run recrawl`), а не позван выкладкой. Сравниваем
// пути, а не имена файлов: выкладка зовёт этот же файл импортом, и совпадение
// по имени сработало бы и там.
if (import.meta.filename === path.resolve(process.argv[1] ?? '')) {
	await recrawl();
}
