// Из чего сделано медиа пака: форматы картинок и звука, кодеки видео.
//
// ————— зачем это здесь —————
//
// Спрашивают об этом те, кто показывает паки не на компьютере. Старые
// телевизоры и телефоны не умеют HEVC и AV1, а иные — и WebP с AVIF, и что пак
// придётся перекодировать, хочется знать до того, как его скачали. Сайту это
// тоже не чужое: видео в HEVC играет не в каждом браузере. На карточке это видит
// только хозяин сайта, а наружу оно уходит через хранилище
// (firePacks.mediaFormats в cf/src/sistorage/packages.js).
//
// ————— как узнаётся —————
//
// Картинки и звук — по расширению из оглавления архива. Оглавление у пака одно,
// а заголовок каждой картинки стоил бы похода к ВК на файл, и картинок в паке
// сотни. Расширение врёт редко, а на вопрос «чем это открывать» его хватает.
//
// Видео — по заголовку, потому что кодек живёт внутри контейнера: mp4 бывает
// и H.264, и HEVC, а webm — и VP9, и AV1. Берётся то же начало файла, что и для
// длительности (HEAD_BYTES в src/duration.js), а у MP4, чьё оглавление стоит
// за содержимым, — кусок с места оглавления (CHUNK_BYTES): дорожки перечислены
// там, и у каждой кодек назван четырьмя буквами.
//
// ————— чего этот разбор не умеет —————
//
// Сжатых в архиве MP4 с оглавлением в конце: начало сжатой записи распаковать
// можно, а середину — нечем (см. slices в src/zip.js). Такой файл и всякий
// другой, чей кодек не нашёлся, считается как unknown — не пропадает из счёта:
// по нему видно, что смотрели не всё.

import { CHUNK_BYTES, HEAD_BYTES, mediaKind, plainName } from './duration.js';

const extensionOf = name => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();

/** Расширение картинки — в одно имя формата: jpeg и jfif — тот же jpg. */
const IMAGES = {
	jpg: 'jpg', jpeg: 'jpg', jpe: 'jpg', jfif: 'jpg',
	png: 'png', gif: 'gif', webp: 'webp', avif: 'avif', bmp: 'bmp', svg: 'svg',
	heic: 'heic', heif: 'heic', tif: 'tiff', tiff: 'tiff', ico: 'ico',
};

/** Звук — так же: m4a и aac — один AAC, oga — тот же ogg. */
const AUDIO = {
	mp3: 'mp3', wav: 'wav', ogg: 'ogg', oga: 'ogg', opus: 'opus',
	m4a: 'aac', aac: 'aac', flac: 'flac', wma: 'wma',
};

/** Контейнер видео: m4v — тот же mp4. */
const CONTAINERS = {
	mp4: 'mp4', m4v: 'mp4', mov: 'mov', webm: 'webm', mkv: 'mkv', avi: 'avi', wmv: 'wmv', flv: 'flv',
};

/**
 * Кодек дорожки MP4 по её четырём буквам (запись в stsd). Звуковые дорожки
 * здесь не названы нарочно: ищется видео, а mp4a рядом с ним есть почти всегда.
 */
const ISO_CODECS = {
	avc1: 'h264', avc2: 'h264', avc3: 'h264', avc4: 'h264',
	hvc1: 'hevc', hev1: 'hevc', dvh1: 'hevc', dvhe: 'hevc',
	av01: 'av1', vp09: 'vp9', vp08: 'vp8', mp4v: 'mpeg4',
	jpeg: 'mjpeg', mjpa: 'mjpeg', mjpb: 'mjpeg', s263: 'h263', h263: 'h263',
	apch: 'prores', apcn: 'prores', apcs: 'prores', apco: 'prores', ap4h: 'prores',
};

/** Звуковые дорожки MP4: нашлись только они — значит, видео в файле нет вовсе. */
const ISO_SOUND = new Set(['mp4a', 'ac-3', 'ec-3', 'opus', 'alac', 'fLaC', '.mp3', 'samr', 'lpcm', 'sowt', 'twos']);

