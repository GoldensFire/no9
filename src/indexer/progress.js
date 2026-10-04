// Как обход рассказывает о себе: строка в лог от имени шага и полоска
// выполнения для страницы обновления базы.
//
// Отдельным файлом потому, что счётчик у шагов общий по устройству: полосы
// идут вперемешку (см. шапку src/indexer.js), и каждая отчитывается своим
// Track в один и тот же поток. Шагу отсюда нужны две вещи — say() и track(), —
// и больше он про отчётность знать не обязан.

import { PROGRESS_PREFIX } from '../config.js';

/**
 * Отчёт о ходе работы для страницы обновления базы: сколько сделано из скольких.
 * В обычном запуске из консоли эти строки только мешали бы, поэтому печатаются,
 * лишь когда индексатор запущен сайтом (см. server.js).
 */
const guiMode = process.env.FIREPACKS_GUI === '1';

export function report(event) {
	if (guiMode) {
		process.stdout.write(PROGRESS_PREFIX + JSON.stringify(event) + '\n');
	}
}

/** Человеческая запись длительности: «2 ч 05 мин», «14 мин», «40 с». */
export function formatSpan(ms) {
	if (ms === null || !Number.isFinite(ms)) {
		return '';
	}

	const seconds = Math.round(ms / 1000);

	if (seconds < 90) {
		return `${seconds} с`;
	}

	const minutes = Math.round(seconds / 60);

	if (minutes < 90) {
		return `${minutes} мин`;
	}

	return `${Math.floor(minutes / 60)} ч ${String(minutes % 60).padStart(2, '0')} мин`;
}

/**
 * Счётчик одного шага: сколько сделано, сколько всего и когда это кончится.
 *
 * Всего — величина не постоянная: пока идёт обход ВК, у разбора прибывает работа,
 * а у статистики она прибывает от разбора. Поэтому «всего» не задаётся вперёд,
 * а растёт (см. expand), и остаток времени считается по нынешнему темпу: сколько
 * ушло на сделанное, столько же в среднем уйдёт на каждое оставшееся.
 *
 * Темп берётся не за всё время, а за последнее: у разбора первые паки идут
 * вперемешку с обходом ВК и медленнее, чем потом, и средняя за весь шаг обещала
 * бы вдвое больше правды.
 */
export class Track {
	constructor(step) {
		this.step = step;
		this.total = 0;
		this.done = 0;
		this.issued = 0;
		this.reported = 0;
		this.startedAt = Date.now();
		this.marks = [];
		this.lastSent = 0;
		this.growing = false;
	}

	/**
	 * Номер для строки лога. Считается по выданным, а не по законченным: работники
	 * идут вшестером, и «сделано» у них в один миг одно и то же — шесть строк
	 * подряд с одинаковым номером.
	 */
	label() {
		return `${++this.issued}/${this.total}`;
	}

	/**
	 * Пора ли писать в лог очередное «столько-то из стольких».
	 *
	 * Не просто остаток от деления: работников несколько, и в тот миг, когда
	 * сделано ровно сотня, спросить об этом успевают все четверо — в логе выходило
	 * четыре одинаковых строки подряд.
	 */
	milestone(every) {
		if (this.done > 0 && this.done - this.reported >= every) {
			this.reported = this.done;
			return true;
		}

		return false;
	}

	expand(count) {
		this.total += count;
		this.send(true);
	}

	tick(count = 1) {
		this.done += count;
		this.marks.push([Date.now(), this.done]);

		// Хвоста в две сотни отметок хватает, чтобы сгладить случайный долгий пак
		// и при этом не помнить о том, как шаг разгонялся полчаса назад
		if (this.marks.length > 200) {
			this.marks.splice(0, this.marks.length - 200);
		}

		this.send();
	}

	/** Сколько осталось, миллисекунды. Пусто, пока считать не из чего. */
	get etaMs() {
		const left = this.total - this.done;

		if (left <= 0 || this.marks.length < 2) {
			return null;
		}

		const [firstAt, firstDone] = this.marks[0];
		const [lastAt, lastDone] = this.marks.at(-1);
		const span = lastAt - firstAt;
		const made = lastDone - firstDone;

		if (span <= 0 || made <= 0) {
			return null;
		}

		return Math.round((span / made) * left);
	}

	/** Хвост строки для консоли: «1200/4885, осталось ~14 мин». */
	get line() {
		const eta = this.etaMs;
		return `${this.done}/${this.total}${eta ? `, осталось ~${formatSpan(eta)}` : ''}`;
	}

	send(force = false) {
		const now = Date.now();

		// Полоска выполнения на странице не станет честнее от сотни сообщений
		// в секунду, а стоят они настоящих байтов в трубе
		if (!force && now - this.lastSent < 250) {
			return;
		}

		this.lastSent = now;
		report({ step: this.step, done: this.done, total: this.total, eta: this.etaMs, growing: this.growing });
	}

	finish() {
		this.send(true);
		report({ step: this.step, state: 'done' });
	}
}

export const tracks = new Map();
export const track = step => tracks.get(step);

/** Строка в лог от имени шага: полосы идут вперемешку, и без подписи их не разобрать. */
export const TAGS = {
	vk: 'ВК',
	parse: 'разбор',
	stats: 'статистика',
	statsnew: 'статистика новых',
	topics: 'тематики',
	summary: 'описания',
	analyze: 'разметка',
	logos: 'логотипы',
	specials: 'спецвопросы',
	prints: 'отпечатки',
	durations: 'длительность',
	hyx: 'SI-HYX',
	authors: 'авторы',
	copies: 'копии',
	plagiarism: 'плагиат',
	recalc: 'пересчёт',
	// Не шаг, а весь обход разом: строка про то, что отпущенное время вышло
	// и очередь досрочно свёрнута (см. --minutes)
	time: 'время',
};

export const say = (step, line) => console.log(`[${TAGS[step]}] ${line}`);
