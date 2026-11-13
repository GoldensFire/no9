// Кадр записи по времени: начало сегмента Range-запросом → ffmpeg → PNG
// шириной 1280.
//
// Каждый сегмент Twitch начинается с ключевого кадра, и полмегабайта
// от начала (768 КБ у исходника 1080p) хватает на него всегда — проверено
// на семистах кадрах TwitchFinder (plan.md, 3.4). Если всё-таки не хватило,
// сегмент берётся целиком. У fMP4 перед сегментом нужен init — он один
// на запись.
//
// ffmpeg на раннере ставит задача (как в nightly.yml). Дома его можно
// показать переменной FFMPEG — полный путь к ffmpeg.exe.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { HEADERS } from './twitch.js';

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

async function fetchBytes(url, range) {
	for (let i = 1; ; i++) {
		try {
			const r = await fetch(url, { headers: range ? { ...HEADERS, Range: `bytes=0-${range - 1}` } : HEADERS });
			if (!r.ok) throw Object.assign(new Error(`сегмент: HTTP ${r.status}`), { final: r.status === 403 || r.status === 404 });
			return Buffer.from(await r.arrayBuffer());
		} catch (e) {
			if (e.final || i >= 3) throw e;
			await new Promise(res => setTimeout(res, 1500 * i));
		}
	}
}

async function decode(raw, png) {
	await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-frames:v', '1', '-vf', 'scale=1280:-2', png]);
	if (!fs.existsSync(png) || fs.statSync(png).size === 0) throw new Error('ffmpeg не дал кадра');
}

/**
 * @param {Awaited<ReturnType<import('./twitch.js').openMedia>>} media
 * @returns {Promise<{t:number, at:number, bytes:number}>} at — начало сегмента
 */
export async function grabFrame(media, t, png) {
	const seg = media.segs.findLast(s => s.t <= t) || media.segs[0];
	if (media.init && !media.initBytes) media.initBytes = await fetchBytes(media.init);
	const raw = png + (media.init ? '.mp4' : '.ts');
	const glue = buf => (media.init ? Buffer.concat([media.initBytes, buf]) : buf);
	let buf = await fetchBytes(seg.url, media.big ? 786432 : 524288);
	try {
		fs.writeFileSync(raw, glue(buf));
		try {
			await decode(raw, png);
		} catch {
			buf = await fetchBytes(seg.url);
			fs.writeFileSync(raw, glue(buf));
			await decode(raw, png);
		}
	} finally {
		fs.rmSync(raw, { force: true });
	}
	return { t, at: Math.round(seg.t), bytes: buf.length };
}
