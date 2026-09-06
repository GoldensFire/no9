// Один автор — один человек: сводит подписи, за которыми стоит один и тот же
// человек, к одному автору.
//
// Ни сети, ни модели — одна выборка по базе. Без неё топ авторов разваливает
// человека на столько строк, сколько ников он себе придумал.

import { db } from '../db.js';
import { say } from './progress.js';

// ————— один автор — один человек —————

/**
 * Сводит подписи, за которыми стоит один и тот же человек, к одному автору.
 *
 * ————— чем плоха подпись в файле —————
 *
 * Автор пака — это то, что написано в поле <author> внутри .siq, и написано там
 * что угодно. Один и тот же человек подписывается то ником, то ником с цифрой,
 * то названием своей команды, то именем и фамилией; в топе авторов он стоял
 * столькими строками, сколько написаний придумал, и в каждой — своя горстка
 * паков вместо общего счёта.
 *
 * Между тем видно, что это один человек: паки выложены с одной и той же
 * страницы ВК. Имя в ВК меняют, адрес страницы — нет, и другого столь же
 * твёрдого признака у нас нет (по нему же считается «свой пак» в плагиате,
 * см. samePerson в src/plagiarism.js).
 *
 * ————— почему не «все подписи одного аккаунта — один человек» —————
 *
 * Потому что с одного аккаунта выкладывают и чужое. Человек, перевыложивший
 * пак приятеля, забрал бы себе и приятеля со всеми его паками — а тот выкладывал
 * их сам и со своей страницы.
 *
 * Поэтому сливаются только подписи, за которыми никого другого не стоит:
 * подпись переходит к аккаунту, если ВСЕ её паки выложены с него одного.
 * Подпись, встретившаяся у двух аккаунтов, остаётся сама по себе — это ровно
 * тот случай, когда неизвестно, кто из них автор, и выдумывать нечего.
 *
 * Главным именем становится то написание, которым подписано больше паков:
 * это то имя, под которым человека знают. При равенстве — то, что короче
 * и раньше по алфавиту, чтобы выбор не плясал от запуска к запуску.
 *
 * ————— и отдельно: подпись с опечаткой —————
 *
 * Правило выше молчит про случай, который на сайте виден лучше всех прочих:
 * человек однажды промахнулся мимо клавиши. «Magneticalsmit» и
 * «MagneticalSmith» — это не два человека, а один и опечатка, но правилу
 * «все паки с одного аккаунта» тут зацепиться не за что: большая подпись
 * встречается у трёх аккаунтов (страница ВК записана и коротким именем,
 * и номером, да ещё один пак выложил за компанию соавтор), а значит,
 * сливаться не имеет права вовсе — и остаётся сама по себе. Маленькая же
 * подпись живёт на одном аккаунте, сливается с чем придётся и становится
 * отдельным человеком: в топе авторов один и тот же человек стоял двумя
 * строками, и вторая вела не на его страницу, а в библиотеку отбором
 * (/?author=Magneticalsmit при живой /author/magneticalsmith).
 *
 * Поэтому есть вторая, узкая мерка — та, что ниже названа nearDuplicate:
 * подпись отдаётся другой подписи, если совпало всё сразу — обе встречаются
 * на одном и том же аккаунте, различаются одной-единственной буквой, длиннее
 * NEAR_MIN_LENGTH, и та, другая, крупнее. Мерка нарочно сделана такой узкой:
 * похожие имена сами по себе не значат ничего («Anna» и «Anny» — двое разных),
 * и решает здесь не похожесть, а похожесть ВМЕСТЕ с общей страницей ВК.
 */
