// Чтение одного файла из ZIP-архива по сети через range-запросы.
// Позволяет достать content.xml из пака на 100 МБ, скачав пару десятков килобайт.

import zlib from 'node:zlib';

import { config } from './config.js';

/**
 * Сколько байт вообще разрешено получить из одной записи архива.
 *
 * Не «столько бывает», а «дальше это уже не пак»: самый большой настоящий
 * content.xml в базе меньше на порядки. Потолок нужен затем, что вход сюда —
 * чужой файл из обсуждения, а deflate сжимает нули с плотностью тысяча к одному
 * (см. места вызова inflateRawSync ниже).
 */
const UNPACK_LIMIT = 64 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD64_SIGNATURE = 0x06064b50;
const MAX_EOCD_SIZE = 65557;

/**
 * Сколько лишнего берём за локальным заголовком в надежде накрыть его целиком
 * (см. read). Поле extra там обычно пустое или в несколько десятков байт;
 * четверти килобайта хватает всегда, а стоит она нисколько.
 */
const LOCAL_EXTRA_SLACK = 256;

/** ВК отдаёт HTML вместо файла, когда документ удалён или скрыт. */
export class DeadLinkError extends Error {
	constructor() {
		super('ссылка недоступна: документ удалён или скрыт');
		this.name = 'DeadLinkError';
	}
}

/**
 * Хранилище ВК ответило ошибкой сервера: подписанная ссылка протухла.
 *
 * ————— чем это отличается от мёртвой ссылки и почему различать обязательно —————
 *
 * Внешне ничем: и там и там вместо файла приезжает страница с HTML, и до сих
 * пор разбор смотрел ровно на это — «content-type: text/html» значило «документ
 * удалён». Разница в коде ответа, и она решающая.
 *
 * Удалённый документ ВК отдаёт двухсотым с HTML своей страницы ошибки — это
 * и вправду насовсем. А вот протухшая подпись выглядит иначе: vk.com честно
 * переправляет на psv4.userapi.com, и уже оттуда приходит 502 с той же самой
 * страницей ошибки. Файл при этом на месте и прекрасно открывается — по свежей
 * ссылке, которую ВК выдаёт по первому запросу (см. refreshDocumentUrl).
 *
 * Пока эти два случая были одним, второй лечиться не мог вовсе. Свежую ссылку
 * просит только withFreshUrl и только на мёртвой ссылке — то есть просил и здесь,
 * — но пак при этом уже был объявлен мёртвым: разбор ставил ему status='dead'
 * и убирал с сайта живой пак. Так стояло с паком 2291 («39. Офицеры»): отпечатки
 * вопросов у него не снимались с апреля, версия свёртки осталась первой, а сам
 * файл всё это время лежал в теме и открывался.
 *
 * Поэтому 5xx (и 429 — «слишком часто») теперь свой случай: ссылку обновить,
 * попытку повторить, а пак не хоронить (см. withFreshUrl и retryNetwork
 * в src/indexer/pipeline.js).
 */
export class StaleLinkError extends Error {
	constructor(status) {
		super(`хранилище ВК ответило ${status}: ссылка протухла`);
		this.name = 'StaleLinkError';
		this.status = status;
	}
}

/**
 * Ответ, по которому судить о самом файле нельзя: виноват не он, а сервер
 * или наша частота обращений. Проверяется раньше content-type нарочно —
 * страница ошибки приезжает с тем же «text/html», что и «документ удалён»
 * (см. StaleLinkError).
 */
const serverHiccup = status => status >= 500 || status === 429;

async function fetchRange(url, from, to) {
	const response = await fetch(url, {
		headers: {
			'User-Agent': config.userAgent,
			Range: `bytes=${from}-${to}`,
		},
		signal: AbortSignal.timeout(config.rangeTimeout),
	});

	if (serverHiccup(response.status)) {
		throw new StaleLinkError(response.status);
	}

	if (response.status !== 206 && response.status !== 200) {
		throw new Error(`HTTP ${response.status} при чтении ${from}-${to}`);
	}

	return Buffer.from(await response.arrayBuffer());
}

/**
 * Сколько кусков просим одним запросом. Не предел протокола, а вежливость:
 * заголовок Range со ста диапазонами — это пара килобайт заголовка, и сервер
 * вправе на него обидеться. Полусотни хватает, чтобы у обычного пака все
 * медиафайлы уехали в один-два запроса.
 */
