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
import { aliveVods, ensureSchema, knownChannels, knownTitles, knownVods, linkGames, markAlive, notifyStreamOwners, savePackStreams, saveVods, seenChannels, seenWindows } from './store.js';
import { checkVideos, videosById } from './twitch.js';

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
 *   --minutes=N       сколько минут отпущено (по умолчанию 240; при --loop — без лимита)
 *   --loop            бесконечный обход волнами до Ctrl+C (снимает потолок probe-записей)
 *   --pause=N         пауза в минутах между пустыми волнами при --loop (по умолчанию 15)
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
	const loop = !!a.loop;
	return {
		vods: a.vods ? String(a.vods).split(/[\s,]+/).filter(Boolean) : null,
		discoverOnly: !!a.discover,
		aliveOnly: !!a.alive,
		sullyDays: a.days ? Number(a.days) : a.all ? 90 : 7,
		forceSully: !!a.all || !!a.days,
		rescan: !!a.rescan,
		loop,
		pause: a.pause !== undefined ? Math.max(1, Number(a.pause)) : 15,
		limit: a.limit ? Number(a.limit) : Infinity,
		minutes: a.minutes !== undefined ? Number(a.minutes) : (loop ? Infinity : 240),
		dry: !!a.dry || !!a.replay,
		db: path.resolve(root, a.db ? String(a.db) : path.join('data', 'sibase.db')),
		saveOcr: a['save-ocr'] ? path.resolve(String(a['save-ocr'])) : null,
		replay: a.replay ? path.resolve(String(a.replay)) : null,
		out: a.out ? path.resolve(String(a.out)) : null,
	};
}

export async function run(o = options()) {
	const useD1 = !o.dry;
	const loopMode = o.loop && !o.vods && !o.discoverOnly && !o.aliveOnly && !o.replay;
	const deadline = Number.isFinite(o.minutes) ? Date.now() + o.minutes * 60000 : Infinity;

	let stopRequested = false;
	const onSignal = () => {
		if (stopRequested) process.exit(130);
		stopRequested = true;
		console.log('\n⏹ Получен сигнал остановки — завершаю текущую запись и выхожу… (нажмите Ctrl+C ещё раз для немедленного выхода)');
	};
	if (loopMode) {
		process.on('SIGINT', onSignal);
		process.on('SIGTERM', onSignal);
	}
	const sleepInterruptible = async ms => {
		const until = Date.now() + ms;
		while (!stopRequested && Date.now() < until) {
			await new Promise(res => setTimeout(res, Math.min(2000, until - Date.now())));
		}
	};

	if (useD1) {
		await ensureSchema();
		if (o.aliveOnly) {
			const alive = await checkAlive();
			writeSummary(markdown({ alive, results: [] }));
			return;
		}
	}

	const index = o.discoverOnly ? null : buildIndex(o.db);
	const tmp = o.discoverOnly ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-'));
	const recognize = o.discoverOnly ? null : ocrPool();
	let cache = (!o.discoverOnly && o.saveOcr && !o.replay && fs.existsSync(o.saveOcr))
		? JSON.parse(fs.readFileSync(o.saveOcr, 'utf8'))
		: (o.saveOcr ? {} : null);
	let lastAliveAt = 0;

	if (index) {
		console.log(`словарь: ${index.packs.size} паков, ${index.themes.length} тем, ${index.ms} мс; OCR в ${ocrWorkers()} процесса`);
	}

	try {
		for (let wave = 1; !stopRequested; wave++) {
			const started = Date.now();
			const since = started - HORIZON_DAYS * 864e5;
			if (loopMode) {
				console.log(`\n══════ Twitch волна #${wave} (${new Date(started).toLocaleTimeString('ru-RU')}) ══════`);
			}

			let known = new Map(), channels = [], titles = [], live = { channels: [], latestAt: 0 }, liveWindows = new Map();
			let alive = null;
			if (useD1) {
				if (wave === 1 || started - lastAliveAt >= 864e5) {
					alive = await checkAlive();
					lastAliveAt = started;
				}
				known = await knownVods();
				channels = await knownChannels(since);
				titles = await knownTitles(since);
				live = await seenChannels(since);
				liveWindows = await seenWindows(since);
			}

			// 1. Что смотреть
			let items, discovery = null;
			if (o.replay) {
				cache = JSON.parse(fs.readFileSync(o.replay, 'utf8'));
				items = Object.entries(cache).map(([id, e]) => ({ video: e.video || { id, channel: '?', title: '', createdAt: 0, length: 0, chapters: [] }, source: 'кэш' }));
			} else if (o.vods) {
				const videos = await videosById(o.vods);
				items = videos.map((v, i) => v ? { video: v, source: 'вручную' } : { video: { id: o.vods[i], channel: '?', title: '', createdAt: 0, length: 0, chapters: [] }, gone: true });
			} else {
				discovery = await discover({
					sullyDays: o.sullyDays,
					forceSully: o.forceSully,
					since,
					known,
					knownChannels: channels,
					knownTitles: titles,
					seenChannels: live.channels,
					seenLatestAt: live.latestAt,
					seenWindows: liveWindows,
					rescan: o.rescan,
					noProbeCap: loopMode,
				});
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
			const ctx = { index, recognize, tmp, cache, replay: !!o.replay, log: s => console.log(s) };
			const results = [];
			let timeUp = false;
			const queue = Number.isFinite(o.limit) ? items.slice(0, o.limit) : items;
			for (const item of queue) {
				if (stopRequested) break;
				if (Date.now() > deadline) {
					console.log(`время вышло — осталось ${items.length - results.length} записей, возьмём завтра`);
					timeUp = true;
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
					await saveVods([{ ...v, source: item.source, status: res.status, frames: res.frames, signs: res.signs, planKey: res.planKey, error: res.error }]);
				}
				if (o.saveOcr && cache) fs.writeFileSync(o.saveOcr, JSON.stringify(cache));
			}

			// 3. Итог волны
			writeSummary(markdown({ alive, discovery, results, index, took: Date.now() - started }));
			if (o.out) fs.writeFileSync(o.out, JSON.stringify(results.map(details), null, '\t'));

			if (!loopMode || stopRequested || timeUp) break;

			const waitMin = results.length > 0 ? Math.min(3, o.pause) : o.pause;
			console.log(`⏸ Twitch волна #${wave} завершена (просмотрено ${results.length}). Жду ${waitMin} мин до следующей волны…`);
			await sleepInterruptible(waitMin * 60000);
		}
	} finally {
		if (loopMode) {
			process.off('SIGINT', onSignal);
			process.off('SIGTERM', onSignal);
		}
		if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
	}
}

/**
 * Живость записей в полосе: раз в день, одной пачкой GQL. Сбой проверки
 * обход не роняет — полоса денёк постоит вчерашней.
 */
async function checkAlive() {
	try {
		const ids = await aliveVods();
		const { dead, views } = ids.length ? await checkVideos(ids) : { dead: [], views: [] };
		await markAlive(dead, views);
		console.log(`живость: в полосе ${ids.length} записей, умерло ${dead.length}`);
		return { checked: ids.length, dead: dead.length };
	} catch (e) {
		console.log(`живость не проверилась: ${e.message}`);
		return { error: e.message };
	}
}
