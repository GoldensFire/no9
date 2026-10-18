// Сколько длится медиафайл — по его заголовку, а не по нему самому.
//
// ————— зачем это здесь —————
//
// Пак на сорок минут звучания и пак на четыре часа выбирают в разных случаях,
// а по числу вопросов их не отличить: сотня вопросов бывает и там, и там.
// Решает длина куска: тема из шести песен по полторы минуты — это девять минут
// на одну тему, и пак из тридцати таких тем не играется за вечер никогда.
// Поэтому у пака считаются два числа — средняя длительность медиафайла
// и самая большая (см. fetchDurations в src/indexer/backfill.js).
//
// ————— почему файлы не качаются —————
//
// Библиотека весит сотни гигабайт, а длительность лежит в первых килобайтах
// файла — в заголовке. MP3 говорит битрейт, и при постоянном битрейте секунды
// считаются делением размера на него; MP4 держит длительность прямым числом
// в mvhd; WAV — размером куска data; WebM — полем Duration; FLAC — числом
// сэмплов. Ogg — единственный, кто заставляет заглянуть в конец файла:
// там лежит номер последнего сэмпла.
//
// Так что с файла берётся начало (несколько килобайт), а изредка ещё и конец;
// и берутся они у всех медиафайлов пака одним запросом (см. fetchRanges
// и heads в src/zip.js). Это два-три похода к ВК на пак вместо полусотни.
//
// Формат при этом узнаётся по содержимому, а не по имени: файл с расширением
// .m4a сплошь и рядом оказывается голым потоком AAC без всякой коробки вокруг,
// и разбор коробок выдал бы на нём мусор с длиной в четыре гигабайта.
//
// ————— чего этот разбор не умеет —————
//
// FLV. MP4, нарезанный на фрагменты и не записавший общей длины: сложить её
// можно только прочитав файл целиком, а ровно этого мы здесь и не делаем.
// И сжатых в архиве файлов, чьё оглавление лежит в конце: начало такой записи
// распаковать можно (см. heads в src/zip.js), а середину — нечем.
//
// Такой файл в счёт не идёт вовсе: у пака просто окажется меньше измеренных
// файлов, а не выдуманная длина. Сколько их было, видно по числу рядом.
//
// Точность здесь тоже не абсолютная: у MP3 с переменным битрейтом без
// заголовка Xing секунды считаются по первому кадру, и на файле, где битрейт
// гуляет, это оценка. Для «сколько тянется тема» этого хватает с запасом,
// а на глаз разницы между 1:28 и 1:30 никто и не заметит.

/**
 * Сколько байт от начала файла берём по умолчанию.
 *
 * Заголовки короче в разы — но у MP3 перед ними стоит тег ID3, и в него кладут
 * обложку альбома. Четырёх килобайт не хватало доброй половине встреченных
 * файлов, и каждый такой стоил второго запроса; двенадцать закрывают почти всё
 * за один. Дороже это ровно на восемь килобайт трафика, а трафик тут дешевле
 * похода к ВК на порядок.
 */
export const HEAD_BYTES = 12288;

/** Сколько байт от конца: у Ogg последняя страница ближе к концу, чем это. */
export const TAIL_BYTES = 8192;

/**
 * Сколько читать с места, которое назвал needAt: там начинается оглавление
 * MP4, а внутри него mvhd стоит первым. Восьми килобайт хватает с запасом —
 * до mvhd от начала оглавления идёт от восьми байт до сотни.
 */
export const CHUNK_BYTES = 8192;

const AUDIO = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|wma)$/i;
const VIDEO = /\.(mp4|webm|mov|avi|mkv|m4v|wmv|flv)$/i;

/** Звук это, видео или вовсе картинка. Пустая строка — не медиа. */
export function mediaKind(name) {
	if (AUDIO.test(name)) {
		return 'audio';
	}

	return VIDEO.test(name) ? 'video' : '';
}

