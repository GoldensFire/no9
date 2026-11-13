// Распознавание кадра: Tesseract CLI, rus+eng, режим 11 («разреженный
// текст» — обычный не видит мелкую строку «Тема, цена»), по процессу
// на ядро и по потоку на процесс.
//
// Вывод — tsv: из него собираются строки с рамками, а по рамкам
// match.js склеивает перенесённые названия в ячейку табло.
//
// На раннере apt ставит быстрые модели (tessdata_fast): 0,73 с на кадр
// (twitch-streams.md, 3.6). Другие модели — переменной TESSDATA_DIR.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const run = promisify(execFile);

/** Строки из tsv Tesseract: текст и рамка. */
export function linesOfTsv(tsv) {
	const lines = new Map();
	for (const row of String(tsv).split('\n').slice(1)) {
		const c = row.split('\t');
		if (c.length < 12 || c[0] !== '5') continue;
		const text = c.slice(11).join('\t').trim();
		if (!text) continue;
		const key = `${c[1]}.${c[2]}.${c[3]}.${c[4]}`;
		const x0 = +c[6], y0 = +c[7], x1 = x0 + +c[8], y1 = y0 + +c[9];
		const l = lines.get(key);
		if (!l) lines.set(key, { words: [text], bbox: { x0, y0, x1, y1 } });
		else {
			l.words.push(text);
			l.bbox.x0 = Math.min(l.bbox.x0, x0); l.bbox.y0 = Math.min(l.bbox.y0, y0);
			l.bbox.x1 = Math.max(l.bbox.x1, x1); l.bbox.y1 = Math.max(l.bbox.y1, y1);
		}
	}
	return [...lines.values()].map(l => ({ text: l.words.join(' '), bbox: l.bbox }));
}

/** Строки из простого текста (старый кэш без рамок). */
export function linesOfText(text) {
	return String(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(text => ({ text }));
}

/** Строки из того, что лежит в кэше: tsv или текст. */
export function linesOf(raw) {
	return /^level\tpage_num/.test(raw) ? linesOfTsv(raw) : linesOfText(raw);
}

export function ocrWorkers() {
	return Math.max(1, Math.min(8, os.cpus().length));
}

/**
 * Очередь распознавания: не больше workers процессов разом.
 * @returns {(png: string) => Promise<string>} tsv
 */
export function ocrPool(workers = ocrWorkers()) {
	let active = 0;
	const waiting = [];
	const args = png => {
		const a = [png, 'stdout', '-l', 'rus+eng', '--psm', '11'];
		if (process.env.TESSDATA_DIR) a.push('--tessdata-dir', process.env.TESSDATA_DIR);
		return [...a, 'tsv'];
	};
	return async function recognize(png) {
		if (active >= workers) await new Promise(res => waiting.push(res));
		active++;
		try {
			const { stdout } = await run('tesseract', args(png), {
				env: { ...process.env, OMP_THREAD_LIMIT: '1' },
				maxBuffer: 1 << 24,
			});
			return stdout;
		} finally {
			active--;
			waiting.shift()?.();
		}
	};
}
