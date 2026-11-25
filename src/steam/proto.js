// Минимальный кодек wire-формата Protocol Buffers для протокола Steam3/SteamPipe.
//
// Только для дома и GitHub Actions: в cf/src/** этот каталог не импортируется.
// Внешних зависимостей нет — кодек покрывает ровно те типы полей, которыми
// обмениваются CM-сервер Steam, IAuthenticationService и манифесты SteamPipe
// (varint, fixed32, fixed64, length-delimited bytes/string/message).

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_FIXED32 = 5;

/** Наиболее частые коды EResult Steam — для внятных сообщений об ошибках. */
export const ERESULT_NAMES = {
	1: 'OK',
	2: 'Fail',
	3: 'NoConnection',
	5: 'InvalidPassword',
	6: 'LoggedInElsewhere',
	8: 'InvalidParam',
	9: 'FileNotFound',
	15: 'AccessDenied',
	16: 'Timeout',
	17: 'Banned',
	20: 'ServiceUnavailable',
	21: 'NotLoggedOn',
	24: 'InsufficientPrivilege',
	42: 'NoMatch',
	63: 'AccountLogonDenied',
	65: 'InvalidLoginAuthCode',
	66: 'AccountLogonDeniedNoMail',
	73: 'AccountLockedDown',
	84: 'RateLimitExceeded',
	85: 'AccountLoginDeniedNeedTwoFactor',
	88: 'TwoFactorCodeMismatch',
	105: 'Expired',
	112: 'ExpiredLoginAuthCode',
};

export function formatEResult(code) {
	const name = ERESULT_NAMES[code];

	return name ? `${code} (${name})` : String(code);
}

/** Кодирует беззнаковое целое (number | bigint) в protobuf varint. */
export function encodeVarint(value) {
	let n = typeof value === 'bigint' ? BigInt.asUintN(64, value) : BigInt.asUintN(64, BigInt(value));
	const out = [];

	while (n >= 0x80n) {
		out.push(Number((n & 0x7fn) | 0x80n));
		n >>= 7n;
	}

	out.push(Number(n));

	return Buffer.from(out);
}

function encodeTag(fieldNumber, wireType) {
	return encodeVarint((fieldNumber << 3) | wireType);
}

export function fieldVarint(fieldNumber, value) {
	if (value === undefined || value === null) {
		return null;
	}

	const num = typeof value === 'boolean' ? (value ? 1n : 0n) : value;

	return Buffer.concat([encodeTag(fieldNumber, WIRE_VARINT), encodeVarint(num)]);
}

export function fieldFixed32(fieldNumber, value) {
	if (value === undefined || value === null) {
		return null;
	}

	const buf = Buffer.allocUnsafe(4);
	buf.writeUInt32LE(value >>> 0, 0);

	return Buffer.concat([encodeTag(fieldNumber, WIRE_FIXED32), buf]);
}

export function fieldFixed64(fieldNumber, value) {
	if (value === undefined || value === null) {
		return null;
	}

	const buf = Buffer.allocUnsafe(8);
	buf.writeBigUInt64LE(BigInt.asUintN(64, BigInt(value)), 0);

	return Buffer.concat([encodeTag(fieldNumber, WIRE_FIXED64), buf]);
}

export function fieldBytes(fieldNumber, value) {
	if (value === undefined || value === null) {
		return null;
	}

	const data = Buffer.isBuffer(value) ? value : Buffer.from(value);

	return Buffer.concat([encodeTag(fieldNumber, WIRE_BYTES), encodeVarint(data.length), data]);
}

export function fieldString(fieldNumber, value) {
	if (value === undefined || value === null) {
		return null;
	}

	return fieldBytes(fieldNumber, Buffer.from(String(value), 'utf8'));
}

/** Склеивает набор закодированных полей, пропуская null/undefined. */
export function encodeMessage(parts) {
	return Buffer.concat(parts.filter(Boolean));
}