const extensionOf = name => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();

// ————— MP3 —————

/** Битрейты по индексу заголовка кадра, кбит/с. Нулевой и пятнадцатый — «свободный» и «запрещён». */
const MP3_BITRATES = {
	// MPEG 1, слои I, II, III
	'1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
	'1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
	'1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
	// MPEG 2 и 2.5
	'2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
	'2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
	'2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};

const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Длина тега ID3v2, если он есть: десять байт заголовка плюс размер семибитными байтами. */
function id3Length(head) {
	if (head.length < 10 || head.toString('latin1', 0, 3) !== 'ID3') {
		return 0;
	}

	const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);

	// Пятый бит флагов — приписка в конце тега, ещё десять байт
	return 10 + size + ((head[5] & 0x10) ? 10 : 0);
}

/** Разбирает четырёхбайтный заголовок кадра. null — это не кадр. */
function mp3Frame(head, at) {
	if (at + 4 > head.length || head[at] !== 0xff || (head[at + 1] & 0xe0) !== 0xe0) {
		return null;
	}

	const versionBits = (head[at + 1] >> 3) & 3;
	const layerBits = (head[at + 1] >> 1) & 3;
	const bitrateIndex = head[at + 2] >> 4;
	const rateIndex = (head[at + 2] >> 2) & 3;

	// 1 — версия зарезервирована, 0 — слой зарезервирован: не кадр
	if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
		return null;
	}

	const layer = 4 - layerBits;
	const bitrate = MP3_BITRATES[`${versionBits === 3 ? 1 : 2}-${layer}`][bitrateIndex] * 1000;
	const rate = MP3_RATES[versionBits][rateIndex];

	if (!bitrate || !rate) {
		return null;
	}

	// Сэмплов в кадре: у третьего слоя вторая версия вдвое короче первой
	const samples = layer === 1 ? 384 : (layer === 2 ? 1152 : (versionBits === 3 ? 1152 : 576));
	const mono = ((head[at + 3] >> 6) & 3) === 3;

	return { bitrate, rate, samples, layer, mpeg1: versionBits === 3, mono };
}

/**
 * Длительность MP3.
 *
 * Сначала ищется заголовок Xing или VBRI — его пишут кодировщики с переменным
 * битрейтом, и в нём стоит точное число кадров, то есть точная длительность.
 * Нет его — файл считается записанным с постоянным битрейтом, и секунды
 * выходят делением размера звуковых данных на этот битрейт.
 *
 * Перед кадрами стоит тег ID3, и в него кладут обложку альбома — сотни
 * килобайт. Дочитывать их незачем: длина тега написана в его же первых десяти
 * байтах, так что вместо «дайте ещё» отвечается «начните вот отсюда» (needAt),
 * и второй заход читает восемь килобайт ровно там, где тег кончился.
 *
 * @param {Buffer} head кусок файла
 * @param {number} size размер файла целиком
 * @param {number} from с какого байта файла начинается head. Ноль — начало,
 *        и тогда тег ID3 разбирается; иначе кусок уже начинается со звука
 */
function mp3Duration(head, size, from = 0) {
	const skip = from === 0 ? id3Length(head) : from;

	if (skip - from >= head.length) {
		return { needAt: skip };
	}

	// Кадр ищется от конца тега: между тегом и первым кадром попадается мусор
	for (let at = skip - from; at < head.length - 4 && at < skip - from + 8192; at++) {
		const frame = mp3Frame(head, at);

		if (!frame) {
			continue;
		}

		// Смещение Xing внутри кадра — это длина служебной части, и она разная
		// у моно и стерео и у разных версий MPEG
		const sideInfo = frame.mpeg1 ? (frame.mono ? 17 : 32) : (frame.mono ? 9 : 17);
		const tag = head.toString('latin1', at + 4 + sideInfo, at + 8 + sideInfo);

		if (tag === 'Xing' || tag === 'Info') {
			const flags = head.readUInt32BE(at + 8 + sideInfo);

			if ((flags & 1) && at + 16 + sideInfo <= head.length) {
				const frames = head.readUInt32BE(at + 12 + sideInfo);

				if (frames > 0) {
					return { seconds: frames * frame.samples / frame.rate };
				}
			}
		}

		if (head.toString('latin1', at + 36, at + 40) === 'VBRI' && at + 54 <= head.length) {
			const frames = head.readUInt32BE(at + 50);

			if (frames > 0) {
				return { seconds: frames * frame.samples / frame.rate };
			}
		}

		return { seconds: Math.max(0, size - skip) * 8 / frame.bitrate };
	}

	return null;
}

