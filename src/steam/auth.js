// Одноразовая авторизация сервисного аккаунта Steam через IAuthenticationService.
//
// Только для дома (scripts/steam-login.js): тянет node:crypto, в cf/src/** не используется.
// Взамен логина, пароля и одноразового кода Steam Guard выдаёт клиентский
// Refresh Token (platform_type = SteamClient, persistence = Persistent),
// которым дальше пользуется SteamCmClient.logonWithRefreshToken().

import crypto from 'node:crypto';

import {
	decodeMessage,
	encodeMessage,
	fieldBytes,
	fieldFixed64,
	fieldString,
	fieldVarint,
	getAll,
	getBigInt,
	getBytes,
	getFloat,
	getInt,
	getString,
} from './proto.js';

export const GUARD_TYPE = {
	Unknown: 0,
	None: 1,
	EmailCode: 2,
	DeviceCode: 3,
	DeviceConfirmation: 4,
	EmailConfirmation: 5,
	MachineToken: 6,
	LegacyMachineAuth: 7,
};

const PLATFORM_STEAM_CLIENT = 1;
const PERSISTENCE_PERSISTENT = 1;
const DEFAULT_OS_TYPE = 16;

function hexToBase64Url(hex) {
	let buf = Buffer.from(hex.length % 2 === 1 ? `0${hex}` : hex, 'hex');

	// JWK требует беззнакового big-endian без ведущих нулевых байтов
	let start = 0;

	while (start < buf.length - 1 && buf[start] === 0) {
		start++;
	}

	if (start > 0) {
		buf = buf.subarray(start);
	}

	return buf.toString('base64url');
}

/** Шифрует пароль открытым RSA-ключом Steam (PKCS#1 v1.5 → base64). */
export function encryptSteamPassword(password, modHex, expHex) {
	const key = crypto.createPublicKey({
		key: {
			kty: 'RSA',
			n: hexToBase64Url(modHex),
			e: hexToBase64Url(expHex),
		},
		format: 'jwk',
	});

	return crypto.publicEncrypt(
		{ key, padding: crypto.constants.RSA_PKCS1_PADDING },
		Buffer.from(password, 'utf8'),
	).toString('base64');
}

/** Запрашивает открытый RSA-ключ для шифрования пароля аккаунта. */
export async function getPasswordRsaKey(cm, accountName) {
	const req = encodeMessage([fieldString(1, accountName)]);
	const res = await cm.callService('Authentication.GetPasswordRSAPublicKey#1', req, { authed: false });
	const fields = decodeMessage(res);

	const modHex = getString(fields, 1);
	const expHex = getString(fields, 2);
	const timestamp = getBigInt(fields, 3);

	if (!modHex || !expHex) {
		throw new Error('Steam не вернул RSA-ключ для этого аккаунта');
	}

	return { modHex, expHex, timestamp };
}

/** Начинает сессию входа по логину и паролю. */
export async function beginAuthSession(cm, { accountName, password, deviceName = 'FirePacks' }) {
	const rsa = await getPasswordRsaKey(cm, accountName);
	const encryptedPassword = encryptSteamPassword(password, rsa.modHex, rsa.expHex);

	const deviceDetails = encodeMessage([
		fieldString(1, deviceName),
		fieldVarint(2, PLATFORM_STEAM_CLIENT),
		fieldVarint(3, DEFAULT_OS_TYPE),
	]);

	const req = encodeMessage([
		fieldString(1, deviceName),
		fieldString(2, accountName),
		fieldString(3, encryptedPassword),
		fieldVarint(4, rsa.timestamp),
		fieldVarint(5, true), // remember_login
		fieldVarint(6, PLATFORM_STEAM_CLIENT),
		fieldVarint(7, PERSISTENCE_PERSISTENT),
		fieldString(8, 'Client'),
		fieldBytes(9, deviceDetails),
	]);

	const res = await cm.callService('Authentication.BeginAuthSessionViaCredentials#1', req, { authed: false });
	const fields = decodeMessage(res);

	const confirmations = getAll(fields, 4).map(item => {
		const sub = decodeMessage(item.value);

		return {
			type: getInt(sub, 1, 0),
			message: getString(sub, 2),
		};
	});

	return {
		clientId: getBigInt(fields, 1),
		requestId: getBytes(fields, 2),
		interval: getFloat(fields, 3, 5) || 5,
		confirmations,
		steamId: getBigInt(fields, 5),
		extendedError: getString(fields, 8),
	};
}

/** Передаёт одноразовый код Steam Guard (из письма или приложения). */
export async function submitSteamGuardCode(cm, { clientId, steamId, code, codeType }) {
	const req = encodeMessage([
		fieldVarint(1, clientId),
		fieldFixed64(2, steamId),
		fieldString(3, code.trim()),
		fieldVarint(4, codeType),
	]);

	await cm.callService('Authentication.UpdateAuthSessionWithSteamGuardCode#1', req, { authed: false });
}

/** Проверяет статус сессии входа; после подтверждения возвращает refreshToken. */
export async function pollAuthSession(cm, { clientId, requestId }) {
	const req = encodeMessage([
		fieldVarint(1, clientId),
		fieldBytes(2, requestId),
	]);

	const res = await cm.callService('Authentication.PollAuthSessionStatus#1', req, { authed: false });
	const fields = decodeMessage(res);

	return {
		newClientId: getBigInt(fields, 1, 0n),
		refreshToken: getString(fields, 3),
		accessToken: getString(fields, 4),
		accountName: getString(fields, 6),
	};
}
