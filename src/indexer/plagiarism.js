// Шаг «Плагиат»: кто у кого списал. Без сети — по отпечаткам вопросов,
// уже снятым разбором и шагом досчёта (см. backfill.js).
//
// Правила счёта лежат в src/plagiarism.js; здесь — проход по базе: кому
// выносить приговор, что записать в пак и как пометить темы, чужие целиком.

import { config } from '../config.js';
import { db, jsonOrDefault } from '../db.js';
import { reviewPlagiarism, PRINTS_VERSION } from '../plagiarism.js';
import { pullPlagiarismImmunity } from '../../scripts/deploy/immunity.js';
import { say } from './progress.js';
import { queueNote, targetSql } from './queue.js';

const updatePlagiarism = db.prepare(`
	UPDATE packages SET plagiarism_kind = ?, plagiarism_share = ?, plagiarism_questions = ?,
		plagiarism_sources = ?, rounds = ?, plagiarism_at = ? WHERE id = ?
`);

/**
 * Проставляет (или снимает) темам обе метки плагиата прямо в rounds: «взято
 * отсюда» у вора и «взято отсюда другими» у того, у кого взяли.
 *
 * ————— метка вора —————
 *
 * Кроме номера донора (`src`) тема получает два числа: `srcN` — сколько её
 * вопросов пришло от этого донора, и `srcOf` — сколько вопросов в теме всего.
 * Одно без другого бессмысленно: по ним сайт отличает тему, взятую оттуда
 * целиком, от темы, из которой списали пару вопросов, — и красит их по-разному
 * (см. web/card.js).
 *
 * У темы, собранной из нескольких чужих паков, рядом ложится `srcs` — все её
 * доноры с именами и числами. Ссылка у темы по-прежнему одна и ведёт к тому,
 * кто дал больше всех, а подсказка называет всех: «5 вопросов из «Солянки»»
 * там, где «Солянка» дала три, было прямым враньём.
 *
 * ————— метка обворованного —————
 *
 * `taken` — кто позже поставил вопросы этой темы себе, с именами и числами,
 * и `takenOf` — сколько вопросов в теме всего. Имена лежат прямо в теме, а не
 * общим списком у пака, как у доноров: колонки под них в базе нет, а заводить
 * её значило бы перезалить наверх всю базу целиком ради поля, которое читает
 * одна подсказка (см. scripts/export-d1.js — новая колонка требует полной
 * выкладки).
 *
 * Правится разобранный JSON как он лежит, а не то, что вернул normalizeRounds:
 * тот приводит тему к трём полям и выбрасывает всё остальное — в частности
 * `media`, по которому карточка рисует значок картинки или музыки. Переписать
 * пак его выводом значило бы обменять значки на метку плагиата.
 *
 * @param {string} stored поле rounds как оно лежит в базе
 * @param {Array<{round: number, theme: number, source: number, n: number, of: number, donors?: Array}>} places что взято этим паком
 * @param {Array<{round: number, theme: number, of: number, by: Array}>} taken что взято у этого пака
 * @returns {string|null} новое поле или null, если ничего не изменилось
 */
function markStolenThemes(stored, places, taken) {
	const rounds = jsonOrDefault(stored, []);
	const wanted = new Map(places.map(place => [`${place.round}:${place.theme}`, place]));
	const robbed = new Map(taken.map(place => [`${place.round}:${place.theme}`, place]));
	let changed = false;

	rounds.forEach((round, roundIndex) => {
		(round?.themes ?? []).forEach((theme, themeIndex) => {
			// Тема, записанная строкой (так хранили до появления образцов), метки
			// не получает: превратить её в объект значило бы дописать паку поля,
			// которых разбор ему не давал
			if (typeof theme === 'string') {
				return;
			}

			const key = `${roundIndex}:${themeIndex}`;

			if (setSource(theme, wanted.get(key) ?? null)) {
				changed = true;
			}

			if (setTaken(theme, robbed.get(key) ?? null)) {
				changed = true;
			}
		});
	});

	return changed ? JSON.stringify(rounds) : null;
}

