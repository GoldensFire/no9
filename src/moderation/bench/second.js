// Замер второго взгляда (nsfw-moderation.md, раздел 6, шаг 6): каждую
// картинку, которую первый проход хоть раз назвал запрещённой или на которой
// споткнулся фильтр, модель смотрит одну, на обычном разрешении, с темой
// и вопросом. Ответы — second/<модель>.json, сводит их score.js.
//
// Первый проход и разметка владельца здесь только источник кандидатов:
// кандидаты берутся из прогонов текущей версии рубрики, так что сначала
// measure, потом second. Каждая модель смотрит всех кандидатов — кто чей
// второй взгляд, решает счёт, а не замер.
//
// Запуск продолжается с места остановки, как и measure.js.

import fs from 'node:fs';
import { RUBRIC_VERSION, SINGLE_SCHEMA, singleParts } from '../prompt.js';
import { askImages, requestsMade } from './gemini.js';
import { listRuns, loadRun, loadSecond, loadUnits, secondDir, secondFile, unitJpeg, writeJson } from './store.js';

/** Сказал ли первый проход «запрещено»: уровень или блокировка фильтром. */
export const saysProhibited = answer => Boolean(answer) && (Boolean(answer.blocked) || answer.level === 'prohibited');

/** Кандидаты второго взгляда: запрещённое хоть в одном прогоне текущей рубрики. */
export function candidates(units) {
	const runs = listRuns().map(loadRun).filter(run => run?.rubric === RUBRIC_VERSION);
	return units.filter(unit => runs.some(run => saysProhibited(run.units[unit.id])));
}

async function secondModel(model, todo, budget, log) {
	const saved = loadSecond(model);
	const run = saved?.rubric === RUBRIC_VERSION
		? saved
		: { model, rubric: RUBRIC_VERSION, resolution: 'default', startedAt: Date.now(), units: {}, requests: [] };

	const left = todo.filter(unit => {
		const known = run.units[unit.id];
		return !known || known.error;
	});

	log(`${model}: кандидатов ${todo.length}, спросить ${left.length}`);

	for (const unit of left) {
		if (requestsMade(model) >= budget) {
			log(`${model}: кончился запас запросов (${budget})`);
			break;
		}

		const result = await askImages(model, singleParts({ jpeg: unitJpeg(unit) }, unit), {
			schema: SINGLE_SCHEMA,
			resolution: 'default',
			tokens: 1075 + 2500,
		});

		run.requests.push({
			ms: result.ms,
			prompt: result.usage?.promptTokenCount ?? null,
			total: result.usage?.totalTokenCount ?? null,
			blocked: result.blocked ?? null,
			error: result.error ?? null,
		});

		if (result.quota) {
			writeJson(secondFile(model), run);
			log(`${model}: кончились сутки`);
			return;
		}

		run.units[unit.id] = result.blocked
			? { blocked: result.blocked }
			: result.error
				? { error: result.error }
				: { level: result.value.level, category: result.value.category, confidence: result.value.confidence, reason: result.value.reason ?? '' };

		writeJson(secondFile(model), run);
	}

	run.finishedAt = Date.now();
	writeJson(secondFile(model), run);
	log(`${model}: готов, запросов ${run.requests.length}`);
}

/** @param {{models: string[], budget: number}} options */
export async function second({ models, budget, log = console.log }) {
	const todo = candidates(loadUnits());

	if (todo.length === 0) {
		log(`Кандидатов нет: сначала measure на рубрике версии ${RUBRIC_VERSION}.`);
		return;
	}

	fs.mkdirSync(secondDir, { recursive: true });
	await Promise.all(models.map(model => secondModel(model, todo, budget, line => log(`[${new Date().toTimeString().slice(0, 8)}] ${line}`))));
}