const MAX_RANGES = 50;

/** Граница между кусками multipart/byteranges: «--boundary». */
const boundaryOf = contentType => {
	const match = /boundary=("?)([^";,\s]+)\1/i.exec(contentType ?? '');

	return match ? match[2] : null;
};

/**
 * Разбирает ответ multipart/byteranges на куски: каждый со своим смещением,
 * взятым из его собственного Content-Range.
 *
 * Смещение читается из ответа, а не подставляется по порядку запроса, нарочно:
 * сервер вправе слить соседние диапазоны в один кусок и вправе отдать их
 * не в том порядке, в каком просили. Разбирать такой ответ «по счёту» значило бы
 * однажды приписать одному файлу начало другого.
 */
function parseByteRanges(buffer, boundary) {
	const parts = [];
	const mark = Buffer.from(`--${boundary}`);
	let at = buffer.indexOf(mark);

	while (at >= 0) {
		const headerStart = at + mark.length;

		// «--boundary--» — конец, дальше ничего нет
		if (buffer.subarray(headerStart, headerStart + 2).toString('latin1') === '--') {
			break;
		}

		const bodyStart = buffer.indexOf('\r\n\r\n', headerStart);

		if (bodyStart < 0) {
			break;
		}

		const headers = buffer.subarray(headerStart, bodyStart).toString('latin1');
		const next = buffer.indexOf(mark, bodyStart + 4);
		// Перед следующей границей стоит CRLF, и телу куска он не принадлежит
		const bodyEnd = next < 0 ? buffer.length : next - 2;
		const range = /content-range:\s*bytes\s+(\d+)-(\d+)/i.exec(headers);

		if (range) {
			parts.push({ from: Number(range[1]), data: buffer.subarray(bodyStart + 4, bodyEnd) });
		}

		at = next;
	}

	return parts;
}

/**
 * Понимает ли хранилище составной диапазон. null — ещё не пробовали.
 *
 * Одно на весь запуск, а не на архив: отвечает-то одно и то же хранилище.
 * Ради этого флаг и заведён — неудачная попытка стоит секунды, и повторять её
 * на каждом из одиннадцати тысяч паков значило бы выбросить три часа
 * на выяснение того, что уже выяснено.
 *
 * У ВК ответ, к сожалению, «нет»: составной диапазон он понимает, но отдаёт
 * не больше нескольких килобайт разом, а на просьбе покрупнее просто рвёт
 * соединение. Флаг переживёт это молча и один раз.
 */
let multipartWorks = null;

/**
 * Несколько кусков файла — по возможности одним запросом.
 *
 * Ради этого и заведено: у пака полсотни медиафайлов, а длительность каждого
 * читается из первых килобайт (см. src/duration.js). Полсотни отдельных
 * range-запросов — это полсотни походов к ВК по секунде каждый. Тот же набор
 * кусков, запрошенный одним заголовком Range, приезжает одним ответом
 * multipart/byteranges за полторы секунды — там, где сервер это умеет.
 *
 * Обязанностью сервера это не является, и рассчитывать на это нельзя.
 * Поэтому: пробуем один раз за запуск, а дальше либо пользуемся, либо ходим
 * по одному куску, как ходили всегда. Не приехавший кусок не роняет остальные:
 * про него спрашивавший просто ничего не узнает, и один нечитаемый файл
 * не отменяет измерения всего пака.
 *
 * @param {string} url
 * @param {Array<{from: number, to: number}>} ranges
 * @returns {Promise<Array<{from: number, data: Buffer}>>} куски со своими смещениями
 */