/** Одинаковы ли два списка. Сравнивать их поштучно тут не за чем: они короткие. */
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Метка вора у одной темы. @returns изменилось ли что-нибудь */
function setSource(theme, place) {
	const source = place?.source ?? null;
	const n = place?.n ?? null;
	const of = place?.of ?? null;
	const donors = place?.donors ?? null;

	if ((theme.src ?? null) === source && (theme.srcN ?? null) === n
		&& (theme.srcOf ?? null) === of && same(theme.srcs ?? null, donors)) {
		return false;
	}

	if (source === null) {
		delete theme.src;
		delete theme.srcN;
		delete theme.srcOf;
		delete theme.srcs;
	} else {
		theme.src = source;
		theme.srcN = n;
		theme.srcOf = of;

		if (donors) {
			theme.srcs = donors;
		} else {
			delete theme.srcs;
		}
	}

	return true;
}

/** Метка обворованного у одной темы. @returns изменилось ли что-нибудь */
function setTaken(theme, place) {
	const by = place?.by ?? null;
	const of = place?.of ?? null;

	if (same(theme.taken ?? null, by) && (theme.takenOf ?? null) === of) {
		return false;
	}

	if (by === null) {
		delete theme.taken;
		delete theme.takenOf;
	} else {
		theme.taken = by;
		theme.takenOf = of;
	}

	return true;
}

/**
 * Кто у кого списал. Считается дома и целиком: ни одного похода в сеть и ни одной
 * строки в D1 — наверх уезжает только вывод (см. src/plagiarism.js).
 *
 * ————— почему пересмотр всегда полный —————
 *
 * Очередь у шага есть — это паки, чей приговор старше их же разбора
 * (plagiarism_at меньше indexed_at), — но заменить ею работу нельзя. Пак,
 * найденный сегодня в старой теме обсуждения и выложенный в 2019 году, меняет
 * старшинство сразу у всех, кого уже проверили: вчерашний первоисточник
 * оказывается вором, а вчерашний вор — обворованным. Поэтому база всякий раз
 * раскладывается заново, а очередь служит только тем, чтобы сказать вслух,
 * сколько приговоров успело устареть.
 *
 * Стоит это секунд и нисколько не стоит в сети, так что платить за полноту
 * тут нечем.
 *
 * ————— почему база читается потоком —————
 *
 * Свёртка отпечатков — двенадцать байт на вопрос, то есть около килобайта
 * на пак и тринадцать мегабайт на библиотеку. Поднимать это разом незачем:
 * от пака нужны одни числа, и раскладывает их сам plagiarism.js по мере
 * чтения, а свёртка живёт ровно до конца своего витка.
 *
 * ————— пак без отпечатков —————
 *
 * Для правила он попросту пуст: сравнивать нечего, и ни донором, ни вором он
 * не станет. Это не молчаливая потеря, а очередь шага prints — он их и снимет
 * (см. fetchPrints в src/indexer/backfill.js). Сколько таких паков осталось, шаг говорит вслух: пока
 * их много, приговоры по всей базе неполны, и знать об этом важнее, чем
 * получить красивое число отмеченных.
 */
/**
 * Номера паков, которым положен иммунитет от плагиата: все паки хозяина сайта
 * по его подтверждённым страницам ВК, связанным аккаунтам Steam и назначенным
 * подписям (см. scripts/deploy/immunity.js).
 */