// ————— AAC россыпью (ADTS) —————

/** Частоты по индексу в заголовке ADTS. */
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/**
 * Длительность голого потока AAC — того, что лежит кадрами ADTS, без всякой
 * коробки вокруг.
 *
 * Такие файлы попадаются под именем `.m4a`, и это не ошибка автора пака:
 * телефоны и онлайновые резалки выдают их именно так. Внутри же не ISO-BMFF
 * вовсе, а поток кадров, и разбор коробок на нём выдаёт мусор с длиной
 * в четыре гигабайта — узнаётся такой файл по первым двум байтам (0xFFF…),
 * а не по имени.
 *
 * Секунды считаются как у MP3 с постоянным битрейтом: в кадре ровно 1024
 * сэмпла, длина кадра написана в его заголовке, а сколько таких кадров
 * в файле — это его размер, делённый на эту длину. У переменного битрейта
 * выходит оценка, и для «сколько тянется вопрос» её хватает.
 */
function adtsDuration(head, size) {
	if (head.length < 7 || head[0] !== 0xff || (head[1] & 0xf6) !== 0xf0) {
		return null;
	}

	const rate = AAC_RATES[(head[2] >> 2) & 0x0f];
	const frameLength = ((head[3] & 0x03) << 11) | (head[4] << 3) | (head[5] >> 5);
	// Блоков в кадре обычно один; каждый — те самые 1024 сэмпла
	const samples = 1024 * ((head[6] & 0x03) + 1);

	if (!rate || frameLength < 7 || size <= 0) {
		return null;
	}

	return (size / frameLength) * samples / rate;
}

// ————— MP4, M4A, MOV —————

/**
 * Обходит коробки ISO-BMFF на одном уровне и зовёт разбор для каждой.
 * Возвращает то, что вернул разбор, или null.
 */
function walkBoxes(buffer, from, to, visit) {
	let at = from;

	while (at + 8 <= to) {
		let size = buffer.readUInt32BE(at);
		const type = buffer.toString('latin1', at + 4, at + 8);
		let body = at + 8;

		if (size === 1) {
			if (at + 16 > to) {
				return null;
			}

			size = Number(buffer.readBigUInt64BE(at + 8));
			body = at + 16;
		} else if (size === 0) {
			size = to - at;
		}

		if (size < 8) {
			return null;
		}

		const found = visit(type, body, Math.min(to, at + size));

		if (found !== undefined && found !== null) {
			return found;
		}

		at += size;
	}

	return null;
}

/**
 * Тиков и тиков в секунде — из коробки mvhd, чьё тело начинается со смещения body.
 *
 * Порядок полей в ней зависит от версии: нулевая пишет времена по четыре байта,
 * первая — по восемь, и оттого timescale стоит в разных местах.
 */
function mvhdParts(buffer, body) {
	const version = buffer[body];
	const at = body + (version === 1 ? 20 : 12);
	const wide = version === 1;

	if (at + (wide ? 12 : 8) > buffer.length) {
		return null;
	}

	const timescale = buffer.readUInt32BE(at);
	const duration = wide ? Number(buffer.readBigUInt64BE(at + 4)) : buffer.readUInt32BE(at + 4);

	if (timescale <= 0) {
		return null;
	}

	// 0xffffffff — «длительность неизвестна», так пишут в потоковых файлах;
	// для нас это то же самое, что ноль, — оба значат «здесь не записано»
	return { timescale, duration: duration === 0xffffffff ? 0 : duration };
}

