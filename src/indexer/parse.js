// Разбор пака: что достаётся из архива и как оттуда же приезжает логотип.
//
// Читается не весь файл, а его оглавление и content.xml — полторы сотни
// килобайт на пак вместо сотен мегабайт. Одним заходом отсюда выходит всё,
// что известно о паке по его содержимому: название, авторы, темы, спецвопросы,
// состав вопросов и отпечатки. Порознь их считать нельзя — второй заход стоил бы
// второго похода в хранилище ВК, а сам разбор занимает миллисекунды.
//
// Рядом стоит шаг логотипов: он про тот же архив, только для паков, разобранных
// до того, как обложки научились доставать.

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db, authorsOrVk, buildMatchKey, saveAuthors } from '../db.js';
import { openRemoteZip, DeadLinkError } from '../zip.js';
import { isObsceneName } from '../obscene.js';
import { parseContentXml } from '../siq.js';
import { ensureThumb } from '../thumbs.js';
import { thumbName } from '../logo.js';
import { force, jobs, reparse, retryFailed } from './options.js';
import { buryDeadLink, drain, retryNetwork, withFreshUrl } from './pipeline.js';
import { say } from './progress.js';
import { NEWEST_FIRST, queueNote, targetSql } from './queue.js';
import { clearRecheck, storePrints, updateFailed, updateLogo, updateParsed } from './store.js';

const LOGO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.gif', '.webp', '.bmp', '.avif']);

/** Есть ли у обложки уменьшенная копия — та самая, что показывается на карточке. */
const hasThumb = logoFile => Boolean(logoFile) && fs.existsSync(path.join(config.thumbsPath, thumbName(logoFile)));

/** Лежит ли у нас оригинал обложки: из него копию можно сделать когда угодно. */
const hasOriginal = logoFile => Boolean(logoFile) && fs.existsSync(path.join(config.logosPath, logoFile));

/**
 * Скачивает логотип пака из того же архива. Оглавление уже прочитано,
 * так что это ещё два range-запроса.
 *
 * Тут же делается и уменьшенная копия — та, что показывается на карточке.
 * Раньше её делала выкладка (см. scripts/build-web.js), и на домашней машине
 * это было безразлично: оригинал лежит в data/logos и никуда не девается,
 * копию можно посчитать хоть завтра.
 *
 * В облаке — не безразлично, и стоило это четырёх паков без обложек.
 * Оригиналы на полку не ездят (семьдесят мегабайт, см. scripts/state.js) —
 * ездят только готовые копии. Значит, оригинал живёт ровно столько, сколько
 * живёт одноразовый раннер: скачали при разборе, а посчитать копию должны были
 * в самом конце запуска. Не дошло до конца — обход убили по времени, выкладку
 * отключили ключом, шаг упал — и раннер уносит оригинал с собой. В базу же при
 * этом уже записано logo_state='ok', и шаг логотипов такой пак больше не берёт:
 * логотип у него есть, просто показать его нечем. Навсегда.
 *
 * Копия поэтому считается здесь, сразу и в том же запуске. Не вышло уменьшить
 * (уменьшать нечем или картинка не по зубам) — это не ошибка: logo_state
 * остаётся 'ok', оригинал на месте, и копию посчитает выкладка. А вот
 * в облаке, где оригиналу не жить, такой пак попадёт в починку (см. fetchLogos).
 *
 * @returns {Promise<{file: string|null, state: string}>}
 */
async function fetchLogo(archive, logoName, packageId) {
	if (!logoName) {
		return { file: null, state: 'none' };
	}

	const entry = archive.find(`Images/${logoName}`) ?? archive.find(logoName);

	if (!entry) {
		return { file: null, state: 'none' };
	}

	if (entry.compressedSize > config.maxLogoSize) {
		return { file: null, state: 'error' };
	}

	const extension = path.extname(logoName).toLowerCase();

	if (!LOGO_EXTENSIONS.has(extension)) {
		return { file: null, state: 'error' };
	}

	const content = await archive.read(entry);
	const fileName = `${packageId}${extension}`;

	fs.mkdirSync(config.logosPath, { recursive: true });
	fs.writeFileSync(path.join(config.logosPath, fileName), content);

	await ensureThumb(fileName).catch(() => null);

	return { file: fileName, state: 'ok' };
}

