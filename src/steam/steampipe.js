// Чтение .siq из Мастерской Steam через SteamPipe по 1-МБ чанкам.
//
// Только для дома и GitHub Actions: тянет node:crypto и node:zlib, в cf/src/**
// не используется. Вместо скачивания всего пака целиком (~54 МБ) получает
// ключ депо, скачивает манифест (1–5 КБ) и отдаёт в src/zip.js (openZip)
// источник диапазонов, который качает, расшифровывает (AES-256) и распаковывает
// (встроенный zlib.zstdDecompressSync) ровно те чанки, которых коснулся разбор.

import crypto from 'node:crypto';
import zlib from 'node:zlib';

import { EMSG, SteamError } from './cm.js';
import { decompressLzmaRaw } from './lzma.js';
import {
	decodeMessage,
	encodeMessage,
	fieldString,
	fieldVarint,
	formatEResult,
	getAll,
	getBigInt,
	getBool,
	getBytes,
	getFloat,
	getInt,
	getString,
	getUint,
} from './proto.js';

const MANIFEST_PAYLOAD_MAGIC = 0x71f617d0;
const MANIFEST_METADATA_MAGIC = 0x1f4812be;
const MANIFEST_SIGNATURE_MAGIC = 0x1b81b817;
const MANIFEST_END_MAGIC = 0x32c415ab;
const DEPOT_FLAG_DIRECTORY = 0x40;

const ZIP_LOCAL_MAGIC = 0x04034b50;
const ZIP_EOCD_MAGIC = 0x06054b50;
const ZIP_CENTRAL_MAGIC = 0x02014b50;

/** Запрашивает 32-байтный AES-ключ депо у CM-сервера. */
export async function getDepotDecryptionKey(cm, { depotId, appId }) {
	const req = encodeMessage([
		fieldVarint(1, depotId),
		fieldVarint(2, appId),
	]);

	const { body } = await cm.callProto(
		EMSG.ClientGetDepotDecryptionKey,
		EMSG.ClientGetDepotDecryptionKeyResponse,
		req,
	);

	const fields = decodeMessage(body);
	const eresult = getInt(fields, 1, 2);

	if (eresult !== 1) {
		throw new SteamError(
			`ключ депо ${depotId} не получен: EResult ${formatEResult(eresult)}`,
			eresult,
		);
	}

	const key = getBytes(fields, 3);

	if (!key || key.length !== 32) {
		throw new Error(`некорректная длина ключа депо ${depotId}: ${key?.length ?? 0}`);
	}

	return Buffer.from(key);
}

/** Получает список ближайших CDN-серверов SteamPipe. */
export async function getSteamPipeServers(cm, { cellId = cm.cellId || 0, maxServers = 20, appId = 3553500 } = {}) {
	const req = encodeMessage([
		fieldVarint(1, cellId),
		fieldVarint(2, maxServers),
	]);

	const res = await cm.callService('ContentServerDirectory.GetServersForSteamPipe#1', req);
	const fields = decodeMessage(res);

	const servers = getAll(fields, 1).map(item => {
		const s = decodeMessage(item.value);

		return {
			type: getString(s, 1),
			load: getInt(s, 4, 0),
			weightedLoad: getFloat(s, 5, 0),
			steamChinaOnly: getBool(s, 7, false),
			host: getString(s, 8),
			vhost: getString(s, 9),
			httpsSupport: getString(s, 12),
			allowedAppIds: getAll(s, 13).map(v => Number(v.value)),
		};
	});

	const usable = servers.filter(s => {
		if (!s.host || s.steamChinaOnly) {
			return false;
		}

		if (s.type !== 'SteamCache' && s.type !== 'CDN') {
			return false;
		}

		if (s.allowedAppIds.length > 0 && !s.allowedAppIds.includes(appId)) {
			return false;
		}

		return true;
	});

	usable.sort((a, b) => (a.weightedLoad || a.load) - (b.weightedLoad || b.load));

	if (usable.length === 0) {
		throw new Error('Steam не вернул ни одного подходящего CDN-сервера');
	}

	return usable;
}