export async function fetchRanges(url, ranges) {
	if (ranges.length === 0) {
		return [];
	}

	const parts = [];

	/** Кусок приехал, если что-то накрывает его начало. */
	const covered = range => parts.some(part => part.from <= range.from
		&& part.from + part.data.length > range.from);

	for (let at = 0; at < ranges.length; at += MAX_RANGES) {
		const batch = ranges.slice(at, at + MAX_RANGES);

		if (batch.length > 1 && multipartWorks !== false) {
			const before = parts.length;

			try {
				const header = batch.map(range => `${range.from}-${range.to}`).join(', ');
				const response = await fetch(url, {
					headers: { 'User-Agent': config.userAgent, Range: `bytes=${header}` },
					signal: AbortSignal.timeout(config.rangeTimeout),
				});

				const boundary = response.status === 206
					? boundaryOf(response.headers.get('content-type'))
					: null;

				if (boundary) {
					parts.push(...parseByteRanges(Buffer.from(await response.arrayBuffer()), boundary));
				}
			} catch {
				// Оборванное соединение — тот же ответ «не умею», только грубее
			}

			// Умеет тот, кто прислал больше одного куска. Один кусок на просьбу
			// о полусотне — это «не понял и отдал первый», и пользы в этом нет
			multipartWorks = parts.length - before > 1;
		}

		for (const range of batch) {
			if (covered(range)) {
				continue;
			}

			try {
				parts.push({ from: range.from, data: await fetchRange(url, range.from, range.to) });
			} catch {
				// Не приехало — значит, про этот кусок спрашивавший ничего
				// не узнает. Терять из-за одного файла весь пак незачем
			}
		}
	}

	return parts;
}

/**
 * Хвост файла одним запросом — вместе с его полным размером.
 *
 * Обычный диапазон «от такого-то байта» тут не годится: чтобы посчитать, где
 * начинается хвост, надо сперва узнать размер, а это ещё один поход к серверу.
 * Запись «bytes=-N» просит последние N байт, не зная длины файла вовсе, а размер
 * приезжает в ответном content-range: «bytes 58836106-58901662/58901663».
 *
 * Ради одного сбережённого запроса это не стоило бы делать, но у ВК каждый поход
 * стоит от полусекунды до трёх независимо от того, байт в нём или сто килобайт
 * (см. комментарий к parsePackages в indexer.js). Здесь экономится не трафик,
 * а именно поход.
 */
async function fetchTail(url, length) {
	const response = await fetch(url, {
		headers: { 'User-Agent': config.userAgent, Range: `bytes=-${length}` },
	});

	if (serverHiccup(response.status)) {
		throw new StaleLinkError(response.status);
	}

	if ((response.headers.get('content-type') ?? '').startsWith('text/html')) {
		throw new DeadLinkError();
	}

	if (response.status !== 206 && response.status !== 200) {
		throw new Error(`HTTP ${response.status} при чтении хвоста файла`);
	}

	const buffer = Buffer.from(await response.arrayBuffer());
	const contentRange = response.headers.get('content-range');
	const match = contentRange ? /\/(\d+)\s*$/.exec(contentRange) : null;

	// Диапазон поняли: пришёл ровно хвост, и размер сказали в заголовке
	if (response.status === 206 && match) {
		const totalSize = Number(match[1]);

		if (Number.isFinite(totalSize) && totalSize >= buffer.length) {
			return { buffer, totalSize, tailStart: totalSize - buffer.length };
		}
	}

	// Диапазон не поняли и прислали файл целиком. Лишний трафик, но искать
	// оглавление в нём можно там же, где и в хвосте, — просто хвост тут весь файл.
	return { buffer, totalSize: buffer.length, tailStart: 0 };
}

/** Возвращает размер файла, не скачивая его. */
export async function getRemoteSize(url) {
	const response = await fetch(url, {
		headers: { 'User-Agent': config.userAgent, Range: 'bytes=0-0' },
	});

	if (serverHiccup(response.status)) {
		throw new StaleLinkError(response.status);
	}

	if ((response.headers.get('content-type') ?? '').startsWith('text/html')) {
		throw new DeadLinkError();
	}

	if (response.status === 206) {
		const contentRange = response.headers.get('content-range');

		if (contentRange) {
			const size = parseInt(contentRange.split('/')[1], 10);

			if (Number.isFinite(size)) {
				return size;
			}
		}
	}

	if (response.status === 200) {
		const length = response.headers.get('content-length');

		if (length) {
			return parseInt(length, 10);
		}
	}

	throw new Error(`не удалось узнать размер файла (HTTP ${response.status})`);
}

