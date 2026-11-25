// Минималистичный декодер raw LZMA1 без внешних зависимостей для старых
// чанков SteamPipe формата VZ (ранние загрузки Мастерской SIGame весны 2025).
//
// Только для дома и GitHub Actions: в cf/src/** не используется.
// Реализует стандартный декодер LZMA SDK (range decoder + sliding window):
// на вход принимает 5-байтные свойства (lc/lp/pb + dictSize), сжатый поток
// и известный из хвоста VZ размер распакованных данных.

const NUM_STATES = 12;
const NUM_POS_STATES_MAX = 16;
const NUM_LEN_TO_POS_STATES = 4;
const START_POS_MODEL_INDEX = 4;
const END_POS_MODEL_INDEX = 14;
const NUM_FULL_DISTANCES = 1 << (END_POS_MODEL_INDEX >> 1);
const NUM_ALIGN_BITS = 4;
const MATCH_MIN_LEN = 2;
const PROB_INIT = 1024;
const NUM_BIT_MODEL_TOTAL_BITS = 11;
const BIT_MODEL_TOTAL = 1 << NUM_BIT_MODEL_TOTAL_BITS;
const NUM_MOVE_BITS = 5;

function initProbs(count) {
	const arr = new Uint16Array(count);
	arr.fill(PROB_INIT);

	return arr;
}

class RangeDecoder {
	constructor(buf) {
		this.buf = buf;
		this.pos = 0;
		this.range = 0xffffffff;
		this.code = 0;

		if (buf.length < 5) {
			throw new Error('обрезанный поток LZMA (< 5 байт)');
		}

		// Первый байт LZMA range coder всегда 0x00, далее 4 байта big-endian
		this.pos = 1;
		this.code = buf.readUInt32BE(1);
		this.pos = 5;
	}

	normalize() {
		if (this.range < 0x01000000) {
			this.range = (this.range << 8) >>> 0;
			const nextByte = this.pos < this.buf.length ? this.buf[this.pos++] : 0;
			this.code = ((this.code << 8) | nextByte) >>> 0;
		}
	}

	decodeBit(probs, index) {
		const prob = probs[index];
		const bound = (this.range >>> NUM_BIT_MODEL_TOTAL_BITS) * prob;

		if (this.code < bound) {
			this.range = bound >>> 0;
			probs[index] = prob + ((BIT_MODEL_TOTAL - prob) >>> NUM_MOVE_BITS);
			this.normalize();

			return 0;
		}

		this.range = (this.range - bound) >>> 0;
		this.code = (this.code - bound) >>> 0;
		probs[index] = prob - (prob >>> NUM_MOVE_BITS);
		this.normalize();

		return 1;
	}

	decodeDirectBits(numBits) {
		let result = 0;

		for (let i = numBits; i > 0; i--) {
			this.range >>>= 1;
			const t = (this.code - this.range) >>> 31;
			// Если code >= range (t === 0), вычитаем range и ставим бит 1
			if (t === 0) {
				this.code = (this.code - this.range) >>> 0;
				result = (result << 1) | 1;
			} else {
				result <<= 1;
			}

			this.normalize();
		}

		return result >>> 0;
	}
}

class BitTreeDecoder {
	constructor(numBits) {
		this.numBits = numBits;
		this.probs = initProbs(1 << numBits);
	}

	decode(rc) {
		let m = 1;

		for (let i = 0; i < this.numBits; i++) {
			m = (m << 1) | rc.decodeBit(this.probs, m);
		}

		return m - (1 << this.numBits);
	}

	reverseDecode(rc) {
		let m = 1;
		let symbol = 0;

		for (let i = 0; i < this.numBits; i++) {
			const bit = rc.decodeBit(this.probs, m);
			m = (m << 1) | bit;
			symbol |= bit << i;
		}

		return symbol;
	}
}

function reverseDecodeRange(probs, startIndex, rc, numBits) {
	let m = 1;
	let symbol = 0;

	for (let i = 0; i < numBits; i++) {
		const bit = rc.decodeBit(probs, startIndex + m);
		m = (m << 1) | bit;
		symbol |= bit << i;
	}

	return symbol;
}

class LenDecoder {
	constructor() {
		this.choice = initProbs(2);
		this.low = Array.from({ length: NUM_POS_STATES_MAX }, () => new BitTreeDecoder(3));
		this.mid = Array.from({ length: NUM_POS_STATES_MAX }, () => new BitTreeDecoder(3));
		this.high = new BitTreeDecoder(8);
	}

	decode(rc, posState) {
		if (rc.decodeBit(this.choice, 0) === 0) {
			return this.low[posState].decode(rc);
		}

		if (rc.decodeBit(this.choice, 1) === 0) {
			return 8 + this.mid[posState].decode(rc);
		}

		return 16 + this.high.decode(rc);
	}
}

/**
 * Распаковывает raw LZMA1 поток по 5-байтным свойствам и известному размеру.
 *
 * @param {Buffer} propsBuf 5 байт LZMA properties (lc/lp/pb + dictSize)
 * @param {Buffer} dataBuf сжатый LZMA1 поток
 * @param {number} outSize ожидаемая длина распакованных данных в байтах
 * @returns {Buffer}
 */