/** Запрашивает Manifest Request Code (MRC) для скачивания манифеста с CDN. */
export async function getManifestRequestCode(cm, { appId, depotId, manifestId, branch = '' }) {
	const req = encodeMessage([
		fieldVarint(1, appId),
		fieldVarint(2, depotId),
		fieldVarint(3, BigInt(manifestId)),
		branch ? fieldString(4, branch) : null,
	]);

	const res = await cm.callService('ContentServerDirectory.GetManifestRequestCode#1', req);
	const fields = decodeMessage(res);
	const mrc = getBigInt(fields, 1, 0n);

	if (mrc === 0n) {
		throw new Error(`получен пустой Manifest Request Code для манифеста ${manifestId}`);
	}

	return mrc;
}

/** Расшифровывает данные SteamPipe (16 байт ECB → IV, остаток CBC с PKCS#7). */
export function decryptSteamData(encrypted, depotKey) {
	if (encrypted.length < 32 || encrypted.length % 16 !== 0) {
		throw new Error(`некорректная длина шифротекста SteamPipe: ${encrypted.length}`);
	}

	const ecb = crypto.createDecipheriv('aes-256-ecb', depotKey, null);
	ecb.setAutoPadding(false);
	const iv = Buffer.concat([ecb.update(encrypted.subarray(0, 16)), ecb.final()]);

	const cbc = crypto.createDecipheriv('aes-256-cbc', depotKey, iv);

	return Buffer.concat([cbc.update(encrypted.subarray(16)), cbc.final()]);
}

/** Извлекает единственный файл из однофайлового ZIP-контейнера SteamPipe. */
function extractSingleZipEntry(buf) {
	if (buf.length < 30 || buf.readUInt32LE(0) !== ZIP_LOCAL_MAGIC) {
		throw new Error('ожидался ZIP-контейнер SteamPipe');
	}

	const flags = buf.readUInt16LE(6);
	let method = buf.readUInt16LE(8);
	let compressedSize = buf.readUInt32LE(18);
	const nameLen = buf.readUInt16LE(26);
	const extraLen = buf.readUInt16LE(28);
	const dataStart = 30 + nameLen + extraLen;

	// Если выставлен флаг data descriptor (bit 3), реальный размер лежит в Central Directory
	if ((flags & 0x08) !== 0 && compressedSize === 0) {
		for (let i = buf.length - 22; i >= 0; i--) {
			if (buf.readUInt32LE(i) === ZIP_EOCD_MAGIC) {
				const cdOffset = buf.readUInt32LE(i + 16);

				if (cdOffset + 46 <= buf.length && buf.readUInt32LE(cdOffset) === ZIP_CENTRAL_MAGIC) {
					method = buf.readUInt16LE(cdOffset + 10);
					compressedSize = buf.readUInt32LE(cdOffset + 20);
				}

				break;
			}
		}
	}

	const raw = buf.subarray(dataStart, dataStart + compressedSize);

	if (method === 0) {
		return raw;
	}

	if (method === 8) {
		return zlib.inflateRawSync(raw);
	}

	throw new Error(`неподдерживаемый метод сжатия ZIP в SteamPipe: ${method}`);
}

/** Распаковывает уже расшифрованный чанк SteamPipe (VSZa/Zstd или PK/ZIP). */
export function decompressChunk(decBuf) {
	if (decBuf.length < 8) {
		throw new Error(`слишком короткий чанк SteamPipe: ${decBuf.length} байт`);
	}

	const sig4 = decBuf.subarray(0, 4).toString('latin1');

	// Современный формат SteamPipe: VSZa (8 байт заголовок + Zstd + 15 байт хвост)
	if (sig4 === 'VSZa') {
		if (decBuf.length < 23) {
			throw new Error(`обрезанный VSZa-чанк: ${decBuf.length} байт`);
		}

		return zlib.zstdDecompressSync(decBuf.subarray(8, decBuf.length - 15));
	}

	// Классический ZIP-чанк (PK\x03\x04)
	if (decBuf.readUInt32LE(0) === ZIP_LOCAL_MAGIC) {
		return extractSingleZipEntry(decBuf);
	}

	// Классический VZ/LZMA (встречается в ранних загрузках Мастерской SIGame весны 2025):
	// шапка 12 байт: 'V','Z','a' + uint32 timestamp + 5 байт свойств LZMA;
	// хвост 10 байт: uint32 crc32 + uint32 outSize + 'z','v'.
	if (decBuf[0] === 0x56 && decBuf[1] === 0x5a) {
		if (decBuf.length < 22 || decBuf[2] !== 0x61
			|| decBuf[decBuf.length - 2] !== 0x7a || decBuf[decBuf.length - 1] !== 0x76) {
			throw new Error(`повреждённый VZ-чанк SteamPipe (${decBuf.length} байт)`);
		}

		const props = decBuf.subarray(7, 12);
		const stream = decBuf.subarray(12, decBuf.length - 10);
		const outSize = decBuf.readUInt32LE(decBuf.length - 6);

		return decompressLzmaRaw(props, stream, outSize);
	}

	throw new Error(`неизвестный заголовок чанка SteamPipe: ${decBuf.subarray(0, 4).toString('hex')}`);
}

