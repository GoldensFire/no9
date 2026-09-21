// Последнее дело выкладки: сказать поисковикам, что изменилось.
//
// IndexNow — общий для Bing, Yandex и прочих способ не ждать, пока робот
// зайдёт сам. Своим файлом потому, что занятие тут другое: не переложить базу
// наверх, а сходить в чужую службу и запомнить, о чём ей уже говорили —
// повторно слать те же адреса незачем и вредно.
//
// Список адресов при этом берётся не из домашней базы, а из той, что уже стоит
// наверху: говорить надо про то, что там и правда лежит.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { root } from './options.js';
import { CLOUDFLARE_ENV, run } from './wrangler.js';
import { accountId, CLOUDFLARE_API, databaseId } from './d1.js';
import { siteOrigin } from './site.js';

// ————— IndexNow —————
//
// Поисковику незачем гадать, когда сайт менялся, если сайт может сказать это
// сам. IndexNow — общий на всех протокол ровно про это: один запрос со списком
// изменившихся адресов, и он расходится по всем поисковикам, которые в нём
// участвуют. Bing и Яндекс придумали его вместе, оба его и слушают: пинг уходит
// один, доходит до обоих. Google в протоколе не участвует — на его индексацию
// это не влияет никак, ему по-прежнему остаются карта сайта и обход по ссылкам.
//
// Здесь это стоит последним шагом выкладки нарочно: раньше неё сообщать нечего,
// а после неё наверху уже лежит ровно то, о чём мы говорим.

/**
 * Ключ, которым сайт доказывает, что адреса присылает его хозяин, а не сосед.
 * Проверка простая: тот же ключ лежит текстовым файлом по адресу /<ключ>.txt,
 * и поисковик читает его сам, придя на сайт. Устроено это как файлы
 * подтверждения прав у Google и Яндекса (см. VERIFY в cf/src/index.js),
 * и переименованию файл так же не подлежит: имя файла и есть ключ.
 *
 * Тайны в нём нет и быть не может — он открыто лежит на сайте, — но и вреда
 * от чужого знания тоже: всё, что можно сделать чужим ключом, это сказать
 * поисковику правду о нашем же сайте.
 */
const INDEXNOW_KEY = 'abce43ca71328719000c6012c346e9b2';

/** Общая точка входа: отсюда пинг расходится по всем поисковикам протокола. */
const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

/** Сколько адресов протокол принимает за один запрос. */
const INDEXNOW_LIMIT = 10000;

// Адрес сайта наверху считает scripts/deploy/site.js: тот же адрес нужен
// и плашке технических работ — она по нему проверяет, отвечает ли выложенный
// Worker.

/**
 * Один запрос к базе наверху с ответом, а не с отметкой «прошло». Тем же
 * способом, что и заливка (D1 REST, /query), — см. askDatabase выше; разница
 * ровно в том, что оттуда нужен успех, а отсюда строки.
 */
async function queryDatabase(sql, params = []) {
	const account = await accountId();

	const response = await fetch(`${CLOUDFLARE_API}/accounts/${account}/d1/database/${databaseId()}/query`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${CLOUDFLARE_ENV.CLOUDFLARE_API_TOKEN}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ sql, params: params.map(value => value ?? null) }),
	});

	const body = await response.json().catch(() => null);

	if (!response.ok || !body?.success) {
		const complaints = (body?.errors ?? []).map(item => item.message).filter(Boolean);
		throw new Error(complaints.join('; ') || `HTTP ${response.status}`);
	}

	return body.result[0]?.results ?? [];
}

/**
 * База наверху, притворяющаяся той, что подаёт Worker своему коду.
 *
 * Нужна затем, чтобы список адресов сайта считался ровно тем же кодом, что
 * и карта сайта: listSitemap, getFacets, subjectPages и buildSitemap — те же
 * самые (см. /sitemap.xml в cf/src/index.js). Второго списка адресов у сайта
 * быть не должно: разъедься он с картой — и поисковику приходили бы пинги
 * про страницы, которых в карте нет, или наоборот.
 *
 * Прочитать карту готовой, запросом к самому сайту, нельзя: Worker держит её
 * у себя сутки (см. SITEMAP_TTL), и сразу после выкладки оттуда приехала бы
 * вчерашняя — то есть без тех самых паков, ради которых пинг и посылается.
 */
function remoteDatabase() {
	const statement = (sql, params = []) => ({
		bind: (...values) => statement(sql, values),
		all: async () => ({ results: await queryDatabase(sql, params) }),
		first: async () => (await queryDatabase(sql, params))[0] ?? null,
		run: async () => ({ success: true }),
	});

	return {
		prepare: sql => statement(sql),
		batch: async list => {
			const out = [];

			for (const item of list) {
				out.push(await item.all());
			}

			return out;
		},
	};
}