/** Секунды из mvhd — там, где кроме неё смотреть нечего (поиск по сигнатуре). */
function mvhdSeconds(buffer, body) {
	const parts = mvhdParts(buffer, body);

	return parts && parts.duration > 0 ? parts.duration / parts.timescale : null;
}

/**
 * Длительность из коробки moov, чьё тело лежит в buffer от body до end.
 *
 * Обычно её говорит mvhd, и на этом всё. Но у файла, нарезанного на фрагменты
 * (fMP4 — так пишут всё, что готовили для потокового вещания), в mvhd стоит
 * ноль: содержимого на момент записи заголовка ещё не было. Тогда длительность
 * ищется в mvex/mehd — это и есть «сколько получится, когда все фрагменты
 * сложатся».
 *
 * Нет и его — файл остаётся неизмеренным, и это честно: сложить фрагменты
 * можно только прочитав файл целиком, а ровно этого мы здесь и не делаем.
 */
function moovSeconds(buffer, body, end) {
	let timescale = 0;
	let duration = 0;
	let fragments = 0;

	walkBoxes(buffer, body, end, (type, at, boxEnd) => {
		if (type === 'mvhd') {
			const parts = mvhdParts(buffer, at);

			if (parts) {
				timescale = parts.timescale;
				duration = parts.duration;
			}
		} else if (type === 'mvex') {
			walkBoxes(buffer, at, boxEnd, (inner, innerAt) => {
				if (inner === 'mehd' && innerAt + 12 <= buffer.length) {
					fragments = buffer[innerAt] === 1
						? Number(buffer.readBigUInt64BE(innerAt + 4))
						: buffer.readUInt32BE(innerAt + 4);
				}

				return null;
			});
		}

		return null;
	});

	const ticks = duration || fragments;

	return timescale > 0 && ticks > 0 ? ticks / timescale : null;
}

/**
 * Длительность MP4 и родственников.
 *
 * Оглавление (moov) лежит либо в начале файла, либо после самого содержимого:
 * у файлов, подготовленных для потока, оно впереди, у записанных как есть —
 * позади, за коробкой mdat в десятки мегабайт. Первый случай разбирается
 * прямо здесь.
 *
 * Второй мог бы решаться чтением конца файла — так делают все, кто ищет moov
 * вслепую, — но конец тут не нужен вовсе. Коробки ISO-BMFF несут свою длину
 * в заголовке, и, дойдя по началу файла до mdat, мы знаем ровно то, что нужно:
 * где начинается следующая коробка. Значит, вместо гадания про размер хвоста
 * можно назвать точное место и прочитать восемь килобайт ровно там — mvhd
 * стоит внутри moov первым.
 *
 * Ради этого и заведён ответ needAt: «оглавление начинается вот здесь».
 * Гадание про хвост стоило бы сотни килобайт на файл и всё равно промахивалось
 * бы на длинных moov — у видео на четыре минуты таблица кадров легко перерастает
 * любой разумный хвост.
 */