function readVarint(buf, offset) {
	let result = 0n;
	let shift = 0n;
	let pos = offset;

	while (pos < buf.length) {
		const byte = buf[pos++];
		result |= BigInt(byte & 0x7f) << shift;

		if ((byte & 0x80) === 0) {
			return { value: result, next: pos };
		}

		shift += 7n;

		if (shift > 70n) {
			throw new Error('повреждённый varint в protobuf');
		}
	}

	throw new Error('неожиданный конец буфера при чтении varint');
}

/**
 * Разбирает protobuf-сообщение в Map<fieldNumber, Array<{ wire, value }>>.
 *
 * Значения по wire-типам:
 * - 0 (varint)  → BigInt (беззнаковый 64-бит)
 * - 1 (fixed64) → BigInt (беззнаковый 64-бит)
 * - 2 (bytes)   → Buffer (подмассив исходного буфера)
 * - 5 (fixed32) → number (uint32)
 */
export function decodeMessage(buf) {
	const fields = new Map();
	let pos = 0;

	while (pos < buf.length) {
		const tag = readVarint(buf, pos);
		pos = tag.next;

		const fieldNumber = Number(tag.value >> 3n);
		const wire = Number(tag.value & 7n);
		let value;

		if (wire === WIRE_VARINT) {
			const res = readVarint(buf, pos);
			value = res.value;
			pos = res.next;
		} else if (wire === WIRE_FIXED64) {
			if (pos + 8 > buf.length) {
				throw new Error('обрезанный fixed64 в protobuf');
			}

			value = buf.readBigUInt64LE(pos);
			pos += 8;
		} else if (wire === WIRE_BYTES) {
			const len = readVarint(buf, pos);
			const size = Number(len.value);
			pos = len.next;

			if (pos + size > buf.length) {
				throw new Error('обрезанное поле bytes в protobuf');
			}

			value = buf.subarray(pos, pos + size);
			pos += size;
		} else if (wire === WIRE_FIXED32) {
			if (pos + 4 > buf.length) {
				throw new Error('обрезанный fixed32 в protobuf');
			}

			value = buf.readUInt32LE(pos);
			pos += 4;
		} else {
			throw new Error(`неподдерживаемый wire-тип protobuf: ${wire} (поле ${fieldNumber})`);
		}

		let list = fields.get(fieldNumber);

		if (!list) {
			list = [];
			fields.set(fieldNumber, list);
		}

		list.push({ wire, value });
	}

	return fields;
}

export function hasField(fields, num) {
	const list = fields.get(num);

	return Boolean(list && list.length > 0);
}

export function getAll(fields, num) {
	return fields.get(num) ?? [];
}

function getLast(fields, num) {
	const list = fields.get(num);

	return list && list.length > 0 ? list[list.length - 1] : null;
}

export function getBigInt(fields, num, fallback = 0n) {
	const item = getLast(fields, num);

	return item ? BigInt(item.value) : fallback;
}

export function getUint(fields, num, fallback = 0) {
	const item = getLast(fields, num);

	return item ? Number(item.value) : fallback;
}

export function getInt(fields, num, fallback = 0) {
	const item = getLast(fields, num);

	if (!item) {
		return fallback;
	}

	return typeof item.value === 'bigint'
		? Number(BigInt.asIntN(32, item.value))
		: (item.value | 0);
}

export function getFloat(fields, num, fallback = 0) {
	const item = getLast(fields, num);

	if (!item || item.wire !== WIRE_FIXED32) {
		return fallback;
	}

	const buf = Buffer.allocUnsafe(4);
	buf.writeUInt32LE(item.value >>> 0, 0);

	return buf.readFloatLE(0);
}

export function getBool(fields, num, fallback = false) {
	const item = getLast(fields, num);

	return item ? item.value !== 0n && item.value !== 0 : fallback;
}

export function getBytes(fields, num) {
	const item = getLast(fields, num);

	return item && Buffer.isBuffer(item.value) ? item.value : null;
}

export function getString(fields, num, fallback = '') {
	const bytes = getBytes(fields, num);

	return bytes ? bytes.toString('utf8') : fallback;
}
