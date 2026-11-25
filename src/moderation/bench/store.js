// Где лежит эталонный набор и как он читается.
//
// Всё в data/moderation/bench — папка спрятана от гита целиком: в ней сами
// откровенные картинки. Три вещи, у каждой свой хозяин:
//
//   units.json   что в наборе — пишет сборщик (collect.js)
//   labels.json  что это на самом деле — пишет страница разметки (label.js),
//                то есть владелец руками
//   runs/*.json  что ответили модели первым проходом — пишет замер (measure.js)
//   second/*.json  что ответили вторым взглядом по одной картинке — second.js
//
// Сводит их score.js. Никто из троих чужое не правит.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const benchDir = path.join(root, 'data', 'moderation', 'bench');
export const unitsDir = path.join(benchDir, 'units');
export const runsDir = path.join(benchDir, 'runs');

const unitsFile = path.join(benchDir, 'units.json');
const labelsFile = path.join(benchDir, 'labels.json');

function readJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return fallback;
	}
}

/** Запись через временный файл: убитый посреди записи запуск набор не портит. */
export function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, '\t'));
	fs.renameSync(`${file}.tmp`, file);
}

export const loadUnits = () => readJson(unitsFile, []);
export const saveUnits = units => writeJson(unitsFile, units);

export const loadLabels = () => readJson(labelsFile, {});
export const saveLabels = labels => writeJson(labelsFile, labels);

export const unitJpeg = unit => fs.readFileSync(path.join(unitsDir, `${unit.id}.jpg`));

export const secondDir = path.join(benchDir, 'second');
export const secondFile = model => path.join(secondDir, `${model}.json`);
export const loadSecond = model => readJson(secondFile(model), null);

export const runFile = name => path.join(runsDir, `${name}.json`);
export const loadRun = name => readJson(runFile(name), null);
export const listRuns = () => (fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : [])
	.filter(name => name.endsWith('.json'))
	.map(name => name.slice(0, -5));