function isoDuration(head, fileSize) {
	let at = 0;

	while (at + 8 <= head.length) {
		let size = head.readUInt32BE(at);
		const type = head.toString('latin1', at + 4, at + 8);
		let body = at + 8;

		if (size === 1) {
			if (at + 16 > head.length) {
				break;
			}

			size = Number(head.readBigUInt64BE(at + 8));
			body = at + 16;
		}

		if (size > 0 && size < 8) {
			return null;
		}

		// Коробка до конца файла: либо честный ноль, либо «сколько получится»,
		// записанное как 0xffffffff. Так пишет всё, что записывает на ходу,
		// не зная заранее итоговой длины, — диктофоны и захват экрана.
		// Следующей коробки за такой нет, и вычислить её место нечем:
		// если оглавление не здесь, остаётся смотреть конец файла
		if (size === 0 || (fileSize > 0 && at + size > fileSize)) {
			if (type !== 'moov') {
				return { needTail: true };
			}

			const seconds = moovSeconds(head, body, head.length);

			return seconds ? { seconds } : null;
		}

		if (type === 'moov') {
			const seconds = moovSeconds(head, body, Math.min(head.length, at + size));

			return seconds ? { seconds } : null;
		}

		at += size;
	}

	// Начало кончилось раньше оглавления. Место следующей коробки известно
	// точно — за ним и пойдём
	if (at + 8 > head.length && (fileSize === 0 || at + 8 < fileSize)) {
		return { needAt: at };
	}

	return null;
}

/**
 * Длительность из куска, прочитанного с того самого места, которое назвал
 * needAt: там начинается очередная коробка.
 *
 * Коробка эта не обязана быть moov — за mdat иногда стоит free или ещё один
 * mdat, — поэтому кусок обходится теми же правилами, что и начало файла.
 * А если обход упёрся в границу куска, остаётся поиск mvhd по сигнатуре:
 * лучше приблизительно найденное оглавление, чем неизмеренный файл.
 */
function isoChunkDuration(chunk) {
	const found = walkBoxes(chunk, 0, chunk.length, (type, body, end) =>
		(type === 'moov' ? moovSeconds(chunk, body, end) : null));

	if (found) {
		return found;
	}

	const at = chunk.lastIndexOf('mvhd');

	return at < 4 ? null : mvhdSeconds(chunk, at + 4);
}

// ————— Ogg, Opus —————

/**
 * Частота, по которой считается номер сэмпла в Ogg, и сколько сэмплов
 * в начале файла не звучат.
 *
 * У Opus номер всегда считается по сорока восьми килогерцам, какая бы частота
 * ни была записана в самом потоке, — так устроен формат. У Vorbis частота своя,
 * и лежит она в опознавательном заголовке.
 */
function oggRate(head) {
	const opus = head.indexOf('OpusHead');

	if (opus >= 0 && opus + 12 <= head.length) {
		return { rate: 48000, skip: head.readUInt16LE(opus + 10) };
	}

	const vorbis = head.indexOf('vorbis', 0, 'latin1');

	if (vorbis >= 0 && vorbis + 16 <= head.length) {
		return { rate: head.readUInt32LE(vorbis + 12), skip: 0 };
	}

	return null;
}

/** Номер последнего сэмпла — из последней страницы Ogg в куске из конца файла. */
function oggGranule(tail) {
	for (let at = tail.length - 27; at >= 0; at--) {
		if (tail.toString('latin1', at, at + 4) === 'OggS') {
			const granule = tail.readBigUInt64LE(at + 6);

			// 0xffff… значит «страница без завершённого пакета» — не последняя
			if (granule !== 0xffffffffffffffffn) {
				return Number(granule);
			}
		}
	}

	return null;
}

// ————— WAV —————

function wavDuration(head) {
	if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') {
		return null;
	}

	let byteRate = 0;
	let at = 12;

	while (at + 8 <= head.length) {
		const id = head.toString('latin1', at, at + 4);
		const size = head.readUInt32LE(at + 4);

		if (id === 'fmt ' && at + 16 <= head.length) {
			byteRate = head.readUInt32LE(at + 12);
		}

		if (id === 'data') {
			return byteRate > 0 ? size / byteRate : null;
		}

		// Куски выровнены по чётной границе
		at += 8 + size + (size % 2);
	}

	return null;
}

// ————— FLAC —————

function flacDuration(head) {
	if (head.toString('latin1', 0, 4) !== 'fLaC' || head.length < 42) {
		return null;
	}

	// Первый блок метаданных обязан быть STREAMINFO, его тело — с 8-го байта
	const packed = head.readBigUInt64BE(18);
	const rate = Number(packed >> 44n) & 0xfffff;
	const samples = Number(packed & 0xfffffffffn);

	return rate > 0 && samples > 0 ? samples / rate : null;
}