function readCentralDirectoryLocation(tail, tailStart, totalSize) {
	let eocd = -1;

	for (let i = tail.length - 22; i >= 0; i--) {
		if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
			eocd = i;
			break;
		}
	}

	if (eocd < 0) {
		throw new Error('это не ZIP-архив');
	}

	let size = tail.readUInt32LE(eocd + 12);
	let offset = tail.readUInt32LE(eocd + 16);

	// ZIP64: большие архивы хранят реальные значения в отдельной записи
	if (offset === 0xffffffff || size === 0xffffffff) {
		for (let i = eocd - 20; i >= 0; i--) {
			if (tail.readUInt32LE(i) === EOCD64_LOCATOR_SIGNATURE) {
				const eocd64Offset = Number(tail.readBigUInt64LE(i + 8));
				const local = eocd64Offset - tailStart;

				if (local >= 0 && local + 56 <= tail.length && tail.readUInt32LE(local) === EOCD64_SIGNATURE) {
					size = Number(tail.readBigUInt64LE(local + 40));
					offset = Number(tail.readBigUInt64LE(local + 48));
				}

				break;
			}
		}
	}

	if (!Number.isFinite(offset) || offset >= totalSize) {
		throw new Error('повреждённое оглавление архива');
	}

	return { size, offset };
}

function parseCentralDirectory(buffer) {
	const entries = [];
	let position = 0;

	while (position + 46 <= buffer.length && buffer.readUInt32LE(position) === CENTRAL_SIGNATURE) {
		const method = buffer.readUInt16LE(position + 10);
		// Контрольная сумма развёрнутого файла. Вместе с размером — ключ, по
		// которому одинаковый файл узнаётся в другом паке ещё до скачивания
		// (см. nsfw-moderation.md, раздел 2.2)
		const crc = buffer.readUInt32LE(position + 16);
		const compressedSize = buffer.readUInt32LE(position + 20);
		// Размер файла как он лежит на диске у автора пака. Нужен дважды:
		// по нему считается вес медиафайла (см. src/plagiarism.js — одинаковое имя
		// при разном весе не заимствование) и длительность CBR-звука, где секунды
		// выводятся из размера и битрейта (см. src/duration.js)
		const size = buffer.readUInt32LE(position + 24);
		const nameLength = buffer.readUInt16LE(position + 28);
		const extraLength = buffer.readUInt16LE(position + 30);
		const commentLength = buffer.readUInt16LE(position + 32);
		const localOffset = buffer.readUInt32LE(position + 42);
		const name = buffer.subarray(position + 46, position + 46 + nameLength).toString('utf8');

		entries.push({ name, method, crc, compressedSize, size, localOffset });
		position += 46 + nameLength + extraLength + commentLength;
	}

	return entries;
}

/**
 * Читает оглавление удалённого архива. Дальше из него можно доставать файлы
 * по одному, не перечитывая оглавление заново.
 * @param {string} url ссылка на архив
 */
