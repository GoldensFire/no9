// Какие файлы пака прошли через SI-HYX — по одним их именам.
//
// SI-HYX — программа владельца сайта для сборки паков (лежит рядом,
// Desktop/SI-HYX). Почти каждая её вкладка, сохраняя файл, дописывает к имени
// свой хвост или ставит своё начало, и по этим меткам видно, чем пак собран.
// Правила ниже переписаны с самой программы — где какое имя рождается, сказано
// у каждого. Поменялось имя там — менять и здесь.
//
// Чего по имени не узнать вовсе:
//   «Загрузчик» без обрезки называет файл ровно как на сайте («%(title)s»);
//   SiQuesterHYX кладёт файл в пак под его собственным именем;
//   «Промпт», ShikimoriHYX, «ЛидербордHYX» и Collab файлов в пак не делают;
//   «Base64» без галочки переименования сохраняет HTML под прежним именем.
//
// Старые хвосты вроде «_svtav1_x105_crf45» и «_СЖАТЫЙ_ag» в паках встречаются,
// но оставлены не SI-HYX: в её истории (Desktop/SI-HYX, git) их нет ни в одной
// версии, «Обработка» с первого коммита пишет «_crf…_speed…».
//
// Отдельно стоит «Генерация аниме-пака». Это не обработка чужого файла,
// а пак, сделанный программой целиком, и сайт метит его иначе — красным
// (см. web/card-hyx.js). Признаков у него три, и хватает любого: имена файлов
// «Сгенерировано в SI-HYX(Тайтл)…», манифест si-hyx-pack.json в архиве и подпись
// «Сгенерировано в программе SI-HYX» в авторах.
//
// Чистая функция без единого импорта: годится и обходу, и любому другому месту.

/** Подпись автора у сгенерированного пака (PACK_AUTHOR в SI-HYX/animepack.py). */
const GENERATED_AUTHOR = /сгенерировано в программе si-hyx/i;

/** Манифест, который генератор кладёт в архив (MANIFEST_NAME в pack_manifest.py). */
const MANIFEST = 'si-hyx-pack.json';

// Хвост, который дописывается к занятому имени: «_1» (_unique_output в Монтаже,
// «Фото» и повторы в SiQuesterHYX) или « (2)» (unique_path и _free_poster_name).
const AGAIN = String.raw`(?:_\d+| \(\d+\))?`;

/**
 * Вкладка → правила для имени файла без папки. Имя сверяется уже раскодированным
 * из percent-кодировки (SIQuester пишет так записи архива).
 *
 * Порядок важен: файл считается за первой подошедшей вкладкой, и генератор
 * стоит первым — у его файлов тоже бывают хвосты вроде «_poster».
 */
