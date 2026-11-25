// Сборщик эталонного набора: какие паки взять, какие темы из них и какие
// картинки и кадры положить владельцу на разметку.
//
// Набор нарочно перекошен. В библиотеке девять паков из десяти чистые, и взятые
// наугад четыреста картинок дали бы десяток нарушений — на таком полноту
// не измерить. Поэтому набор собирается четырьмя корзинами по названиям тем:
//
//   adult   тема сама называет себя взрослой («18+», «хентай») — положительные
//   border  этти, косплей, вайфу, купальники — пограничные
//   gore    гуро, хоррор, расчленёнка
//   plain   случайные темы случайных паков — отрицательные
//
// Корзина — это только откуда картинка взята, а не приговор: приговор ставит
// владелец (label.js), и в «18+» половина картинок окажется чистой.
//
// Файлы читаются из архива ВК по одному (archive.read): на набор их нужна
// горсть с пака, а не весь пак. Архив целиком — дело настоящего конвейера.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../../config.js';
import { openRemoteZip } from '../../zip.js';
import { FOLDERS, mediaMap } from '../media-map.js';
import { loadUnits, saveUnits, unitsDir } from './store.js';

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

/** Сторона картинки, с которой она едет модели (nsfw-moderation.md, раздел 6). */
const SIDE = 768;

/** Ролик тяжелее этого ради двух кадров в набор не качаем. */
const VIDEO_LIMIT = 40 * 1024 * 1024;

const BUCKETS = {
	adult: {
		want: 170,
		match: /18\s*\+|\+\s*18|nsfw|r-?18|хентай|hentai|порн|porn|секс|sex\b|эроти|голы[ейх]|голая|сиськ|rule\s*34|onlyfans|brazzers|для взрослых|пошл/i,
	},
	border: {
		want: 110,
		match: /этти|ecchi|косплей|cosplay|вайфу|waifu|тян(ки|очки|ка|ок)?(?![а-яё])|купальник|бикини|фансервис|горяч|ляжк|чулк|панцу|красотк|девушки|модел[иь]/i,
	},
	gore: {
		want: 50,
		match: /гуро|расчлен|кров[ьиа]|gore|mortal kombat|фаталити|fatality|труп|маньяк|хоррор|horror|ужас|жесть|шок/i,
	},
	plain: { want: 130, match: null },
};

/** Не больше стольких единиц с темы и с пака: набор должен быть пёстрым. */
const PER_THEME = 6;
const PER_PACK = 14;

/** Обычных картинок с пака — горсть: отрицательные должны быть из сотни паков, а не из десяти. */
const PLAIN_PER_PACK = 3;
const FRAMES_PER_VIDEO = 2;

/** Перемешивание с зерном: повторный запуск берёт те же паки в том же порядке. */
function shuffled(list, seed) {
	let state = seed >>> 0;

	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};

	const copy = [...list];

	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}

	return copy;
}

/** В какую корзину идёт тема по своему названию и названию раунда. */
function bucketOf(roundName, themeName) {
	const title = `${roundName} ${themeName}`;

	for (const [bucket, { match }] of Object.entries(BUCKETS)) {
		if (match?.test(title)) {
			return bucket;
		}
	}

	return 'plain';
}

/** Любая картинка → JPEG не шире и не выше SIDE. У GIF берётся первый кадр. */
async function toJpeg(source, target) {
	await run(FFMPEG, [
		'-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-frames:v', '1',
		'-vf', `scale='min(${SIDE},iw)':'min(${SIDE},ih)':force_original_aspect_ratio=decrease`,
		'-q:v', '4', target,
	]);

	return fs.readFileSync(target);
}

/** Кадры ролика раз в две секунды; в набор идут FRAMES_PER_VIDEO из них, вразбивку. */
async function videoFrames(source, folder) {
	const pattern = path.join(folder, 'f%04d.jpg');

	await run(FFMPEG, [
		'-hide_banner', '-loglevel', 'error', '-y', '-i', source,
		'-vf', `fps=1/2,scale='min(${SIDE},iw)':'min(${SIDE},ih)':force_original_aspect_ratio=decrease`,
		'-q:v', '4', pattern,
	]);

	const frames = fs.readdirSync(folder).filter(name => /^f\d+\.jpg$/.test(name)).sort();
	const picked = [];

	for (let i = 1; i <= FRAMES_PER_VIDEO && frames.length > 0; i++) {
		const index = Math.min(frames.length - 1, Math.floor((frames.length * i) / (FRAMES_PER_VIDEO + 1)));
		const name = frames[index];

		if (!picked.some(frame => frame.name === name)) {
			// Кадр N снят на (N − 1) × 2 секунде
			picked.push({ name, t: index * 2, jpeg: fs.readFileSync(path.join(folder, name)) });
		}
	}

	return picked;
}

/**
 * @param {{limitPacks?: number, log?: (line: string) => void}} [options]
 */