/** Обратно из HTML: карта сайта экранирует адреса, а слать их надо как есть. */
const unescapeHtml = text => text
	.replace(/&lt;/g, '<')
	.replace(/&gt;/g, '>')
	.replace(/&quot;/g, '"')
	.replace(/&amp;/g, '&');

/**
 * Все адреса сайта и когда каждый менялся — из карты сайта, разобранной обратно.
 * Дата берётся оттуда же, из lastmod: по ней и видно, что изменилось.
 */
async function sitemapUrls(origin) {
	// Читается это здесь, а не наверху файла, и причина не в скорости.
	// В репозитории лежит только та половина проекта, которой живёт обновление
	// базы, — сайта там нет вовсе (ни web/, ни cf/src/, ни src/meta/), и ночной
	// обход в Actions работает без них. А обычный import наверху потребовал бы
	// их в тот же миг, когда кто-то тронет выкладку, — то есть уронил бы ночь
	// на файле, до которого дело всё равно не доходит: в Actions выкладка идёт
	// только базой (см. dbOnly в options.js), а IndexNow стоит после неё.
	const { buildSitemap } = await import('../../src/meta/sitemap.js');
	const { TOPIC_PAGE_KEYS, subjectPages } = await import('../../src/meta/sections.js');
	const {
		listSitemap, listSubjectGroups, getFacets, getLandingPages, listAuthorPages,
	} = await import('../../cf/src/library/pages.js');

	const db = remoteDatabase();
	const assets = builtAssets();
	const [rows, groups] = await Promise.all([listSitemap(db), listSubjectGroups(db, assets, ASSET_BASE)]);
	const facets = await getFacets(db, assets, ASSET_BASE);
	const [pages, authors] = await Promise.all([
		getLandingPages(assets, ASSET_BASE),
		listAuthorPages(assets, ASSET_BASE),
	]);

	const xml = buildSitemap(rows, origin, {
		topics: TOPIC_PAGE_KEYS.filter(key => (facets.topics?.[key] ?? 0) > 0),
		subjects: subjectPages(groups),
		pages,
		authors,
	});

	const found = [];

	for (const block of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
		const url = /<loc>([^<]+)<\/loc>/.exec(block[1])?.[1];

		if (url) {
			found.push({ url: unescapeHtml(url), stamp: /<lastmod>([^<]+)<\/lastmod>/.exec(block[1])?.[1] ?? '' });
		}
	}

	return found;
}

/**
 * Адрес, от которого спрашивается статика. Настоящий здесь не нужен и не важен:
 * ниже по нему берётся один только путь, — но сами функции Worker'а без него
 * не работают, и придумывать им особый способ вызова незачем.
 */
const ASSET_BASE = 'https://localhost/';

/**
 * Статика, притворяющаяся той, что подаёт Worker'у Cloudflare.
 *
 * Нужна ровно за одним файлом — `prebuilt.json`, готовыми ответами, посчитанными
 * при сборке (см. cf/src/prebuilt.js). В нём лежат страницы авторов и число
 * страниц у каждого раздела, а без них карта, собранная здесь, выходила короче
 * настоящей: не хватало пяти сотен страниц авторов и полутора тысяч вторых
 * и дальше страниц разделов.
 *
 * Недостача эта была тихой и заметной только со стороны. Bing в отчёте писал,
 * что часть важных страниц сайт через IndexNow не отправлял, и был прав: в карте
 * сайта они есть, ссылки на них есть, а пинга про них не уходило никогда.
 *
 * Файла нет — возвращаем «не нашлось», и карта собирается как раньше, без них:
 * между выкладкой Worker'а и выкладкой статики так и бывает (см. prebuilt).
 */
