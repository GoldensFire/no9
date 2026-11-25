// Как шаг перемалывает свою очередь: несколько работников разом, добавка
// на ходу и ещё одна попытка после обрыва.
//
// Общее у всех шагов, а не забота каждого порознь. Полосы идут одновременно
// (см. шапку src/indexer.js), и «очередь может прибыть, пока я работаю» —
// свойство самого устройства обхода: разбор берёт паки, которые обход ВК ещё
// только находит, статистика и модель — те, что разбор ещё только разбирает.

import { db } from '../db.js';
import { DeadLinkError, openRemoteZip, StaleLinkError } from '../zip.js';
import { hasVkApi, refreshDocumentUrl } from '../vkapi.js';
import { isSteamTransientError, openSteamPack, SteamGoneError } from '../steam/session.js';
import { limit, outOfTime } from './options.js';
import { track } from './progress.js';
import { isRunning, STEPS } from './steps.js';
import { markPackSteamState, updateFailed, updateUrl } from './store.js';

const readSteamManifest = db.prepare('SELECT steam_id, hcontent, state FROM pack_steam WHERE package_id = ?');

/** Является ли строка паком из Мастерской Steam (source_key = 'steam:<id>'). */
export const isSteamPack = row => Boolean(row?.source_key?.startsWith('steam:'));

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Прогоняет список через несколько одновременных работников.
 *
 * Порядок выполнения при этом теряется, и полагаться на него нельзя: строки
 * базы друг от друга не зависят, а вот нумерация в выводе считается не по месту
 * в очереди, а по числу законченных, — иначе номера скакали бы взад-вперёд.
 */
async function runPool(items, jobs, worker, stop = () => false) {
	let next = 0;

	const workers = Array.from({ length: Math.min(jobs, items.length) }, async () => {
		while (next < items.length && !stop()) {
			await worker(items[next++]);
		}
	});

	await Promise.all(workers);
}

/**
 * Полоса работы, у которой работа может прибывать по ходу дела.
 *
 * Шаги теперь идут одновременно, и очередь шага уже нельзя посчитать один раз
 * в начале: разбор берёт паки, которые обход ВК ещё только находит, статистика
 * и модель — те, что разбор ещё только разбирает. Поэтому очередь спрашивается
 * у базы заново, пока есть кому её пополнять: `growing` отвечает, работают ли
 * ещё те шаги, что кормят этот. Как только они закончились и очередь пуста —
 * закончился и этот.
 *
 * `seen` нужен не для порядка, а по существу: статистика перезапрашивает всех
 * разобранных паков, и без памяти о том, кого уже спросили в этот заход, второй
 * запрос к базе вернул бы те же пять тысяч по второму кругу.
 *
 * `group` — необязательный делитель очереди на пачки: с ним работник берёт
 * не строку, а список строк. Нужен шагу «Всё о паке», где несколько паков
 * уезжают к модели одним запросом (см. groupForAnalysis в src/indexer/marking.js).
 */
export async function drain({ step, jobs, take, work, group = null, stop = () => false }) {
	const bar = track(step);
	const seen = new Set();

	// Отпущенное время кончается для всех шагов разом и проверяется здесь одним
	// местом, а не в каждом stop по отдельности: срок дан обходу целиком,
	// и «статистика доработает, а разметка нет» было бы правилом ниоткуда
	const done = () => stop() || outOfTime();

	// Кто может подкинуть работы этому шагу, записано в STEPS одним местом (feeds),
	// чтобы «разбору подносит обход ВК» не приходилось помнить в двух файлах
	const feeds = STEPS.find(item => item.key === step)?.feeds ?? [];
	const growing = () => feeds.some(isRunning);

	let taken = 0;

	while (!done()) {
		const room = limit === Infinity ? Infinity : limit - taken;

		if (room <= 0) {
			return;
		}

		bar.growing = growing();

		const batch = take()
			.filter(row => !seen.has(row.id))
			.slice(0, room === Infinity ? undefined : room);

		if (batch.length === 0) {
			if (!growing()) {
				return;
			}

			// Полоса опустела, но кормящий шаг ещё работает: ждём добавки.
			// Секунда — не темп опроса базы, а верхняя граница простоя: запрос
			// этот местный и стоит миллисекунды.
			await sleep(1000);
			continue;
		}

		for (const row of batch) {
			seen.add(row.id);
		}

		taken += batch.length;
		bar.expand(batch.length);

		// Работу можно раздавать не по строке, а пачками: шаг «Всё о паке»
		// спрашивает у Gemini сразу несколько паков одним запросом, и работник
		// там берёт не пак, а пачку паков (см. group в refreshAnalysis)
		// Без group работник берёт строку, как и раньше; с ним — сразу пачку строк
		const units = group ? group(batch) : batch;

		await runPool(units, jobs, async unit => {
			await work(unit, bar);
			bar.tick(Array.isArray(unit) ? unit.length : 1);
		}, done);
	}
}

/**
 * Обрыв соединения — обычное дело на больших файлах, стоит просто попробовать
 * ещё раз. Сюда же и ответ 5xx от хранилища ВК: файл там на месте, отвечает
 * сервер (см. StaleLinkError в src/zip.js).
 */
function isNetworkGlitch(error) {
	return error instanceof StaleLinkError
		|| isSteamTransientError(error)
		|| /terminated|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(error.message);
}

export async function retryNetwork(action, attempts = 3) {
	let lastError = null;

	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await action();
		} catch (error) {
			lastError = error;

			if (!isNetworkGlitch(error) || attempt === attempts) {
				throw error;
			}

			await sleep(2000 * attempt);
		}
	}

	throw lastError;
}

