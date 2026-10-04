// Досчёт того, чего у старых паков нет: отпечатки вопросов, длительность медиа,
// спецвопросы, следы SI-HYX.
//
// Все три считает разбор — но только новым пакам. Паку, разобранному до того,
// как правило появилось, переразбор не нужен: он переписал бы заодно и всё
// остальное, потратив на это полный проход по библиотеке. Поэтому шаги здесь
// читают из архива ровно то, чего не хватает, и заканчиваются насовсем —
// очередь у них конечная и с каждой ночью короче.

import { db } from '../db.js';
import { openRemoteZip } from '../zip.js';
import { parseContentXml } from '../siq.js';
import { PRINTS_VERSION } from '../plagiarism.js';
import { measureMedia } from '../duration.js';
import { hyxDetail, hyxFiles } from '../hyx.js';
import { force, jobs, reprints } from './options.js';
import { buryDeadLink, drain, retryNetwork, withFreshUrl } from './pipeline.js';
import { say } from './progress.js';
import { queueNote, targetSql } from './queue.js';
import { isChosen } from './steps.js';
import { storeDurations, storePrints, storeRounds, updateHyx, updateSpecials } from './store.js';

/**
 * Досчитывает отпечатки вопросов у паков, разобранных до того, как их научились
 * считать.
 *
 * ————— зачем этот шаг вообще есть —————
 *
 * Плагиат ищется по вопросам: совпал текст вопроса, имя приложенного файла
 * и ответ — это тот же самый вопрос (см. src/plagiarism.js). Сами тексты
 * в базе не хранятся, хранится восьмибайтный отпечаток, и считает его разбор
 * пака заодно со всем остальным. Но библиотека разобрана давно, а отпечатков
 * тогда не считал никто — и без этого шага правило было бы слепым ко всей
 * старой базе, то есть ко всей базе.
 *
 * ————— почему это не «переразобрать библиотеку» —————
 *
 * Потому что качается не пак, а один файл из него. src/zip.js читает архив
 * range-запросами: оглавление, потом нужная запись, — и content.xml выходит
 * около семи килобайт при паке в сорок мегабайт. На всю базу это порядка
 * семидесяти мегабайт и два запроса на пак вместо полной закачки, которая
 * шла бы сотнями гигабайт. Ровно так же ходит соседний шаг спецвопросов.
 *
 * ————— почему шаг обязан идти следом за обходом обсуждений —————
 *
 * Ссылки ВК на документы подписаны и живут недолго, а обновляет их только
 * полный обход темы (см. refreshLink в syncComment). Страховки на этот случай
 * нет: docs.getById чужие документы не отдаёт вовсе — ни с сервисным ключом,
 * ни с пользовательским, ни даже с access_key. Значит, отпечатки собираются
 * в ту же ночь, что и обход, — иначе половина ссылок окажется мёртвой
 * (см. REST_STEPS в scripts/nightly.js).
 *
 * Пак берётся в очередь, когда отпечатков у него нет вовсе или когда они
 * старше его разбора: перезалитый файл — это другие вопросы.
 *
 * ————— и заодно: много ли в паке чужих ссылок —————
 *
 * Тем же разбором и из того же content.xml считается, сколько показываемого
 * лежит в самом паке, а сколько — на чужом сервере (см. countMediaRefs
 * в src/siq.js). Числа эти появились позже, чем библиотеку сняли нынешним
 * видом отпечатка, и потому их нет почти ни у кого: очередь отпечатков к тому
 * времени опустела, а без неё считать их было некому.
 *
 * Считать их важно: с половины пак с сайта убирается совсем — половина вопросов
 * не показывает ничего, и за столом такой пак не играется (см. recalcOffsite
 * в src/indexer/recalc.js). Пока числа не сняты, правило слепо, и пак 4003
 * с его 593 пустыми экранами стоит в выдаче наравне с живыми.
 *
 * Поэтому пак без этих чисел встаёт в ту же очередь. Отпечатки при этом
 * переснимаются заново и выходят те же самые — байт в байт, — и это не работа
 * впустую: работа тут одна, скачать оглавление архива и content.xml, а из неё
 * выходят оба ответа сразу.
 *
 * Спрятанные копии (status = 'copy') идут наравне с живыми паками, и это не
 * щедрость. Копией пак объявляется по совпадению отпечатков (см. markCopies в src/indexer/copies.js),
 * а отпечатки, снятые по разным правилам, не совпадают ни у кого: оставь мы
 * копии без пересъёмки — и на следующем же шаге каждая из них перестала бы
 * быть копией и вернулась в библиотеку, чтобы через ночь спрятаться опять.
 */
