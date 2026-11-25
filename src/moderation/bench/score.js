// Счёт: ответы моделей против разметки владельца.
//
// Главное число — полнота по запрещённому: какую долю картинок, которые
// владелец назвал prohibited, модель вообще заметила (поставила mature или
// prohibited). Первый проход только отбирает кандидатов, уровень решает второй
// взгляд — поэтому «заметила» важнее, чем «угадала уровень». Заблокированная
// фильтром картинка считается замеченной: для конвейера блокировка — находка.
//
// Цена полноты — сколько чистого уехало в кандидаты («лишние»): каждая такая
// картинка стоит запроса второго взгляда.
//
// Второй взгляд (second.js) считается отдельно: пак получает prohibited,
// только когда «запрещено» сказали и первый проход, и второй взгляд. Здесь
// цена ошибки обратная — лишний prohibited уедет на сайт значком.

import { CATEGORY_RU, RUBRIC_VERSION, sayRu } from '../prompt.js';
import { listRuns, loadLabels, loadRun, loadSecond, loadUnits } from './store.js';

/** Прогоны первого прохода на текущей рубрике; старые лежат в runs/v1 и не видны. */
const currentRuns = () => listRuns().map(loadRun)
	.filter(run => run?.rubric === RUBRIC_VERSION)
	.sort((a, b) => a.model.localeCompare(b.model) || a.resolution.localeCompare(b.resolution) || a.size - b.size);

/** «Запрещено» первого прохода или второго взгляда: уровень или блокировка. */
const saysProhibited = answer => Boolean(answer) && (Boolean(answer.blocked) || answer.level === 'prohibited');

/** Ответы второго взгляда на текущей рубрике — по модели. */
const currentSeconds = models => models.map(loadSecond).filter(second => second?.rubric === RUBRIC_VERSION);

/**
 * Спорные картинки: где не меньше половины прогонов первого прохода — или все
 * вторые взгляды — разошлись с владельцем по границе «запрещено — нет». Их
 * страница разметки показывает отдельно (label --disputes) вместе с тем, что
 * сказали модели.
 */
export function disputed(units, labels) {
	const runs = currentRuns();
	const seconds = currentSeconds([...new Set(runs.map(run => run.model))]);

	return units.flatMap(unit => {
		const truth = labels[unit.id];

		if (!truth || truth.level === 'skip' || runs.length === 0) {
			return [];
		}

		const isAgainst = answer => saysProhibited(answer) !== (truth.level === 'prohibited');
		const answers = runs.map(run => run.units[unit.id]).filter(answer => answer && (answer.blocked || answer.level));
		const against = answers.filter(isAgainst);
		const looks = seconds.map(second => [second.model, second.units[unit.id]])
			.filter(([, answer]) => answer && (answer.blocked || answer.level));
		const looksAgainst = looks.length > 0 && looks.every(([, answer]) => isAgainst(answer));

		if (against.length * 2 < answers.length && !looksAgainst) {
			return [];
		}

		const said = {};

		for (const answer of against) {
			const name = answer.blocked ? 'фильтр Google' : (CATEGORY_RU[answer.category] ?? answer.category);
			said[name] = (said[name] ?? 0) + 1;
		}

		const second = looks.map(([model, answer]) => `${model.replace('gemini-', '')}: ${answer.blocked ? 'фильтр Google' : `${sayRu(answer)} — ${answer.reason}`}`);

		return [{
			...unit,
			models: [
				`у вас: ${sayRu(truth)}; первый проход: ${against.length} из ${answers.length} не согласны${against.length ? ` (${Object.entries(said).map(([name, count]) => `${name} ${count}`).join(', ')})` : ''}`,
				...second.map(line => `второй взгляд ${line}`),
			].join('; '),
		}];
	});
}

const share = (part, whole) => (whole > 0 ? `${Math.round((100 * part) / whole)} %` : '—');

/** Заметила ли модель картинку: любой не-clean ответ или блокировка. */
const flagged = answer => Boolean(answer) && (Boolean(answer.blocked) || (answer.level && answer.level !== 'clean'));

/** Есть ли по картинке ответ вообще (не ошибка и не пропуск). */
const answered = answer => Boolean(answer) && (Boolean(answer.blocked) || Boolean(answer.level));

function scoreRun(run, units, labels) {
	const row = {
		prohibited: 0, prohibitedHit: 0, prohibitedExact: 0,
		mature: 0, matureHit: 0,
		clean: 0, cleanFlagged: 0,
		unanswered: 0, blockedUnits: 0,
		missed: [],
	};

	for (const unit of units) {
		const truth = labels[unit.id];
		const answer = run.units[unit.id];

		if (!truth || truth.level === 'skip') {
			continue;
		}

		if (!answered(answer)) {
			row.unanswered++;
			continue;
		}

		row.blockedUnits += answer.blocked ? 1 : 0;

		if (truth.level === 'prohibited') {
			row.prohibited++;
			row.prohibitedHit += flagged(answer) ? 1 : 0;
			row.prohibitedExact += answer.blocked || answer.level === 'prohibited' ? 1 : 0;

			if (!flagged(answer)) {
				row.missed.push(`${unit.id} (${CATEGORY_RU[truth.category] ?? truth.category})`);
			}
		} else if (truth.level === 'mature') {
			row.mature++;
			row.matureHit += flagged(answer) ? 1 : 0;
		} else {
			row.clean++;
			row.cleanFlagged += flagged(answer) ? 1 : 0;
		}
	}

	return row;
}