/**
 * Ссылки ВК умирают, а полученные через API ещё и протухают по времени.
 * Если есть ключ — просим у ВК свежую ссылку и повторяем попытку один раз.
 *
 * Оба случая идут сюда: и «документ удалён» (тогда свежей ссылки не дадут
 * и пак действительно мёртв), и «хранилище ответило 502» — а вот тут свежую
 * ссылку дадут, и по ней всё откроется. Различать их снаружи нельзя: с виду
 * это одна и та же страница ошибки (см. StaleLinkError в src/zip.js).
 */
export async function withFreshUrl(row, action) {
	try {
		return await action(row.url);
	} catch (error) {
		const refreshable = error instanceof DeadLinkError || error instanceof StaleLinkError;

		if (!refreshable || !hasVkApi()) {
			throw error;
		}

		const fresh = await refreshDocumentUrl(row.source_key).catch(() => null);

		if (!fresh || fresh === row.url) {
			throw error;
		}

		updateUrl.run(fresh, row.id);
		return action(fresh);
	}
}

/**
 * Единая точка открытия архива пака (ВК или Мастерская Steam).
 *
 * Для ВК идёт прежний путь withFreshUrl + openRemoteZip; для Steam-паков
 * (source_key = 'steam:<id>') — чанковый SteamPipeReader поверх одной общей
 * сессии CM на прогон. Если Steam-пак был «повышен» ВК-дублем (url <> '')
 * и сам элемент Мастерской удалён — прозрачно читаем по его ВК-ссылке.
 */
export async function withPackArchive(row, action) {
	if (isSteamPack(row)) {
		const info = readSteamManifest.get(row.id);

		if (info && info.state === 'ok' && info.hcontent && info.hcontent !== '0') {
			const archive = await openSteamPack({ steamId: info.steam_id, hcontent: info.hcontent });
			return action(archive);
		}

		// Если элемент Мастерской пропал, но у карточки есть живое ВК-зеркало — читаем оттуда
		if (row.url) {
			return action(await openRemoteZip(row.url));
		}

		throw new SteamGoneError(`для пака ${row.source_key} нет живого манифеста Steam`);
	}

	return withFreshUrl(row, async url => action(await openRemoteZip(url)));
}

/**
 * Пак, до файла которого больше не добраться, — мёртвый пак.
 *
 * ————— зачем это понадобилось всем шагам сразу —————
 *
 * Мёртвую ссылку хоронил только разбор (см. parsePackages в parse.js), а он
 * берёт лишь новые и перезалитые паки. Всё остальное — отпечатки вопросов,
 * длительность медиа, спецвопросы, обложки — ходит в те же архивы по тем же
 * ссылкам, натыкается на те же похороны и молча считает это своей неудачей:
 * `failed++`, строка в лог, до свидания. Пак при этом остаётся «ok»
 * и завтра встаёт в ту же очередь.
 *
 * Стоило это ровно того, о чём спрашивают, глядя на страницу обновления:
 * «почему отпечатки не сняты у трёх паков». Не потому, что шаг их пропускает,
 * а потому, что качать оттуда нечего с апреля — документы из ВК удалены, —
 * а сказать об этом было некому. Очередь на три пака, вечная.
 *
 * Хоронится только настоящая смерть — DeadLinkError, то есть двухсотый ответ
 * со страницей ошибки ВК. Ответ сервера (502 и прочие 5xx) сюда не попадает
 * вовсе: он приходит отдельным видом и означает не смерть, а протухшую подпись
 * (см. StaleLinkError в src/zip.js). До этого места он и не доходит — его
 * повторяет retryNetwork, а ссылку обновляет withFreshUrl.
 *
 * Ссылка к этому мигу уже обновлялась: withFreshUrl просит у ВК свежую
 * и повторяет попытку, и только если и по свежей приходит та же страница
 * ошибки — документа в ВК больше нет. Просьба эта, впрочем, помогает редко:
 * docs.getById чужие документы не отдаёт вовсе, ни с каким ключом.
 *
 * ————— и почему у похорон есть потолок —————
 *
 * Потому что «страница вместо файла» — это ещё и то, чем ВК отвечает, когда
 * ему надоели наши запросы. Отличить «документ удалён» от «уйдите, вы частите»
 * по ответу нельзя: и там и там двухсотый с HTML. Разница только в числе —
 * авторы удаляют свои паки поодиночке, а отказ приходит сразу всем.
 *
 * Похороны поэтому идут, пока их немного. Перевалило за сотню за один запуск —
 * значит, дело не в паках, и хоронить дальше нельзя: очередь у длительности
 * медиа на тысячи строк, и один неудачный час мог бы вымести с сайта половину
 * библиотеки. Оставшиеся при этом никуда не денутся — попадут в ту же очередь
 * следующей ночью, когда ВК отойдёт.
 *
 * @returns {boolean} похоронен ли пак
 */
const BURY_LIMIT = 100;

let buried = 0;
let buryStopped = false;

export function buryDeadLink(row, error) {
	if (!(error instanceof DeadLinkError || error instanceof SteamGoneError)) {
		return false;
	}

	if (buried >= BURY_LIMIT) {
		if (!buryStopped) {
			buryStopped = true;
			console.error(`[обход] мёртвых ссылок за один запуск больше ${BURY_LIMIT} — `
				+ 'это не удалённые паки, а отказ источника отдавать файлы. Больше никого не хороню; '
				+ 'кто и правда удалён, дождётся следующей ночи.');
		}

		return false;
	}

	buried++;
	updateFailed.run('dead', error.message, Date.now(), row.id);

	if (isSteamPack(row)) {
		markPackSteamState.run('dead', Date.now(), row.id);
	}

	return true;
}
