// Замер: весь эталонный набор проходит через модель при каждом сочетании
// «размер пачки × разрешение», ответы ложатся в runs/<модель>_<N>_<разрешение>.json.
//
// Разметка владельца для этого не нужна — она нужна только счёту (score.js).
// Поэтому замер можно гнать, пока набор ещё размечается.
//
// Заодно меряется то, чего этап 0 померить не мог: как часто Gemini блокирует
// пачку встроенным фильтром. Заблокированная пачка делится пополам до одной
// картинки (nsfw-moderation.md, 7.4) — ровно так поступит конвейер, и сколько
// запросов на это уходит, тоже результат замера.
//
// Запуск продолжается с места остановки: ответ по картинке, уже лежащий
// в файле прогона, заново не спрашивается.

import fs from 'node:fs';
import { BATCH_SCHEMA, RUBRIC_VERSION, batchParts } from '../prompt.js';
import { askImages, requestsMade } from './gemini.js';
import { listRuns, loadRun, loadUnits, runFile, runsDir, unitJpeg, writeJson } from './store.js';

/** Токенов на картинку — замер этапа 0 (nsfw-moderation.md, раздел 12). */
const IMAGE_TOKENS = { low: 264, medium: 540, default: 1075 };

/** Порядок картинок в пачках: один и тот же у всех прогонов, вперемешку по корзинам. */
function ordered(units) {
	return [...units].sort((a, b) => a.sha256.slice(8).localeCompare(b.sha256.slice(8)));
}

/**
 * Одна пачка: спросить, разложить ответ по картинкам, заблокированную —
 * поделить и спросить половины.
 */
async function askBatch(model, batch, resolution, run, budget, depth = 0) {
	if (requestsMade(model) >= budget) {
		for (const unit of batch) {
			run.units[unit.id] = { skipped: 'кончился запас запросов' };
		}

		return false;
	}

	const images = batch.map(unit => ({ jpeg: unitJpeg(unit) }));
	const result = await askImages(model, batchParts(images), {
		schema: BATCH_SCHEMA,
		resolution,
		tokens: batch.length * IMAGE_TOKENS[resolution] + 2500,
	});

	run.requests.push({
		n: batch.length,
		depth,
		ms: result.ms,
		prompt: result.usage?.promptTokenCount ?? null,
		total: result.usage?.totalTokenCount ?? null,
		thoughts: result.usage?.thoughtsTokenCount ?? null,
		blocked: result.blocked ?? null,
		error: result.error ?? null,
	});

	if (result.quota) {
		return false;
	}

	if (result.blocked) {
		if (batch.length === 1) {
			run.units[batch[0].id] = { blocked: result.blocked };
			return true;
		}

		const middle = Math.ceil(batch.length / 2);

		return await askBatch(model, batch.slice(0, middle), resolution, run, budget, depth + 1)
			&& await askBatch(model, batch.slice(middle), resolution, run, budget, depth + 1);
	}

	if (result.error) {
		for (const unit of batch) {
			run.units[unit.id] = { error: result.error };
		}

		return true;
	}

	const rows = new Map((result.value.images ?? []).map(row => [row.n, row]));

	batch.forEach((unit, index) => {
		const row = rows.get(index + 1);

		run.units[unit.id] = row
			? { level: row.level, category: row.category, confidence: row.confidence, reason: row.reason ?? '', batch: batch.length }
			: { missing: true };
	});

	return true;
}

/**
 * Резал ли фильтр этой модели эту картинку в другом прогоне.
 * Свой прогон не в счёт; из чужих первым берётся тот, что на том же разрешении.
 */
function blockedBefore(model, id, self) {
	let found = null;

	for (const name of listRuns()) {
		const other = name === self ? null : loadRunCached(name);
		const answer = other?.model === model && other.rubric === RUBRIC_VERSION ? other.units[id] : null;

		if (answer?.blocked && (!found || name.endsWith(self.slice(self.lastIndexOf('_'))))) {
			found = { blocked: answer.blocked, resolution: other.resolution };
		}
	}

	return found;
}

