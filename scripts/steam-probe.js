// Живой тест этапа 0: чтение реального .siq из Мастерской Steam (SIGame 3553500)
// через SteamPipeReader + src/zip.js (openZip) → src/siq.js + src/plagiarism.js.
//
// Запуск:
//   node scripts/steam-probe.js                 # возьмёт 1 популярный пак из Мастерской
//   node scripts/steam-probe.js --count=3       # прогонит 3 пака за одну сессию CM
//   node scripts/steam-probe.js --id=3496225043 # проверит конкретный publishedfileid

import { config } from '../src/config.js';
import { countPrints, encodePrints } from '../src/plagiarism.js';
import { parseContentXml } from '../src/siq.js';
import { SteamCmClient } from '../src/steam/cm.js';
import {
	createSteamPipeReader,
	fetchManifest,
	getDepotDecryptionKey,
	getManifestRequestCode,
	getSteamPipeServers,
	pickSiqFile,
} from '../src/steam/steampipe.js';
import {
	getPublishedFileDetails,
	queryWorkshopFiles,
	WORKSHOP_QUERY,
} from '../src/steam/workshop.js';
import { openZip } from '../src/zip.js';

const APP_ID = config.steamAppId;

function parseArgs(argv) {
	let id = null;
	let count = 1;

	for (const arg of argv) {
		if (arg.startsWith('--id=')) {
			id = arg.slice(5).trim();
		} else if (arg.startsWith('--count=')) {
			const n = parseInt(arg.slice(8), 10);

			if (Number.isFinite(n) && n > 0) {
				count = Math.min(n, 20);
			}
		}
	}

	return { id, count };
}

const fmtMb = bytes => `${(bytes / (1024 * 1024)).toFixed(2)} МБ`;

async function probeItem({ cm, servers, depotKey, item }) {
	const started = Date.now();
	console.log(`\n=== Steam Workshop #${item.steamId}: ${item.title || '(без заголовка)'} ===`);
	console.log(`Подписок: ${item.subscriptions} | Просмотров: ${item.views} | hcontent: ${item.hcontent}`);

	if (!item.hcontent || item.hcontent === '0') {
		throw new Error('у элемента пустой hcontent_file');
	}

	const mrc = await getManifestRequestCode(cm, {
		appId: APP_ID,
		depotId: APP_ID,
		manifestId: item.hcontent,
	});

	const { rawBytes: manifestBytes, manifest } = await fetchManifest({
		servers,
		depotId: APP_ID,
		manifestId: item.hcontent,
		mrc,
		depotKey,
	});

	const file = pickSiqFile(manifest);

	if (!file) {
		throw new Error(`в манифесте нет .siq (файлов: ${manifest.files.map(f => f.filename).join(', ')})`);
	}

	console.log(`Файл: ${file.filename} (${fmtMb(file.size)}, чанков: ${file.chunks.length}, SHA-1: ${file.sha1 ?? 'нет'})`);

	const reader = createSteamPipeReader({
		servers,
		depotId: APP_ID,
		depotKey,
		file,
	});

	const archive = await openZip(reader);
	const contentEntry = archive.find('content.xml');

	if (!contentEntry) {
		throw new Error('внутри .siq не найден content.xml');
	}

	const xmlBuf = await archive.read(contentEntry);
	const parsed = parseContentXml(xmlBuf, archive.mediaSizes());
	const prints = encodePrints(parsed.questions);

	let logoInfo = 'нет в content.xml';

	if (parsed.logo) {
		const logoEntry = archive.find(`Images/${parsed.logo}`) ?? archive.find(parsed.logo);

		if (!logoEntry) {
			logoInfo = `указана (${parsed.logo}), но отсутствует в архиве`;
		} else {
			const logoBuf = await archive.read(logoEntry);
			logoInfo = `${logoEntry.name} (${(logoBuf.length / 1024).toFixed(1)} КБ, magic=${logoBuf.subarray(0, 4).toString('hex')})`;
		}
	}

	const elapsed = Date.now() - started;
	const wireTotal = manifestBytes + reader.stats.bytesWireDownloaded;
	const savedPct = file.size > 0 ? ((1 - wireTotal / file.size) * 100).toFixed(1) : '0.0';

	console.log(`Название в .siq: ${parsed.name || '(пусто)'}`);
	console.log(`Авторы:          ${parsed.authors.join(', ') || '(не указаны)'}`);
	console.log(`Состав:          ${parsed.roundCount} раундов, ${parsed.themeCount} тем, ${parsed.questionCount} вопросов (спец: ${parsed.specialCount})`);
	console.log(`Медиа-типы:      текст=${parsed.contentStat.text} карт=${parsed.contentStat.image} звук=${parsed.contentStat.audio} видео=${parsed.contentStat.video}`);
	console.log(`Обложка:         ${logoInfo}`);
	console.log(`Отпечатки:       ${countPrints(prints)} вопросов (${prints.length} байт)`);
	console.log(
		`Трафик:          ${fmtMb(wireTotal)} из ${fmtMb(file.size)} (экономия ${savedPct}%, `
		+ `манифест ${(manifestBytes / 1024).toFixed(1)} КБ, `
		+ `чанков ${reader.stats.chunksDownloaded}/${reader.stats.totalChunks}, кэш-хитов ${reader.stats.cacheHits}) `
		+ `за ${(elapsed / 1000).toFixed(2)} с`,
	);
}

async function main() {
	if (!config.steamRefreshToken) {
		console.error('Не найден STEAM_REFRESH_TOKEN (ни в окружении, ни в data/steam-refresh-token.txt).');
		console.error('Сначала выполните одноразовый вход: node scripts/steam-login.js');
		process.exit(1);
	}

	const { id, count } = parseArgs(process.argv.slice(2));
	const cm = new SteamCmClient();

	try {
		await cm.connect();
		const logon = await cm.logonWithRefreshToken(config.steamRefreshToken);
		console.log(`Steam CM: ${cm.endpoint} | SteamID64: ${logon.steamId} | cell_id=${logon.cellId}`);

		const depotKey = await getDepotDecryptionKey(cm, { depotId: APP_ID, appId: APP_ID });
		const servers = await getSteamPipeServers(cm, { cellId: logon.cellId, appId: APP_ID });
		console.log(`Ключ депо ${APP_ID} получен; CDN-серверов: ${servers.length} (первый: ${servers[0].vhost || servers[0].host}).`);

		let items;

		if (id) {
			items = await getPublishedFileDetails([id]);

			if (items.length === 0 || items[0].result !== 1) {
				throw new Error(`элемент Мастерской ${id} не найден (result=${items[0]?.result ?? 'нет'})`);
			}
		} else {
			const page = await queryWorkshopFiles(cm, {
				appId: APP_ID,
				queryType: WORKSHOP_QUERY.RankedByTotalUniqueSubscriptions,
				numPerPage: Math.max(10, count * 2),
			});
			console.log(`Всего элементов в Мастерской SIGame: ${page.total}`);
			items = page.items.filter(item => item.hcontent && item.hcontent !== '0' && !item.banned).slice(0, count);
		}

		for (const item of items) {
			await probeItem({ cm, servers, depotKey, item });
		}
	} finally {
		cm.close();
	}
}

main().catch(error => {
	console.error(`\nОшибка: ${error.message}`);
	process.exit(1);
});
