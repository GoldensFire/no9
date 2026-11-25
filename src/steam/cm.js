// Транспорт Steam3 CM поверх встроенного WebSocket Node.
//
// Только для дома и GitHub Actions: тянет node:zlib, в cf/src/** не используется.
// Умеет:
// - получать свежий список WebSocket CM-серверов через ISteamDirectory;
// - упаковывать и разбирать protobuf-фреймы Steam3, включая сжатый EMsg.Multi;
// - входить анонимно или по Refresh Token (JWT с aud: "client");
// - вызывать сервисные методы (authed EMsg 151 и non-authed EMsg 9804)
//   и прямые protobuf-сообщения (ClientGetDepotDecryptionKey и др.).

import zlib from 'node:zlib';

import {
	decodeMessage,
	encodeMessage,
	fieldBytes,
	fieldFixed64,
	fieldString,
	fieldVarint,
	formatEResult,
	getBigInt,
	getBytes,
	getInt,
	getString,
	getUint,
	hasField,
} from './proto.js';

const PROTO_MASK = 0x80000000;
const ANON_STEAM_ID = (1n << 56n) | (10n << 52n); // Universe=Public(1), Type=AnonUser(10)
const PROTOCOL_VERSION = 65580;
const DEFAULT_OS_TYPE = 16; // Windows 10

export const EMSG = {
	Multi: 1,
	ServiceMethod: 146,
	ServiceMethodResponse: 147,
	ServiceMethodCallFromClient: 151,
	ClientHeartBeat: 703,
	ClientLogOff: 706,
	ClientLogOnResponse: 751,
	ClientLoggedOff: 757,
	ClientGetDepotDecryptionKey: 5438,
	ClientGetDepotDecryptionKeyResponse: 5439,
	ClientLogon: 5514,
	ServiceMethodCallFromClientNonAuthed: 9804,
	ClientHello: 9805,
};

const FALLBACK_CMS = [
	'cmp1-fra1.steamserver.net:27018',
	'cmp2-fra1.steamserver.net:27018',
	'cmp1-ams1.steamserver.net:27018',
];

export class SteamError extends Error {
	constructor(message, eresult = null) {
		super(message);
		this.name = 'SteamError';
		this.eresult = eresult;
	}
}

/** Разбирает payload JWT без проверки подписи (нам нужны sub, iss, aud, exp). */
export function decodeJwtPayload(token) {
	const parts = String(token ?? '').trim().split('.');

	if (parts.length !== 3) {
		throw new Error('токен Steam не похож на JWT');
	}

	const json = Buffer.from(parts[1], 'base64url').toString('utf8');

	return JSON.parse(json);
}

/** Проверяет, что переданный токен — именно клиентский Refresh Token Steam. */
export function parseRefreshToken(token) {
	const clean = String(token ?? '').trim();
	const payload = decodeJwtPayload(clean);

	if (payload.iss !== 'steam') {
		throw new Error(`это не Refresh Token Steam (iss=${payload.iss ?? 'пусто'})`);
	}

	const aud = Array.isArray(payload.aud) ? payload.aud : [];

	if (!aud.includes('client')) {
		throw new Error(`Refresh Token выпущен не для SteamClient (aud=${aud.join(',')})`);
	}

	if (!payload.sub || !/^\d+$/.test(String(payload.sub))) {
		throw new Error('в Refresh Token отсутствует корректный SteamID (sub)');
	}

	const nowSec = Math.floor(Date.now() / 1000);

	if (typeof payload.exp === 'number' && payload.exp <= nowSec) {
		throw new Error('срок действия STEAM_REFRESH_TOKEN истёк — перевыпустите через node scripts/steam-login.js');
	}

	return {
		token: clean,
		steamId: BigInt(payload.sub),
		exp: payload.exp ?? null,
		aud,
	};
}

/** Запрашивает у Valve живые адреса WebSocket CM-серверов. */
export async function fetchCmEndpoints(maxCount = 15) {
	try {
		const url = `https://api.steampowered.com/ISteamDirectory/GetCMListForConnect/v1/?cmtype=websockets&maxcount=${maxCount}`;
		const res = await fetch(url, { signal: AbortSignal.timeout(10000) });

		if (res.ok) {
			const data = await res.json();
			const list = data?.response?.serverlist ?? [];
			const endpoints = list
				.filter(item => item.type === 'websockets' && item.endpoint)
				.map(item => item.endpoint);

			if (endpoints.length > 0) {
				return endpoints;
			}
		}
	} catch {
		// Уходим на запасной список, если directory временно недоступен
	}

	return FALLBACK_CMS;
}