export function mergeAuthors() {
	// Строка на «подпись под паком, выложенным с этого аккаунта». Мёртвые
	// и похороненные паки в счёт идут наравне с живыми: аккаунт, с которого
	// выкладывали, остаётся тем же аккаунтом, а вот подпись, встречающаяся
	// только у мёртвого пака, без них потеряла бы своего человека
	const rows = db.prepare(`
		SELECT a.author_key AS key, a.author AS name, p.vk_author_url AS account, COUNT(*) AS packs,
			SUM(CASE WHEN p.status = 'ok' THEN 1 ELSE 0 END) AS live
		FROM pack_authors a JOIN packages p ON p.id = a.package_id
		GROUP BY a.author_key, a.author, p.vk_author_url
	`).all();

	/** Подпись -> {написания, из них живые, аккаунты, сколько паков}. */
	const signatures = new Map();

	for (const row of rows) {
		let item = signatures.get(row.key);

		if (!item) {
			item = { key: row.key, spellings: new Map(), live: new Map(), accounts: new Set(), packs: 0 };
			signatures.set(row.key, item);
		}

		item.spellings.set(row.name, (item.spellings.get(row.name) ?? 0) + row.packs);
		item.live.set(row.name, (item.live.get(row.name) ?? 0) + (row.live ?? 0));
		item.packs += row.packs;

		const account = (row.account ?? '').trim();

		// Пак, выложенный не через ВК или без адреса автора, аккаунтом
		// не считается: неизвестность не должна связывать подписи между собой
		if (account) {
			item.accounts.add(account);
		} else {
			item.accounts.add(`?${row.key}`);
		}
	}

	/** Аккаунт -> подписи, которые нигде больше не встречаются. */
	const byAccount = new Map();

	/**
	 * Аккаунт -> все подписи, встреченные на нём, включая те, что встречаются
	 * и на других аккаунтах.
	 *
	 * Нужен он одной лишь мерке про опечатку: та ищет крупную подпись, с которой
	 * маленькую роднит и написание, и страница ВК, — а крупная как раз обычно
	 * и есть многоаккаунтная, то есть в byAccount её нет.
	 */
	const seenByAccount = new Map();

	for (const item of signatures.values()) {
		for (const account of item.accounts) {
			if (!account.startsWith('?')) {
				const all = seenByAccount.get(account) ?? [];
				all.push(item);
				seenByAccount.set(account, all);
			}
		}

		if (item.accounts.size !== 1) {
			continue;
		}

		const account = [...item.accounts][0];

		// Мнимый аккаунт «?подпись» — это «выложено без адреса»: собственный
		// у каждой подписи, и слить он ничего не может
		if (account.startsWith('?')) {
			continue;
		}

		const known = byAccount.get(account) ?? [];
		known.push(item);
		byAccount.set(account, known);
	}

	const write = db.prepare('UPDATE pack_authors SET canon_key = ?, canon_name = ? WHERE author_key = ?');
	const mark = db.prepare('UPDATE pack_authors SET canon_account = ? WHERE author_key = ?');
	const reset = db.prepare('UPDATE pack_authors SET canon_key = author_key, canon_name = author WHERE canon_key <> author_key');
	const unmark = db.prepare('UPDATE pack_authors SET canon_account = NULL WHERE canon_account IS NOT NULL');

	// Сначала всё возвращается к подписям, потом сливается заново. Иначе слияние,
	// отменённое новыми паками (подпись встретилась у второго аккаунта), осталось
	// бы в базе навсегда. То же и со страницей ВК: подпись, у которой появился
	// второй аккаунт, своего человека больше не называет, и метка обязана сойти —
	// иначе на сайте остался бы подтверждённый автор, которого уже нечем
	// подтвердить (см. cf/src/library/authorship.js)
	reset.run();
	unmark.run();

	// Главное написание — каждой подписи своё, ещё до всякого слияния.
	//
	// Раньше этого прохода не было вовсе: canon_name у неслитой подписи
	// оставался тем, что написано в поле <author> вот этого одного пака, —
	// то есть у одного и того же человека он был разным от пака к паку.
	// Теперь он один на подпись и выбран по счёту паков (см. mainSpelling),
	// и на карточке, на странице автора и в топе стоит одно и то же имя.
	for (const item of signatures.values()) {
		write.run(item.key, mainSpelling(item), item.key);
	}

	let merged = 0;
	let people = 0;
	let marked = 0;

	// ————— опечатки —————
	//
	// Первым проходом, до слияния по аккаунтам, и это важно: подпись, отданную
	// сюда, второй проход трогать уже не должен, иначе он тут же перепишет
	// её канон на свой (см. own ниже).
	const aliased = new Set();
	let typos = 0;

	for (const [account, group] of byAccount) {
		for (const item of group) {
			// Крупнее, на том же аккаунте и всего на букву иначе. Многоаккаунтность
			// второй подписи здесь не условие, а обычное положение дел: будь она
			// тоже своя, обе и так уехали бы в один канон проходом ниже
			const twin = (seenByAccount.get(account) ?? []).find(other => other !== item
				&& other.packs > item.packs && nearDuplicate(item.key, other.key));

			if (twin) {
				write.run(twin.key, mainSpelling(twin), item.key);
				aliased.add(item.key);
				typos++;

				say('authors', `${mainSpelling(twin)}: ${item.key} — опечатка`);
			}
		}
	}

	for (const [account, group] of byAccount) {
		// Номер страницы ВК, если он вообще есть. Ставится и одиночной подписи —
		// сливать у неё нечего, а человек за ней стоит такой же настоящий,
		// и подтверждать своё авторство он должен наравне со всеми
		const number = accountNumber(account);

		if (number) {
			for (const item of group) {
				mark.run(number, item.key);
				marked++;
			}
		}

		// Подписи, уже отданные своей опечаткой другому человеку, из счёта вон:
		// иначе слияние по аккаунту тут же увело бы их обратно
		const own = group.filter(item => !aliased.has(item.key));

		if (own.length < 2) {
			continue;
		}

		// Главное написание — то, которым подписано больше паков
		const best = bestSpelling(own.flatMap(item => spellingCounts(item)));

		const canonKey = own
			.slice()
			.sort((a, b) => b.packs - a.packs || a.key.length - b.key.length || a.key.localeCompare(b.key))[0].key;

		for (const item of own) {
			write.run(canonKey, best, item.key);
		}

		people++;
		merged += own.length - 1;

		say('authors', `${best}: ${own.map(item => item.key).join(', ')}`);
	}

	say('authors', `подписей ${signatures.size}; сведено ${merged} лишних к ${people} авторам `
		+ `(паки выложены с одной страницы ВК); опечаток ${typos}; с номером страницы ${marked}`);
}

