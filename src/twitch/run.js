// Обход стримов целиком: проверить живость → найти записи → посмотреть →
// запомнить в D1 (twitch_vods, pack_streams) → итог.
// Точка входа — scripts/twitch.js; ключи запуска — ниже, в options().

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover } from './discover.js';
import { buildIndex } from './index.js';
import { ocrPool, ocrWorkers } from './ocr.js';
import { windowsOf } from './plan.js';
import { details, markdown, windowsText, writeSummary } from './report.js';
import { scanVod } from './scan.js';
import { aliveVods, ensureSchema, knownChannels, knownVods, linkGames, markAlive, notifyStreamOwners, savePackStreams, saveVods } from './store.js';
import { deadVideos, videosById } from './twitch.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Twitch дольше всего хранит записи партнёров — 60 дней. */
const HORIZON_DAYS = 61;

/*
 * Ключи запуска:
 *   --vods=1,2,3      эти записи, а не найденные (смотрятся, даже если уже смотрели)
 *   --discover        только найти и показать, что смотреть, — без кадров
 *   --alive           только проверить, живы ли записи в полосе
 *   --all             каналы SullyGnome за 90 дней, а не за 7 (первый проход)
 *   --days=N          каналы SullyGnome за N дней
 *   --rescan          не пропускать уже просмотренные
 *   --limit=N         не больше N записей за запуск
 *   --minutes=N       сколько минут отпущено (по умолчанию 240)
 *   --dry             не читать и не писать D1
 *   --db=путь         база паков (по умолчанию data/sibase.db)
 *   --save-ocr=файл   дописывать распознанное в кэш
 *   --replay=файл     не ходить в Twitch: сверить заново то, что в кэше
 *   --out=файл        подробности по каждой записи в JSON
 */
export function options(argv = process.argv.slice(2)) {
	const a = Object.fromEntries(argv.map(s => {
		const m = /^--([^=]+)(?:=(.*))?$/.exec(s);
		return m ? [m[1], m[2] ?? true] : [s, true];
	}));
	return {
		vods: a.vods ? String(a.vods).split(/[\s,]+/).filter(Boolean) : null,
		discoverOnly: !!a.discover,
		aliveOnly: !!a.alive,
		sullyDays: a.days ? Number(a.days) : a.all ? 90 : 7,
		rescan: !!a.rescan,
		limit: a.limit ? Number(a.limit) : Infinity,
		minutes: a.minutes ? Number(a.minutes) : 240,
		dry: !!a.dry || !!a.replay,
		db: path.resolve(root, a.db ? String(a.db) : path.join('data', 'sibase.db')),
		saveOcr: a['save-ocr'] ? path.resolve(String(a['save-ocr'])) : null,
		replay: a.replay ? path.resolve(String(a.replay)) : null,
		out: a.out ? path.resolve(String(a.out)) : null,
	};
}

export async function run(o = options()) {
	const started = Date.now();
	const since = started - HORIZON_DAYS * 864e5;
	const useD1 = !o.dry;

	let known = new Map(), channels = [];
	let alive = null;
	if (useD1) {
		await ensureSchema();
		alive = await checkAlive();
		if (o.aliveOnly) {
			writeSummary(markdown({ alive, results: [] }));
			return;
		}
		known = await knownVods(since);
		channels = await knownChannels(since);
	}

	// 1. Что смотреть
	let items, discovery = null;
	let cache = null;
	if (o.replay) {
		cache = JSON.parse(fs.readFileSync(o.replay, 'utf8'));
		items = Object.entries(cache).map(([id, e]) => ({ video: e.video || { id, channel: '?', title: '', createdAt: 0, length: 0, chapters: [] }, source: 'кэш' }));
	} else if (o.vods) {
		const videos = await videosById(o.vods);
		items = videos.map((v, i) => v ? { video: v, source: 'вручную' } : { video: { id: o.vods[i], channel: '?', title: '', createdAt: 0, length: 0, chapters: [] }, gone: true });
	} else {
		discovery = await discover({ sullyDays: o.sullyDays, since, known, knownChannels: channels, rescan: o.rescan });
		items = discovery.todo;
	}

	if (o.discoverOnly) {
		const lines = (items || []).map(({ video: v, source }) => {
			const p = windowsOf(v);
			return `| ${v.id} | ${v.channel} | ${new Date(v.createdAt).toISOString().slice(0, 16).replace('T', ' ')} | ${Math.round(v.length / 60)} мин | ${v.game} | ${p.mode || p.reason} | ${p.windows ? windowsText(p.windows) : ''} | ${source || ''} |`;
		});
		writeSummary([markdown({ alive, discovery, results: [] }), '| Запись | Канал | Начало (UTC) | Длина | Категория | Как | Окна | Откуда |', '|---|---|---|---|---|---|---|---|', ...lines].join('\n'));
		return;
	}

	// 2. Смотреть
	if (o.saveOcr && !cache) cache = fs.existsSync(o.saveOcr) ? JSON.parse(fs.readFileSync(o.saveOcr, 'utf8')) : {};
	const index = buildIndex(o.db);
	console.log(`словарь: ${index.packs.size} паков, ${index.themes.length} тем, ${index.ms} мс; OCR в ${ocrWorkers()} процесса`);
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-'));
	const ctx = { index, recognize: ocrPool(), tmp, cache, replay: !!o.replay, log: s => console.log(s) };

	const results = [];
	try {
		for (const item of items.slice(0, o.limit)) {
			if (Date.now() - started > o.minutes * 60000) {
				console.log(`время вышло — осталось ${items.length - results.length} записей, возьмём завтра`);
				break;
			}
			const v = item.video;
			console.log(`▶ ${v.id} ${v.channel} «${v.title}» ${Math.round(v.length / 60)} мин`);
			const res = item.gone ? { status: 'gone', error: 'запись удалена или скрыта' } : await scanVod(v, ctx);
			results.push({ video: v, res, source: item.source });
			if (useD1 && res.status !== 'skip' && !item.gone) {
				// Сначала паки, потом отметка «просмотрена»: оборвись запуск между
				// ними — запись просто посмотрят ещё раз
				if (res.status === 'done') {
					const fresh = await savePackStreams(v, res.packs);
					await linkGames(v, res.packs);
					const sent = await notifyStreamOwners(v, fresh);
					if (sent) console.log(`  звонков авторам: ${sent}`);
				}
				await saveVods([{ ...v, source: item.source, status: res.status, frames: res.frames, planKey: res.planKey, error: res.error }]);
			}
			if (o.saveOcr && cache) fs.writeFileSync(o.saveOcr, JSON.stringify(cache));
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}

	// 3. Итог
	writeSummary(markdown({ alive, discovery, results, index, took: Date.now() - started }));
	if (o.out) fs.writeFileSync(o.out, JSON.stringify(results.map(details), null, '\t'));
}

/**
 * Живость записей в полосе: раз в день, одной пачкой GQL. Сбой проверки
 * обход не роняет — полоса денёк постоит вчерашней.
 */
async function checkAlive() {
	try {
		const ids = await aliveVods();
		const dead = ids.length ? await deadVideos(ids) : [];
		await markAlive(dead);
		console.log(`живость: в полосе ${ids.length} записей, умерло ${dead.length}`);
		return { checked: ids.length, dead: dead.length };
	} catch (e) {
		console.log(`живость не проверилась: ${e.message}`);
		return { error: e.message };
	}
}