/** Разбирает скачанный с CDN манифест в список файлов и их чанков. */
export function parseManifest(rawBuf, depotKey) {
	const data = rawBuf.length >= 4 && rawBuf.readUInt32LE(0) === ZIP_LOCAL_MAGIC
		? extractSingleZipEntry(rawBuf)
		: rawBuf;

	let payloadBuf = null;
	let metadataBuf = null;
	let pos = 0;

	while (pos + 4 <= data.length) {
		const magic = data.readUInt32LE(pos);
		pos += 4;

		if (magic === MANIFEST_END_MAGIC) {
			break;
		}

		if (pos + 4 > data.length) {
			break;
		}

		const len = data.readUInt32LE(pos);
		pos += 4;

		if (pos + len > data.length) {
			throw new Error(`обрезанная секция манифеста (magic=0x${magic.toString(16)})`);
		}

		const slice = data.subarray(pos, pos + len);
		pos += len;

		if (magic === MANIFEST_PAYLOAD_MAGIC) {
			payloadBuf = slice;
		} else if (magic === MANIFEST_METADATA_MAGIC) {
			metadataBuf = slice;
		} else if (magic !== MANIFEST_SIGNATURE_MAGIC) {
			throw new Error(`неизвестная секция манифеста: 0x${magic.toString(16)}`);
		}
	}

	if (!payloadBuf) {
		throw new Error('в манифесте отсутствует ContentManifestPayload');
	}

	const metadata = metadataBuf ? decodeMessage(metadataBuf) : new Map();
	const filenamesEncrypted = getBool(metadata, 4, false);
	const payload = decodeMessage(payloadBuf);

	const files = getAll(payload, 1).map(item => {
		const m = decodeMessage(item.value);
		let filename = getString(m, 1);

		if (filenamesEncrypted && filename) {
			const decrypted = decryptSteamData(Buffer.from(filename, 'base64'), depotKey);
			filename = decrypted.toString('utf8').replace(/\0+$/, '');
		}

		const shaContent = getBytes(m, 5);
		const chunks = getAll(m, 6).map(chunkItem => {
			const c = decodeMessage(chunkItem.value);
			const sha = getBytes(c, 1);

			return {
				shaHex: sha ? sha.toString('hex') : '',
				crc: getUint(c, 2, 0),
				offset: Number(getBigInt(c, 3, 0n)),
				size: getUint(c, 4, 0),
				compressedSize: getUint(c, 5, 0),
			};
		});

		chunks.sort((a, b) => a.offset - b.offset);

		return {
			filename,
			size: Number(getBigInt(m, 2, 0n)),
			flags: getUint(m, 3, 0),
			sha1: shaContent ? shaContent.toString('hex') : null,
			chunks,
		};
	});

	return {
		depotId: getUint(metadata, 1, 0),
		manifestId: getBigInt(metadata, 2, 0n).toString(),
		creationTime: getUint(metadata, 3, 0),
		filenamesEncrypted,
		files,
	};
}

/** Выбирает .siq-файл из манифеста (если их несколько — самый крупный). */
export function pickSiqFile(manifest) {
	const candidates = manifest.files.filter(f => (f.flags & DEPOT_FLAG_DIRECTORY) === 0
		&& /\.siq$/i.test(f.filename));

	if (candidates.length === 0) {
		return null;
	}

	candidates.sort((a, b) => b.size - a.size);

	return candidates[0];
}

function serverOrigin(server) {
	const scheme = server.httpsSupport === 'unavailable' ? 'http' : 'https';
	const host = server.vhost || server.host;

	return `${scheme}://${host}`;
}