export class SteamCmClient {
	constructor() {
		this.ws = null;
		this.endpoint = null;
		this.steamId = 0n;
		this.sessionId = 0;
		this.cellId = 0;
		this.loggedIn = false;
		this._helloSent = false;
		this._nextJobId = 1n;
		this._pendingJobs = new Map();
		this._emsgWaiters = new Map();
		this._heartbeatTimer = null;
	}

	/** Подключается к первому ответившему WebSocket CM-серверу. */
	async connect({ timeoutMs = 10000 } = {}) {
		const endpoints = await fetchCmEndpoints();
		let lastError = null;

		for (const endpoint of endpoints.slice(0, 5)) {
			try {
				await this._connectOne(endpoint, timeoutMs);

				return this;
			} catch (error) {
				lastError = error;
			}
		}

		throw new Error(`не удалось подключиться к Steam CM: ${lastError?.message ?? 'нет ответа'}`);
	}

	_connectOne(endpoint, timeoutMs) {
		return new Promise((resolve, reject) => {
			const url = `wss://${endpoint}/cmsocket/`;
			const ws = new WebSocket(url);
			ws.binaryType = 'arraybuffer';

			let settled = false;
			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					try {
						ws.close();
					} catch {}
					reject(new Error(`таймаут подключения к ${endpoint}`));
				}
			}, timeoutMs);

			ws.addEventListener('open', () => {
				if (settled) {
					return;
				}

				settled = true;
				clearTimeout(timer);
				this.ws = ws;
				this.endpoint = endpoint;
				resolve();
			});

