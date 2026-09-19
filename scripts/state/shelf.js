// Сама полка: разговор с GitHub через gh, метка «что там лежало в прошлый раз»
// и упаковка с распаковкой того, что туда ездит.
//
// Одно занятие, хоть и с двух сторон: положить и забрать. Всё, что касается
// самих данных внутри базы — что из старой перенести в новую, — лежит рядом,
// в scripts/state/carry.js.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
	ASSET, dbPath, force, MARK, prevPath, previewsPath, root, STAGE, TAG, thumbsPath, WORK,
} from './config.js';

/**
 * Запуск с выводом наружу. Возвращает код, а не падает: у каждой команды здесь
 * своя реакция на неудачу, и общее «умереть» ни одной не подходит.
 */
export function run(program, args, options = {}) {
	// Без оболочки нарочно. В Windows она склеивает список доводов в одну строку,
	// не расставляя кавычек, и «--title Рабочее состояние базы» приезжает к gh
	// как заголовок «Рабочее» и два непонятно чьих слова следом. Запускаем здесь
	// только gh и tar — обе настоящие программы, и оболочка для них не нужна.
	const result = spawnSync(program, args, {
		cwd: root,
		stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
		encoding: 'utf8',
	});

	return { code: result.status ?? 1, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
}

export const haveGh = () => run('gh', ['--version'], { quiet: true }).code === 0;

export function requireGh() {
	if (!haveGh()) {
		console.error('Нет gh — это команда GitHub. Поставьте её (winget install GitHub.cli) и войдите: gh auth login');
		process.exit(1);
	}
}

/** Что лежит на полке: время, размер и отпечаток. null — там ещё ничего нет. */
export function remoteAsset() {
	const result = run('gh', ['release', 'view', TAG, '--json', 'assets'], { quiet: true });

	if (result.code !== 0) {
		return null;
	}

	try {
		const assets = JSON.parse(result.out).assets ?? [];
		return assets.find(asset => asset.name === ASSET) ?? null;
	} catch {
		return null;
	}
}

/**
 * Чем один свёрток отличается от другого. Обычно это sha256, который GitHub
 * считает сам; старые gh его не показывают — тогда сойдёт пара «время и размер»:
 * приложение перезаписывается целиком, и совпасть у разных свёртков ей неоткуда.
 */
export const assetId = asset => asset.digest || `${asset.updatedAt}|${asset.size}`;

export function readMark() {
	try {
		return JSON.parse(fs.readFileSync(MARK, 'utf8'));
	} catch {
		return null;
	}
}

export function writeMark(asset) {
	fs.writeFileSync(MARK, `${JSON.stringify({
		id: assetId(asset),
		updatedAt: asset.updatedAt,
		size: asset.size,
		at: new Date().toISOString(),
	}, null, '\t')}\n`, 'utf8');
}

export function localStamp() {
	try {
		const stat = fs.statSync(dbPath);
		return { at: stat.mtime, size: stat.size };
	} catch {
		return null;
	}
}

export const megabytes = bytes => `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
export const when = value => new Date(value).toLocaleString('ru-RU');

/** Путь для SQL. Обратные косые Windows внутри строки SQLite не мешают, но прямые понятнее. */
export const sqlPath = file => file.split(path.sep).join('/').replace(/'/g, "''");

/**
 * Сколько в базе паков. Нужно ровно затем, чтобы после подмены сказать вслух,
 * что именно приехало: «было 9199, стало 11387» — единственная строка, по которой
 * видно, что сверка вообще работает.
 */
export function contentOf(file) {
	if (!fs.existsSync(file)) {
		return null;
	}

	try {
		const db = new DatabaseSync(file, { readOnly: true });

		try {
			return db.prepare(`
				SELECT (SELECT count(*) FROM packages) AS packs,
				       (SELECT count(*) FROM packages WHERE status = 'ok') AS ready
			`).get();
		} finally {
			db.close();
		}
	} catch {
		// база занята, побита или ещё не заведена — сказать про неё нечего
		return null;
	}
}

/**
 * Слить журнал в саму базу. Без этого копировать файл базы бессмысленно: в WAL
 * может лежать больше, чем в ней самой (здесь бывало 190 МБ журнала на 115 МБ
 * базы), и уехавшая на полку копия недосчиталась бы работы за несколько дней.
 *
 * Возвращает false, если базу держит кто-то ещё: тогда трогать её нельзя вовсе.
 */
function checkpoint() {
	if (!fs.existsSync(dbPath)) {
		return true;
	}

	try {
		const db = new DatabaseSync(dbPath);

		try {
			const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
			return !row || row.busy === 0;
		} finally {
			db.close();
		}
	} catch {
		return false;
	}
}

/**
 * Копия базы одним куском. Делается средствами самой SQLite (VACUUM INTO), а не
 * копированием файла: копия получается согласованной, даже если в базу в этот
 * миг пишут, и заодно ужатой — свободные страницы в неё не попадают.
 */
function snapshot(target) {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.rmSync(target, { force: true });

	const db = new DatabaseSync(dbPath);

	try {
		db.exec(`VACUUM INTO '${sqlPath(target)}'`);
	} finally {
		db.close();
	}
}

/**
 * Свёрток делается tar — он есть и в Windows 10+, и на машине Actions.
 *
 * База кладётся не та, что лежит в data, а её снимок из STAGE: см. snapshot.
 * Отсюда и два «-C»: сначала переходим в STAGE за базой, потом обратно в корень
 * за обложками. Пути внутри свёртка от этого не меняются — как были «data/…»,
 * так и остались, и разворачивается он у себя в корне проекта.
 *
 * Обложек может не быть (ни один пак ещё не разобран) — тогда в свёрток едет
 * одна база: tar отказался бы целиком из-за одной отсутствующей части.
 */
export function pack(file) {
	if (!fs.existsSync(dbPath)) {
		console.error('Складывать нечего: базы нет. Соберите её обычным запуском (npm run index).');
		process.exit(1);
	}

	const stage = path.join(root, STAGE);
	fs.rmSync(stage, { recursive: true, force: true });

	console.log('Снимаю копию базы…');
	snapshot(path.join(stage, 'data', 'sibase.db'));

	/** Что обязано оказаться внутри — этим же списком свёрток потом и проверяется. */
	const parts = ['data/sibase.db'];
	const args = ['-czf', file, '-C', STAGE, 'data/sibase.db'];

	// Второй «-C» уводит из STAGE обратно в корень проекта; третьего не нужно —
	// оба склада лежат в одной папке data, и tar остаётся там же, куда его
	// увели. Лишний «-C ../..» отсюда увёл бы на две ступени выше корня.
	if (fs.existsSync(thumbsPath)) {
		parts.push('data/thumbs');
		args.push('-C', '../..', 'data/thumbs');
	}

	// Крупные копии для чужих окон — рядом с обложками и по той же причине:
	// без них обход не может положить наверх картинку, которую Discord покажет
	// в карточке ссылки (см. previewsPath в scripts/state/config.js).
	//
	// Своя проверка на существование, а не одна на обе папки: у того, кто ещё
	// ни разу не собирал сайт, склад крупных копий пуст, а обложки уже есть, —
	// и tar отказался бы от всего свёртка целиком из-за одной отсутствующей части.
	if (fs.existsSync(previewsPath)) {
		parts.push('data/previews');

		// «-C» здесь не повторяется: если папка обложек нашлась, tar уже стоит
		// в корне, а если не нашлась — увести его туда надо теперь.
		if (!fs.existsSync(thumbsPath)) {
			args.push('-C', '../..');
		}

		args.push('data/previews');
	}

	const result = run('tar', args);
	fs.rmSync(stage, { recursive: true, force: true });

	if (result.code !== 0) {
		console.error('Не вышло сложить свёрток.');
		process.exit(1);
	}

	// Заглянуть в собранное перед отправкой. Два «-C» подряд разные tar считают
	// одинаково — второй путь относительно первого, — но проверено это на одной
	// машине, а укладывает свёрток и Windows, и Actions. Ошибись он молча, полка
	// осталась бы без обложек, и заметилось бы это через неделю.
	//
	// Строки режутся по \r\n, а не по \n, нарочно. Windows-овский tar (bsdtar
	// из System32) заканчивает каждую строку списка возвратом каретки, и «data/sibase.db\r»
	// не равно «data/sibase.db» — проверка не находила в свёртке ровно то, что
	// сама же туда только что положила, и всякая выкладка с домашней машины
	// заканчивалась «в свёрток не попало». Под Git Bash тот же код работал:
	// там первым в PATH стоит GNU tar, а он переводит строку по-своему.
	const listed = run('tar', ['-tzf', file], { quiet: true }).out.split(/\r?\n/).map(name => name.trim());

	for (const part of parts) {
		if (!listed.some(name => name === part || name.startsWith(`${part}/`))) {
			console.error(`В свёрток не попало: ${part}. Отправлять такое нельзя.`);
			process.exit(1);
		}
	}
}

/**
 * Развернуть скачанный свёрток на место здешней базы.
 *
 * Порядок здесь важнее, чем кажется. Сначала журнал сливается в базу — иначе
 * отодвинутая копия окажется без последней работы. Потом база отодвигается,
 * а не затирается: разошлись — значит, здесь было что-то своё, и выбрасывать
 * его молча нельзя. И только потом убираются -wal и -shm: оставь их рядом
 * с приехавшей базой — SQLite попыталась бы доиграть в неё чужой журнал.
 */
export function unpack() {
	if (fs.existsSync(dbPath) && !checkpoint()) {
		console.error('База занята другой программой — скорее всего, сайт уже запущен.');
		console.error('Закройте окно сайта и повторите: подменять базу под работающим сервером нельзя.');
		process.exit(1);
	}

	if (fs.existsSync(dbPath)) {
		fs.rmSync(prevPath, { force: true });

		try {
			fs.renameSync(dbPath, prevPath);
		} catch {
			console.error('Не вышло отодвинуть здешнюю базу: её кто-то держит открытой.');
			console.error('Закройте сайт (и окно обновления базы) и повторите.');
			process.exit(1);
		}
	}

	for (const suffix of ['-wal', '-shm']) {
		fs.rmSync(`${dbPath}${suffix}`, { force: true });
	}

	if (run('tar', ['-xzf', WORK]).code !== 0) {
		console.error('Не вышло развернуть свёрток. Прежняя база цела: data/sibase.prev.db');
		process.exit(1);
	}
}