function resolveImmunePackIds(immunity, vkToSteam) {
	const ids = new Set();

	if (!immunity?.enabled) {
		return ids;
	}

	const vkIds = immunity.vkIds ?? [];
	const authorKeys = immunity.authorKeys ?? [];

	if (vkIds.length > 0) {
		const places = vkIds.map(() => '?').join(', ');
		const vkUrls = vkIds.map(id => `https://vk.com/id${id}`);

		for (const row of db.prepare(`SELECT DISTINCT package_id AS id FROM pack_authors WHERE canon_account IN (${places})`).all(...vkIds)) {
			ids.add(row.id);
		}

		for (const row of db.prepare(`SELECT id FROM packages WHERE status = 'ok' AND TRIM(vk_author_url) IN (${places})`).all(...vkUrls)) {
			ids.add(row.id);
		}

		const steamCreators = new Set();

		for (const url of vkUrls) {
			for (const creatorId of vkToSteam.get(url) ?? []) {
				steamCreators.add(creatorId);
			}
		}

		if (steamCreators.size > 0) {
			const creatorList = [...steamCreators];
			const creatorPlaces = creatorList.map(() => '?').join(', ');

			for (const row of db.prepare(`
				SELECT DISTINCT target_package_id AS id FROM pack_steam
				WHERE state = 'ok' AND creator_id IN (${creatorPlaces})
			`).all(...creatorList)) {
				ids.add(row.id);
			}
		}
	}

	if (authorKeys.length > 0) {
		const places = authorKeys.map(() => '?').join(', ');

		for (const row of db.prepare(`
			SELECT DISTINCT package_id AS id FROM pack_authors
			WHERE author_key IN (${places})
				OR canon_key IN (SELECT canon_key FROM pack_authors WHERE author_key IN (${places}))
		`).all(...authorKeys, ...authorKeys)) {
			ids.add(row.id);
		}
	}

	return ids;
}