export function decompressLzmaRaw(propsBuf, dataBuf, outSize) {
	if (propsBuf.length < 5) {
		throw new Error('некорректные свойства LZMA (< 5 байт)');
	}

	let d = propsBuf[0];

	if (d >= 9 * 5 * 5) {
		throw new Error(`некорректный байт свойств LZMA: ${d}`);
	}

	const lc = d % 9;
	d = (d / 9) | 0;
	const lp = d % 5;
	const pb = (d / 5) | 0;
	const dictSize = Math.max(4096, propsBuf.readUInt32LE(1));

	const posStateMask = (1 << pb) - 1;
	const literalPosMask = (1 << lp) - 1;

	const isMatch = initProbs(NUM_STATES << 4);
	const isRep = initProbs(NUM_STATES);
	const isRepG0 = initProbs(NUM_STATES);
	const isRepG1 = initProbs(NUM_STATES);
	const isRepG2 = initProbs(NUM_STATES);
	const isRep0Long = initProbs(NUM_STATES << 4);
	const posSlotDecoder = Array.from({ length: NUM_LEN_TO_POS_STATES }, () => new BitTreeDecoder(6));
	const posDecoders = initProbs(NUM_FULL_DISTANCES - END_POS_MODEL_INDEX + 1);
	const posAlignDecoder = new BitTreeDecoder(NUM_ALIGN_BITS);
	const lenDecoder = new LenDecoder();
	const repLenDecoder = new LenDecoder();
	const litProbs = initProbs(0x300 << (lc + lp));

	const rc = new RangeDecoder(dataBuf);
	const out = Buffer.allocUnsafe(outSize);

	let outPos = 0;
	let state = 0;
	let rep0 = 0;
	let rep1 = 0;
	let rep2 = 0;
	let rep3 = 0;

	while (outPos < outSize) {
		const posState = outPos & posStateMask;

		if (rc.decodeBit(isMatch, (state << 4) + posState) === 0) {
			const prevByte = outPos > 0 ? out[outPos - 1] : 0;
			const litState = ((outPos & literalPosMask) << lc) + (prevByte >>> (8 - lc));
			const base = litState * 0x300;
			let symbol = 1;

			if (state >= 7) {
				let matchByte = outPos - rep0 - 1 >= 0 ? out[outPos - rep0 - 1] : 0;

				do {
					const matchBit = (matchByte >>> 7) & 1;
					matchByte = (matchByte << 1) & 0xff;
					const bit = rc.decodeBit(litProbs, base + ((1 + matchBit) << 8) + symbol);
					symbol = (symbol << 1) | bit;

					if (matchBit !== bit) {
						break;
					}
				} while (symbol < 0x100);
			}

			while (symbol < 0x100) {
				symbol = (symbol << 1) | rc.decodeBit(litProbs, base + symbol);
			}

			out[outPos++] = symbol & 0xff;
			state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
		} else {
			let len;

			if (rc.decodeBit(isRep, state) === 1) {
				len = 0;

				if (rc.decodeBit(isRepG0, state) === 0) {
					if (rc.decodeBit(isRep0Long, (state << 4) + posState) === 0) {
						state = state < 7 ? 9 : 11;
						const srcPos = outPos - rep0 - 1;

						if (srcPos < 0) {
							throw new Error('некорректное смещение LZMA (short rep)');
						}

						out[outPos++] = out[srcPos];
						continue;
					}
				} else {
					let distance;

					if (rc.decodeBit(isRepG1, state) === 0) {
						distance = rep1;
					} else {
						if (rc.decodeBit(isRepG2, state) === 0) {
							distance = rep2;
						} else {
							distance = rep3;
							rep3 = rep2;
						}

						rep2 = rep1;
					}

					rep1 = rep0;
					rep0 = distance;
				}

				len = repLenDecoder.decode(rc, posState) + MATCH_MIN_LEN;
				state = state < 7 ? 8 : 11;
			} else {
				rep3 = rep2;
				rep2 = rep1;
				rep1 = rep0;
				len = lenDecoder.decode(rc, posState) + MATCH_MIN_LEN;
				state = state < 7 ? 7 : 10;

				const lenToPosState = len - MATCH_MIN_LEN < NUM_LEN_TO_POS_STATES
					? len - MATCH_MIN_LEN
					: NUM_LEN_TO_POS_STATES - 1;
				const posSlot = posSlotDecoder[lenToPosState].decode(rc);

				if (posSlot >= START_POS_MODEL_INDEX) {
					const numDirectBits = (posSlot >> 1) - 1;
					rep0 = (2 | (posSlot & 1)) << numDirectBits;

					if (posSlot < END_POS_MODEL_INDEX) {
						rep0 += reverseDecodeRange(posDecoders, rep0 - posSlot, rc, numDirectBits);
					} else {
						rep0 += rc.decodeDirectBits(numDirectBits - NUM_ALIGN_BITS) << NUM_ALIGN_BITS;
						rep0 += posAlignDecoder.reverseDecode(rc);

						if (rep0 === 0xffffffff) {
							// Маркер конца потока LZMA
							break;
						}
					}
				} else {
					rep0 = posSlot;
				}
			}

			if (rep0 >= outPos || rep0 >= dictSize) {
				throw new Error(`смещение LZMA выходит за границу окна: rep0=${rep0}, outPos=${outPos}`);
			}

			for (let i = 0; i < len && outPos < outSize; i++) {
				out[outPos] = out[outPos - rep0 - 1];
				outPos++;
			}
		}
	}

	return outPos === outSize ? out : out.subarray(0, outPos);
}