export async function parsePackages() {
	const statuses = ['new'];

	if (retryFailed) {
		statuses.push('error');
	}

	if (reparse) {
		statuses.push('ok');
	}

	const placeholders = statuses.map(() => '?').join(',');
	// Единственный шаг, который ходит с keepUnparsed: неразобранный пак не должен
	// стареть мимо очереди (см. targetSql в src/indexer/queue.js)
	const target = targetSql('p', { keepUnparsed: true });

	// Пометка recheck — это перезалитые файлы: пак давно разобран и стоит «ok»,
	// но в сообщении обсуждения лежит уже другой архив (см. syncComment в src/indexer/vk-scan.js).
	// Разбор идёт с самых свежих (см. NEWEST_FIRST в src/indexer/queue.js): очередь длинная, ночь конечная,
	// и недоделанным должно остаться позавчерашнее, а не сегодняшнее
	const pending = db.prepare(`
		SELECT p.id, p.url, p.file_name, p.source_key, p.status, p.vk_author FROM packages p
		WHERE (p.status IN (${placeholders}) OR p.recheck = 1)${target.where}
		ORDER BY ${NEWEST_FIRST}
	`);

	const params = [...statuses, ...target.params];

	say('parse', `в очереди ${pending.all(...params).length}${queueNote(false, true)}${jobs > 1 ? `, по ${jobs} разом` : ''}`);

	let ok = 0;
	let failed = 0;
	let dead = 0;
	let logos = 0;

	await drain({
		step: 'parse',
		jobs,
		take: () => pending.all(...params),
		work: async (row, bar) => {
			const label = bar.label();

			try {
				const result = await retryNetwork(() => withFreshUrl(row, async url => {
					const archive = await openRemoteZip(url);
					const entry = archive.find('content.xml');

					if (!entry) {
						throw new Error('в архиве нет content.xml');
					}

					// Вес вложенных файлов идёт в разбор из оглавления архива:
					// по нему отпечаток вопроса отличает «тот же файл» от «то же
					// имя» (см. sameWeight в src/plagiarism.js). Оглавление уже
					// прочитано, так что стоит это ничего
					const parsed = parseContentXml(await archive.read(entry), archive.mediaSizes());

					if (!parsed.name) {
						throw new Error('в паке не указано имя');
					}

					const logo = await fetchLogo(archive, parsed.logo, row.id).catch(() => ({ file: null, state: 'error' }));

					return { parsed, logo, totalSize: archive.totalSize };
				}));

				const { parsed, logo, totalSize } = result;

				// Не подписался в файле — подписывается страницей ВК, с которой
				// пак выложен (см. authorsOrVk выше)
				const authors = authorsOrVk(parsed.authors, row.vk_author);

				updateParsed.run(
					parsed.name,
					JSON.stringify(authors),
					authors.join(', '),
					buildMatchKey(parsed.name, authors),
					parsed.authorDifficulty,
					parsed.language,
					parsed.date,
					parsed.id,
					totalSize,
					parsed.questionCount,
					parsed.roundCount,
					parsed.themeCount,
					parsed.specialCount,
					JSON.stringify(parsed.specialStat),
					JSON.stringify(parsed.contentStat),
					JSON.stringify(parsed.rounds),
					// Где лежит показываемое: в паке или по чужим ссылкам
					// (см. countMediaRefs в src/siq.js)
					parsed.mediaRefs?.own ?? null,
					parsed.mediaRefs?.offsite ?? null,
					logo.file,
					logo.state,
					// Мат и непристойность в названии: страница такого пака
					// просит поисковик её не индексировать, но с сайта пак
					// никуда не девается (см. src/obscene.js)
					isObsceneName(parsed.name) ? 1 : 0,
					Date.now(),
					row.id,
				);

				saveAuthors(row.id, authors);

				// Отпечатки вопросов — здесь же, из того же разбора. Отдельный шаг
				// prints нужен только тем пакам, что разобраны до его появления:
				// второй раз качать content.xml ради того, что уже прочитано,
				// незачем (см. fetchPrints в src/indexer/backfill.js)
				storePrints(row.id, parsed.questions);

				ok++;

				if (logo.state === 'ok') {
					logos++;
				}

				say('parse', `${label} ${row.file_name ?? row.url} -> «${parsed.name}», вопросов ${parsed.questionCount}, `
					+ `${Math.round(totalSize / 1024 / 1024)} МБ${logo.state === 'ok' ? ', с логотипом' : ''}`);
			} catch (error) {
				const status = error instanceof DeadLinkError ? 'dead' : 'error';

				if (status === 'dead') {
					dead++;
				} else {
					failed++;
				}

				// Пак уже был разобран: временная ошибка не повод убирать его из выдачи
				if (status === 'error' && row.status === 'ok') {
					clearRecheck.run(row.id);
					say('parse', `${label} ${row.file_name ?? row.url} -> не вышло: ${error.message}; оставляю прежний разбор`);
				} else {
					updateFailed.run(status, error.message, Date.now(), row.id);
					say('parse', `${label} ${row.file_name ?? row.url} -> не вышло: ${error.message}`);
				}
			}
		},
	});

	say('parse', `разобрано: ${ok} (логотипов ${logos}), мёртвых ссылок: ${dead}, прочих ошибок: ${failed}.`);
}

