// Общая ленивая сессия Steam CM + SteamPipe на один запуск индексатора.
//
// Только для дома и GitHub Actions: тянет src/steam/* (node:crypto, node:zlib),
// в cf/src/** не используется. Открывает одно WebSocket-соединение к CM на весь
// прогон, кэширует ключ депо SIGame (3553500) и список CDN-серверов, а при
// обрыве переподключается прозрачно для вызывающего шага.

import { config } from '../config.js';
import { openZip } from '../zip.js';
import { SteamCmClient, SteamError } from './cm.js';
import {
	createSteamPipeReader,
	fetchManifest,
	getDepotDecryptionKey,
	getManifestRequestCode,
	getSteamPipeServers,
	pickSiqFile,
} from './steampipe.js';

const APP_ID = config.steamAppId;

/** Временные коды Steam, на которых есть смысл переподключиться и повторить. */
const TRANSIENT_ERESULTS = new Set([
	3,  // NoConnection
	10, // Busy
	16, // Timeout
	20, // ServiceUnavailable
	35, // TryAnotherCM
	48, // TryAnotherCM / Region
	84, // RateLimitExceeded
]);

/** Ошибка «манифеста или файла в Steam больше нет» (аналог DeadLinkError). */
export class SteamGoneError extends Error {
	constructor(message) {
		super(message);
		this.name = 'SteamGoneError';
	}
}

let active = null;
let connecting = null;

function isSessionAlive(session) {
	return Boolean(session?.cm?.loggedIn && session.cm.ws && session.cm.ws.readyState === WebSocket.OPEN);
}

/**
 * Возвращает готовую сессию `{ cm, depotKey, servers }`.
 * Параллельные вызовы разделяют одно подключение.
 */
export async function getSteamSession() {
	if (isSessionAlive(active)) {
		return active;
	}

	if (connecting) {
		return connecting;
	}

	connecting = (async () => {
		if (!config.steamRefreshToken) {
			throw new Error(
				'не задан STEAM_REFRESH_TOKEN (ни в окружении, ни в data/steam-refresh-token.txt) — '
				+ 'выполните одноразовый вход: node scripts/steam-login.js',
			);
		}

		// На случай переподключения после обрыва — аккуратно закрываем старую сессию
		if (active?.cm) {
			try {
				active.cm.close();
			} catch {}
			active = null;
		}

		const cm = new SteamCmClient();

		try {
			await cm.connect();
			const logon = await cm.logonWithRefreshToken(config.steamRefreshToken);
			const depotKey = await getDepotDecryptionKey(cm, { depotId: APP_ID, appId: APP_ID });
			const servers = await getSteamPipeServers(cm, { cellId: logon.cellId, appId: APP_ID });

			active = {
				cm,
				depotKey,
				servers,
				steamId: logon.steamId,
				cellId: logon.cellId,
			};

			return active;
		} catch (error) {
			try {
				cm.close();
			} catch {}
			throw error;
		}
	})();

	try {
		return await connecting;
	} finally {
		connecting = null;
	}
}

/** Корректно закрывает WebSocket-сессию Steam CM по окончании запуска. */
export function closeSteamSession() {
	if (active?.cm) {
		try {
			active.cm.close();
		} catch {}
	}

	active = null;
}

/** Считается ли ошибка Steam временным сетевым сбоем (для retryNetwork). */
export function isSteamTransientError(error) {
	if (!error) {
		return false;
	}

	if (error instanceof SteamError && TRANSIENT_ERESULTS.has(error.eresult)) {
		return true;
	}

	return /таймаут ответа Steam CM|Steam CM разорвал соединение|соединение со Steam CM не открыто|CDN .* HTTP (5\d\d|429)/i
		.test(String(error.message ?? ''));
}

/**
 * Открывает .siq из Мастерской Steam поверх чанкового SteamPipeReader.
 *
 * Возвращает обычный объект архива из src/zip.js (openZip), дополненный полем
 * `steamMeta: { fileName, fileSize, sha1, stats }` — по нему разбор обновляет
 * SHA-1 и имя файла в pack_steam/packages без повторного скачивания.
 */
export async function openSteamPack({ steamId, hcontent }) {
	if (!hcontent || hcontent === '0') {
		throw new SteamGoneError(`у элемента Мастерской ${steamId} отсутствует hcontent_file`);
	}

	const session = await getSteamSession();
	let mrc;

	try {
		mrc = await getManifestRequestCode(session.cm, {
			appId: APP_ID,
			depotId: APP_ID,
			manifestId: hcontent,
		});
	} catch (error) {
		if (error instanceof SteamError && error.eresult === 9) {
			throw new SteamGoneError(`манифест ${hcontent} элемента Steam ${steamId} не найден (FileNotFound)`);
		}

		throw error;
	}

	let manifestResult;

	try {
		manifestResult = await fetchManifest({
			servers: session.servers,
			depotId: APP_ID,
			manifestId: hcontent,
			mrc,
			depotKey: session.depotKey,
		});
	} catch (error) {
		if (/HTTP 404\b/.test(String(error.message ?? ''))) {
			throw new SteamGoneError(`манифест ${hcontent} элемента Steam ${steamId} удалён с CDN (HTTP 404)`);
		}

		throw error;
	}

	const file = pickSiqFile(manifestResult.manifest);

	if (!file) {
		const names = manifestResult.manifest.files.map(f => f.filename).slice(0, 5).join(', ');
		throw new Error(`в манифесте Мастерской нет файла .siq (файлы: ${names || 'пусто'})`);
	}

	const reader = createSteamPipeReader({
		servers: session.servers,
		depotId: APP_ID,
		depotKey: session.depotKey,
		file,
	});

	const archive = await openZip(reader);
	archive.steamMeta = {
		fileName: file.filename,
		fileSize: file.size,
		sha1: file.sha1,
		stats: reader.stats,
	};

	return archive;
}
