// Что делать, когда Gemini отвечает отказом: перейти на запасную модель
// или свернуть разметку до следующего раза.
//
// Порознь от самой разметки потому, что вопрос этот общий на все три шага,
// которые ходят к модели (тематики, описания, «всё о паке»), а решение
// у него одно на весь запуск: кончившиеся суточные запросы кончились для всех
// сразу, и узнать об этом каждому шагу порознь означало бы упереться в предел
// по три раза.

import { activeModel, hasGemini, useModel } from '../gemini/api.js';
import { nextSpareModel, usage, usageLine } from '../models.js';
import { fallback, fallbackAny } from './options.js';
import { say } from './progress.js';

/**
 * Ошибка, после которой следующий пак получит ровно то же самое: неверный ключ,
 * неизвестная модель, кончившиеся лимиты. Признак ставит сам src/gemini/api.js; строки
 * оставлены для ошибок, пришедших не оттуда.
 */
function isFatalGeminiError(error) {
	return error.fatal === true || /ключа|API key|API_KEY|not found|permission/i.test(error.message);
}

/**
 * Кончившиеся лимиты — беда общая: если их не хватило на тематики, то и на
 * описания не хватит. Обе полосы смотрят на этот признак и сворачиваются,
 * вместо того чтобы выяснять то же самое заново на каждом оставшемся паке.
 */
export let geminiQuotaSpent = false;

/**
 * Кончились суточные запросы: перейти на запасную модель или свернуть полосу.
 *
 * Зовётся оттуда, где раньше стояло просто «geminiQuotaSpent = true». Разница
 * в одном: сперва спрашивается, есть ли чем продолжать (см. nextSpareModel
 * в models.js), и только если нечем — ночь на этом кончается.
 *
 * @param {string} step от чьего имени писать в лог
 * @param {string} model модель, которой этот запрос отказали
 * @returns {boolean} перешли ли на другую: false — полоса сворачивается
 */
function switchModel(step, model) {
	if (!fallback) {
		return false;
	}

	// Полос две и работников в каждой несколько: отказ по одному и тому же лимиту
	// прилетает разом с нескольких сторон. Переключает первый, кто добежал,
	// а остальные видят, что модель уже не та, которой им отказали, — и молчат.
	// Иначе один кончившийся лимит перебрал бы весь список запасных подряд
	if (model !== activeModel()) {
		return true;
	}

	const next = nextSpareModel(model, { any: fallbackAny });

	if (!next) {
		return false;
	}

	useModel(next);
	say(step, `у ${model} суточные запросы кончились — перехожу на ${next}. ${usageLine(next)}`);

	return true;
}

/**
 * Что делать с ошибкой модели, прилетевшей в полосу.
 *
 * Обычная ошибка (сеть, оборванный ответ) полосу не трогает: следующий пак
 * вполне может разобраться. Ошибка, после которой следующий получит то же самое,
 * сворачивает полосу — кроме одного случая: кончившиеся суточные запросы можно
 * пережить, перейдя на запасную модель.
 *
 * @param {string} step от чьего имени писать в лог
 * @param {Error} error что пришло
 * @param {string} model модель, которой отказали
 */
export function noteGeminiFailure(step, error, model) {
	if (!isFatalGeminiError(error)) {
		return;
	}

	// Кончились сутки у этой модели, а не у ключа: если есть чем продолжать,
	// полоса не сворачивается вовсе — просто дальше спрашивается другая
	if (error.quota === true && switchModel(step, model)) {
		return;
	}

	geminiQuotaSpent = geminiQuotaSpent || error.quota === true;
	say(step, stopReason(error));
}

/**
 * Модель перегружена и после всех повторов: перейти на другую, если запуску
 * это разрешено (--fallback), — и тогда шаг спрашивает про те же паки ещё раз.
 *
 * Нужно ежечасному обходу: у него пак один, а следующий запуск GitHub может
 * отложить на полдня, и пак всё это время висит на сайте без типа и описания.
 * Ночь ключа --fallback не берёт и этим не пользуется: у неё неразмеченное
 * подберёт следующая ночь, а менять модель из-за минутного всплеска незачем.
 *
 * @returns {boolean} перешли ли на другую модель
 */
export function overloadSwitch(step, error, model) {
	if (error.overloaded !== true || !fallback) {
		return false;
	}

	// Другой работник уже переключил — повторяем на той, что стоит сейчас
	if (model !== activeModel()) {
		return true;
	}

	const next = nextSpareModel(model, { any: fallbackAny });

	if (!next) {
		return false;
	}

	useModel(next);
	say(step, `${model} перегружена — перехожу на ${next}. ${usageLine(next)}`);

	return true;
}

/** Что написать, сворачивая полосу. Кончившиеся лимиты — не поломка. */
function stopReason(error) {
	return error.quota === true
		? `у ${activeModel()} кончились суточные лимиты. Оставшиеся паки разберутся при следующем запуске: `
			+ 'шаг и так берёт только те, у которых разметки нет.'
		: 'останавливаю шаг: следующий пак получит ту же ошибку.';
}

/** Общая проверка перед шагом с моделью. Возвращает false, если спрашивать некого. */
export function geminiReady(step) {
	if (!hasGemini()) {
		say(step, 'пропускаю, нет ключа Gemini (data/gemini-key.txt или GEMINI_API_KEY)');
		return false;
	}

	if (geminiQuotaSpent) {
		say(step, 'пропускаю, лимиты Gemini кончились');
		return false;
	}

	const left = usage(activeModel());

	if (left.unavailable) {
		say(step, `пропускаю: модель ${activeModel()} закрыта для этого ключа (${left.refusal ?? 'без объяснений'})`);
		return false;
	}

	// Лимиты кончились ещё до начала шага — обычное дело для второго прохода ночи:
	// первый уже выбрал сутки. Переход на запасную модель годится и здесь
	if (left.spentOut) {
		if (switchModel(step, activeModel())) {
			return true;
		}

		say(step, `пропускаю: у ${activeModel()} лимиты на сегодня уже кончились (${usageLine(activeModel())})`);
		geminiQuotaSpent = true;
		return false;
	}

	return true;
}