// ————— WebM, MKV —————

/** Читает число переменной длины EBML. Возвращает значение и сколько байт заняло. */
function ebmlNumber(buffer, at, keepMarker) {
	if (at >= buffer.length) {
		return null;
	}

	const first = buffer[at];

	if (first === 0) {
		return null;
	}

	let length = 1;

	while (length <= 8 && !(first & (0x80 >> (length - 1)))) {
		length++;
	}

	if (length > 8 || at + length > buffer.length) {
		return null;
	}

	let value = keepMarker ? first : first & (0xff >> length);

	for (let i = 1; i < length; i++) {
		value = value * 256 + buffer[at + i];
	}

	return { value, length };
}

/**
 * Длительность WebM и MKV: поле Duration внутри Info, умноженное
 * на TimecodeScale (по умолчанию миллион наносекунд, то есть миллисекунда).
 *
 * Обход тут поверхностный нарочно: спускаемся только в Segment и в Info,
 * а всё остальное перешагиваем по длине. Дорожки, метки и тем более сами
 * кадры разбирать незачем — и хорошо, что незачем: в начале файла их
 * всё равно нет.
 */
function matroskaDuration(head) {
	const DESCEND = new Set([0x18538067, 0x1549a966]);
	let scale = 1000000;
	let duration = null;

	const walk = (from, to) => {
		let at = from;

		while (at < to) {
			const id = ebmlNumber(head, at, true);

			if (!id) {
				return;
			}

			const size = ebmlNumber(head, at + id.length, false);

			if (!size) {
				return;
			}

			const body = at + id.length + size.length;
			const end = Math.min(to, body + size.value);

			if (DESCEND.has(id.value)) {
				walk(body, end);
			} else if (id.value === 0x2ad7b1 && end <= head.length) {
				let value = 0;

				for (let i = body; i < end; i++) {
					value = value * 256 + head[i];
				}

				scale = value || scale;
			} else if (id.value === 0x4489 && end <= head.length) {
				duration = end - body === 4 ? head.readFloatBE(body) : head.readDoubleBE(body);
			}

			at = body + size.value;
		}
	};

	walk(0, head.length);

	return duration === null ? null : duration * scale / 1e9;
}

// ————— AVI —————

function aviDuration(head) {
	if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'AVI ') {
		return null;
	}

	const at = head.indexOf('avih');

	if (at < 0 || at + 28 > head.length) {
		return null;
	}

	const microsPerFrame = head.readUInt32LE(at + 8);
	const frames = head.readUInt32LE(at + 24);

	return microsPerFrame > 0 && frames > 0 ? microsPerFrame * frames / 1e6 : null;
}

// ————— ASF: WMV и WMA —————

/** Начало заголовка ASF и начало его же «свойств файла» — оба GUID'а как байты. */
const ASF_HEADER = Buffer.from('3026b2758e66cf11a6d900aa0062ce6c', 'hex');
const ASF_PROPERTIES = Buffer.from('a1dcab8c47a9cf118ee400c00c205365', 'hex');

/**
 * Длительность WMV и WMA.
 *
 * Формат микрософтовский и снаружи ни на что не похож: файл начинается
 * шестнадцатибайтным GUID'ом, а не четырьмя буквами, и всё внутри устроено
 * так же. Нужен один вложенный объект — «свойства файла»: в нём длительность
 * записана прямым числом в стонаносекундных долях, а рядом стоит задержка
 * перед началом воспроизведения, которую из неё положено вычесть.
 *
 * Файлов этих в паках немного, но там, где они есть, их обычно целая тема:
 * автор один раз собрал папку и залил её всю.
 */
