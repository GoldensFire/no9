// Локальное сканирование YouTube-видео на домашнем ПК без квоты Gemini:
//   yt-dlp -g (прямой 720p MP4 URL) → ffmpeg -ss (Range-seek кадров) →
//   Tesseract OCR (src/twitch/ocr.js) → матчер FirePacks (match.js / verdict.js / marks.js).
//
// Работает на резидентском IP (без bot-wall YouTube) и не тратит суточные
// лимиты Gemini Free Tier: ~35–75 с на запись (60–80 видео/час на 6-ядерном ПК).
// Ролики 18+ без cookies возвращают AgeRestrictedError — их можно либо
// пропустить для облачного Gemini (--local), либо сразу досмотреть через
// Gemini (--hybrid), либо передать --cookies / --cookies-from-browser=chrome.

import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { frameWords, marksOf, themeWordsOf } from '../twitch/marks.js';
import { analyzeFrame } from '../twitch/match.js';
import { linesOf, ocrPool } from '../twitch/ocr.js';
import { grid, merge, openings, STEP } from '../twitch/plan.js';
import { collectHits, collectNames, judge } from '../twitch/verdict.js';
import { parseChapterTimestamps } from './plan.js';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const LOCAL_PLAN_KEY = 'local-v1/tesseract';

const MAX_LOCAL_FRAMES = 75;
const MAX_OPENING_FRAMES = 10;
const PROBE_FRACTIONS = [0.08, 0.24, 0.40, 0.56, 0.72, 0.88];
const FORMAT_SELECTOR = 'bestvideo[height<=720][ext=mp4]/best[height<=720][ext=mp4]/bestvideo[height<=720]/best[height<=720]/best';
const FFMPEG_TIMEOUT_MS = 35_000;
const YTDLP_TIMEOUT_MS = 45_000;

export class AgeRestrictedError extends Error {
	constructor(message) {
		super(message);
		this.name = 'AgeRestrictedError';
	}
}

export class LocalVideoGoneError extends Error {
	constructor(message) {
		super(message);
		this.name = 'LocalVideoGoneError';
	}
}

export class LocalBotCheckError extends Error {
	constructor(message) {
		super(message);
		this.name = 'LocalBotCheckError';
	}
}

export class LocalExtractorError extends Error {
	constructor(message) {
		super(message);
		this.name = 'LocalExtractorError';
	}
}

function commandExists(cmd) {
	try {
		const res = spawnSync(cmd, ['-version'], { stdio: 'ignore', windowsHide: true });
		if (res.status === 0 || res.status === 1) return true;
		const res2 = spawnSync(cmd, ['--version'], { stdio: 'ignore', windowsHide: true });
		return res2.status === 0;
	} catch {
		return false;
	}
}