export async function fetchPrints() {
	const target = targetSql();
	// Свёртка прежнего вида — тоже очередь. Без веса файлов правило работает
	// ровно как работало, просто не умеет отменять совпадение имени при разном
	// файле, — а вот до третьего вида оно ещё и находило лишнее: вопрос
	// из одного имени файла, без текста и без ответа, совпадал с таким же
	// в чужом паке и шёл в улики (см. MUTE и PRINTS_VERSION в src/plagiarism.js).
	// Пока свёртка не переснята, такие находки у пака остаются
	// Сюда же попадает и пак, у которого не посчитано, много ли в нём чужих
	// ссылок (media_offsite IS NULL), — и это не второе дело шага, а то же самое.
	// Оба числа выходят из одного разбора одного и того же content.xml
	// (см. parseContentXml и storeRounds), и завести ради второго свой шаг
	// значило бы качать те же семь килобайт из тех же одиннадцати тысяч
	// архивов второй раз.
	const missing = reprints
		? ''
		: ' AND (q.package_id IS NULL OR q.parsed_at IS NULL OR q.parsed_at < COALESCE(p.indexed_at, 0)'
			+ ` OR COALESCE(q.version, 1) < ${PRINTS_VERSION} OR p.media_offsite IS NULL)`;

	const pending = db.prepare(`
		SELECT p.id, p.url, p.file_name, p.source_key, p.name, p.theme_count FROM packages p
		LEFT JOIN pack_prints q ON q.package_id = p.id
		WHERE (p.status = 'ok' OR p.status = 'copy')${missing}${target.where}
		ORDER BY p.id
	`);

	const params = target.params;
	const waiting = pending.all(...params).length;

	say('prints', `${reprints ? `переснимаю отпечатки у ${waiting} паков`
		: `отпечатков вопросов или счёта чужих ссылок нет у ${waiting} паков`}`
		+ `${queueNote(false)}${jobs > 1 ? `, по ${jobs} разом` : ''}`);

	let ok = 0;
	let failed = 0;
	let dead = 0;
	let questions = 0;
	// Паки, у которых после разбора стало другое число тем: у них сброшена
	// разметка, и следующий шаг модели разберёт их заново (см. storeRounds в src/indexer/store.js)
	let retopic = 0;

	await drain({
		step: 'prints',
		jobs,
		take: () => pending.all(...params),
		work: async (row, bar) => {
			try {
				const parsed = await retryNetwork(() => withFreshUrl(row, async url => {
					const archive = await openRemoteZip(url);
					const entry = archive.find('content.xml');

					if (!entry) {
						throw new Error('в архиве нет content.xml');
					}

					return parseContentXml(await archive.read(entry), archive.mediaSizes());
				}));

				questions += storePrints(row.id, parsed.questions);

				// Раунды пишутся тем же разбором: у пака со смесью названных
				// и безымянных тем номера тем теперь другие, и старые раунды
				// рядом с новыми отпечатками показывали бы улику на чужой теме
				if (storeRounds(row, parsed)) {
					retopic++;
				}

				ok++;
			} catch (error) {
				// Документа в ВК больше нет: пак хоронится, а не переспрашивается
				// каждую ночь до скончания века (см. buryDeadLink в pipeline.js)
				if (buryDeadLink(row, error)) {
					dead++;
				} else {
					failed++;
				}

				say('prints', `${row.name ?? row.file_name}: ${error.message}`);
			}

			if (bar.milestone(100)) {
				say('prints', bar.line);
			}
		},
	});

	say('prints', `сняты у ${ok} паков, вопросов в них ${questions}`
		+ `${dead ? `, похоронено по мёртвой ссылке ${dead}` : ''}, ошибок ${failed}.`);

	if (retopic > 0) {
		say('prints', `у ${retopic} паков стало другое число тем — обычно это темы без названия, `
			+ 'которых прежний разбор не видел вовсе. Разметка у них сброшена: '
			+ 'считалась она по неполному набору тем.');
	}

	// Снятый отпечаток обесценивает все уже вынесенные приговоры: пак, который
	// час назад был для правила пуст, теперь и донор, и подозреваемый сразу для
	// всей библиотеки. Пока шаг об этом молчал, ровно это и случилось — отпечатки
	// сняли отдельным запуском, плагиат пересмотреть забыли, и списанные слово
	// в слово темы месяц стояли неотмеченными. Сам себя следующий шаг позвать
	// не может (шаги выбирает человек), но сказать вслух — обязан
	if (ok > 0 && !isChosen('plagiarism')) {
		say('prints', 'приговоры плагиата теперь устарели: судили без этих отпечатков. '
			+ 'Нужен шаг «Плагиат» (--plagiarism) — он идёт по базе и укладывается в секунды.');
	}
}