function asfDuration(head) {
	if (head.length < 30 || !head.subarray(0, 16).equals(ASF_HEADER)) {
		return null;
	}

	const at = head.indexOf(ASF_PROPERTIES);

	// Длительность лежит за FileID, размером файла, датой создания и числом
	// пакетов — то есть в шестидесяти четырёх байтах от начала объекта
	if (at < 0 || at + 88 > head.length) {
		return null;
	}

	const hundredNanos = Number(head.readBigUInt64LE(at + 64));
	const preroll = Number(head.readBigUInt64LE(at + 80));
	const seconds = hundredNanos / 1e7 - preroll / 1000;

	return seconds > 0 ? seconds : null;
}

/**
 * Длительность файла по его началу.
 *
 * @param {string} name имя файла — по расширению выбирается разбор
 * @param {Buffer} head первые байты файла
 * @param {number} size размер файла целиком (нужен MP3 с постоянным битрейтом)
 * @returns {{seconds: number}|{needTail: true}|{needAt: number}|null}
 *          сколько длится; либо чего для этого не хватило — конец файла
 *          или кусок с названного места; либо null — «этот формат мы
 *          не читаем», и файл в счёт не идёт
 */
export function probeDuration(name, head, size) {
	if (!head || head.length < 16) {
		return null;
	}

	const wrap = seconds => (Number.isFinite(seconds) && seconds > 0 ? { seconds } : null);

	switch (extensionOf(name)) {
		case 'mp3':
			return mp3Duration(head, size);
		case 'mp4':
		case 'm4a':
		case 'm4v':
		case 'mov':
		case 'aac':
			// Имя говорит «коробка», а внутри бывает голый поток кадров:
			// решает содержимое, а не расширение
			return wrap(adtsDuration(head, size)) ?? isoDuration(head, size);
		case 'ogg':
		case 'oga':
		case 'opus':
			return { needTail: true };
		case 'wav':
			return wrap(wavDuration(head));
		case 'flac':
			return wrap(flacDuration(head));
		case 'webm':
		case 'mkv':
			return wrap(matroskaDuration(head));
		case 'avi':
			return wrap(aviDuration(head));
		case 'wma':
		case 'wmv':
			return wrap(asfDuration(head));
		default:
			return null;
	}
}

/**
 * Длительность файла, которому не хватило начала: досчитывается по концу.
 *
 * Так устроен Ogg — номер последнего сэмпла лежит на последней странице.
 * Сюда же попадает MP4, у которого содержимое записано коробкой «до конца
 * файла»: место оглавления по такой не вычислить, и остаётся искать mvhd
 * в конце по сигнатуре.
 *
 * @returns {number|null} секунды
 */
export function probeDurationTail(name, head, tail) {
	if (!tail || tail.length < 16) {
		return null;
	}

	const extension = extensionOf(name);

	if (extension !== 'ogg' && extension !== 'oga' && extension !== 'opus') {
		const seconds = isoChunkDuration(tail);

		return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
	}

	const stream = oggRate(head);
	const granule = oggGranule(tail);

	if (!stream || granule === null || !stream.rate) {
		return null;
	}

	const seconds = (granule - stream.skip) / stream.rate;

	return seconds > 0 ? seconds : null;
}

/**
 * Длительность из куска, прочитанного с места, которое назвал needAt.
 *
 * Мест таких два, и оба точные: у MP3 это первый байт за тегом ID3, у MP4 —
 * начало коробки, до которой не дотянулось прочитанное начало. Ни там, ни там
 * гадать не приходится — оба формата сами говорят, где кончается то, что нам
 * не нужно.
 *
 * @param {string} name имя файла
 * @param {Buffer} chunk кусок, начинающийся с байта from
 * @param {number} size размер файла целиком
 * @param {number} from с какого байта файла кусок прочитан
 * @returns {number|null} секунды
 */