/** Найти ffmpeg (env FFMPEG, PATH или популярные установки Windows вроде ShareX / Shutter Encoder / winget). */
export function findFfmpeg() {
	if (process.env.FFMPEG && fs.existsSync(process.env.FFMPEG)) return process.env.FFMPEG;
	if (commandExists('ffmpeg')) return 'ffmpeg';
	if (process.platform === 'win32') {
		const home = os.homedir();
		const localApp = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
		const candidates = [
			path.join(home, 'Desktop', 'SI-HYX', 'bin', 'ffmpeg.exe'),
			'C:\\Program Files\\ShareX\\ffmpeg.exe',
			'C:\\Program Files\\Shutter Encoder\\Library\\ffmpeg.exe',
			'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
			'C:\\ffmpeg\\bin\\ffmpeg.exe',
			path.join(localApp, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
			path.join(home, 'scoop', 'shims', 'ffmpeg.exe'),
			'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
		];
		for (const p of candidates) {
			if (fs.existsSync(p)) return p;
		}
	}
	return null;
}

/** Проверить наличие yt-dlp, ffmpeg и tesseract для локального режима. */
export function detectLocalTools() {
	const ytdlp = process.env.YTDLP || (commandExists('yt-dlp') ? 'yt-dlp' : null);
	const ffmpeg = findFfmpeg();
	const tesseract = commandExists('tesseract')
		? 'tesseract'
		: (process.platform === 'win32' && fs.existsSync('C:\\Program Files\\Tesseract-OCR\\tesseract.exe')
			? 'C:\\Program Files\\Tesseract-OCR\\tesseract.exe'
			: null);

	const missing = [];
	if (!ytdlp) missing.push('yt-dlp (pip install yt-dlp или winget install yt-dlp.yt-dlp)');
	if (!ffmpeg) missing.push('ffmpeg (переменная FFMPEG или winget install Gyan.FFmpeg)');
	if (!tesseract) missing.push('tesseract с языками rus+eng (winget install UB-Mannheim.TesseractOCR)');
	if (missing.length) {
		throw new Error(`Для локального сканирования не хватает программ:\n  - ${missing.join('\n  - ')}`);
	}
	return { ytdlp, ffmpeg, tesseract };
}

/** Подобрать cookies, если указаны флагом или лежат в data/youtube-cookies.txt / на рабочем столе. */
export function resolveCookiesOption({ cookies = null, cookiesFromBrowser = null } = {}) {
	if (cookies === false || cookies === 'none') return { cookies: null, cookiesFromBrowser: null };
	if (cookies) return { cookies: path.resolve(String(cookies)), cookiesFromBrowser: null };
	if (cookiesFromBrowser) return { cookies: null, cookiesFromBrowser: String(cookiesFromBrowser) };
	const candidates = [
		path.join(root, 'data', 'youtube-cookies.txt'),
		path.join(os.homedir(), 'Desktop', 'YouTubecookies.txt'),
		path.join(os.homedir(), 'Desktop', 'youtube-cookies.txt'),
	];
	for (const p of candidates) {
		if (fs.existsSync(p)) return { cookies: p, cookiesFromBrowser: null };
	}
	return { cookies: null, cookiesFromBrowser: null };
}

/** Создать переиспользуемый контекст локального сканера (пул Tesseract + временная папка). */
export function createLocalScanner({ jobs = 8, cookies = null, cookiesFromBrowser = null } = {}) {
	const tools = detectLocalTools();
	// Если tesseract нашёлся по полному пути вне PATH, добавим его папку в PATH для src/twitch/ocr.js
	if (tools.tesseract !== 'tesseract') {
		const dir = path.dirname(tools.tesseract);
		if (!String(process.env.PATH || '').toLowerCase().includes(dir.toLowerCase())) {
			process.env.PATH = `${dir}${path.delimiter}${process.env.PATH || ''}`;
		}
	}
	const workers = Math.max(2, Math.min(10, Number(jobs) || Math.min(8, os.cpus().length)));
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-local-'));
	const ck = resolveCookiesOption({ cookies, cookiesFromBrowser });

	return {
		...tools,
		workers,
		tmp,
		cookies: ck.cookies,
		cookiesFromBrowser: ck.cookiesFromBrowser,
		cookiesCopy: null,
		cookiesSourceMtime: 0,
		recognize: ocrPool(workers),
		close: () => fs.rmSync(tmp, { recursive: true, force: true }),
	};
}

/**
 * Рабочая копия cookies-файла внутри tmp: yt-dlp перезаписывает файл из --cookies
 * после каждого запуска, поэтому отдаём ему копию (обновляя её, если пользователь
 * подложил свежий файл прямо во время прогона) — исходник на диске не портится.
 */
function workingCookiesFile(scanner) {
	if (!scanner.cookies) return null;
	try {
		const mtime = fs.statSync(scanner.cookies).mtimeMs;
		const copy = path.join(scanner.tmp, 'cookies.txt');
		if (!scanner.cookiesCopy || mtime !== scanner.cookiesSourceMtime || !fs.existsSync(copy)) {
			fs.copyFileSync(scanner.cookies, copy);
			scanner.cookiesCopy = copy;
			scanner.cookiesSourceMtime = mtime;
		}
		return copy;
	} catch {
		return scanner.cookies;
	}
}

/** Получить прямой URL видеопотока 720p MP4 через yt-dlp -g. */
async function resolveStreamUrl(videoId, scanner) {
	// Без --no-warnings: предупреждения идут в stderr (stdout с -g остаётся чистым URL),
	// зато при отказе видно настоящую причину (сбой JS-солвера EJS, SABR и т. п.).
	const args = ['-f', FORMAT_SELECTOR, '-g', '--no-playlist'];
	const ckFile = workingCookiesFile(scanner);
	if (ckFile) args.push('--cookies', ckFile);
	else if (scanner.cookiesFromBrowser) args.push('--cookies-from-browser', scanner.cookiesFromBrowser);
	args.push(`https://www.youtube.com/watch?v=${videoId}`);

	try {
		const { stdout } = await execFileAsync(scanner.ytdlp, args, {
			timeout: YTDLP_TIMEOUT_MS,
			windowsHide: true,
			maxBuffer: 1 << 20,
		});
		const url = String(stdout || '').trim().split(/\r?\n/).find(l => l.startsWith('http'));
		if (!url) throw new Error('yt-dlp не вернул URL потока');
		return url;
	} catch (err) {
		const stderr = String(err.stderr || '').trim();
		const msg = `${stderr} ${err.message || ''}`.trim();
		const rotated = /cookies are no longer valid|rotated in the browser/i.test(stderr);
		const ckNote = scanner.cookies
			? (rotated
				? `cookies в ${path.basename(scanner.cookies)} ротированы браузером — экспортируйте из окна инкогнито и закройте его`
				: `cookies в ${path.basename(scanner.cookies)} устарели или не авторизованы`)
			: (scanner.cookiesFromBrowser ? `cookies из ${scanner.cookiesFromBrowser} не прошли проверку` : null);
		if (/sign in to confirm your age|age[- ]restricted|inappropriate for some users/i.test(msg)) {
			throw new AgeRestrictedError(ckNote ? `видео 18+ (${ckNote})` : 'видео 18+ (нужны cookies или Gemini)');
		}
		if (/sign in to confirm you.{0,5}re not a bot|confirm you.{0,5}re not a bot/i.test(msg)) {
			throw new LocalBotCheckError(ckNote
				? `YouTube запросил проверку на бота (${ckNote} — обновите их или передайте --cookies-from-browser)`
				: 'YouTube запросил проверку на бота (передайте --cookies или --cookies-from-browser)');
		}
		if (/n challenge solving failed|Signature solving failed|addOnDisposeCallback|Only images are available for download/i.test(msg)) {
			const detail = stderr.split(/\r?\n/).find(l => /addOnDisposeCallback|challenge solving failed|Only images are available/i.test(l))?.slice(0, 180) || '';
			throw new LocalExtractorError(`yt-dlp не смог решить JS-челлендж YouTube (обновите yt-dlp / yt-dlp-ejs)${detail ? `: ${detail}` : ''}`);
		}
		if (/video unavailable|private video|has been removed|account associated|members-only|join this channel|premieres in/i.test(msg)) {
			const firstErr = stderr.split(/\r?\n/).find(l => /^ERROR:/i.test(l)) || msg.split(/\r?\n/)[0];
			throw new LocalVideoGoneError(firstErr.slice(0, 220));
		}
		const errLine = stderr.split(/\r?\n/).find(l => /^ERROR:/i.test(l))
			|| msg.split(/\r?\n/).filter(Boolean).slice(-1)[0]
			|| err.message;
		const wrapped = new Error(`yt-dlp: ${String(errLine || '').slice(0, 220)}`);
		if (/please sign in|requested format is not available/i.test(msg)) {
			wrapped.systemic = true;
		}
		throw wrapped;
	}
}

/** Выдернуть 1 кадр по времени t (в секундах) через Range-seek ffmpeg. */
async function grabYoutubeFrame(ffmpeg, streamUrl, t, png) {
	const args = [
		'-hide_banner', '-loglevel', 'error', '-y',
		'-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '3',
		'-ss', String(Math.max(0, Math.round(t))),
		'-i', streamUrl,
		'-frames:v', '1',
		'-vf', 'scale=1280:-2',
		png,
	];
	await execFileAsync(ffmpeg, args, { timeout: FFMPEG_TIMEOUT_MS, windowsHide: true });
	if (!fs.existsSync(png) || fs.statSync(png).size === 0) {
		throw new Error('ffmpeg не дал кадра');
	}
}

/** Опорные таймкоды near-паков (≥ 2 опознающих тем) для добора кадров. */
function nearDrillTimes(nearList, hits, duration) {
	const out = [];
	const offsets = [-45, 45, -90, 90, -150, 150];
	for (const n of nearList.slice(0, 2)) {
		const ts = [];
		for (const h of hits.values()) {
			if (!h.th.distinctive || !h.th.packs.includes(n.key)) continue;
			ts.push(h.first);
			if (h.last !== h.first) ts.push(h.last);
		}
		if (!ts.length) continue;
		ts.sort((a, b) => a - b);
		const mid = Math.round((ts[0] + ts[ts.length - 1]) / 2);
		for (const off of offsets) {
			const t = Math.min(duration - 15, Math.max(15, mid + off));
			out.push(t);
		}
	}
	return out;
}

/**
 * Просканировать одно YouTube-видео локально на ПК (yt-dlp + ffmpeg + tesseract).
 *
 * @param {object} video метаданные из api.js
 * @param {{ index, local: ReturnType<typeof createLocalScanner>, log?: Function }} ctx
 */
export async function scanYoutubeVideoLocal(video, ctx) {
	const started = Date.now();
	const scanner = ctx.local;
	const duration = Math.max(60, Math.floor(video.length || 0));

	// Явно помеченные 18+ ролики без cookies сразу отдаём наверх (гибрид передаст их Gemini,
	// а чистый --local пропустит без записи ошибки, чтобы не тратить 4 с на yt-dlp)
	if (video.ageRestricted && !scanner.cookies && !scanner.cookiesFromBrowser) {
		throw new AgeRestrictedError('видео 18+ (без cookies)');
	}

	let streamUrl;
	try {
		streamUrl = await resolveStreamUrl(video.id, scanner);
	} catch (err) {
		if (err instanceof LocalVideoGoneError) {
			return {
				status: 'restricted',
				engine: 'local',
				calls: 0,
				tokensIn: 0,
				frames: 0,
				signs: 0,
				planKey: LOCAL_PLAN_KEY,
				error: err.message,
				packs: [],
				near: [],
				names: [],
				inside: [],
				ms: Date.now() - started,
			};
		}
		throw err;
	}

	const frames = new Map();
	let errors = 0;
	let lastError = '';

	const shoot = async times => {
		const todo = [...new Set(times.map(Math.round))]
			.filter(t => !frames.has(t) && t >= 5 && t < duration - 5);
		if (!todo.length) return;
		let cursor = 0;
		const worker = async () => {
			while (cursor < todo.length) {
				const t = todo[cursor++];
				const png = path.join(scanner.tmp, `${video.id}_${t}.png`);
				try {
					await grabYoutubeFrame(scanner.ffmpeg, streamUrl, t, png);
					const tsv = await scanner.recognize(png);
					const lines = linesOf(tsv);
					const an = analyzeFrame(lines, ctx.index);
					frames.set(t, { t, matches: an.matches, names: an.names, sign: an.sign, words: frameWords(lines) });
				} catch (e) {
					errors++;
					lastError = e.message;
				} finally {
					fs.rmSync(png, { force: true });
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(scanner.workers, todo.length) }, worker));
	};

	// Этап 1. Быстрая разведка: 6 точек по всему ролику + до 2 глав из описания (~8–10 с)
	const probeTimes = PROBE_FRACTIONS.map(f => Math.min(duration - 15, Math.max(15, Math.round(duration * f))));
	const chapters = parseChapterTimestamps(video.description, duration).slice(0, 2);
	for (const c of chapters) {
		if (!probeTimes.some(p => Math.abs(p - c) < 90)) probeTimes.push(c);
	}
	await shoot(probeTimes);

	const probeSigns = [...frames.values()].filter(f => f.sign);
	if (probeSigns.length === 0 && frames.size >= 4) {
		ctx.log?.(`  [local] ранний выход на шуме (${frames.size} кадров, signs=0, ${Math.round((Date.now() - started) / 1000)} с)`);
		return {
			status: 'done',
			engine: 'local',
			calls: 0,
			tokensIn: 0,
			frames: frames.size,
			signs: 0,
			planKey: LOCAL_PLAN_KEY,
			packs: [],
			near: [],
			names: [],
			inside: [],
			errors,
			lastError,
			ms: Date.now() - started,
		};
	}

	// Этап 2. Плотная сетка (шаг 2 мин, как в Twitch, но с потолком MAX_LOCAL_FRAMES)
	// вокруг участков, где разведка увидела SIGame
	const probeGap = Math.max(STEP * 2, Math.round(duration * 0.18));
	const rawWindows = probeSigns.length
		? probeSigns.map(f => [Math.max(15, f.t - probeGap), Math.min(duration - 15, f.t + probeGap)])
		: [[15, duration - 15]];
	const windows = merge(rawWindows);
	const span = windows.reduce((a, [x, y]) => a + y - x, 0);
	const step = Math.max(STEP, Math.ceil(span / MAX_LOCAL_FRAMES / 30) * 30);
	await shoot(grid(windows, step));

	// Этап 3. Густое начало игры (экран названия пака) + точечный добор near ×2
	const openingTimes = openings([...frames].map(([t, f]) => [t, f.sign])).slice(0, MAX_OPENING_FRAMES);
	if (openingTimes.length) await shoot(openingTimes);

	let shot = [...frames.values()].sort((a, b) => a.t - b.t);
	let hits = collectHits(shot);
	let names = collectNames(shot);
	let verdict = judge(hits, ctx.index, names);

	const near2 = verdict.near.filter(n => n.themes >= 2);
	if (near2.length) {
		const extra = nearDrillTimes(near2, hits, duration).slice(0, 6);
		if (extra.length) {
			ctx.log?.(`  [local] добор ${extra.length} кадр. (near ×2: ${near2.slice(0, 2).map(n => `#${n.pack.id}`).join(', ')})`);
			await shoot(extra);
			shot = [...frames.values()].sort((a, b) => a.t - b.t);
			hits = collectHits(shot);
			names = collectNames(shot);
			verdict = judge(hits, ctx.index, names);
		}
	}

	const tried = shot.length + errors;
	if (tried >= 6 && errors > tried / 2 && verdict.packs.length === 0) {
		return {
			status: 'error',
			engine: 'local',
			calls: 0,
			tokensIn: 0,
			frames: shot.length,
			signs: shot.filter(f => f.sign).length,
			planKey: LOCAL_PLAN_KEY,
			error: `${errors} из ${tried} кадров не вышло: ${lastError}`,
			packs: [],
			near: verdict.near,
			names: verdict.names,
			inside: verdict.inside,
			hits,
			ms: Date.now() - started,
		};
	}

	for (const p of verdict.packs) {
		p.marks = marksOf(shot, p, themeWordsOf(ctx.index, p.key));
	}

	return {
		status: 'done',
		engine: 'local',
		calls: 0,
		tokensIn: 0,
		frames: shot.length,
		signs: shot.filter(f => f.sign).length,
		planKey: LOCAL_PLAN_KEY,
		packs: verdict.packs,
		near: verdict.near,
		names: verdict.names,
		inside: verdict.inside,
		hits,
		errors,
		lastError,
		ms: Date.now() - started,
	};
}
