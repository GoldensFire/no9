// Одноразовый вход в сервисный аккаунт Steam для получения STEAM_REFRESH_TOKEN.
//
// Запуск:
//   node scripts/steam-login.js
//
// Что делает:
//   1. Спрашивает логин, пароль (скрыто) и при необходимости код Steam Guard.
//   2. Получает клиентский Refresh Token через IAuthenticationService.
//   3. Сохраняет его в data/steam-refresh-token.txt (в .gitignore).
//   4. Сразу проверяет вход по токену и получение ключа депо 3553500 (SIGame).
//
// Логин и пароль никуда не записываются.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { config } from '../src/config.js';
import {
	beginAuthSession,
	GUARD_TYPE,
	pollAuthSession,
	submitSteamGuardCode,
} from '../src/steam/auth.js';
import { parseRefreshToken, SteamCmClient } from '../src/steam/cm.js';
import { getDepotDecryptionKey } from '../src/steam/steampipe.js';

const TOKEN_FILE = path.join(config.rootPath, 'data', 'steam-refresh-token.txt');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function askLine(prompt) {
	return new Promise(resolve => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		rl.question(prompt, answer => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

function askPassword(prompt) {
	if (!process.stdin.isTTY) {
		return askLine(prompt);
	}

	return new Promise((resolve, reject) => {
		process.stdout.write(prompt);
		const stdin = process.stdin;
		const wasRaw = stdin.isRaw;
		stdin.setRawMode(true);
		stdin.resume();

		let value = '';

		const cleanup = () => {
			stdin.removeListener('data', onData);
			stdin.setRawMode(Boolean(wasRaw));
			stdin.pause();
		};

		const onData = chunk => {
			const text = chunk.toString('utf8');

			for (const ch of text) {
				if (ch === '\r' || ch === '\n') {
					cleanup();
					process.stdout.write('\n');
					resolve(value);

					return;
				}

				if (ch === '\u0003') {
					cleanup();
					process.stdout.write('\n');
					reject(new Error('прервано пользователем (Ctrl+C)'));

					return;
				}

				if (ch === '\u007f' || ch === '\b') {
					if (value.length > 0) {
						value = value.slice(0, -1);
						process.stdout.write('\b \b');
					}

					continue;
				}

				value += ch;
				process.stdout.write('*');
			}
		};

		stdin.on('data', onData);
	});
}

async function waitForToken(cm, session, { maxWaitMs = 180_000 } = {}) {
	let clientId = session.clientId;
	const intervalMs = Math.max(2000, Math.round((session.interval || 5) * 1000));
	const deadline = Date.now() + maxWaitMs;

	while (Date.now() < deadline) {
		const poll = await pollAuthSession(cm, { clientId, requestId: session.requestId });

		if (poll.newClientId && poll.newClientId !== 0n) {
			clientId = poll.newClientId;
		}

		if (poll.refreshToken) {
			return poll;
		}

		await sleep(intervalMs);
	}

	throw new Error('истекло время ожидания подтверждения входа Steam');
}

async function main() {
	console.log('Вход в сервисный аккаунт Steam (SIGame AppID ' + config.steamAppId + ').');
	console.log('Логин и пароль не сохраняются — запишется только Refresh Token в data/steam-refresh-token.txt.\n');

	const accountName = await askLine('Логин Steam: ');

	if (!accountName) {
		throw new Error('логин не может быть пустым');
	}

	const password = await askPassword('Пароль Steam: ');

	if (!password) {
		throw new Error('пароль не может быть пустым');
	}

	const authCm = new SteamCmClient();

	let pollResult;

	try {
		console.log('\nПодключаюсь к Steam CM...');
		await authCm.connect();
		console.log(`Подключено к ${authCm.endpoint}. Начинаю авторизацию...`);

		const session = await beginAuthSession(authCm, { accountName, password });
		const types = session.confirmations.map(c => c.type);

		const emailCodeConf = session.confirmations.find(c => c.type === GUARD_TYPE.EmailCode);
		const deviceCodeConf = session.confirmations.find(c => c.type === GUARD_TYPE.DeviceCode);
		const needsNoGuard = types.length === 0 || types.includes(GUARD_TYPE.None);

		if (emailCodeConf) {
			const hint = emailCodeConf.message ? ` (${emailCodeConf.message})` : '';
			const code = await askLine(`Код Steam Guard из письма${hint}: `);
			await submitSteamGuardCode(authCm, {
				clientId: session.clientId,
				steamId: session.steamId,
				code,
				codeType: GUARD_TYPE.EmailCode,
			});
			pollResult = await waitForToken(authCm, session, { maxWaitMs: 30_000 });
		} else if (deviceCodeConf) {
			const code = await askLine('Код из мобильного приложения Steam Guard: ');
			await submitSteamGuardCode(authCm, {
				clientId: session.clientId,
				steamId: session.steamId,
				code,
				codeType: GUARD_TYPE.DeviceCode,
			});
			pollResult = await waitForToken(authCm, session, { maxWaitMs: 30_000 });
		} else if (needsNoGuard) {
			pollResult = await waitForToken(authCm, session, { maxWaitMs: 30_000 });
		} else if (types.includes(GUARD_TYPE.DeviceConfirmation) || types.includes(GUARD_TYPE.EmailConfirmation)) {
			console.log('Подтвердите вход в приложении Steam или по ссылке из письма (жду до 3 минут)...');
			pollResult = await waitForToken(authCm, session, { maxWaitMs: 180_000 });
		} else {
			throw new Error(`неподдерживаемый тип подтверждения Steam Guard: ${types.join(', ')}`);
		}
	} finally {
		authCm.close();
	}

	const token = pollResult.refreshToken;
	const parsed = parseRefreshToken(token);

	fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
	fs.writeFileSync(TOKEN_FILE, `${token}\n`, 'utf8');

	const expDate = parsed.exp ? new Date(parsed.exp * 1000).toISOString().slice(0, 10) : 'неизвестно';
	console.log(`\nRefresh Token получен и сохранён в ${TOKEN_FILE}`);
	console.log(`SteamID64: ${parsed.steamId} | истекает ориентировочно: ${expDate}`);

	// Сразу проверяем вход по токену и право чтения депо 3553500 (SIGame)
	console.log('\nПроверяю вход по Refresh Token и ключ депо SIGame (' + config.steamAppId + ')...');
	const verifyCm = new SteamCmClient();

	try {
		await verifyCm.connect();
		const logon = await verifyCm.logonWithRefreshToken(token);
		console.log(`ClientLogon OK (cell_id=${logon.cellId}, session=${logon.sessionId}).`);

		const key = await getDepotDecryptionKey(verifyCm, {
			depotId: config.steamAppId,
			appId: config.steamAppId,
		});
		console.log(`Ключ депо ${config.steamAppId} получен (${key.length} байт AES-256)! Доступ к Мастерской SIGame открыт.`);
	} finally {
		verifyCm.close();
	}

	console.log('\nГотово! Теперь можно прогнать живой тест чтения пака:');
	console.log('  node scripts/steam-probe.js');
	console.log('Для GitHub Actions позже скопируйте содержимое data/steam-refresh-token.txt в секрет STEAM_REFRESH_TOKEN.');
}

main().catch(error => {
	console.error(`\nОшибка: ${error.message}`);
	process.exit(1);
});