export function probeDurationAt(name, chunk, size, from) {
	if (!chunk || chunk.length < 16) {
		return null;
	}

	const seconds = extensionOf(name) === 'mp3'
		? mp3Duration(chunk, size, from)?.seconds
		: isoChunkDuration(chunk);

	return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** Имя записи архива как оно читается человеком: без percent-кодировки и без папки. */
export function plainName(name) {
	try {
		return decodeURIComponent(name);
	} catch {
		return name;
	}
}

/**
 * Сколько длится медиа в паке: среднее и самое длинное.
 *
 * ————— почему среднее, а не сумма —————
 *
 * Сумма отвечает на вопрос «сколько всего звучит», а спрашивают не это.
 * Спрашивают, сколько тянется один вопрос: тема из шести песен по минуте
 * играется вдвое дольше темы из шести по полминуты, и вот эта разница решает,
 * поместится ли пак в вечер. Сумма же у обоих может совпасть — просто тем
 * будет разное число.
 *
 * Самое длинное стоит рядом не для полноты. Средние тридцать секунд при
 * максимуме в пять минут — это не «пак с короткими отрывками», это пак,
 * в котором где-то лежит целая серия, и человек за столом будет её смотреть.
 *
 * ————— чего здесь нет —————
 *
 * Картинок. Длительности у них не бывает, и подмешивать их в среднее нулями
 * значило бы объявить любой пак с картинками коротким.
 *
 * Файлов, которые не прочитались: неизвестного формата, сжатых в архиве или
 * попросту не приехавших. Они не считаются ни нулём, ни как-нибудь ещё — их
 * просто нет в счёте, и сколько их было, видно по разнице files и total.
 *
 * @param {object} archive открытый архив (см. openRemoteZip в src/zip.js)
 * @returns {Promise<{total: number, files: number, average: number|null,
 *          longest: number|null}>} total — сколько медиафайлов в паке,
 *          files — сколько удалось измерить
 */
export async function measureMedia(archive) {
	const media = archive.entries.filter(entry => mediaKind(plainName(entry.name)));
	const empty = { total: media.length, files: 0, average: null, longest: null };

	if (media.length === 0) {
		return empty;
	}

	const seconds = [];
	const sizeOf = entry => entry.size || entry.compressedSize;

	// Кому начала не хватило: у MP3 звук лежит за тегом ID3, у MP4 оглавление —
	// за содержимым. Оба назвали точное место, так что это один короткий кусок
	// на файл, а не дочитывание вслепую
	const pointed = [];
	// Ogg: номер последнего сэмпла лежит на последней странице файла
	const tailed = [];
	const heads = await archive.heads(media, HEAD_BYTES);

	for (const entry of media) {
		const head = heads.get(entry);

		if (!head) {
			continue;
		}

		const name = plainName(entry.name);
		const probe = probeDuration(name, head.data, sizeOf(entry));

		if (probe?.seconds) {
			seconds.push(probe.seconds);
		} else if (probe?.needTail) {
			tailed.push({ entry, dataStart: head.dataStart, head: head.data });
		} else if (probe?.needAt) {
			pointed.push({ entry, dataStart: head.dataStart, from: probe.needAt, bytes: CHUNK_BYTES });
		}
	}

	if (tailed.length > 0) {
		const tails = await archive.tails(tailed, TAIL_BYTES);

		for (const item of tailed) {
			const value = probeDurationTail(plainName(item.entry.name), item.head, tails.get(item.entry));

			if (value) {
				seconds.push(value);
			}
		}
	}

	if (pointed.length > 0) {
		const chunks = await archive.slices(pointed);

		for (const item of pointed) {
			const value = probeDurationAt(plainName(item.entry.name), chunks.get(item.entry),
				sizeOf(item.entry), item.from);

			if (value) {
				seconds.push(value);
			}
		}
	}

	if (seconds.length === 0) {
		return empty;
	}

	return {
		total: media.length,
		files: seconds.length,
		average: seconds.reduce((sum, value) => sum + value, 0) / seconds.length,
		longest: Math.max(...seconds),
	};
}