export async function checkPlagiarism() {
	const target = targetSql();

	// Названные поимённо паки судятся одни, а вот раскладывается база всегда
	// целиком: старшинство — это отношение пака ко всем остальным, и по одному
	// паку его не выяснить. `--packs=N` сужает, кому выносится приговор,
	// а не по чему он выносится.
	//
	// Сужение записано подзапросом, а не именем таблицы через точку, ровно
	// по той же причине, что и в recalcLevels: targetSql пишет свои условия
	// от псевдонима, а в UPDATE псевдонима нет
	const scope = target.where
		? ` AND id IN (SELECT p.id FROM packages p WHERE 1 = 1${target.where})`
		: '';

	/** Кому приговор записывается. null — всем; сузить может только `--packs`/`--authors`. */
	const only = target.where
		? new Set(db.prepare(`SELECT p.id FROM packages p WHERE p.status = 'ok'${target.where}`)
			.all(...target.params).map(row => row.id))
		: null;

	// Приговор устарел не только у переразобранного пака, но и у того, чьи
	// отпечатки сняты позже приговора. Разница не теоретическая: шаг prints
	// идёт часами и его запускают отдельно, а пак, отпечатков у которого
	// на момент суда не было, для правила был попросту пуст — ни донором,
	// ни вором он тогда стать не мог. Так и вышло, что тема, списанная слово
	// в слово, месяц стояла неотмеченной: судили её раньше, чем прочитали
	// того, у кого списали
	const stale = db.prepare(`SELECT COUNT(*) AS c FROM packages p
		LEFT JOIN pack_prints q ON q.package_id = p.id
		WHERE p.status = 'ok' AND (p.plagiarism_at IS NULL
			OR p.plagiarism_at < COALESCE(p.indexed_at, 0)
			OR p.plagiarism_at < COALESCE(q.parsed_at, 0))${target.where}`)
		.get(...target.params).c;

	say('plagiarism', `приговор устарел у ${stale} паков${queueNote(false)}; `
		+ 'пересматриваю базу целиком — иначе найденный сегодня старый пак так и останется первоисточником');

	// Связка ВК-страница ↔ SteamID64 по совпавшим пакам-дублям (раздел 6.2):
	// берём только creator_id, привязанные ровно к ОДНОЙ странице ВК, чтобы чужой
	// перезаливщик десятков разных авторов не стал «одним человеком» со всеми ними
	const bridgeRows = db.prepare(`
		SELECT DISTINCT TRIM(p.vk_author_url) AS vk_url, TRIM(ps.creator_id) AS creator_id
		FROM pack_steam ps
		JOIN packages p ON p.id = ps.target_package_id
		WHERE ps.state = 'ok' AND p.status = 'ok'
			AND p.vk_author_url IS NOT NULL AND TRIM(p.vk_author_url) <> ''
			AND ps.creator_id IS NOT NULL AND TRIM(ps.creator_id) <> ''
	`).all();

	const creatorToVk = new Map();

	for (const row of bridgeRows) {
		const set = creatorToVk.get(row.creator_id) ?? new Set();
		set.add(row.vk_url);
		creatorToVk.set(row.creator_id, set);
	}

	const vkToSteam = new Map();

	for (const [creatorId, vkUrls] of creatorToVk) {
		if (vkUrls.size !== 1) {
			continue;
		}

		const [vkUrl] = vkUrls;
		const set = vkToSteam.get(vkUrl) ?? new Set();
		set.add(creatorId);
		vkToSteam.set(vkUrl, set);
	}

	const immunity = await pullPlagiarismImmunity();
	const immuneIds = resolveImmunePackIds(immunity, vkToSteam);

	if (immuneIds.size > 0) {
		say('plagiarism', `иммунитет от плагиата включён: истинно оригинальных паков ${immuneIds.size}`);
	}

	// Отпечатки подшиваются слева: пак, у которого их ещё нет, из счёта
	// не выпадает — он просто приходит с пустой свёрткой и остаётся ни при чём.
	// Заодно подтягиваются дата самого раннего живого Steam-дубля (для contentTs),
	// SteamID64 создателей и канонический ключ единственного автора (для samePerson)
	const rows = db.prepare(`
		SELECT p.id, p.name, p.vk_ts, p.file_ts, p.vk_author, p.vk_author_url, p.authors_key,
			q.prints, COALESCE(q.version, 1) AS prints_version,
			(SELECT MIN(ps.created_at) FROM pack_steam ps
				WHERE ps.target_package_id = p.id AND ps.state = 'ok' AND ps.created_at > 0) AS steam_created_at,
			(SELECT GROUP_CONCAT(DISTINCT ps.creator_id) FROM pack_steam ps
				WHERE ps.target_package_id = p.id AND ps.state = 'ok'
					AND ps.creator_id IS NOT NULL AND ps.creator_id <> '') AS steam_creators,
			(SELECT CASE WHEN COUNT(*) = 1 THEN MIN(pa.canon_key) END FROM pack_authors pa
				WHERE pa.package_id = p.id) AS canon_key
		FROM packages p LEFT JOIN pack_prints q ON q.package_id = p.id
		WHERE p.status = 'ok' ORDER BY p.id
	`).iterate();

	const { verdicts, taken, stats } = reviewPlagiarism(rows, config, { vkToSteam, immuneIds });

	// Кто числился вором вчера. Нужны затем, чтобы снять метку с того, кто её
	// потерял: пак, у которого сменился разбор или у которого нашёлся ещё более
	// ранний первоисточник, обязан перестать числиться вором сам, а не ждать,
	// пока это заметят руками
	const marked = db.prepare(`SELECT id FROM packages WHERE plagiarism_kind IS NOT NULL${scope}`)
		.all(...target.params).map(row => row.id);

	// …и кто числился обворованным. Своей колонки у этой метки нет — она лежит
	// прямо в темах (см. markStolenThemes), — поэтому и ищется она по темам.
	// Обход всей строки rounds на пятнадцати тысячах паков стоит доли секунды
	// и случается раз в пересмотр, то есть дешевле новой колонки, которая
	// потянула бы за собой полную перезаливку базы наверх
	const robbed = db.prepare(`SELECT id FROM packages
		WHERE rounds LIKE '%"taken"%'${scope}`).all(...target.params).map(row => row.id);

	const readRounds = db.prepare('SELECT rounds FROM packages WHERE id = ?');
	const now = Date.now();

	// Отметка «проверен» всем разом, одним запросом. Проверены-то все — приговор
	// получают единицы, и заводить на каждый пак по запросу ради одного числа
	// значило бы одиннадцать тысяч записей вместо одной
	db.prepare(`UPDATE packages SET plagiarism_at = ? WHERE status = 'ok'${scope}`).run(now, ...target.params);

	/**
	 * Приговор одному паку вместе с метками у его тем — обеими сразу.
	 *
	 * Обе стороны пишутся одним запросом нарочно: у пака бывают сразу и та,
	 * и другая — он и списал у кого-то, и у него списали, — а темы лежат в одном
	 * поле, и два запроса переписали бы его дважды, вторым затерев первое.
	 */
	const save = (id, verdict) => {
		const stored = readRounds.get(id).rounds;
		const places = verdict?.places ?? [];
		const mine = taken.get(id)?.places ?? [];

		updatePlagiarism.run(
			verdict?.kind ?? null,
			verdict?.share ?? null,
			verdict?.questions ?? null,
			JSON.stringify(verdict?.sources ?? []),
			markStolenThemes(stored, places, mine) ?? stored,
			now,
			id,
		);
	};

	let cleared = 0;
	let questions = 0;
	const kinds = { pack: 0, compiled: 0, partial: 0, trace: 0 };

	// Кого пишем: всех, у кого сегодня есть хоть одна из двух меток, и всех,
	// у кого вчера была хоть одна, — вторым метку снимет тот же save
	const touched = new Set([...verdicts.keys(), ...taken.keys(), ...marked, ...robbed]);
	const wasMarked = new Set(marked);

	for (const id of touched) {
		// Приговор вынесен по всей базе, а записывается только названным:
		// «обнови вот этот пак» не должно трогать соседей
		if (only && !only.has(id)) {
			continue;
		}

		const verdict = verdicts.get(id) ?? null;

		save(id, verdict);

		if (verdict) {
			kinds[verdict.kind]++;
			questions += verdict.questions;
		} else if (wasMarked.has(id)) {
			cleared++;
		}
	}

	const marks = kinds.pack + kinds.compiled + kinds.partial + kinds.trace;
	const blind = stats.packs - stats.withPrints;

	say('plagiarism', `разных вопросов ${stats.fingerprints}, из них общих мест ${stats.common}`
		+ ` (встречаются в ${config.plagiarismCommonPacks}+ паках и в счёт не идут);`
		+ ` паков с отпечатками ${stats.withPrints} из ${stats.packs}`);

	// Пак без отпечатков для правила пуст, и молчать об этом нельзя: приговоры
	// по такой базе неполны, а выглядят они точно так же, как полные
	if (blind > 0) {
		say('plagiarism', `у ${blind} паков отпечатков вопросов ещё нет — по ним ничего не найдено `
			+ 'и найдено быть не могло. Снимает их шаг «Отпечатки вопросов» (--prints).');
	}

	// Пак из одних немых вопросов — тоже пустой для правила, но пустой навсегда:
	// пересъёмка отпечатков ему не поможет (см. MUTE в src/plagiarism.js),
	// и путать его с теми, у кого отпечатков просто нет, нельзя
	if (stats.mute > 0) {
		say('plagiarism', `у ${stats.mute} паков все вопросы без текста и без ответа — одни имена файлов; `
			+ 'сравнивать их не с чем, и в улов они не попадут ни при каком пересмотре');
	}

	// Свёртка старого вида врёт в другую сторону, и об этом тоже надо сказать
	// вслух: в ней вопрос из одного имени файла записан обычным отпечатком,
	// и совпадение таких вопросов у двух паков идёт в улики, хотя улики
	// за этим нет (см. MUTE в src/plagiarism.js)
	const stalePrints = db.prepare(`SELECT COUNT(*) AS c FROM packages p
		JOIN pack_prints q ON q.package_id = p.id
		WHERE p.status = 'ok' AND q.prints IS NOT NULL
			AND COALESCE(q.version, 1) < ${PRINTS_VERSION}`).get().c;

	if (stalePrints > 0) {
		say('plagiarism', `у ${stalePrints} паков отпечатки сняты по прежнему правилу: `
			+ 'у них медиавопрос без текста и без ответа всё ещё совпадает по одному имени файла. '
			+ 'Пересниматься они будут шагом «Отпечатки вопросов» (--prints), и после него нужен новый пересмотр.');
	}

	say('plagiarism', `отмечено ${marks}: копий ${kinds.pack}, солянок ${kinds.compiled}, `
		+ `с заметной долей чужого ${kinds.partial}, с единичными чужими вопросами ${kinds.trace}`
		+ `${cleared > 0 ? `; метка снята у ${cleared}` : ''}`);
	say('plagiarism', `чужих вопросов в отмеченных паках ${questions}`);

	// Обратная сторона тех же находок: у скольких паков что-то взяли. Число
	// это не про воровство, а про то, чьи вопросы разошлись по библиотеке,
	// и на карточке такая тема красится зелёным
	say('plagiarism', `вопросы взяли у ${stats.robbed} паков — их темы отмечены зелёным`);
}