/** Кодек WebM и MKV — по CodecID дорожки. Порядок важен: длинное раньше короткого. */
const MATROSKA_CODECS = [
	['V_MPEGH/ISO/HEVC', 'hevc'], ['V_MPEG4/ISO/AVC', 'h264'], ['V_MPEG4/ISO/', 'mpeg4'],
	['V_AV1', 'av1'], ['V_VP9', 'vp9'], ['V_VP8', 'vp8'], ['V_THEORA', 'theora'], ['V_MS/VFW/', 'other'],
];

/** Кодек AVI — по четырём буквам обработчика дорожки vids. */
const AVI_CODECS = {
	H264: 'h264', X264: 'h264', AVC1: 'h264', DAVC: 'h264',
	HEVC: 'hevc', H265: 'hevc', HVC1: 'hevc',
	XVID: 'mpeg4', DIVX: 'mpeg4', DX50: 'mpeg4', FMP4: 'mpeg4', MP4V: 'mpeg4', '3IV2': 'mpeg4',
	MJPG: 'mjpeg',
};

/** Кодек FLV — по номеру в первом видеокадре (четыре младших бита). */
const FLV_CODECS = { 2: 'h263', 3: 'screen', 4: 'vp6', 5: 'vp6', 6: 'screen', 7: 'h264', 12: 'hevc' };

/** То же для «расширенного» FLV, где кодек назван четырьмя буквами, как в MP4. */
const FLV_FOURCC = { avc1: 'h264', hvc1: 'hevc', av01: 'av1', vp09: 'vp9' };

/**
 * Видеокодек из прочитанного куска MP4: все записи stsd в нём, первая
 * видеодорожка. 'none' — дорожки нашлись, но все звуковые; null — ни одной.
 *
 * Ищется подписью, а не обходом коробок: кусок бывает началом оглавления,
 * а бывает и его серединой, и обойти коробки с середины нечем. Случайно
 * встретить «stsd» в чужих байтах здесь негде — внутри оглавления это имя
 * коробки, а сжатое содержимое в эти куски почти не попадает.
 */
function isoCodec(buffer) {
	if (!buffer) {
		return null;
	}

	let sound = false;

	for (let at = buffer.indexOf('stsd', 0, 'latin1'); at >= 0; at = buffer.indexOf('stsd', at + 4, 'latin1')) {
		if (at + 20 > buffer.length) {
			break;
		}

		const type = buffer.toString('latin1', at + 16, at + 20);

		if (ISO_CODECS[type]) {
			return ISO_CODECS[type];
		}

		sound ||= ISO_SOUND.has(type);
	}

	return sound ? 'none' : null;
}

/**
 * Где в MP4 начинается коробка, до которой не дотянулось начало файла.
 *
 * Обходятся коробки верхнего уровня: ftyp, mdat, moov, free… Оглавление
 * в начале нашлось бы в самом начале — раз его там нет, оно за той коробкой,
 * которая из прочитанного вылезла, и место ему — её конец. Длина в коробке
 * записана точно, гадать не надо.
 *
 * @returns {number|null} смещение от начала файла; null — дальше искать негде
 */
function isoNextBox(head) {
	let at = 0;

	while (at + 8 <= head.length) {
		let size = head.readUInt32BE(at);

		if (size === 1) {
			if (at + 16 > head.length) {
				return null;
			}

			size = Number(head.readBigUInt64BE(at + 8));
		}

		// Ноль — «до конца файла»: за такой коробкой ничего нет
		if (size < 8) {
			return null;
		}

		// Вылезло само оглавление — дочитывать с того места, где кончилось начало
		// (с небольшим заходом назад: имя коробки могло разрезаться пополам).
		// Вылезло что-то другое — оглавление стоит за ним
		if (at + size > head.length) {
			return head.toString('latin1', at + 4, at + 8) === 'moov' ? Math.max(at, head.length - 64) : at + size;
		}

		at += size;
	}

	return null;
}

function matroskaCodec(head) {
	const text = head.toString('latin1');

	return MATROSKA_CODECS.find(([id]) => text.includes(id))?.[1] ?? null;
}