/**
 * Меряет, сколько тянется медиа в паках: среднее по файлам и самый длинный.
 *
 * ————— зачем —————
 *
 * Число вопросов не говорит, на сколько пак: сотня вопросов бывает и на два
 * часа, и на пять. Разницу делает длина куска — тема из шести песен по полторы
 * минуты идёт девять минут одна, и пак из тридцати таких тем за вечер
 * не проходят никогда. Среднее отвечает на «сколько тянется вопрос», самое
 * длинное — на «нет ли там целой серии» (см. src/duration.js).
 *
 * ————— почему это не «скачать пак» —————
 *
 * Длительность лежит в заголовке файла, то есть в первых его килобайтах:
 * MP3 говорит битрейт, MP4 — прямое число, WAV — размер куска данных. Поэтому
 * с каждого медиафайла берётся начало на двенадцать килобайт, изредка ещё
 * и конец, — а не сам файл. На пак с полусотней песен это меньше мегабайта
 * вместо трёхсот.
 *
 * Дорог тут не трафик, а походы: составной range-запрос, которым все эти
 * начала брались бы разом, ВК понимает только на нескольких килобайтах
 * и на большем рвёт соединение (см. fetchRanges в src/zip.js). Значит, поход
 * на файл — то есть шаг этот из всех самый долгий, и по умолчанию он не идёт.
 * Зато идти ему надо один раз: новый пак меряется вместе со своим разбором,
 * а перемеривать неизменившийся незачем.
 *
 * ————— почему шаг обязан идти следом за обходом обсуждений —————
 *
 * По той же причине, что и отпечатки: ссылки ВК на документы подписаны и живут
 * недолго, а обновляет их только полный обход темы. Страховки нет —
 * docs.getById чужие документы не отдаёт вовсе (см. fetchPrints).
 */
export async function fetchDurations() {
	const target = targetSql();
	const missing = force
		? ''
		: ' AND (p.media_at IS NULL OR p.media_at < COALESCE(p.indexed_at, 0))';

	const pending = db.prepare(`
		SELECT p.id, p.url, p.file_name, p.source_key, p.name FROM packages p
		WHERE p.status = 'ok'${missing}${target.where}
		ORDER BY p.id
	`);

	const params = target.params;
	const waiting = pending.all(...params).length;

	say('durations', `не мерена длительность у ${waiting} паков${queueNote(false)}`
		+ `${jobs > 1 ? `, по ${jobs} разом` : ''}`);

	let ok = 0;
	let failed = 0;
	let dead = 0;
	let withMedia = 0;
	let files = 0;

	await drain({
		step: 'durations',
		jobs,
		take: () => pending.all(...params),
		work: async (row, bar) => {
			try {
				const media = await retryNetwork(() => withFreshUrl(row, async url => measureMedia(await openRemoteZip(url))));

				storeDurations(row.id, media);
				ok++;

				if (media.files > 0) {
					withMedia++;
					files += media.files;
					say('durations', `${bar.label()} ${row.name ?? row.file_name}: `
						+ `${media.files} из ${media.total} файлов, в среднем ${Math.round(media.average)} с, `
						+ `самый длинный ${Math.round(media.longest)} с`);
				}
			} catch (error) {
				if (buryDeadLink(row, error)) {
					dead++;
				} else {
					failed++;
				}

				say('durations', `${row.name ?? row.file_name}: ${error.message}`);
			}

			if (bar.milestone(25)) {
				say('durations', bar.line);
			}
		},
	});

	say('durations', `померено у ${ok} паков, из них с медиа ${withMedia}, файлов в них ${files}`
		+ `${dead ? `, похоронено по мёртвой ссылке ${dead}` : ''}, ошибок ${failed}.`);
}

/**
 * Следы SI-HYX у паков, разобранных до того, как их научились искать.
 *
 * Читается одно оглавление архива — имена файлов, больше ничего (см. src/hyx.js):
 * это самый дешёвый из здешних шагов, один-два range-запроса на пак. Подписи
 * берутся из базы, а не из content.xml: разбор их уже записал.
 */
