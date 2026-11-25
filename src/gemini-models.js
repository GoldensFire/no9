// Справочник моделей Gemini, которыми имеет смысл размечать паки.
//
// Отдельно от src/models.js по одной причине: этот файл общий с Worker'ом
// (см. cf/src/library/rescan.js), а в Worker'е нет ни node:sqlite, ни node:fs.
// Здесь только чистые данные и расчёт ранга — никакого состояния и никакой базы.

/**
 * Как называются разметчики и что из названия следует.
 *
 * Два автоматических семейства зовутся одинаково — «gemini-<версия>-flash»
 * и то же самое с «-lite» на конце, — и по названию сразу известны и пределы
 * ключа, и место модели в ряду. На этом держится автопополнение списка
 * (см. discoverModels в src/gemini/discover.js).
 *
 * Предварительные сборки («-preview») и флагманские модели вроде Hydrogen
 * сюда нарочно не попадают: их вписывают руками ниже.
 */
export const FAMILY_ID = /^gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/;

/** Пределы бесплатного ключа по семейству. */
export const FAMILIES = {
	lite: { rpd: 500, rpm: 15, tpm: 250_000, spare: true },
	flash: { rpd: 20, rpm: 5, tpm: 250_000, spare: false },
	flagship: { rpd: 20, rpm: 5, tpm: 250_000, spare: false },
};

/**
 * Сила модели по её названию и семейству.
 *
 * Сначала все Flash-Lite по возрастанию версии, затем старшие Flash (100+),
 * затем флагманские модели (200+). Сотни — не числа, а разделители семейств:
 * любая модель старшего семейства сильнее любой младшего.
 */
export function modelRankOf(id, family) {
	const version = Number(FAMILY_ID.exec(id)?.[1] ?? /gemini-(\d+(?:\.\d+)?)-/.exec(id)?.[1]);

	if (!Number.isFinite(version)) {
		return 0;
	}

	if (family === 'lite') {
		return version;
	}

	if (family === 'flagship') {
		return 200 + version;
	}

	return 100 + version;
}

/** Описание модели по названию: семейство, пределы, ранг. */
export function describeModel(id, { title, note, family } = {}) {
	const kind = family ?? (FAMILY_ID.exec(id)?.[2] ? 'lite' : 'flash');

	return {
		id,
		title: title ?? id,
		note: note ?? '',
		family: kind,
		rank: modelRankOf(id, kind),
		...FAMILIES[kind],
	};
}

/** Проверенные модели, которыми имеет смысл размечать паки. */
export const BASE_MODELS = [
	describeModel('gemini-3.1-flash-lite', {
		title: 'Gemini 3.1 Flash-Lite',
		note: 'Самая дешёвая и быстрая. Пятьсот паков в сутки — ею и проходят базу',
	}),
	describeModel('gemini-3.5-flash-lite', {
		title: 'Gemini 3.5 Flash-Lite',
		note: 'Разумная середина: те же пятьсот в сутки, а ошибается заметно реже',
	}),
	describeModel('gemini-3-flash-preview', {
		title: 'Gemini 3 Flash (предварительная)',
		note: 'Предварительная сборка: работает, но может закрыться без предупреждения',
		family: 'flash',
	}),
	describeModel('gemini-3.5-flash', {
		title: 'Gemini 3.5 Flash',
		note: 'Хорошо понимает шуточные названия тем. Двадцать запросов в сутки — только на важное',
	}),
	describeModel('gemini-3.6-flash', {
		title: 'Gemini 3.6 Flash',
		note: 'Двадцать запросов в сутки — только на важное',
	}),
	describeModel('gemini-3.7-flash', {
		title: 'Gemini 3.7 Flash',
		note: 'Двадцать запросов в сутки — только на важное',
	}),
	describeModel('gemini-3.8-flash', {
		title: 'Gemini 3.8 Flash',
		note: 'Двадцать запросов в сутки — только на важное',
	}),
	describeModel('gemini-4-hydrogen', {
		title: 'Gemini 4 Hydrogen',
		note: 'Лучшая сейчас доступная модель. Для важных паков и точечного перескана',
		family: 'flagship',
	}),
];