function builtAssets() {
	return {
		fetch: async address => {
			const file = path.join(root, 'cf', 'public', new URL(address).pathname.replace(/^\//, ''));

			if (!fs.existsSync(file)) {
				return { ok: false, json: async () => null };
			}

			return { ok: true, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
		},
	};
}

/**
 * Что уже отправляли и когда оно тогда менялось.
 *
 * Лежит это в домашней базе, рядом с отметками «строка доехала до D1»
 * (см. d1_sync в scripts/export-d1.js), и по той же причине: база ездит между
 * машинами полкой (см. scripts/state.js), а значит ночной обход в Actions
 * и здешний запуск помнят одно и то же. Отдельным файлом такая память
 * не пережила бы и первой ночи — и сайт слал бы все одиннадцать тысяч адресов
 * каждую ночь заново.
 */
function sentBefore(db) {
	db.exec(`CREATE TABLE IF NOT EXISTS indexnow_sent (
		url TEXT PRIMARY KEY,
		stamp TEXT NOT NULL,
		sent_at INTEGER NOT NULL
	)`);

	const known = new Map();

	for (const row of db.prepare('SELECT url, stamp FROM indexnow_sent').iterate()) {
		known.set(row.url, row.stamp);
	}

	return known;
}

/**
 * Сказать поисковикам, что на сайте изменилось.
 *
 * Отправляется не всё подряд, а только новое и изменившееся: первый запуск
 * увозит весь сайт, дальше — те несколько десятков адресов, которые за ночь
 * прибавились. Всё это одним запросом и один раз за выкладку: протокол просит
 * не частить, и он прав — «изменилось всё» дважды в час значит «не верьте мне».
 *
 * Больше десяти тысяч за раз протокол не принимает. Отправляем самое свежее,
 * а хвост доедет следующей выкладкой: запоминается только то, что вправду ушло.
 *
 * Сорвалось — говорим и живём дальше. Сайт выложен, карта сайта на месте,
 * и поисковик дойдёт до нового сам, просто позже.
 */
export async function pingIndexNow() {
	console.log('\n───── IndexNow ─────');

	const keyFile = path.join(root, 'web', `${INDEXNOW_KEY}.txt`);

	if (fs.readFileSync(keyFile, 'utf8').trim() !== INDEXNOW_KEY) {
		console.error(`Ключ и файл разошлись: в web/${INDEXNOW_KEY}.txt лежит не тот ключ.`);
		console.error('Поисковик проверяет их сверкой, и с таким расхождением пинг он отбросит.');
		return;
	}

	const dbPath = path.join(root, 'data', 'sibase.db');

	if (!fs.existsSync(dbPath)) {
		console.log('Домашней базы нет — вспомнить, что уже отправляли, нечем. Пропускаем.');
		return;
	}

	const origin = await siteOrigin();

	if (!origin) {
		console.log('Адрес сайта у Cloudflare не спросился — пинг отложен до следующей выкладки.');
		return;
	}

	const db = new DatabaseSync(dbPath);

	try {
		const known = sentBefore(db);
		const all = await sitemapUrls(origin);

		// Свежее вперёд: если адресов больше, чем протокол берёт за раз,
		// уехать должны новые паки, а не хвост позапрошлого года
		const changed = all
			.filter(item => known.get(item.url) !== item.stamp)
			.sort((first, second) => second.stamp.localeCompare(first.stamp))
			.slice(0, INDEXNOW_LIMIT);

		if (changed.length === 0) {
			console.log(`Адресов на сайте ${all.length}, изменившихся нет — сообщать нечего.`);
			return;
		}

		const response = await fetch(INDEXNOW_ENDPOINT, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json; charset=utf-8' },
			body: JSON.stringify({
				host: new URL(origin).host,
				key: INDEXNOW_KEY,
				keyLocation: `${origin}/${INDEXNOW_KEY}.txt`,
				urlList: changed.map(item => item.url),
			}),
		});

		// 200 — приняли, 202 — приняли и пошли читать файл с ключом. И то,
		// и другое значит «дошло»; остальное значит, что не дошло.
		//
		// 403 отдельно стоит узнавать в лицо: это «файла с ключом не видно».
		// Так отвечает самая первая выкладка с новым ключом — поисковик идёт
		// за /<ключ>.txt в ту же секунду, когда файл только-только уехал наверх,
		// и не находит его. Лечится это ничем: следующая выкладка отправит
		// те же адреса, и к тому времени файл будет на месте.
		if (response.status !== 200 && response.status !== 202) {
			console.error(`IndexNow ответил ${response.status} — адреса не приняты, отправим их следующей выкладкой.`);

			if (response.status === 403) {
				console.error(`Проверьте, что ${origin}/${INDEXNOW_KEY}.txt открывается и в нём лежит сам ключ.`);
			}

			return;
		}

		const remember = db.prepare(
			'INSERT OR REPLACE INTO indexnow_sent (url, stamp, sent_at) VALUES (?, ?, ?)',
		);

		const now = Date.now();

		db.exec('BEGIN');

		for (const item of changed) {
			remember.run(item.url, item.stamp, now);
		}

		db.exec('COMMIT');

		const left = all.filter(item => known.get(item.url) !== item.stamp).length - changed.length;

		console.log(`Отправлено адресов: ${changed.length} из ${all.length}`
			+ (left > 0 ? `; ещё ${left} уедут следующей выкладкой` : ''));
	} catch (error) {
		console.error(`IndexNow не отработал: ${error.message}`);
		console.error('На сам сайт это не влияет — поисковик дойдёт до нового по карте сайта.');
	} finally {
		db.close();
	}
}
