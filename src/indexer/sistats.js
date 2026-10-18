// Статистика и сложность с сервиса SIGame (vladimirkhil.com/sistatistics).
//
// Единственное о паке, что не выводится из самого файла: сколько раз в него
// играли и как в этих играх отвечали. Отсюда же берётся уровень сложности —
// он считается по доле взятых вопросов, а её знает только сервис.
//
// Название файла нарочно не stats.js: рядом лежит src/stats.js, и это разные
// вещи — там правила счёта, здесь шаг обхода, который эти правила зовёт.

import { config } from '../config.js';
import { db } from '../db.js';
import { fetchPackageStats, summarize, themeStats, toLevel } from '../stats.js';
import { drain, sleep } from './pipeline.js';
import { say } from './progress.js';
import { queueNote, targetSql } from './queue.js';
import { upsertStats } from './store.js';

/**
 * Статистика и сложность с сервиса SIGame.
 *
 * Шага этого два, и это не удвоение, а разные вопросы. Полный обход спрашивает
 * заново про все пять тысяч паков: числа игр живут своей жизнью, и обновлять их
 * надо целиком, иначе позавчерашняя сложность так и останется позавчерашней.
 * Стоит он полчаса и пять тысяч запросов к чужому сервису.
 *
 * Второй спрашивает только про тех, у кого статистики нет вовсе, — про паки,
 * добавленные этой ночью. Это десятки запросов вместо тысяч, и после разбора
 * новых паков нужен обычно именно он: у остальных числа и так вчерашние.
 *
 * @param {'all'|'new'} scope
 */
export async function refreshStats(scope = 'all') {
	const step = scope === 'new' ? 'statsnew' : 'stats';

	// «Только новые» — это те, кого ни разу не спрашивали. Пак, про который сервис
	// ответил «не знаю» (found = 0), новым уже не считается: строка у него есть,
	// и переспрашивать его каждую ночь означало бы вечную очередь из тех, кого
	// статистика не знает и знать не будет.
	const fresh = scope === 'new'
		? 'AND NOT EXISTS (SELECT 1 FROM stats s WHERE s.package_id = p.id)'
		: '';

	const target = targetSql();

	const pending = db.prepare(`
		SELECT p.id, p.name, p.authors
		FROM packages p
		WHERE p.status = 'ok' AND p.name IS NOT NULL ${fresh}${target.where}
		ORDER BY p.id
	`);

	const params = target.params;

	// Раунды и число тёзок — по одному паку, на месте, а не в общем списке выше:
	// раунды с образцами тем весят по десятку килобайт на пак, и список на пять
	// тысяч паков, который drain перечитывает, тащил бы их все разом
	const layout = db.prepare('SELECT rounds, stats_twins FROM packages WHERE id = ?');

	const statsJobs = Math.max(1, config.statsJobs);

	say(step, `запрашиваю ${pending.all(...params).length} паков${scope === 'new' ? ' без статистики' : ''}`
		+ `${queueNote(false)}, по ${statsJobs} разом`);

	let found = 0;
	let rated = 0;

	await drain({
		step,
		jobs: statsJobs,
		take: () => pending.all(...params),
		work: async (row, bar) => {
			const authors = JSON.parse(row.authors);

			try {
				const raw = await fetchPackageStats(row.name, authors);

				if (!raw) {
					upsertStats.run(row.id, 0, 0, 0, 0, 0, 0, null, null, null, 0, Date.now(), null);
				} else {
					const summary = summarize(raw);
					const level = toLevel(summary);

					if (level !== null) {
						rated++;
					}

					found++;

					// По темам — только у пака, которому статистика принадлежит одному.
					// У тёзок она общая на всех (см. stats_twins в src/db.js), и места
					// «раунд:тема» в ней — от разных файлов сразу
					const own = layout.get(row.id);
					const themes = own && own.stats_twins <= 1
						? themeStats(raw, JSON.parse(own.rounds ?? '[]'))
						: null;

					upsertStats.run(
						row.id,
						summary.startedGames,
						summary.completedGames,
						summary.shown,
						summary.answered,
						summary.correct,
						summary.wrong,
						summary.rightPercent,
						summary.takePercent,
						level,
						1,
						Date.now(),
						themes ? JSON.stringify(themes) : null,
					);
				}
			} catch (error) {
				say(step, `${row.name}: ${error.message}`);
			}

			if (bar.milestone(100)) {
				say(step, bar.line);
			}

			await sleep(config.statsDelayMs);
		},
	});

	say(step, `статистика найдена у ${found} паков, оценку сложности получили ${rated}.`);
}