			ws.addEventListener('error', () => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					reject(new Error(`ошибка WebSocket на ${endpoint}`));
				}
			});

			ws.addEventListener('message', event => {
				const raw = event.data instanceof ArrayBuffer
					? Buffer.from(event.data)
					: Buffer.isBuffer(event.data) ? event.data : Buffer.from(event.data);

				this._handleFrame(raw);
			});

			ws.addEventListener('close', event => {
				this._stopHeartbeat();

				if (!settled) {
					settled = true;
					clearTimeout(timer);
					reject(new Error(`CM закрыл соединение (${event.code})`));

					return;
				}

				const reason = new Error(`Steam CM разорвал соединение (код ${event.code})`);
				this._failAllPending(reason);
			});
		});
	}

	_handleFrame(buf) {
		if (buf.length < 8) {
			return;
		}

		const rawEmsg = buf.readUInt32LE(0);
		const isProto = (rawEmsg & PROTO_MASK) !== 0;
		const emsg = rawEmsg & ~PROTO_MASK;

		if (!isProto) {
			return;
		}

		const headerLen = buf.readUInt32LE(4);

		if (8 + headerLen > buf.length) {
			return;
		}

		const header = decodeMessage(buf.subarray(8, 8 + headerLen));
		const body = buf.subarray(8 + headerLen);

		if (emsg === EMSG.Multi) {
			this._handleMulti(body);

			return;
		}

		// Обновляем sessionId/steamId, если сервер их прислал (приходят в ClientLogOnResponse)
		if (hasField(header, 2)) {
			const sid = getInt(header, 2);

			if (sid !== 0) {
				this.sessionId = sid;
			}
		}

		if (hasField(header, 1)) {
			const stid = getBigInt(header, 1);

			if (stid !== 0n) {
				this.steamId = stid;
			}
		}

		if (emsg === EMSG.ClientLoggedOff) {
			const fields = decodeMessage(body);
			const eresult = getInt(fields, 1, 2);
			this.loggedIn = false;
			this._stopHeartbeat();
			this._failAllPending(new SteamError(`Steam разлогинил сессию: EResult ${formatEResult(eresult)}`, eresult));

			return;
		}

		const targetJobId = getBigInt(header, 11, 0n);

		if (targetJobId !== 0n && targetJobId !== 0xffffffffffffffffn) {
			const job = this._pendingJobs.get(targetJobId);

			if (job) {
				this._pendingJobs.delete(targetJobId);
				clearTimeout(job.timer);
				job.resolve({ emsg, header, body });

				return;
			}
		}

		const waiters = this._emsgWaiters.get(emsg);

		if (waiters && waiters.length > 0) {
			const waiter = waiters.shift();

			if (waiters.length === 0) {
				this._emsgWaiters.delete(emsg);
			}

			clearTimeout(waiter.timer);
			waiter.resolve({ emsg, header, body });
		}
	}

	_handleMulti(body) {
		const fields = decodeMessage(body);
		const sizeUnzipped = getUint(fields, 1, 0);
		let data = getBytes(fields, 2);

		if (!data) {
			return;
		}

		if (sizeUnzipped > 0) {
			data = zlib.gunzipSync(data);
		}

		let offset = 0;

		while (offset + 4 <= data.length) {
			const chunkLen = data.readUInt32LE(offset);
			offset += 4;

			if (offset + chunkLen > data.length) {
				break;
			}

			this._handleFrame(data.subarray(offset, offset + chunkLen));
			offset += chunkLen;
		}
	}

	_allocJobId() {
		return this._nextJobId++;
	}

	sendProto(emsg, body = Buffer.alloc(0), headerOpts = {}) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error('соединение со Steam CM не открыто');
		}

		const steamId = headerOpts.steamId !== undefined ? headerOpts.steamId : this.steamId;
		const sessionId = headerOpts.sessionId !== undefined ? headerOpts.sessionId : this.sessionId;

		const headerBuf = encodeMessage([
			steamId ? fieldFixed64(1, steamId) : null,
			sessionId ? fieldVarint(2, sessionId) : null,
			headerOpts.jobIdSource ? fieldFixed64(10, headerOpts.jobIdSource) : null,
			headerOpts.targetJobName ? fieldString(12, headerOpts.targetJobName) : null,
		]);

		const prefix = Buffer.allocUnsafe(8);
		prefix.writeUInt32LE((emsg | PROTO_MASK) >>> 0, 0);
		prefix.writeUInt32LE(headerBuf.length >>> 0, 4);

		this.ws.send(Buffer.concat([prefix, headerBuf, body]));
	}

	_waitForJob(jobId, timeoutMs, label) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this._pendingJobs.delete(jobId);
				reject(new Error(`таймаут ответа Steam CM на ${label}`));
			}, timeoutMs);

			this._pendingJobs.set(jobId, { resolve, reject, timer });
		});
	}

	_waitForEmsg(emsg, timeoutMs, label) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const list = this._emsgWaiters.get(emsg);

				if (list) {
					const idx = list.indexOf(entry);

					if (idx >= 0) {
						list.splice(idx, 1);
					}
				}

				reject(new Error(`таймаут ответа Steam CM на ${label}`));
			}, timeoutMs);

			const entry = { resolve, reject, timer };
			let list = this._emsgWaiters.get(emsg);

			if (!list) {
				list = [];
				this._emsgWaiters.set(emsg, list);
			}

			list.push(entry);
		});
	}

	/** Отправляет protobuf-сообщение и ждёт ответ с указанным EMsg (или по jobId). */
	async callProto(emsg, responseEmsg, body, { timeoutMs = 20000, headerOpts = {} } = {}) {
		const jobId = this._allocJobId();
		const waitJob = this._waitForJob(jobId, timeoutMs, `EMsg ${emsg}`);
		const waitEmsg = responseEmsg ? this._waitForEmsg(responseEmsg, timeoutMs, `EMsg ${responseEmsg}`) : null;

		this.sendProto(emsg, body, { ...headerOpts, jobIdSource: jobId });

		if (!waitEmsg) {
			return waitJob;
		}

		// Некоторые ответы Steam присылает с jobid_target, а некоторые — без него
		return Promise.race([
			waitJob.then(res => {
				this._cancelEmsgWaiter(responseEmsg);

				return res;
			}),
			waitEmsg.then(res => {
				const pending = this._pendingJobs.get(jobId);

				if (pending) {
					clearTimeout(pending.timer);
					this._pendingJobs.delete(jobId);
				}

				return res;
			}),
		]);
	}

	_cancelEmsgWaiter(emsg) {
		const list = this._emsgWaiters.get(emsg);

		if (list && list.length > 0) {
			const item = list.shift();
			clearTimeout(item.timer);

			if (list.length === 0) {
				this._emsgWaiters.delete(emsg);
			}
		}
	}

	/** Шлёт ClientHello (нужен CM перед неавторизованными вызовами Authentication.*). */
	sendHello() {
		if (this._helloSent) {
			return;
		}

		this._helloSent = true;
		const body = encodeMessage([fieldVarint(1, PROTOCOL_VERSION)]);
		this.sendProto(EMSG.ClientHello, body, { steamId: 0n, sessionId: 0 });
	}

	/**
	 * Вызывает сервисный метод Steam (например, «PublishedFile.QueryFiles#1»).
	 * До входа используется NonAuthed (9804), после входа — Authed (151).
	 */
	async callService(methodName, reqBody = Buffer.alloc(0), { authed = this.loggedIn, timeoutMs = 20000 } = {}) {
		if (!authed && !this.loggedIn && !this._helloSent) {
			this.sendHello();
		}

		const jobId = this._allocJobId();
		const emsg = authed ? EMSG.ServiceMethodCallFromClient : EMSG.ServiceMethodCallFromClientNonAuthed;
		const waiter = this._waitForJob(jobId, timeoutMs, methodName);

		this.sendProto(emsg, reqBody, {
			jobIdSource: jobId,
			targetJobName: methodName,
		});

		const { header, body } = await waiter;
		const eresult = hasField(header, 13) ? getInt(header, 13, 1) : 1;

		if (eresult !== 1) {
			const detail = getString(header, 14);
			const suffix = detail ? `: ${detail}` : '';
			throw new SteamError(`${methodName} вернул EResult ${formatEResult(eresult)}${suffix}`, eresult);
		}

		return body;
	}

	/** Анонимный вход (достаточен для QueryFiles, но не для депо 3553500). */
	async logonAnonymous() {
		const body = encodeMessage([
			fieldVarint(1, PROTOCOL_VERSION),
			fieldString(6, 'english'),
			fieldVarint(7, DEFAULT_OS_TYPE),
		]);

		return this._finishLogon(ANON_STEAM_ID, body);
	}

	/** Вход по сохранённому Refresh Token (JWT сервисного аккаунта). */
	async logonWithRefreshToken(refreshToken) {
		const parsed = parseRefreshToken(refreshToken);

		const body = encodeMessage([
			fieldVarint(1, PROTOCOL_VERSION),
			fieldString(6, 'english'),
			fieldVarint(7, DEFAULT_OS_TYPE),
			fieldVarint(8, true), // should_remember_password
			fieldString(108, parsed.token), // access_token
		]);

		return this._finishLogon(parsed.steamId, body);
	}

	async _finishLogon(steamId, body) {
		this.steamId = steamId;
		this.sessionId = 0;

		const waiter = this._waitForEmsg(EMSG.ClientLogOnResponse, 20000, 'ClientLogon');
		this.sendProto(EMSG.ClientLogon, body, { steamId, sessionId: 0 });

		const { body: resBody } = await waiter;
		const fields = decodeMessage(resBody);
		const eresult = getInt(fields, 1, 2);

		if (eresult !== 1) {
			throw new SteamError(`ClientLogon отклонён: EResult ${formatEResult(eresult)}`, eresult);
		}

		this.loggedIn = true;
		this.cellId = getUint(fields, 7, 0);
		const heartbeatSec = getInt(fields, 3, 0) || getInt(fields, 2, 0) || 30;
		this._startHeartbeat(heartbeatSec);

		return {
			eresult,
			steamId: this.steamId,
			sessionId: this.sessionId,
			cellId: this.cellId,
			heartbeatSec,
		};
	}

	_startHeartbeat(seconds) {
		this._stopHeartbeat();
		const intervalMs = Math.max(10, seconds) * 1000;
		this._heartbeatTimer = setInterval(() => {
			if (this.ws && this.ws.readyState === WebSocket.OPEN) {
				try {
					this.sendProto(EMSG.ClientHeartBeat, Buffer.alloc(0));
				} catch {
					// Закрытое соединение обработается событием close
				}
			}
		}, intervalMs);
		this._heartbeatTimer.unref?.();
	}

	_stopHeartbeat() {
		if (this._heartbeatTimer) {
			clearInterval(this._heartbeatTimer);
			this._heartbeatTimer = null;
		}
	}

	_failAllPending(error) {
		for (const job of this._pendingJobs.values()) {
			clearTimeout(job.timer);
			job.reject(error);
		}

		this._pendingJobs.clear();

		for (const list of this._emsgWaiters.values()) {
			for (const waiter of list) {
				clearTimeout(waiter.timer);
				waiter.reject(error);
			}
		}

		this._emsgWaiters.clear();
	}

	close() {
		this._stopHeartbeat();

		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			if (this.loggedIn) {
				try {
					this.sendProto(EMSG.ClientLogOff, Buffer.alloc(0));
				} catch {}
			}

			try {
				this.ws.close();
			} catch {}
		}

		this.loggedIn = false;
		this.ws = null;
		this._failAllPending(new Error('соединение Steam CM закрыто'));
	}
}