export async function fetchHyx() {
	const target = targetSql();
	const missing = force ? '' : ' AND p.hyx_files IS NULL';

	const pending = db.prepare(`
		SELECT p.id, p.url, p.file_name, p.source_key, p.name, p.authors FROM packages p
		WHERE p.status = 'ok'${missing}${target.where}
		ORDER BY p.id
	`);

	const params = target.params;

	say('hyx', `не смотрены следы SI-HYX у ${pending.all(...params).length} паков${queueNote(false)}`
		+ `${jobs > 1 ? `, по ${jobs} разом` : ''}`);

	let ok = 0;
	let failed = 0;
	let dead = 0;
	let found = 0;
	let generated = 0;

	await drain({
		step: 'hyx',
		jobs,
		take: () => pending.all(...params),
		work: async (row, bar) => {
			try {
				const names = await retryNetwork(() => withFreshUrl(row, async url =>
					(await openRemoteZip(url)).entries.map(item => item.name)));
				let authors = [];

				try {
					authors = JSON.parse(row.authors ?? '[]');
				} catch {
					// Подпись не разобрать — признаков генератора остаётся два
				}

				const hyx = hyxFiles(names, authors);

				updateHyx.run(hyx.files, hyxDetail(hyx), row.id);
				ok++;

				if (hyx.files > 0 || hyx.generated) {
					found++;
					generated += hyx.generated ? 1 : 0;
					say('hyx', `${bar.label()} ${row.name ?? row.file_name}: ${hyx.files} из ${hyx.of}`
						+ `${hyx.generated ? ', сгенерирован' : ''} ${JSON.stringify(hyx.tabs)}`);
				}
			} catch (error) {
				if (buryDeadLink(row, error)) {
					dead++;
				} else {
					failed++;
				}

				say('hyx', `${row.name ?? row.file_name}: ${error.message}`);
			}

			if (bar.milestone(25)) {
				say('hyx', bar.line);
			}
		},
	});

	say('hyx', `посмотрено ${ok} паков, следы SI-HYX у ${found}, из них сгенерировано ${generated}`
		+ `${dead ? `, похоронено по мёртвой ссылке ${dead}` : ''}, ошибок ${failed}.`);
}

/**
 * Досчитывает спецвопросы у паков, разобранных до того, как их научились считать.
 *
 * Полный разбор сделал бы то же самое, но заодно переписал бы всё остальное
 * и заново скачал логотипы; здесь из архива читается только content.xml —
 * это пара range-запросов на пак.
 */
export async function fetchSpecials() {
	const target = targetSql();
	const missing = force ? '' : ' AND p.special_count IS NULL';

	const pending = db.prepare(`
		SELECT p.id, p.url, p.file_name, p.source_key, p.name FROM packages p
		WHERE p.status = 'ok'${missing}${target.where}
		ORDER BY p.id
	`);

	const params = target.params;

	say('specials', `не посчитаны у ${pending.all(...params).length} паков${queueNote(false)}`
		+ `${jobs > 1 ? `, по ${jobs} разом` : ''}`);

	let ok = 0;
	let failed = 0;
	let dead = 0;
	let found = 0;

	await drain({
		step: 'specials',
		jobs,
		take: () => pending.all(...params),
		work: async (row, bar) => {
			try {
				const parsed = await retryNetwork(() => withFreshUrl(row, async url => {
					const archive = await openRemoteZip(url);
					const entry = archive.find('content.xml');

					if (!entry) {
						throw new Error('в архиве нет content.xml');
					}

					return parseContentXml(await archive.read(entry));
				}));

				updateSpecials.run(parsed.specialCount, JSON.stringify(parsed.specialStat), row.id);
				ok++;

				if (parsed.specialCount > 0) {
					found++;
				}
			} catch (error) {
				if (buryDeadLink(row, error)) {
					dead++;
				} else {
					failed++;
				}

				say('specials', `${row.name ?? row.file_name}: ${error.message}`);
			}

			if (bar.milestone(25)) {
				say('specials', bar.line);
			}
		},
	});

	say('specials', `посчитаны у ${ok} паков, из них со спецвопросами ${found}`
		+ `${dead ? `, похоронено по мёртвой ссылке ${dead}` : ''}, ошибок ${failed}.`);
}
