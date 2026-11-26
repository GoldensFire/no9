// Поиск кандидатов YouTube для сканера Gemini:
//   1. Поиск свежих роликов по 9 проверенным запросам (searchVideos);
//   2. Обход известных SIGame YouTube-каналов из youtube_channels (channelUploads);
//   3. Еженедельный мост Twitch → YouTube по socialMedias подтверждённых
//      SIGame-стримеров из twitch_vods (одной пачкой Twitch GQL + resolveChannels).

import { gqlBatch } from '../twitch/twitch.js';
import { MAX_TRIES } from '../twitch/store.js';
import { apiMode, channelUploads, parseYoutubeChannelRef, resolveChannels, searchVideos, videosById } from './api.js';
import { shouldSkipPreview, shouldSkipVideo } from './plan.js';

/** 11 проверенных запросов (9 базовых из youtube-gemini-plan.md + 2 высокоточных RU-запроса). */
export const SEARCH_QUERIES = [
	'sigame',
	'сигейм',
	'си гейм',
	'сигаме',
	'своя игра пак',
	'своя игра sigame',
	'своя игра запись стрима',
	'своя игра стрим',
	'своя игра twitch',
	'своя игра твич',
	'своя игра солянка',
];

/** Вытащить все http(s)-ссылки и голые youtube.com/... из свободного текста (описание канала или панели Twitch). */
function extractUrls(text) {
	if (!text) return [];
	const matches = String(text).match(/(?:https?:\/\/|(?:www\.|m\.)?youtube\.com\/)[^\s<>"')\]]+/gi) || [];
	return matches.map(u => u.replace(/[.,;:!?]+$/, ''));
}

/** Срок кэша для логинов Twitch, у которых не нашлось YouTube-канала: 60 дн при полном чтении, 30 дн при обходе без socialMedias. */
const BRIDGE_FULL_TTL_MS = 60 * 864e5;
const BRIDGE_PARTIAL_TTL_MS = 30 * 864e5;

/**
 * Мост Twitch → YouTube: вытащить ссылки на YouTube-каналы из socialMedias,
 * панелей и описания подтверждённых SIGame-стримеров Twitch и отрезолвить новые в UC... ID.
 * На облачных IP Twitch закрывает socialMedias ошибкой IntegrityCheckFailed,
 * но панели и описание в том же GQL-ответе продолжают приходить.
 *
 * Кэш `checkedCache` ({ full: { login: ts }, partial: { login: ts } }) не даёт
 * каждый раз спамить одни и те же логины с облачного IP; при запуске с домашнего ПК
 * (где socialMedias открыты) `partial`-логины автоматически допроверяются полностью.
 *
 * @param {string[]} twitchLogins
 * @param {Set<string>} knownChannelIds уже известные channel_id
 * @param {Set<string>} knownLogins уже привязанные twitch_login
 * @param {{ checkedCache?: { full?: object, partial?: object }, force?: boolean }} [opts]
 */
export async function bridgeTwitchChannels(twitchLogins, knownChannelIds, knownLogins, { checkedCache = null, force = false } = {}) {
	const now = Date.now();
	const fullMap = { ...(checkedCache?.full || {}) };
	const partialMap = { ...(checkedCache?.partial || {}) };

	// Предварительно отсекаем уже привязанные и недавно полностью проверенные (60 дн).
	// Логины из partial проверяем только если их срок истёк, передан force, или
	// если пробный первый логин показал, что с этого IP socialMedias открыты.
	const unlinked = twitchLogins
		.map(l => String(l || '').toLowerCase())
		.filter(l => l && !knownLogins.has(l));

	const dueAlways = [];
	const partialOnly = [];
	for (const l of unlinked) {
		if (!force && fullMap[l] && now - fullMap[l] < BRIDGE_FULL_TTL_MS) continue;
		if (!force && partialMap[l] && now - partialMap[l] < BRIDGE_PARTIAL_TTL_MS) {
			partialOnly.push(l);
		} else {
			dueAlways.push(l);
		}
	}

	let freshLogins = dueAlways;
	let probedIntegrityBlocked = false;
	if (!force && partialOnly.length > 0 && dueAlways.length === 0) {
		// Пробный запрос на 1 логин: с домашнего ПК socialMedias открыты → допроверим все partialOnly;
		// с облачного IP (IntegrityCheckFailed) сразу выходим без 70+ пустых отказов в логе.
		const probe = await gqlBatch([{
			query: `query($l:String!){ user(login:$l){ login channel{ socialMedias{ name url } } } }`,
			variables: { l: partialOnly[0] },
		}]);
		if (probe[0]?.user?.channel && probe[0].user.channel.socialMedias !== null) {
			freshLogins = partialOnly;
		} else {
			probedIntegrityBlocked = true;
		}
	} else if (!force && partialOnly.length > 0 && dueAlways.length > 0) {
		// Сначала проверим dueAlways; если socialMedias окажутся открыты (домашний ПК), доберём partialOnly ниже
	}

	if (!freshLogins.length) {
		return {
			channels: [],
			checked: 0,
			skippedCached: partialOnly.length,
			integrityBlocked: probedIntegrityBlocked,
			checkedCache: { full: fullMap, partial: partialMap },
		};
	}

	const queryOf = l => ({
		query: `query($l:String!){
			user(login:$l){
				login
				description
				panels{ __typename ... on DefaultPanel { linkURL description } }
				channel{ socialMedias{ name url } }
			}
		}`,
		variables: { l },
	});

	let res = await gqlBatch(freshLogins.map(queryOf));

	const refs = [];
	const seenRef = new Set();
	let usersWithChannel = 0;
	let nullSocialMedias = 0;

	const pushUrl = (rawUrl, login) => {
		const parsed = parseYoutubeChannelRef(rawUrl);
		if (!parsed) return;
		if (parsed.kind === 'id' && knownChannelIds.has(parsed.value)) return;
		const key = `${parsed.kind}:${parsed.value.toLowerCase()}`;
		if (seenRef.has(key)) return;
		seenRef.add(key);
		refs.push({ ...parsed, twitchLogin: login });
	};

	const consume = (rows, loginsList) => {
		for (let i = 0; i < rows.length; i++) {
			const u = rows[i]?.user;
			const login = (u?.login || loginsList[i] || '').toLowerCase();
			if (!login) continue;
			if (u?.channel) {
				usersWithChannel++;
				if (u.channel.socialMedias === null) nullSocialMedias++;
			}
			for (const s of u?.channel?.socialMedias || []) pushUrl(s?.url, login);
			for (const p of u?.panels || []) {
				if (p?.linkURL) pushUrl(p.linkURL, login);
				for (const url of extractUrls(p?.description)) pushUrl(url, login);
			}
			for (const url of extractUrls(u?.description)) pushUrl(url, login);
		}
	};

	consume(res, freshLogins);
	let integrityBlocked = usersWithChannel > 0 && nullSocialMedias >= Math.ceil(usersWithChannel * 0.8);

	// Если запускаемся с домашнего ПК (socialMedias открыты) и были partial-логины с облака — допроверим их сразу!
	let allChecked = [...freshLogins];
	if (!integrityBlocked && !force && partialOnly.length > 0 && freshLogins !== partialOnly) {
		const extraRes = await gqlBatch(partialOnly.map(queryOf));
		consume(extraRes, partialOnly);
		allChecked.push(...partialOnly);
		integrityBlocked = usersWithChannel > 0 && nullSocialMedias >= Math.ceil(usersWithChannel * 0.8);
	}

	const resolved = refs.length ? await resolveChannels(refs) : [];
	const newChannels = resolved.filter(c => !knownChannelIds.has(c.channelId));

	for (const l of allChecked) {
		if (integrityBlocked) {
			partialMap[l] = now;
		} else {
			fullMap[l] = now;
			delete partialMap[l];
		}
	}

	return {
		channels: newChannels,
		checked: allChecked.length,
		skippedCached: integrityBlocked ? partialOnly.length : 0,
		integrityBlocked,
		checkedCache: { full: fullMap, partial: partialMap },
	};
}

/**
 * Найти новые ролики YouTube для сканирования.
 *
 * @param {object} opts
 * @param {number} [opts.days] горизонт поиска в днях (по умолчанию 7; при backfill — без порога)
 * @param {boolean} [opts.backfill] глубокий обход (больше страниц поиска и до 500 видео на паковый канал)
 * @param {Map<string, object>} [opts.known] уже известные видео из youtube_videos
 * @param {Array<object>} [opts.channels] известные каналы из youtube_channels
 * @param {Map<string, { scanned: number, withPacks: number }>} [opts.channelYield] отдача каналов из D1
 * @param {boolean} [opts.rescan] пересматривать уже просмотренные
 * @param {boolean} [opts.preferInnertubeSearch] искать через InnerTube (на домашнем ПК бережёт 100/сут квоту search.list для облака)
 */
export async function discover({
	days = 7,
	backfill = false,
	known = new Map(),
	channels = [],
	channelYield = new Map(),
	rescan = false,
	preferInnertubeSearch = false,
} = {}) {
	const now = Date.now();
	const publishedAfter = backfill || days <= 0 ? 0 : now - days * 864e5;
	const channelCutoff = (!backfill && publishedAfter > 0) ? now - Math.max(days, 14) * 864e5 : 0;
	const baseMode = apiMode();
	const useInnertubeSearch = preferInnertubeSearch || baseMode !== 'data-v3';
	// В Data API v3 страница поиска = 50 видео (и жёсткий лимит 100 вызовов/сут),
	// а в InnerTube страница = ~20 видео и квоты нет: в локальном режиме сразу
	// ищем через InnerTube (8 + 6 стр.), чтобы не сжигать суточную квоту ключа для облака,
	// а в облачном режиме при 429 автоматически переключаемся на InnerTube.
	const itDatePages = backfill ? 8 : 1;
	const itRelPages = backfill ? 6 : 0;
	const datePages = useInnertubeSearch ? itDatePages : (backfill ? 3 : 1);
	const relevancePages = useInnertubeSearch ? itRelPages : (backfill ? 2 : 0);

	const stats = {
		mode: baseMode === 'data-v3' && useInnertubeSearch ? 'data-v3 + innertube-search' : baseMode,
		searchQueries: 0,
		searchCalls: 0,
		searchRaw: 0,
		channelsChecked: 0,
		channelRaw: 0,
		videosFetched: 0,
		errors: [],
	};

	const yieldOf = chId => channelYield.get(String(chId || '')) || { scanned: 0, withPacks: 0 };
	const isColdChannel = chId => {
		const y = yieldOf(chId);
		return y.scanned >= 5 && y.withPacks === 0;
	};

	// videoId → { sources: Set<'search'|'channel'>, preview: object|null }
	const candidates = new Map();
	const addCandidate = (item, src) => {
		const id = typeof item === 'string' ? item : item?.id;
		if (!id) return;
		let entry = candidates.get(id);
		if (!entry) candidates.set(id, entry = { sources: new Set(), preview: null });
		entry.sources.add(src);
		if (item && typeof item === 'object') {
			if (!entry.preview) entry.preview = { ...item };
			else {
				// Сохраняем более полные поля превью (например, length из InnerTube + publishedAt из Data API)
				if (!entry.preview.title && item.title) entry.preview.title = item.title;
				if (!entry.preview.channelTitle && item.channelTitle) entry.preview.channelTitle = item.channelTitle;
				if (!entry.preview.channelId && item.channelId) entry.preview.channelId = item.channelId;
				if (!entry.preview.publishedAt && item.publishedAt) entry.preview.publishedAt = item.publishedAt;
				if (!entry.preview.length && item.length) entry.preview.length = item.length;
				if (item.isLive) entry.preview.isLive = true;
			}
		}
	};

	// 1. Поиск по запросам: в обычном прогоне 1 стр. по дате (11 вызовов),
	// в backfill — 3+2 стр. (data-v3) или 8+6 стр. (InnerTube), чтобы доставать
	// не только последние 2–3 недели, но и многолетний бэклог 2020–2026.
	let quotaFallbackLogged = false;
	const noteQuotaFallback = res => {
		if (!res?.quotaFallback || quotaFallbackLogged) return;
		quotaFallbackLogged = true;
		stats.mode = 'data-v3 (поиск → innertube по 429)';
		console.warn('⚠️ YouTube Data API v3 search.list упёрся в суточную квоту (429) — поиск переключён на InnerTube');
	};
	for (const q of SEARCH_QUERIES) {
		try {
			const res = await searchVideos(q, {
				publishedAfter,
				maxPages: datePages,
				innertubeMaxPages: itDatePages,
				days: backfill ? 0 : days,
				order: 'date',
				useInnertube: useInnertubeSearch,
			});
			noteQuotaFallback(res);
			stats.searchQueries++;
			stats.searchCalls += res.calls;
			stats.searchRaw += res.ids.length;
			for (const item of res.items || res.ids) addCandidate(item, 'search');
			if (relevancePages > 0) {
				const rel = await searchVideos(q, {
					publishedAfter: 0,
					maxPages: relevancePages,
					innertubeMaxPages: itRelPages,
					days: 0,
					order: 'relevance',
					useInnertube: useInnertubeSearch,
				});
				noteQuotaFallback(rel);
				stats.searchCalls += rel.calls;
				stats.searchRaw += rel.ids.length;
				for (const item of rel.items || rel.ids) addCandidate(item, 'search');
			}
		} catch (e) {
			stats.errors.push(`поиск «${q}»: ${e.message}`);
		}
	}

	// 2. Известные YouTube-каналы: паковые и ещё не проверенные первыми, затем по давности обхода.
	const channelRank = c => {
		const y = yieldOf(c.channel_id);
		if (y.withPacks > 0) return 3;
		if (!c.last_checked_at) return 2;
		if (y.scanned >= 5 && y.withPacks === 0) return 0;
		return 1;
	};
	const channelPool = [...channels]
		.filter(c => (c.sigame_videos || 0) > 0 || c.source === 'twitch' || c.source === 'manual')
		.sort((a, b) => channelRank(b) - channelRank(a) || (a.last_checked_at || 0) - (b.last_checked_at || 0))
		.slice(0, backfill ? 250 : 120);

	const checkedChannelIds = [];
	const CHANNEL_CONCURRENCY = 5;
	let chCursor = 0;
	const channelWorker = async () => {
		while (chCursor < channelPool.length) {
			const ch = channelPool[chCursor++];
			try {
				// Глубина обхода зависит от отдачи канала:
				//   - давал паки из нашей базы (withPacks > 0) → до 500 видео в backfill (Архив Графона, ALEX TEM GAMER, TWOLFACE);
				//   - «сухой» канал (0 паков на ≥5 просмотренных видео, вроде шоу по Lineage 2) → не глубже 30;
				//   - неразведанный канал (включая Twitch-мост) → до 150 видео в backfill.
				const y = yieldOf(ch.channel_id);
				const depth = !backfill ? 30
					: y.withPacks > 0 ? 500
					: (y.scanned >= 5 ? 30 : 150);
				const res = await channelUploads(ch.channel_id, {
					maxResults: depth,
					channelTitle: ch.title || '',
					publishedAfter: channelCutoff,
				});
				stats.channelsChecked++;
				stats.channelRaw += res.ids.length;
				checkedChannelIds.push(ch.channel_id);
				for (const item of res.items || res.ids) addCandidate(item, 'channel');
			} catch (e) {
				stats.errors.push(`канал ${ch.title || ch.channel_id}: ${e.message}`);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(CHANNEL_CONCURRENCY, channelPool.length) }, channelWorker));

	const skipped = {
		seen: 0,
		failed: 0,
		old: 0,
		short: 0,
		live: 0,
		noise: 0,
		missing: 0,
	};

	const noteSkipReason = reason => {
		if (reason === 'прямой эфир / анонс') skipped.live++;
		else if (reason === 'короче 15 мин') skipped.short++;
		else skipped.noise++;
	};

	// Отсеиваем уже известные, старые (в ежедневном режиме) и явный шум по заголовку ДО videosById,
	// чтобы не гонять по 15 000 лишних запросов videos.list / InnerTube player
	const toFetch = [];
	for (const [id, entry] of candidates) {
		const prev = known.get(id);
		if (prev && !rescan) {
			if (prev.status === 'done' || prev.status === 'gone' || prev.status === 'restricted') {
				skipped.seen++;
				continue;
			}
			if (prev.status === 'error' && (prev.tries || 0) >= MAX_TRIES) {
				skipped.failed++;
				continue;
			}
		}
		const p = entry.preview;
		if (p) {
			if (channelCutoff > 0 && p.publishedAt > 0 && p.publishedAt < channelCutoff) {
				skipped.old++;
				continue;
			}
			const pre = shouldSkipPreview(p, { requireTitleMatch: true });
			if (pre.skip) {
				noteSkipReason(pre.reason);
				continue;
			}
		}
		toFetch.push(id);
	}

	// 3. Метаданные пачкой (videos.list / player) — только для прошедших предфильтр кандидатов
	const { videos, missing, botChecked = 0 } = await videosById(toFetch);
	stats.videosFetched = videos.size;
	skipped.missing = missing.length;
	if (botChecked > 0) {
		const msg = `InnerTube player: YouTube закрыл ${botChecked} из ${toFetch.length} видео проверкой на бота (положите data/youtube-api-key.txt или смените IP)`;
		stats.errors.push(msg);
		console.warn(`⚠️ ${msg}`);
	}

	const todo = [];
	for (const [id, v] of videos) {
		const srcs = [...(candidates.get(id)?.sources || [])];
		if (channelCutoff > 0 && v.publishedAt > 0 && v.publishedAt < channelCutoff) {
			skipped.old++;
			continue;
		}
		const check = shouldSkipVideo(v, { requireTitleMatch: true });
		if (check.skip) {
			noteSkipReason(check.reason);
			continue;
		}
		todo.push({ video: v, source: srcs.join('+') });
	}

	// Очередь приоритета с учётом реальной отдачи каналов:
	//   5 — свежие ролики (≤ 14 дней), КРОМЕ «сухих» каналов (0 паков на ≥5 видео);
	//   4 — бэклог паковых каналов (withPacks > 0: Архив Графона, Dark Kingdom, TWOLFACE, ALEX TEM GAMER…),
	//       внутри выше каналы с большим % попаданий;
	//   3 — первые пробы неразведанных каналов (scanned < 5, withPacks = 0) — не более (5 - scanned)
	//       видео на один канал за запуск, чтобы неизвестный канал с частными паками не сожрал весь прогон;
	//   2 — каналы с 3–4 видео и 0 паков;
	//   1 — «сухие» каналы (≥5 видео и 0 паков) и хвост неразведанных сверх пробной квоты.
	const freshCutoff = now - 14 * 864e5;
	// Сначала сортируем по дате (свежие вперёд), чтобы пробные слоты неразведанных каналов
	// доставались их самым свежим роликам
	todo.sort((a, b) => (b.video.publishedAt || 0) - (a.video.publishedAt || 0));

	const unprovenAssigned = new Map();
	const scored = todo.map(item => {
		const v = item.video;
		const chId = String(v.channelId || '');
		const y = yieldOf(chId);
		const pub = v.publishedAt || 0;
		const cold = isColdChannel(chId);
		let tier;
		let rate = 0;

		if (pub >= freshCutoff && !cold) {
			tier = 5;
			rate = y.scanned > 0 ? y.withPacks / y.scanned : 0.5;
		} else if (y.withPacks > 0) {
			tier = 4;
			rate = y.withPacks / Math.max(1, y.scanned);
		} else if (!cold) {
			const used = unprovenAssigned.get(chId) || 0;
			const trialAllowance = Math.max(1, 5 - y.scanned);
			if (used < trialAllowance) {
				unprovenAssigned.set(chId, used + 1);
				tier = y.scanned < 3 ? 3 : 2;
			} else {
				tier = 1;
			}
		} else {
			tier = 1;
		}
		return { item, tier, rate, pub };
	});

	scored.sort((a, b) => b.tier - a.tier || b.rate - a.rate || b.pub - a.pub);

	return { todo: scored.map(s => s.item), stats, skipped, checkedChannelIds };
}