/** Написания подписи с двумя счётчиками: сколько паков всего и сколько живых. */
const spellingCounts = item => [...item.spellings.entries()]
	.map(([name, all]) => ({ name, all, live: item.live.get(name) ?? 0 }));

/**
 * Написание, под которым человека знают: то, которым подписано больше паков.
 *
 * Считаются сперва живые паки, и только если живых нет ни одного — все подряд.
 * Разница не умозрительная: у «пети» три пака подписаны «петя» и три
 * «baziltred», но все три первых давно мертвы, а в библиотеке стоят вторые —
 * и звать человека именем, которого на сайте нет ни на одной карточке, значит
 * уводить с карточки «baziltred» на страницу «петя».
 *
 * При равенстве — то, что короче и раньше по алфавиту, чтобы выбор не плясал
 * от запуска к запуску.
 */
function bestSpelling(counts) {
	const live = counts.filter(item => item.live > 0);
	const pool = live.length > 0
		? live.map(item => ({ name: item.name, packs: item.live }))
		: counts.map(item => ({ name: item.name, packs: item.all }));

	return pool
		.sort((a, b) => b.packs - a.packs || a.name.length - b.name.length || a.name.localeCompare(b.name))[0]
		.name;
}

const mainSpelling = item => bestSpelling(spellingCounts(item));

/**
 * Короче этого подписи на опечатки не проверяются вовсе.
 *
 * В четырёх буквах одна ошибка — это уже другое слово: «Anna» и «Anny» с одной
 * страницы ВК бывают и двумя разными людьми, а «magneticalsmit»
 * и «magneticalsmith» — нет. Порог тот же по духу, что и у поиска
 * (см. allowedErrors в src/fuzzy.js): там короткие слова тоже не прощают ничего.
 */
const NEAR_MIN_LENGTH = 6;

/**
 * Одна ли это подпись с опечаткой: вставленная, потерянная, перепутанная буква
 * или две соседние, поменянные местами.
 *
 * Считается не расстоянием Левенштейна, а разбором четырёх случаев подряд:
 * их всего четыре, каждый читается строкой, а общая мера прощала бы ещё
 * и вторую ошибку, если её попросить, — а её здесь просить нельзя.
 */
function nearDuplicate(one, two) {
	if (Math.min(one.length, two.length) < NEAR_MIN_LENGTH || Math.abs(one.length - two.length) > 1) {
		return false;
	}

	if (one === two) {
		return false;
	}

	// Первое расхождение слева и первое справа. Если между ними не осталось
	// ничего, кроме одной буквы (или одной пары), — это одна ошибка
	let head = 0;

	while (head < one.length && head < two.length && one[head] === two[head]) {
		head++;
	}

	let tail = 0;

	while (tail < one.length - head && tail < two.length - head
		&& one[one.length - 1 - tail] === two[two.length - 1 - tail]) {
		tail++;
	}

	const left = one.length - head - tail;
	const right = two.length - head - tail;

	// Лишняя или пропавшая буква — и подмена одной буквы на другую
	if ((left <= 1 && right <= 1)) {
		return true;
	}

	// Две соседние буквы наоборот: «поттре» вместо «поттер»
	return left === 2 && right === 2
		&& one[head] === two[head + 1] && one[head + 1] === two[head];
}

/**
 * Номер страницы ВК из её адреса, или null.
 *
 * Адрес автора приходит из ВК в двух видах: vk.com/id123456 — так его строит
 * обход по номеру отправителя сообщения (см. buildAuthor в src/vkapi.js), —
 * и vk.com/короткое_имя, как он записан у старых паков, разобранных ещё
 * по странице обсуждения. Второй вид номера не содержит вовсе, и достать
 * его оттуда нечем: короткое имя человек меняет, когда захочет.
 *
 * Почему это важно именно здесь. Войдя, ВК называет сайту номер — и только
 * номер. Сравнить его с коротким именем нельзя ничем, поэтому подпись,
 * у которой известно лишь короткое имя, остаётся без метки: пусть автор
 * не подтвердится, чем подтвердится не тот.
 *
 * Страницы сообществ (vk.com/club123, vk.com/public123) не в счёт по той же
 * причине с другой стороны: войти сообществом нельзя, и метка на нём была бы
 * меткой, которую некому предъявить.
 */
function accountNumber(url) {
	return /^https:\/\/vk\.com\/id(\d+)$/.exec(String(url ?? '').trim())?.[1] ?? null;
}