/**
 * Догружает логотипы для паков, разобранных до появления этой возможности,
 * и чинит те, у которых логотип по базе есть, а показать его нечем.
 *
 * Второе — про паки вроде 15915–15917 и 16554. В базе у них logo_state='ok',
 * а на деле нет ни уменьшенной копии, ни оригинала: копию должна была посчитать
 * выкладка, но до неё тот запуск не дожил, а оригинал уехал вместе с раннером
 * (см. fetchLogo). Пометки в базе такому случаю нет и быть не может — она
 * не врала в тот миг, когда её ставили, — поэтому чинится он по тому, чего нет
 * на складе: ни копии, ни оригинала. Такой пак качается заново, и на этот раз
 * копия делается сразу.
 */
export async function fetchLogos() {
	const target = targetSql();

	// Точечное обновление логотип перекачивает всегда: «докачать недостающие» —
	// это про ночной обход, а названный поимённо пак просят обновить целиком.
	//
	// Паки с logo_state='ok' идут в очередь наравне с прочими: есть у них
	// показывать нечего или нет, по одной базе не видно — это решает уже склад
	// (см. broken ниже)
	const missing = force ? '' : ` AND (p.logo_state IS NULL OR p.logo_state = 'error' OR p.logo_state = 'ok')`;

	const pending = db.prepare(`
		SELECT p.id, p.url, p.file_name, p.source_key, p.name, p.logo_state, p.logo_file FROM packages p
		WHERE p.status = 'ok'${missing}${target.where}
		ORDER BY p.id
	`);

	const params = target.params;

	/**
	 * Что из отобранного и вправду надо качать. Пак, у которого логотип уже есть
	 * и показывается, отсеивается здесь: по одной базе этого не видно — ответ
	 * лежит на складе обложек, а не в ней.
	 *
	 * `--force` отсев отменяет целиком, как и всё прочее: «обнови этот пак»
	 * означает перекачать, а не рассудить, надо ли.
	 */
	const wanted = () => (force
		? pending.all(...params)
		: pending.all(...params)
			.filter(row => row.logo_state !== 'ok' || !(hasThumb(row.logo_file) || hasOriginal(row.logo_file))));

	const queue = wanted();
	const broken = queue.filter(row => row.logo_state === 'ok').length;

	say('logos', `без логотипа ${queue.length - broken}`
		+ `${broken ? `, с потерянной обложкой ${broken}` : ''}`
		+ `${queueNote(false)}${jobs > 1 ? `, по ${jobs} разом` : ''}`);

	let ok = 0;
	let none = 0;
	let failed = 0;
	let dead = 0;

	await drain({
		step: 'logos',
		jobs,
		take: wanted,
		work: async (row, bar) => {
			try {
				const logo = await retryNetwork(() => withFreshUrl(row, async url => {
					const archive = await openRemoteZip(url);
					const entry = archive.find('content.xml');

					if (!entry) {
						throw new Error('в архиве нет content.xml');
					}

					const parsed = parseContentXml(await archive.read(entry));
					return fetchLogo(archive, parsed.logo, row.id);
				}));

				updateLogo.run(logo.file, logo.state, row.id);

				if (logo.state === 'ok') {
					ok++;
				} else {
					none++;
				}
			} catch (error) {
				if (buryDeadLink(row, error)) {
					dead++;
				} else {
					failed++;
					updateLogo.run(null, 'error', row.id);
				}

				say('logos', `${row.name ?? row.file_name}: ${error.message}`);
			}

			if (bar.milestone(25)) {
				say('logos', bar.line);
			}
		},
	});

	say('logos', `скачано ${ok}, в паке нет ${none}`
		+ `${dead ? `, похоронено по мёртвой ссылке ${dead}` : ''}, ошибок ${failed}.`);
}
