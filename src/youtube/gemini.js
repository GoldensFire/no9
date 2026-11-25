// Обращение к Gemini Video API по YouTube URL (fileData + videoMetadata).
//
// Видео забирает Google на своей стороне, поэтому сканер работает с IP
// GitHub Actions без yt-dlp, ffmpeg, tesseract и cookies.
//
// Особенности, проверенные вживую (youtube-gemini-plan.md, 1.4):
//   - 403 PERMISSION_DENIED на YouTube URL обычно означает приватное, удалённое
//     или идущее прямо сейчас live-видео, а НЕ битый ключ. Останавливаем только
//     это видео (VideoAccessError). Ключ считаем сломанным лишь после 5 разных
//     видео подряд с 403.
//   - 400 INVALID_ARGUMENT — битый срез или оффсет за концом видео (BadSliceError).
//   - 503 UNAVAILABLE (пик Free Tier) — переключение на запасную модель с
//     короткой паузой 5 с → 15 с → 30 с → 45 с и 5-минутным охлаждением
//     перегруженной модели (после охлаждения снова предпочитаем gemini-3.5-flash-lite).
//   - 429 RESOURCE_EXHAUSTED — различаем минутный лимит (ждём RetryInfo до 30 с)
//     и суточный (переключаем модель, а когда обе кончились — QuotaExhaustedError).

import { config } from '../config.js';

export const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const RPM_GAP_MS = 4500;
const OVERLOAD_BACKOFF_MS = [5_000, 15_000, 30_000, 45_000];
const OVERLOAD_COOLDOWN_MS = 5 * 60_000;
const MAX_QUOTA_WAIT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 40_000;
const MAX_CONSECUTIVE_403 = 5;

const sleep = ms => new Promise(res => setTimeout(res, ms));

