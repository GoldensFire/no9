// Доставка для замера: пачка картинок → ответ модели или причина, по которой
// его нет. Ходит ключом модерации (config.geminiModKey), никогда ключом
// разметки.
//
// Это времянка этапа 1. Настоящая доставка — src/gemini/api.js, и картинки
// она научится возить на этапе 2 (nsfw-moderation.md, 7.1); тогда этот файл
// уходит, а замер зовёт её. Сюда вынесено ровно то, чего там пока нет:
// части-картинки, mediaResolution, очередь на каждую модель отдельно
// и блокировка как исход, а не как ошибка.
//
// Расход в gemini_usage не пишется нарочно: ключ другой, проект другой,
// и суточный счёт разметки он не трогает.

import { config } from '../../config.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Пределы бесплатного ключа у Flash-Lite (FAMILIES в src/models.js). */
const RPM = 15;
const TPM = 250_000 * 0.8;

/** Очередь у каждой модели своя: две модели идут разом и друг друга не ждут. */
const lanes = new Map();

function lane(model) {
	if (!lanes.has(model)) {
		lanes.set(model, { nextAt: 0, log: [], requests: 0, dead: null });
	}

	return lanes.get(model);
}

export const requestsMade = model => lane(model).requests;

async function takeTurn(model, tokens) {
	const state = lane(model);

	for (;;) {
		const now = Date.now();
		state.log = state.log.filter(entry => entry.at > now - 60_000);

		const spent = state.log.reduce((sum, entry) => sum + entry.tokens, 0);
		const wait = Math.max(
			state.nextAt - now,
			spent + tokens > TPM && state.log.length > 0 ? state.log[0].at + 60_500 - now : 0,
		);

		if (wait <= 0) {
			break;
		}

		await sleep(wait);
	}

	state.nextAt = Date.now() + Math.ceil(60_000 / RPM) + 200;
	state.requests++;

	const entry = { at: Date.now(), tokens };
	state.log.push(entry);
	return entry;
}

const SAFETY_OFF = [
	'HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH',
	'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT',
].map(category => ({ category, threshold: 'BLOCK_NONE' }));

/**
 * @param {string} model
 * @param {object[]} parts части запроса (см. batchParts в ../prompt.js)
 * @param {{schema: object, resolution: 'low'|'medium'|'default', tokens: number}} options
 *   tokens — во сколько запрос обойдётся по оценке, для минутного предела
 * @returns {Promise<{value?: any, blocked?: string, quota?: boolean, error?: string,
 *   usage?: object, ms: number}>} ровно один из исходов: ответ, блокировка
 *   фильтром, кончившиеся сутки или ошибка
 */
export async function askImages(model, parts, { schema, resolution, tokens }) {
	if (!config.geminiModKey) {
		return { error: 'нет ключа модерации: data/gemini-mod-key.txt или GEMINI_MOD_KEY', ms: 0 };
	}

	const state = lane(model);

	if (state.dead) {
		return { quota: true, error: state.dead, ms: 0 };
	}

	const body = JSON.stringify({
		contents: [{ role: 'user', parts }],
		safetySettings: SAFETY_OFF,
		generationConfig: {
			temperature: 0,
			responseMimeType: 'application/json',
			responseSchema: schema,
			thinkingConfig: { thinkingLevel: 'low' },
			...(resolution === 'default' ? {} : { mediaResolution: `MEDIA_RESOLUTION_${resolution.toUpperCase()}` }),
		},
	});

	for (let attempt = 1; ; attempt++) {
		const slot = await takeTurn(model, tokens);
		const started = Date.now();
		let response;
		let data;

		try {
			response = await fetch(`${config.geminiEndpoint}/models/${model}:generateContent`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiModKey },
				body,
			});
			data = await response.json();
		} catch (error) {
			if (attempt >= 3) {
				return { error: `сеть: ${error.message}`, ms: Date.now() - started };
			}

			await sleep(3000 * attempt);
			continue;
		}

		const ms = Date.now() - started;

		if (response.status === 429) {
			const details = data.error?.details ?? [];
			const perDay = details.some(detail => (detail.violations ?? [])
				.some(item => /per_?day/i.test(`${item.quotaId}${item.quotaMetric}`)));
			const delay = details.map(detail => /^(\d+(?:\.\d+)?)s$/.exec(String(detail.retryDelay ?? ''))?.[1]).find(Boolean);

			if (perDay || attempt >= 4) {
				state.dead = data.error?.message?.slice(0, 200) ?? 'кончились сутки';
				return { quota: true, error: state.dead, ms };
			}

			await sleep(Math.min(60_000, (Number(delay) || 15) * 1000 + 500));
			continue;
		}

		if (!response.ok) {
			if (response.status >= 500 && attempt < 3) {
				await sleep(4000 * attempt);
				continue;
			}

			return { error: `${response.status}: ${data.error?.message?.slice(0, 200)}`, ms };
		}

		const usage = data.usageMetadata ?? {};

		if (Number.isFinite(usage.totalTokenCount)) {
			slot.tokens = usage.totalTokenCount;
		}

		// Блокировка: либо запрос не приняли вовсе (promptFeedback), либо ответ
		// оборван фильтром. И то, и другое — сигнал о содержимом пачки
		const candidate = data.candidates?.[0];
		const blocked = data.promptFeedback?.blockReason
			?? (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'IMAGE_SAFETY', 'SPII'].includes(candidate?.finishReason) ? candidate.finishReason : null);

		if (blocked) {
			return { blocked, usage, ms };
		}

		const text = (candidate?.content?.parts ?? []).map(part => part.text ?? '').join('');

		try {
			return { value: JSON.parse(text), usage, ms };
		} catch {
			if (attempt < 2) {
				continue;
			}

			return { error: `ответ не разобрать (${candidate?.finishReason ?? 'без причины'}): ${text.slice(0, 80)}`, usage, ms };
		}
	}
}