async function fetchFromCdn(servers, urlPath, { timeoutMs = 20000 } = {}) {
	let lastError = null;
	const attempts = Math.min(3, servers.length);

	for (let i = 0; i < attempts; i++) {
		const server = servers[i];
		const url = `${serverOrigin(server)}${urlPath}`;

		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });

			if (res.ok) {
				return Buffer.from(await res.arrayBuffer());
			}

			lastError = new Error(`CDN ${server.host} ответил HTTP ${res.status} на ${urlPath}`);

			// 401/403/404 не починятся сменой CDN, если это не временный 5xx/429
			if (res.status < 500 && res.status !== 429) {
				break;
			}
		} catch (error) {
			lastError = error;
		}
	}

	throw lastError ?? new Error(`не удалось скачать ${urlPath} с SteamPipe CDN`);
}

/** Скачивает и разбирает манифест элемента Мастерской с CDN SteamPipe. */
export async function fetchManifest({ servers, depotId, manifestId, mrc, depotKey }) {
	const urlPath = `/depot/${depotId}/manifest/${manifestId}/5/${mrc}`;
	const raw = await fetchFromCdn(servers, urlPath);

	return {
		rawBytes: raw.length,
		manifest: parseManifest(raw, depotKey),
	};
}

/**
 * Создаёт источник диапазонов для src/zip.js (openZip) поверх чанков SteamPipe.
 *
 * Скачанные чанки кэшируются в памяти в пределах одного пака, чтобы чтение
 * оглавления, content.xml, обложки и отпечатков не качало один и тот же
 * 1-МБ чанк дважды.
 */
export function createSteamPipeReader({ servers, depotId, depotKey, file, maxCachedChunks = 16 }) {
	const totalSize = file.size;
	const chunks = file.chunks;
	const cache = new Map();
	const inFlight = new Map();

	const stats = {
		totalChunks: chunks.length,
		chunksDownloaded: 0,
		cacheHits: 0,
		bytesWireDownloaded: 0,
		bytesDecompressed: 0,
	};

	const loadChunk = async index => {
		if (cache.has(index)) {
			stats.cacheHits++;
			const hit = cache.get(index);
			// Обновляем порядок для LRU
			cache.delete(index);
			cache.set(index, hit);

			return hit;
		}

		if (inFlight.has(index)) {
			return inFlight.get(index);
		}

		const chunk = chunks[index];
		const promise = (async () => {
			const enc = await fetchFromCdn(servers, `/depot/${depotId}/chunk/${chunk.shaHex}`);
			stats.chunksDownloaded++;
			stats.bytesWireDownloaded += enc.length;

			const dec = decryptSteamData(enc, depotKey);
			const plain = decompressChunk(dec);
			stats.bytesDecompressed += plain.length;

			if (plain.length !== chunk.size) {
				throw new Error(
					`размер распакованного чанка ${chunk.shaHex} не совпал: ${plain.length} !== ${chunk.size}`,
				);
			}

			cache.set(index, plain);

			while (cache.size > maxCachedChunks) {
				const oldest = cache.keys().next().value;
				cache.delete(oldest);
			}

			return plain;
		})();

		inFlight.set(index, promise);

		try {
			return await promise;
		} finally {
			inFlight.delete(index);
		}
	};

	const readRange = async (from, to) => {
		const start = Math.max(0, from);
		const end = Math.min(totalSize - 1, to);

		if (end < start || totalSize === 0) {
			return Buffer.alloc(0);
		}

		const out = Buffer.allocUnsafe(end - start + 1);
		let written = 0;

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			const chunkEnd = chunk.offset + chunk.size - 1;

			if (chunkEnd < start) {
				continue;
			}

			if (chunk.offset > end) {
				break;
			}

			const data = await loadChunk(i);
			const sliceFrom = Math.max(0, start - chunk.offset);
			const sliceTo = Math.min(chunk.size, end - chunk.offset + 1);
			const slice = data.subarray(sliceFrom, sliceTo);
			slice.copy(out, written);
			written += slice.length;
		}

		return written === out.length ? out : out.subarray(0, written);
	};

	const readTail = async length => {
		const tailStart = Math.max(0, totalSize - length);
		const buffer = await readRange(tailStart, totalSize - 1);

		return { buffer, totalSize, tailStart };
	};

	const readRanges = async ranges => {
		const parts = [];

		for (const range of ranges) {
			try {
				parts.push({ from: range.from, data: await readRange(range.from, range.to) });
			} catch {
				// Пропускаем нечитаемый кусок — см. fetchRanges в src/zip.js
			}
		}

		return parts;
	};

	return {
		totalSize,
		fileName: file.filename,
		sha1: file.sha1,
		stats,
		readRange,
		readTail,
		readRanges,
	};
}