/** Готовые прогоны читаются по разу на сочетание, а не на каждую картинку. */
const runCache = new Map();

function loadRunCached(name) {
	if (!runCache.has(name)) {
		runCache.set(name, loadRun(name));
	}

	return runCache.get(name);
}

async function measureModel(model, units, sizes, resolutions, budget, log) {
	for (const resolution of resolutions) {
		for (const size of sizes) {
			const name = `${model}_${size}_${resolution}`;
			runCache.clear();
			const saved = loadRun(name);

			const run = saved?.rubric === RUBRIC_VERSION
				? saved
				: { model, size, resolution, rubric: RUBRIC_VERSION, startedAt: Date.now(), units: {}, requests: [] };

			// Спрашивается то, на что нет ответа; ошибки и пропуски переспрашиваются
			const todo = units.filter(unit => {
				const known = run.units[unit.id];
				return !known || known.error || known.skipped || known.missing;
			});

			// Картинку, которую фильтр этой модели уже резал, в общую пачку класть
			// нельзя: она валит пачку целиком, и поиск её делением стоит десятка
			// запросов каждый раз. На том же разрешении блокировка просто
			// переносится из готового прогона — так же поступит и конвейер, у него
			// для этого кэш приговоров. На другом разрешении картинка
			// переспрашивается в одиночку: один запрос вместо десяти.
			const alone = [];

			for (const unit of [...todo]) {
				const before = blockedBefore(model, unit.id, name);

				if (!before) {
					continue;
				}

				todo.splice(todo.indexOf(unit), 1);

				if (before.resolution === resolution) {
					run.units[unit.id] = { blocked: before.blocked, carried: true };
				} else {
					alone.push(unit);
				}
			}

			for (const unit of alone) {
				if (!await askBatch(model, [unit], resolution, run, budget)) {
					writeJson(runFile(name), run);
					log(`${name}: остановлен на одиночных — запросов ${requestsMade(model)} из ${budget}`);
					return;
				}
			}

			writeJson(runFile(name), run);

			if (todo.length === 0) {
				log(`${name}: уже готов`);
				continue;
			}

			log(`${name}: ${todo.length} картинок, ${Math.ceil(todo.length / size)} пачек`);

			for (let i = 0; i < todo.length; i += size) {
				const alive = await askBatch(model, todo.slice(i, i + size), resolution, run, budget);
				writeJson(runFile(name), run);

				if (!alive) {
					log(`${name}: остановлен на ${i} из ${todo.length} — запросов ${requestsMade(model)} из ${budget}`);
					return;
				}
			}

			run.finishedAt = Date.now();
			writeJson(runFile(name), run);

			const blocked = run.requests.filter(request => request.blocked).length;
			log(`${name}: готов, запросов ${run.requests.length}, из них заблокировано ${blocked}`);
		}
	}
}

/**
 * @param {{models: string[], sizes: number[], resolutions: string[], budget: number}} options
 *   budget — потолок запросов на модель за этот запуск: суточных у бесплатного
 *   ключа пятьсот, и деление заблокированных пачек не должно съесть их все
 */
export async function measure({ models, sizes, resolutions, budget, log = console.log }) {
	const units = ordered(loadUnits());

	if (units.length === 0) {
		log('Набор пуст: сначала collect.');
		return;
	}

	fs.mkdirSync(runsDir, { recursive: true });
	log(`Набор: ${units.length} картинок. Модели: ${models.join(', ')}; пачки ${sizes.join('/')}; разрешения ${resolutions.join('/')}.`);

	await Promise.all(models.map(model => measureModel(model, units, sizes, resolutions, budget, line => log(`[${new Date().toTimeString().slice(0, 8)}] ${line}`))));
}