const TABS = [
	['gen', [
		// MEDIA_NAME_PREFIX и _media_base в animepack.py: «Сгенерировано
		// в SI-HYX(Тайтл).opus», «…_poster.avif», «…_frame.avif», «… 2.mp4»
		//
		// До MEDIA_NAME_PREFIX файлы звались номером песни AnisongDB или MAL
		// (media_key в song_candidate.py) с теми же хвостами — «12345_poster.avif».
		// По имени такие не берутся: проверка на живой библиотеке нашла
		// «1350595965_cover.jpg» в чужом паке, а здесь ошибка стоит красной
		// метки. Старый сгенерированный пак узнаётся манифестом и подписью
		/^сгенерировано в si-hyx/i,
	]],
	['process', [
		// «Обработка», видео: _out_suffix в process_worker_run_ffmpeg_capture.py —
		// «_crf45_speed100», «_autocrf_speed100», дальше «_noaudio»/«_norm» и «_fade»
		new RegExp(String.raw`_(?:crf\d+|autocrf)_speed\d+(?:_noaudio|_norm)?(?:_fade)?${AGAIN}\.\w+$`, 'i'),
		// Звук без видео получает только «_norm»/«_fade» и всегда .opus;
		// ролик без звука — «_noaudio» и .mp4 (при выключенном видео CRF в имени нет)
		new RegExp(String.raw`_(?:norm(?:_fade)?|fade|noaudio)${AGAIN}\.(?:opus|mp4)$`, 'i'),
		// AVIF из «Обработки»: process_worker_process_avif.py
		new RegExp(String.raw`_Сжатый${AGAIN}\.avif$`, 'i'),
	]],
	['edit', [
		// «Монтаж»: обрезка (edit_tab__execute_cut, smartcut), пикселизация,
		// привязка дорожки, удаление объекта и «Появление»
		new RegExp(String.raw`_(?:обрез|пиксель|привязка|без_объекта)${AGAIN}\.\w+$`, 'i'),
		new RegExp(String.raw` — появление${AGAIN}\.mp4$`, 'i'),
		// Кадр, сохранённый из плеера: «имя_00-01-23_456.png»
		// (edit_tab__reset_image_overlay.py, время через s_to_time)
		new RegExp(String.raw`_\d{2}-\d{2}-\d{2}_\d{3}${AGAIN}\.png$`, 'i'),
	]],
	['photo', [
		// «Редактирование фото»: _output_path в inpaint_tab_key_press_event.py
		new RegExp(String.raw`_photo${AGAIN}\.(?:png|bmp|tiff?|webp)$`, 'i'),
		// «Объединить фото»: photo_merger_tab.py
		/^merged_\d{4}\.\w+$/i,
	]],
	['download', [
		// «Загрузчик» с обрезкой по времени: «Название [30s-90s].mp4»
		// (ytdlp_worker_run.py)
		new RegExp(String.raw` \[\d+s-(?:\d+s|end)\]${AGAIN}\.\w+$`, 'i'),
		// Kodik: «slug - 3 серия [720p].mp4» или «slug [720p].mp4»
		new RegExp(String.raw`^[a-z0-9-]+(?: - \d+ серия)? \[\d{3,4}p\]${AGAIN}\.\w+$`, 'i'),
	]],
	['upgrade', [
		// «Апгрейд пака»: постеры Shikimori, pack_upgrader__do_titles.py
		new RegExp(String.raw`^shiki_(?:manga_)?\d+_poster${AGAIN}\.avif$`, 'i'),
	]],
	['b64', [
		// «Base64» с галочкой переименования: «имя_base.html»
		// (tabs/base64_tab__mask_html.py)
		new RegExp(String.raw`_base${AGAIN}\.html?$`, 'i'),
	]],
];

/** Вкладки по порядку — подписи к ним знает страница (см. web/card-hyx.js). */
export const HYX_TABS = TABS.map(([key]) => key);

/** Служебное в архиве — не файлы пака. */
const SERVICE = /^(?:content\.xml|\[content_types\]\.xml|texts\/.*|.*\/)$/i;

function decodeSafe(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * Сколько файлов пака сделано SI-HYX и какими вкладками.
 *
 * @param {Iterable<string>} names имена записей архива, как в оглавлении
 * @param {string[]} [authors] подписи из content.xml
 * @returns {{files: number, of: number, tabs: Record<string, number>, generated: boolean}}
 *   files — сколько файлов узнано; of — сколько всего файлов в паке;
 *   tabs — по вкладкам, только непустые; generated — пак собран генератором
 */
export function hyxFiles(names, authors = []) {
	const tabs = {};
	let files = 0;
	let of = 0;
	let manifest = false;

	for (const raw of names) {
		const path = decodeSafe(String(raw ?? '')).replaceAll('\\', '/');

		if (SERVICE.test(path)) {
			continue;
		}

		const name = path.split('/').pop().normalize('NFC');

		if (name.toLowerCase() === MANIFEST) {
			manifest = true;
			continue;
		}

		of++;

		const tab = TABS.find(([, rules]) => rules.some(rule => rule.test(name)));

		if (tab) {
			tabs[tab[0]] = (tabs[tab[0]] ?? 0) + 1;
			files++;
		}
	}

	const generated = (tabs.gen ?? 0) > 0 || manifest
		|| authors.some(author => GENERATED_AUTHOR.test(String(author ?? '')));

	return { files, of, tabs, generated };
}

/** То же для записи в базу: что кладётся в колонку hyx_detail. */
export function hyxDetail(found) {
	return JSON.stringify({ of: found.of, tabs: found.tabs, generated: found.generated || undefined });
}