export async function openRemoteZip(url) {
	const { buffer: tail, totalSize, tailStart } = await fetchTail(url, MAX_EOCD_SIZE);

	if (totalSize > config.maxPackageSize) {
		throw new Error(`пак слишком большой: ${Math.round(totalSize / 1024 / 1024)} МБ`);
	}

	const location = readCentralDirectoryLocation(tail, tailStart, totalSize);

	const central = location.offset >= tailStart
		? tail.subarray(location.offset - tailStart, location.offset - tailStart + location.size)
		: await fetchRange(url, location.offset, location.offset + location.size - 1);

	const entries = parseCentralDirectory(central);

	/** Ищет файл по имени. Регистр не важен, percent-кодировка тоже. */
	const find = name => {
		const variants = new Set();

		for (const candidate of [name, encodeURIComponent(name), decodeSafe(name)]) {
			variants.add(candidate.toLowerCase());
			variants.add(candidate.toLowerCase().replace(/%20/g, '+'));
		}

		return entries.find(entry => variants.has(entry.name.toLowerCase()))
			?? entries.find(entry => variants.has(decodeSafe(entry.name).toLowerCase()));
	};

	/**
	 * Скачивает и распаковывает один файл.
	 *
	 * Данные лежат сразу за локальным заголовком, а его длина заранее неизвестна:
	 * он повторяет имя файла и несёт собственное extra-поле, которое не обязано
	 * совпадать с тем, что записано в оглавлении. Честный порядок — прочитать
	 * заголовок, узнать длины, потом сходить за данными, — стоит двух походов
	 * к серверу, и это ровно вдвое дороже самих данных: у ВК поход стоит секунду
	 * с лишним независимо от размера.
	 *
	 * Поэтому берём сразу с запасом: заголовок с полем extra любого разумного
	 * размера плюс сами данные. Настоящие длины читаются уже из полученного куска,
	 * и данные из него же и вырезаются. Если запаса всё-таки не хватило —
	 * дочитываем недостающий хвост вторым запросом, то есть как раньше.
	 */
	const read = async entry => {
		if (entry.compressedSize === 0) {
			return Buffer.alloc(0);
		}

		const guess = 30 + Buffer.byteLength(entry.name, 'utf8') + LOCAL_EXTRA_SLACK;
		const head = await fetchRange(url, entry.localOffset, entry.localOffset + guess + entry.compressedSize - 1);

		if (head.length < 30) {
			throw new Error('обрезанный локальный заголовок');
		}

		const dataOffset = 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
		let raw = head.subarray(dataOffset, dataOffset + entry.compressedSize);

		if (raw.length < entry.compressedSize) {
			const from = entry.localOffset + dataOffset + raw.length;
			const rest = await fetchRange(url, from, entry.localOffset + dataOffset + entry.compressedSize - 1);
			raw = Buffer.concat([raw, rest]);
		}

		// Потолок на развёрнутое — от зип-бомбы. Плотность сжатия у deflate
		// доходит до тысячи к одному: десять мегабайт content.xml разворачиваются
		// в десять гигабайт, и Node падает по памяти — а выложить такой пак
		// в обсуждение может кто угодно (разбор от 02.09.2026). Шестьдесят
		// четыре мегабайта — с большим запасом больше любого настоящего
		// content.xml; переполнение возвращается обычной ошибкой и ловится там же,
		// где ловятся прочие кривые архивы.
		return entry.method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: UNPACK_LIMIT });
	};

	/**
	 * Начала сразу многих записей — одним запросом на всех.
	 *
	 * Нужны тому, кто читает не файл, а его заголовок: длительность звука или
	 * видео лежит в первых килобайтах (см. src/duration.js), и качать ради неё
	 * сорокамегабайтный файл незачем. Сложность тут одна: где именно начинаются
	 * данные, оглавление не говорит — перед ними стоит локальный заголовок
	 * со своим полем extra, и длину его знает только он сам. Поэтому просится
	 * заголовок с запасом вместе с нужным началом, а настоящее смещение
	 * читается уже из полученного куска — ровно как в read выше.
	 *
	 * Сжатые записи (метод 8) читаются тоже, и это не мелочь: авторы паков
	 * нет-нет да и сжимают папку Audio целиком, и таких паков в библиотеке
	 * хватает — у одного из встреченных сжаты сорок файлов из сорока двух.
	 * Поток deflate распаковывается ровно настолько, насколько его прислали:
	 * обрыв посреди потока — не ошибка, а ожидаемый конец куска (Z_SYNC_FLUSH).
	 * Начало файла из него выходит целым, а больше начала здесь и не нужно.
	 *
	 * @param {Array<object>} wanted записи из оглавления
	 * @param {number} bytes сколько байт от начала каждой записи нужно
	 * @returns {Promise<Map<object, {data: Buffer, dataStart: number}>>} по записи
	 *          на ключ; отсутствие ключа значит «не приехало», а не «пусто»
	 */
	const heads = async (wanted, bytes) => {
		const usable = wanted.filter(entry => entry.compressedSize > 0);
		const ranges = usable.map(entry => ({
			from: entry.localOffset,
			to: entry.localOffset + 30 + Buffer.byteLength(entry.name, 'utf8') + LOCAL_EXTRA_SLACK
				+ Math.min(bytes, entry.compressedSize) - 1,
		}));

		const parts = await fetchRanges(url, ranges);
		const result = new Map();

		for (const entry of usable) {
			const part = parts.find(item => item.from <= entry.localOffset
				&& item.from + item.data.length > entry.localOffset + 30);

			if (!part) {
				continue;
			}

			const head = part.data.subarray(entry.localOffset - part.from);
			const dataOffset = 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
			const raw = head.subarray(dataOffset, dataOffset + Math.min(bytes, entry.compressedSize));
			let data = raw;

			if (entry.method !== 0) {
				try {
					data = zlib.inflateRawSync(raw,
						{ finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: UNPACK_LIMIT });
				} catch {
					// Не поток deflate или обрыв в самом неудачном месте: у этой
					// записи начала просто нет, и спрашивавший о ней не узнает
					continue;
				}
			}

			result.set(entry, { data, dataStart: entry.localOffset + dataOffset });
		}

		return result;
	};

	/**
	 * Куски записей с названного места по уже известным смещениям их данных.
	 *
	 * Отдельно от heads потому, что смещение данных до heads неизвестно:
	 * его считает локальный заголовок, а его ещё надо прочитать. Нужны эти
	 * куски тем, кто по началу файла понял, где лежит остальное: у MP4
	 * оглавление стоит за содержимым, и место его известно точно
	 * (см. needAt в src/duration.js).
	 *
	 * Только для несжатых записей: у сжатой смещение внутри распакованного
	 * файла не совпадает со смещением в архиве никак.
	 *
	 * @param {Array<{entry: object, dataStart: number, from: number, bytes: number}>} wanted
	 *        from — смещение внутри самого файла, а не внутри архива
	 */
	const slices = async wanted => {
		const usable = wanted.filter(item => item.entry.method === 0
			&& item.from >= 0 && item.from < item.entry.compressedSize);

		const ranges = usable.map(item => ({
			from: item.dataStart + item.from,
			to: item.dataStart + Math.min(item.entry.compressedSize, item.from + item.bytes) - 1,
		}));

		const parts = await fetchRanges(url, ranges);
		const result = new Map();

		usable.forEach((item, index) => {
			const want = ranges[index];
			const part = parts.find(candidate => candidate.from <= want.from
				&& candidate.from + candidate.data.length > want.from);

			if (part) {
				result.set(item.entry, part.data.subarray(want.from - part.from, want.to + 1 - part.from));
			}
		});

		return result;
	};

	/**
	 * Концы записей — тот же slices, только место считается от конца файла.
	 * Нужны Ogg: номер последнего сэмпла лежит на последней странице.
	 *
	 * @param {Array<{entry: object, dataStart: number}>} wanted
	 * @param {number} bytes сколько байт от конца записи нужно
	 */
	const tails = (wanted, bytes) => slices(wanted.map(item => ({
		...item,
		from: Math.max(0, item.entry.compressedSize - bytes),
		bytes,
	})));

	/**
	 * Вес каждого вложенного файла по его имени без папки: «naruto.mp3» → 3 214 887.
	 *
	 * Ключ без папки и в нижнем регистре потому, что спрашивает по нему разбор
	 * content.xml: вопрос ссылается на файл именем («@Naruto.mp3»), а в архиве
	 * тот лежит в своей папке и обычно в percent-кодировке
	 * («Audio/%D0%9D%D0%B0%D1%80%D1%83%D1%82%D0%BE.mp3»).
	 *
	 * Одноимённые файлы в разных папках — картинка и звук с одним именем —
	 * встречаются, и берётся первый: разбор всё равно спрашивает по имени,
	 * а сам вопрос не говорит, из какой файл папки. Ошибиться тут можно только
	 * в сторону «вес неизвестен», и цена ошибки — не найденное совпадение,
	 * а не выдуманное.
	 */
	const mediaSizes = () => {
		const sizes = new Map();

		for (const entry of entries) {
			const key = decodeSafe(entry.name).split('/').pop().toLowerCase();

			if (key && !sizes.has(key)) {
				sizes.set(key, entry.size || entry.compressedSize);
			}
		}

		return sizes;
	};

	return { totalSize, entries, find, read, heads, slices, tails, mediaSizes };
}

function decodeSafe(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * Достаёт один файл из удалённого ZIP-архива.
 * @param {string} url ссылка на архив
 * @param {string} entryName имя файла внутри архива, регистр не важен
 */
export async function readRemoteZipEntry(url, entryName) {
	const archive = await openRemoteZip(url);
	const entry = archive.find(entryName);

	if (!entry) {
		throw new Error(`в архиве нет ${entryName}`);
	}

	return { content: await archive.read(entry), totalSize: archive.totalSize, fileCount: archive.entries.length };
}