function aviCodec(head) {
	// Тип дорожки стоит в куске strh за его именем и длиной: «strh», четыре
	// байта длины, «vids»
	let at = head.indexOf('vids', 8, 'latin1');

	while (at >= 0 && head.toString('latin1', at - 8, at - 4) !== 'strh') {
		at = head.indexOf('vids', at + 4, 'latin1');
	}

	if (at < 0) {
		return null;
	}

	// Обработчик стоит сразу за типом дорожки; бывает пустым — тогда кодек
	// назван в BITMAPINFOHEADER следующего куска strf
	let handler = head.toString('latin1', at + 4, at + 8).trim().toUpperCase();

	if (!/^[A-Z0-9]{4}$/.test(handler)) {
		const format = head.indexOf('strf', at, 'latin1');
		handler = format >= 0 ? head.toString('latin1', format + 24, format + 28).toUpperCase() : '';
	}

	return AVI_CODECS[handler] ?? (handler ? 'other' : null);
}

function flvCodec(head) {
	if (head.toString('latin1', 0, 3) !== 'FLV' || head.length < 13) {
		return null;
	}

	// Заголовок, за ним длина «предыдущего кадра» и кадры: тип, три байта длины,
	// четыре — времени, три — номера потока, и данные
	for (let at = head.readUInt32BE(5) + 4; at + 12 <= head.length;) {
		const type = head[at];
		const size = head.readUIntBE(at + 1, 3);

		if (type === 9) {
			const first = head[at + 11];

			return first & 0x80
				? FLV_FOURCC[head.toString('latin1', at + 12, at + 16)] ?? 'other'
				: FLV_CODECS[first & 0x0f] ?? 'other';
		}

		at += 11 + size + 4;
	}

	return null;
}

/**
 * Кодек видео по началу файла.
 *
 * @returns {{codec: string}|{needAt: number}|null} кодек; либо где дочитать
 *          (у MP4 оглавление бывает за содержимым); либо null — не узнали
 */
export function probeVideoCodec(name, head) {
	if (!head || head.length < 16) {
		return null;
	}

	const wrap = codec => (codec ? { codec } : null);

	switch (CONTAINERS[extensionOf(name)]) {
		case 'mp4':
		case 'mov': {
			const codec = isoCodec(head);

			if (codec) {
				return { codec };
			}

			const next = isoNextBox(head);

			return next === null ? null : { needAt: next };
		}
		case 'webm':
		case 'mkv':
			return wrap(matroskaCodec(head));
		case 'avi':
			return wrap(aviCodec(head));
		case 'flv':
			return wrap(flvCodec(head));
		// WMV держит кодек в заголовке ASF, но там он всегда свой — WMV1–3 или VC-1,
		// и для вопроса «что придётся перекодировать» этого имени достаточно
		case 'wmv':
			return { codec: 'wmv' };
		default:
			return null;
	}
}

const add = (counts, key) => {
	counts[key] = (counts[key] ?? 0) + 1;
};

/**
 * Форматы медиа в паке, счётом по файлам.
 *
 * @param {object} archive открытый архив (см. openRemoteZip в src/zip.js)
 * @returns {Promise<{images: object, audio: object, containers: object, video: object}>}
 *          { jpg: 120, webp: 3 } и так далее; у video — кодеки, у containers —
 *          в чём они лежат. Пустой объект — таких файлов в паке нет
 */
export async function measureFormats(archive) {
	const formats = { images: {}, audio: {}, containers: {}, video: {} };
	const videos = [];

	for (const entry of archive.entries) {
		const name = plainName(entry.name);
		const extension = extensionOf(name);
		const kind = mediaKind(name);

		if (kind === 'audio') {
			add(formats.audio, AUDIO[extension] ?? extension);
		} else if (kind === 'video') {
			add(formats.containers, CONTAINERS[extension] ?? extension);
			videos.push(entry);
		} else if (IMAGES[extension]) {
			add(formats.images, IMAGES[extension]);
		}
	}

	if (videos.length === 0) {
		return formats;
	}

	const heads = await archive.heads(videos, HEAD_BYTES);
	const pointed = [];

	for (const entry of videos) {
		const head = heads.get(entry);
		const probe = head ? probeVideoCodec(plainName(entry.name), head.data) : null;

		if (probe?.codec) {
			add(formats.video, probe.codec);
		} else if (probe?.needAt) {
			pointed.push({ entry, dataStart: head.dataStart, from: probe.needAt, bytes: CHUNK_BYTES });
		} else {
			add(formats.video, 'unknown');
		}
	}

	if (pointed.length > 0) {
		const chunks = await archive.slices(pointed);

		for (const item of pointed) {
			add(formats.video, isoCodec(chunks.get(item.entry)) ?? 'unknown');
		}
	}

	return formats;
}