export function score({ log = console.log } = {}) {
	const units = loadUnits();
	const labels = loadLabels();
	const judged = units.filter(unit => labels[unit.id] && labels[unit.id].level !== 'skip');

	const counts = { clean: 0, mature: 0, prohibited: 0 };
	const byCategory = {};

	for (const unit of judged) {
		counts[labels[unit.id].level]++;

		if (labels[unit.id].level !== 'clean') {
			byCategory[CATEGORY_RU[labels[unit.id].category] ?? labels[unit.id].category] = (byCategory[CATEGORY_RU[labels[unit.id].category] ?? labels[unit.id].category] ?? 0) + 1;
		}
	}

	log(`Набор: ${units.length}, размечено ${judged.length} — чисто ${counts.clean}, пограничное ${counts.mature}, запрещено ${counts.prohibited}.`);
	log(`Нарушения по категориям: ${Object.entries(byCategory).map(([name, count]) => `${name} ${count}`).join(', ') || '—'}`);

	const runs = currentRuns();
	log(`Рубрика версии ${RUBRIC_VERSION}, прогонов на ней ${runs.length}.`);

	log('');
	log('| модель | разрешение | пачка | запросов | блокировок | токенов на картинку | запрещённое: замечено | из них уровень верный | пограничное: замечено | чистое в кандидатах | без ответа |');
	log('|---|---|---|---|---|---|---|---|---|---|---|');

	const misses = [];

	for (const run of runs) {
		const row = scoreRun(run, units, labels);
		const clean = run.requests.filter(request => !request.blocked && !request.error && request.prompt);
		const perImage = clean.length > 0
			? Math.round(clean.reduce((sum, request) => sum + request.total, 0) / clean.reduce((sum, request) => sum + request.n, 0))
			: null;

		log(`| ${run.model} | ${run.resolution} | ${run.size} | ${run.requests.length} | ${run.requests.filter(request => request.blocked).length} | ${perImage ?? '—'} | ${row.prohibitedHit}/${row.prohibited} (${share(row.prohibitedHit, row.prohibited)}) | ${share(row.prohibitedExact, row.prohibitedHit)} | ${row.matureHit}/${row.mature} (${share(row.matureHit, row.mature)}) | ${row.cleanFlagged}/${row.clean} (${share(row.cleanFlagged, row.clean)}) | ${row.unanswered} |`);

		if (row.missed.length > 0) {
			misses.push(`${run.model} ${run.resolution} N=${run.size}: ${row.missed.join(', ')}`);
		}
	}

	if (misses.length > 0) {
		log('');
		log('Пропущенное запрещённое (номер картинки — файл в data/moderation/bench/units):');
		misses.forEach(line => log(`  ${line}`));
	}

	scoreSecond(runs, units, labels, log);
}

/**
 * Первый проход + второй взгляд: что останется prohibited. Строка — пара
 * «прогон первого прохода → модель второго взгляда». Блокировка на втором
 * взгляде — отдельный столбец: решать её будет человек или правило.
 */
function scoreSecond(runs, units, labels, log) {
	const seconds = currentSeconds([...new Set(runs.map(run => run.model))]);

	if (seconds.length === 0) {
		return;
	}

	log('');
	log('Второй взгляд: «запрещено», только если «запрещено» сказали и первый проход, и второй взгляд.');
	log('');
	log('| первый проход | второй взгляд | запрещённое осталось | ушло в пограничное | ушло в чистое | фильтр на втором | лишних «запрещено»: из пограничного | из чистого | без ответа |');
	log('|---|---|---|---|---|---|---|---|---|');

	const lost = [];

	for (const run of runs) {
		for (const second of seconds) {
			const row = { truth: 0, kept: 0, toMature: 0, toClean: 0, blocked: 0, extraMature: 0, extraClean: 0, unanswered: 0 };

			for (const unit of units) {
				const truth = labels[unit.id];

				if (!truth || truth.level === 'skip') {
					continue;
				}

				row.truth += truth.level === 'prohibited' ? 1 : 0;

				if (!saysProhibited(run.units[unit.id])) {
					continue;
				}

				const answer = second.units[unit.id];

				if (!answer || answer.error) {
					row.unanswered++;
					continue;
				}

				if (answer.blocked) {
					row.blocked++;
					continue;
				}

				if (truth.level === 'prohibited') {
					if (answer.level === 'prohibited') {
						row.kept++;
					} else {
						row[answer.level === 'mature' ? 'toMature' : 'toClean']++;
						lost.push(`${second.model}: ${unit.id} (${CATEGORY_RU[truth.category] ?? truth.category}) — ${sayRu(answer)}, «${answer.reason}»`);
					}
				} else if (answer.level === 'prohibited') {
					row[truth.level === 'mature' ? 'extraMature' : 'extraClean']++;
				}
			}

			log(`| ${run.model} ${run.resolution} N=${run.size} | ${second.model} | ${row.kept}/${row.truth} | ${row.toMature} | ${row.toClean} | ${row.blocked} | ${row.extraMature} | ${row.extraClean} | ${row.unanswered} |`);
		}
	}

	if (lost.length > 0) {
		log('');
		log('Запрещённое, которое второй взгляд отпустил:');
		[...new Set(lost)].forEach(line => log(`  ${line}`));
	}
}