export async function collect({ limitPacks = 600, log = console.log } = {}) {
	fs.mkdirSync(unitsDir, { recursive: true });

	const units = loadUnits();
	const known = new Set(units.map(unit => unit.id));
	const donePacks = new Set(units.map(unit => unit.pack.id));
	const have = bucket => units.filter(unit => unit.bucket === bucket).length;
	const full = () => Object.entries(BUCKETS).every(([bucket, { want }]) => have(bucket) >= want);

	const db = new DatabaseSync(config.dbPath, { readOnly: true });
	const rows = db.prepare(`
		SELECT id, source_key, name, url, rounds FROM packages
		WHERE status = 'ok' AND size < 150000000 AND url LIKE 'http%'
	`).all();
	db.close();

	// Сначала паки, у которых есть помеченные темы: редкие корзины иначе
	// не набрать. Обычные — после, ими доливается plain
	const marked = [];
	const plain = [];

	for (const row of shuffled(rows, 20261117)) {
		let rounds = [];

		try {
			rounds = JSON.parse(row.rounds);
		} catch {
			continue;
		}

		const hit = rounds.some(round => round.themes?.some(theme => bucketOf(round.name, theme.name) !== 'plain'));
		(hit ? marked : plain).push(row);
	}

	// Вперемешку три к одному: помеченные паки дают все корзины разом,
	// обычные — только plain
	const queue = [];

	for (let i = 0, j = 0; i < marked.length || j < plain.length;) {
		for (let k = 0; k < 3 && i < marked.length; k++) {
			queue.push(marked[i++]);
		}

		if (j < plain.length) {
			queue.push(plain[j++]);
		}
	}

	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-bench-'));
	let opened = 0;
	let failed = 0;

	try {
		for (const row of queue) {
			if (full() || opened >= limitPacks) {
				break;
			}

			if (donePacks.has(row.id)) {
				continue;
			}

			opened++;

			let taken = 0;

			try {
				const archive = await openRemoteZip(row.url);
				const content = archive.find('content.xml');

				if (!content) {
					throw new Error('нет content.xml');
				}

				const map = mediaMap(await archive.read(content))
					.filter(item => !item.offsite && (item.kind === 'image' || item.kind === 'video'));

				// Темы пака по корзинам; из каждой темы — случайные файлы
				const themes = new Map();

				for (const item of map) {
					const key = `${item.round}:${item.theme}`;

					if (!themes.has(key)) {
						themes.set(key, { bucket: bucketOf(item.roundName, item.themeName), items: [] });
					}

					themes.get(key).items.push(item);
				}

				// Помеченные темы вперёд: иначе обычные темы того же пака выберут
				// его долю раньше, чем очередь дойдёт до редкого
				const ordered = shuffled([...themes.values()], row.id)
					.sort((a, b) => (a.bucket === 'plain') - (b.bucket === 'plain'));
				let plainTaken = 0;

				for (const theme of ordered) {
					if (taken >= PER_PACK) {
						break;
					}

					if (have(theme.bucket) >= BUCKETS[theme.bucket].want) {
						continue;
					}

					let fromTheme = 0;

					for (const item of shuffled(theme.items, row.id + 1)) {
						if (fromTheme >= PER_THEME || taken >= PER_PACK || have(theme.bucket) >= BUCKETS[theme.bucket].want) {
							break;
						}

						if (theme.bucket === 'plain' && plainTaken >= PLAIN_PER_PACK) {
							break;
						}

						plainTaken += theme.bucket === 'plain' ? 1 : 0;

						const entry = archive.find(`${FOLDERS[item.kind]}/${item.file}`);

						if (!entry || entry.size === 0 || (item.kind === 'video' && entry.size > VIDEO_LIMIT)) {
							continue;
						}

						const raw = path.join(temp, `raw${path.extname(item.file).toLowerCase() || '.bin'}`);
						let shots = [];

						try {
							fs.writeFileSync(raw, await archive.read(entry));

							if (item.kind === 'image') {
								shots = [{ t: null, jpeg: await toJpeg(raw, path.join(temp, 'out.jpg')) }];
							} else {
								const folder = fs.mkdtempSync(path.join(temp, 'v-'));
								shots = await videoFrames(raw, folder);
								fs.rmSync(folder, { recursive: true, force: true });
							}
						} catch (error) {
							log(`    ${item.file}: ${String(error.message).split('\n')[0].slice(0, 120)}`);
							continue;
						}

						for (const shot of shots) {
							const sha256 = crypto.createHash('sha256').update(shot.jpeg).digest('hex');
							const id = sha256.slice(0, 16);

							if (known.has(id)) {
								continue;
							}

							known.add(id);
							fs.writeFileSync(path.join(unitsDir, `${id}.jpg`), shot.jpeg);

							units.push({
								id,
								sha256,
								bucket: theme.bucket,
								kind: item.kind === 'video' ? 'frame' : 'image',
								t: shot.t,
								pack: { id: row.id, key: row.source_key, name: row.name },
								round: item.roundName,
								theme: item.themeName,
								side: item.side,
								file: item.file,
								crc: `${entry.crc >>> 0}:${entry.size}`,
								text: item.text.slice(0, 300),
								answer: item.answer.slice(0, 200),
							});

							fromTheme++;
							taken++;
						}
					}
				}
			} catch (error) {
				failed++;
				log(`  ${row.id} ${row.name}: ${String(error.message).slice(0, 100)}`);
				continue;
			}

			if (taken > 0) {
				saveUnits(units);
			}

			log(`${row.id} ${row.name}: +${taken} — ${Object.keys(BUCKETS).map(bucket => `${bucket} ${have(bucket)}/${BUCKETS[bucket].want}`).join(', ')}`);
		}
	} finally {
		fs.rmSync(temp, { recursive: true, force: true });
	}

	saveUnits(units);
	log(`Готово: ${units.length} единиц из ${new Set(units.map(unit => unit.pack.id)).size} паков; открыто ${opened}, не открылось ${failed}.`);
}
