// Страница разметки эталона: владелец смотрит картинку и одной клавишей
// говорит, что это. Слушает только этот компьютер — картинки в наборе
// откровенные, и в сеть им незачем.
//
// Разметка пишется на диск после каждого ответа (labels.json), так что
// закрыть вкладку можно в любой момент: продолжение — с первой неразмеченной.
//
// С disputes страница показывает только спорные картинки — где прогоны
// моделей в большинстве разошлись с разметкой по границе «запрещено — нет»
// (disputed в score.js), и под картинкой пишет, что сказали модели.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORY_LEVEL } from '../prompt.js';
import { disputed } from './score.js';
import { loadLabels, loadUnits, saveLabels, unitsDir } from './store.js';

const page = path.join(path.dirname(fileURLToPath(import.meta.url)), 'label.html');

/** Что значит каждая клавиша. Порядок — как на странице. */
const CHOICES = [
	{ key: '1', level: 'clean', category: 'none', title: 'Чисто' },
	{ key: '2', level: 'mature', category: 'suggestive', title: 'Этти, фансервис, бельё, откровенный косплей' },
	{ key: '3', level: 'mature', category: 'gore_fiction', title: 'Кровь и расчленёнка из игр, кино, аниме' },
	{ key: 'q', level: 'mature', category: 'other', title: 'Другое пограничное (наркотики, азарт)' },
	{ key: '4', level: 'prohibited', category: 'nudity', title: 'Нагота — настоящая или нарисованная, и с цензурой' },
	{ key: '5', level: 'prohibited', category: 'sex_act', title: 'Половой акт, хентай, порно' },
	{ key: '6', level: 'prohibited', category: 'minor_sexual', title: 'Сексуализация детской внешности' },
	{ key: '7', level: 'prohibited', category: 'gore_real', title: 'Настоящие трупы, увечья, смерть' },
	{ key: '8', level: 'prohibited', category: 'hate', title: 'Символика и слова ненависти' },
	{ key: '9', level: 'prohibited', category: 'other', title: 'Другое запрещённое' },
	{ key: '0', level: 'skip', category: 'none', title: 'Не разобрать / пропустить' },
].map(choice => ({ ...choice, level: choice.level === 'skip' ? 'skip' : (CATEGORY_LEVEL[choice.category] ?? choice.level) }));

function send(response, status, body, type = 'application/json; charset=utf-8') {
	response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
	response.end(body);
}

export function serveLabels(port, { disputes = false } = {}) {
	const labels = loadLabels();
	const units = disputes ? disputed(loadUnits(), labels) : loadUnits();
	const byId = new Map(units.map(unit => [unit.id, unit]));

	// Порядок показа — вперемешку по номеру, а не корзинами: сорок «18+» подряд
	// сбивают глаз, и сорок первая чистая кажется чище, чем есть
	const order = [...units].sort((a, b) => a.id.localeCompare(b.id)).map(unit => unit.id);

	const server = http.createServer((request, response) => {
		const url = new URL(request.url, 'http://localhost');

		if (request.method === 'GET' && url.pathname === '/') {
			return send(response, 200, fs.readFileSync(page), 'text/html; charset=utf-8');
		}

		if (request.method === 'GET' && url.pathname === '/api/state') {
			return send(response, 200, JSON.stringify({
				choices: CHOICES,
				units: order.map(id => byId.get(id)),
				labels,
			}));
		}

		if (request.method === 'GET' && url.pathname.startsWith('/unit/')) {
			const id = url.pathname.slice(6).replace(/[^0-9a-f]/g, '');
			const file = path.join(unitsDir, `${id}.jpg`);

			return fs.existsSync(file)
				? send(response, 200, fs.readFileSync(file), 'image/jpeg')
				: send(response, 404, '{}');
		}

		if (request.method === 'POST' && url.pathname === '/api/label') {
			let body = '';

			request.on('data', chunk => { body += chunk; });
			request.on('end', () => {
				try {
					const { id, key } = JSON.parse(body);
					const choice = CHOICES.find(item => item.key === key);

					if (!byId.has(id) || (key !== null && !choice)) {
						return send(response, 400, '{"error":"нет такой картинки или клавиши"}');
					}

					if (key === null) {
						delete labels[id];
					} else {
						labels[id] = { level: choice.level, category: choice.category, at: Date.now() };
					}

					saveLabels(labels);
					send(response, 200, JSON.stringify({ done: Object.keys(labels).length }));
				} catch (error) {
					send(response, 400, JSON.stringify({ error: String(error.message) }));
				}
			});

			return undefined;
		}

		return send(response, 404, '{}');
	});

	server.listen(port, '127.0.0.1', () => {
		console.log(disputes
			? `Спорные картинки эталона: http://localhost:${port} — ${units.length} штук.`
			: `Разметка эталона: http://localhost:${port} — ${units.length} картинок, размечено ${Object.keys(labels).length}.`);
	});
}