function fmtOffset(sec) {
	const s = Math.max(0, Math.round(sec || 0));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const r = s % 60;
	return h > 0
		? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
		: `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

const PROMPT = [
	'Проверь КАЖДЫЙ переданный фрагмент видео с YouTube отдельно. Это может быть запись игры в «Свою игру» (SIGame / SIOnline) или другое видео.',
	'Определи:',
	'1. is_sigame: true, если хотя бы в одном фрагменте виден интерфейс компьютерной игры SIGame / SIOnline (табло тем с ценами 100-500, заголовок «Тема, цена», экран вопроса или выбора тем с панелью игроков SIGame). Для телепередачи НТВ «Своя игра» (телестудия, ведущий, синее студийное табло) и любых других игр/разговоров ставь false.',
	'2. themes: ВСЕ названия тем SIGame, которые читаются на экране в КАЖДОМ фрагменте (со всех строк табло слева, из заголовка «Тема, цена» сверху, из списка тем раунда). Переписывай название темы дословно, без цены и без добавления лишних слов вроде «Вопросы из...»; в поле clip укажи номер фрагмента (1, 2, ...), а в at — таймкод видео в формате MM:SS или HH:MM:SS.',
	'3. pack_names: названия паков вопросов ТОЛЬКО с экрана начала игры / обложки / названия пакета (отдельные темы раунда сюда НЕ клади).',
	'4. players: ники игроков и ведущего, видимые на панели игроков SIGame.',
	'Если SIGame в фрагментах нет, верни is_sigame: false и пустые массивы. Не выдумывай темы, которых не видно на экране.',
].join('\n');

const RESPONSE_SCHEMA = {
	type: 'OBJECT',
	properties: {
		is_sigame: { type: 'BOOLEAN' },
		pack_names: { type: 'ARRAY', items: { type: 'STRING' } },
		players: { type: 'ARRAY', items: { type: 'STRING' } },
		themes: {
			type: 'ARRAY',
			items: {
				type: 'OBJECT',
				properties: {
					name: { type: 'STRING' },
					clip: { type: 'INTEGER' },
					at: { type: 'STRING' },
				},
				required: ['name'],
			},
		},
	},
	required: ['is_sigame', 'pack_names', 'players', 'themes'],
};

export class VideoAccessError extends Error {
	constructor(message) {
		super(message);
		this.name = 'VideoAccessError';
	}
}

export class BadSliceError extends Error {
	constructor(message) {
		super(message);
		this.name = 'BadSliceError';
	}
}

export class QuotaExhaustedError extends Error {
	constructor(message, retryAfterMs = null) {
		super(message);
		this.name = 'QuotaExhaustedError';
		this.retryAfterMs = retryAfterMs;
	}
}

export class KeyBlockedError extends Error {
	constructor(message) {
		super(message);
		this.name = 'KeyBlockedError';
	}
}

function retryDelayFrom(error) {
	for (const detail of error?.details ?? []) {
		const m = /^(\d+(?:\.\d+)?)s$/.exec(String(detail.retryDelay ?? ''));
		if (m) return Math.round(Number(m[1]) * 1000);
	}
	const msg = String(error?.message || '');
	const hm = /retry\s+in\s+(?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i.exec(msg);
	if (hm) {
		return Math.round((Number(hm[1] || 0) * 3600 + Number(hm[2] || 0) * 60 + Number(hm[3] || 0)) * 1000);
	}
	return null;
}

function quotaInfoFrom(error) {
	let perDay = false;
	let youtubeLimit = false;
	const msg = String(error?.message || '');
	if (/per\s*day|daily|8\s*hours|youtube/i.test(msg)) {
		perDay = /per\s*day|daily/i.test(msg);
		youtubeLimit = /8\s*hours|youtube/i.test(msg);
	}
	for (const detail of error?.details ?? []) {
		for (const v of detail.violations ?? []) {
			const id = String(v.quotaId ?? '') + ' ' + String(v.quotaMetric ?? '');
			if (/per_?day/i.test(id)) perDay = true;
			if (/youtube|video_duration/i.test(id)) youtubeLimit = true;
		}
	}
	return { perDay, youtubeLimit };
}

export function createYoutubeGemini({ apiKey = config.youtubeGeminiKey || config.geminiKey, models = MODELS, log = () => {} } = {}) {
	const nextSlotByModel = new Map();
	const cooldownUntil = new Map();
	const exhaustedModels = new Set();
	let consecutive403Videos = new Set();
	let totalCalls = 0;
	let totalTokensIn = 0;

	const currentModel = () => {
		const avail = models.filter(m => !exhaustedModels.has(m));
		if (!avail.length) return null;
		const now = Date.now();
		// Предпочитаем основную модель (models[0] = gemini-3.5-flash-lite), как только остыл её 5-мин таймаут после 503
		const ready = avail.find(m => (cooldownUntil.get(m) || 0) <= now);
		if (ready) return ready;
		return [...avail].sort((a, b) => (cooldownUntil.get(a) || 0) - (cooldownUntil.get(b) || 0))[0];
	};

	const fallbackModel = model => {
		const others = models.filter(m => m !== model && !exhaustedModels.has(m));
		if (!others.length) return null;
		const now = Date.now();
		return others.find(m => (cooldownUntil.get(m) || 0) <= now) || others[0];
	};

	async function waitSlot(model) {
		const now = Date.now();
		const slot = Math.max(now, nextSlotByModel.get(model) || 0);
		nextSlotByModel.set(model, slot + RPM_GAP_MS);
		if (slot > now) await sleep(slot - now);
	}

	async function callOnce(model, videoId, clips) {
		if (!apiKey) {
			throw new KeyBlockedError('нет ключа Gemini: положите его в data/youtube-gemini-key.txt или YOUTUBE_GEMINI_API_KEY');
		}
		await waitSlot(model);
		totalCalls++;

		const uri = `https://www.youtube.com/watch?v=${videoId}`;
		const parts = [];
		clips.forEach((c, idx) => {
			parts.push({ text: `Фрагмент ${idx + 1} (таймкод видео ${fmtOffset(c.start)}–${fmtOffset(c.end)}):` });
			parts.push({
				fileData: { fileUri: uri },
				videoMetadata: {
					startOffset: `${c.start}s`,
					endOffset: `${c.end}s`,
					fps: c.fps ?? 0.25,
				},
			});
		});
		parts.push({ text: PROMPT });

		const body = {
			contents: [{ role: 'user', parts }],
			generationConfig: {
				temperature: 0,
				responseMimeType: 'application/json',
				responseSchema: RESPONSE_SCHEMA,
				thinkingConfig: { thinkingLevel: 'minimal' },
			},
		};

		const response = await fetch(`${config.geminiEndpoint}/models/${model}:generateContent`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-goog-api-key': apiKey,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});

		const text = await response.text();
		if (!response.ok) {
			let error = null;
			let message = text.slice(0, 300);
			try {
				error = JSON.parse(text).error;
				message = error?.message || message;
			} catch {
				// оставляем сырой текст
			}
			throw Object.assign(new Error(message), {
				status: response.status,
				retryAfterMs: retryDelayFrom(error),
				quota: quotaInfoFrom(error),
			});
		}

		const data = JSON.parse(text);
		const tokensIn = Number(data.usageMetadata?.promptTokenCount || 0);
		totalTokensIn += tokensIn;

		const candidate = data.candidates?.[0];
		const outText = (candidate?.content?.parts ?? []).map(p => p.text ?? '').join('').trim();
		if (!outText) {
			throw Object.assign(new Error(`пустой ответ (${candidate?.finishReason ?? 'без причины'})`), { status: 500 });
		}
		const parsed = JSON.parse(outText);
		consecutive403Videos.clear();

		return {
			model,
			tokensIn,
			is_sigame: Boolean(parsed.is_sigame),
			pack_names: Array.isArray(parsed.pack_names) ? parsed.pack_names.map(s => String(s || '').trim()).filter(Boolean) : [],
			players: Array.isArray(parsed.players) ? parsed.players.map(s => String(s || '').trim()).filter(Boolean) : [],
			themes: Array.isArray(parsed.themes)
				? parsed.themes
					.filter(t => t && typeof t.name === 'string' && t.name.trim())
					.map(t => ({
						name: t.name.trim(),
						clip: Number.isFinite(Number(t.clip)) && Number(t.clip) >= 1 ? Math.round(Number(t.clip)) : null,
						at: t.at ? String(t.at).trim() : '',
					}))
				: [],
		};
	}

	/**
	 * Проверить батч срезов одного YouTube-видео.
	 * @param {string} videoId
	 * @param {Array<{start: number, end: number, fps?: number}>} clips
	 */
	async function analyzeClips(videoId, clips) {
		let model = currentModel();
		if (!model) throw new QuotaExhaustedError('суточный лимит всех моделей Gemini исчерпан');

		let overloadTry = 0;
		let rpmTry = 0;

		for (;;) {
			try {
				const res = await callOnce(model, videoId, clips);
				cooldownUntil.delete(model);
				return res;
			} catch (err) {
				const status = err.status || 0;

				// 403 на YouTube URL — приватное/удалённое/live видео, а не битый ключ
				if (status === 403) {
					consecutive403Videos.add(videoId);
					if (consecutive403Videos.size >= MAX_CONSECUTIVE_403) {
						throw new KeyBlockedError(`5 разных видео подряд дали 403 — похоже, ключ/проект заблокирован: ${err.message}`);
					}
					throw new VideoAccessError(err.message);
				}

				if (status === 401) {
					throw new KeyBlockedError(`неверный ключ Gemini (401): ${err.message}`);
				}

				// 400 — оффсет за концом видео или неподдерживаемый поток
				if (status === 400) {
					throw new BadSliceError(err.message);
				}

				// 429 — квота
				if (status === 429) {
					if (err.quota?.youtubeLimit) {
						throw new QuotaExhaustedError(`суточный лимит YouTube-видео проекта Gemini: ${err.message}`, err.retryAfterMs);
					}
					if (err.quota?.perDay || rpmTry >= 2) {
						exhaustedModels.add(model);
						const alt = fallbackModel(model);
						if (alt) {
							log(`  [gemini] ${model} упёрлась в суточный 429 → переключаюсь на ${alt}`);
							model = alt;
							rpmTry = 0;
							continue;
						}
						throw new QuotaExhaustedError(`суточный лимит Gemini исчерпан: ${err.message}`, err.retryAfterMs);
					}
					rpmTry++;
					const wait = Math.min(err.retryAfterMs ?? 15_000 * rpmTry, MAX_QUOTA_WAIT_MS);
					nextSlotByModel.set(model, Date.now() + wait);
					log(`  [gemini] 429 RPM на ${model}, жду ${Math.round(wait / 1000)} с`);
					await sleep(wait);
					continue;
				}

				// 503 / таймаут / сетевой сбой — охлаждаем перегруженную модель на 5 мин и пробуем запасную
				const isOverload = status === 503 || status === 500 || status === 502 || status === 504
					|| /high demand|overloaded|UNAVAILABLE|timeout|aborted|fetch failed/i.test(err.message || '');
				if (isOverload && overloadTry < OVERLOAD_BACKOFF_MS.length) {
					cooldownUntil.set(model, Date.now() + OVERLOAD_COOLDOWN_MS);
					const wait = OVERLOAD_BACKOFF_MS[overloadTry++];
					const alt = fallbackModel(model);
					if (alt) {
						log(`  [gemini] ${status || 'net'} на ${model}, пробую ${alt} через ${wait / 1000} с (#${overloadTry})`);
						model = alt;
					} else {
						log(`  [gemini] ${status || 'net'} на ${model}, повтор #${overloadTry} через ${wait / 1000} с`);
					}
					await sleep(wait);
					continue;
				}

				throw err;
			}
		}
	}

	return {
		analyzeClips,
		activeModel: () => currentModel() || models[0],
		resetExhausted: () => {
			exhaustedModels.clear();
			cooldownUntil.clear();
		},
		stats: () => ({ calls: totalCalls, tokensIn: totalTokensIn }),
	};
}
