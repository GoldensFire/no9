// YouTube: поиск роликов, метаданные видео, загрузки каналов и резолв @handle.
//
// Основной путь — официальный YouTube Data API v3 (ключ YOUTUBE_API_KEY или
// data/youtube-api-key.txt). Если ключ не задан, автоматически работает
// безключевой запасной путь через YouTube InnerTube (youtubei/v1), чтобы
// сканер мог работать сразу без дополнительной настройки консоли GCP.

import { config } from '../config.js';

const DATA_API = 'https://www.googleapis.com/youtube/v3';
const INNERTUBE = 'https://www.youtube.com/youtubei/v1';
const YT_CONTEXT = {
	client: {
		clientName: 'WEB',
		clientVersion: '2.20261101.00.00',
		hl: 'ru',
		gl: 'RU',
	},
};
const YT_HEADERS = {
	'Content-Type': 'application/json',
	'Accept-Language': 'ru-RU,ru;q=0.9',
	'Origin': 'https://www.youtube.com',
	'User-Agent': config.userAgent,
};

const sleep = ms => new Promise(res => setTimeout(res, ms));
let dataSearchQuotaHit = false;
let dataQuotaHit = false;
let dataQuotaLogged = false;

function markDataQuotaHit(where) {
	dataQuotaHit = true;
	dataSearchQuotaHit = true;
	if (!dataQuotaLogged) {
		dataQuotaLogged = true;
		console.warn(`⚠️ YouTube Data API v3 упёрся в суточную квоту (${where}) — переключаюсь на InnerTube`);
	}
}

/** Переключился ли клиент на InnerTube из-за исчерпания квоты Data API v3. */
export function isDataQuotaHit() {
	return dataQuotaHit || dataSearchQuotaHit;
}

function decodeHtml(s) {
	return String(s || '')
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>');
}

/** Каким путём сейчас ходим в YouTube. */
export function apiMode() {
	return config.youtubeApiKey ? 'data-v3' : 'innertube';
}

/** ISO-8601 длительность (PT1H48M34S) → секунды. */
export function parseIsoDuration(iso) {
	const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(String(iso || ''));
	if (!m) return 0;
	return (Number(m[1] || 0) * 86400)
		+ (Number(m[2] || 0) * 3600)
		+ (Number(m[3] || 0) * 60)
		+ Number(m[4] || 0);
}

/** Строка времени («1:48:34» или «41:12») → секунды. */
export function parseClockDuration(text) {
	const parts = String(text || '').trim().split(':').map(Number);
	if (!parts.length || parts.some(n => !Number.isFinite(n))) return 0;
	return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** Извлечь 11-значный ID видео из ID или ссылки YouTube. */
export function cleanVideoId(raw) {
	const s = String(raw || '').trim().replace(/^yt:/, '');
	if (/^[\w-]{11}$/.test(s)) return s;
	const m = /(?:v=|youtu\.be\/|\/live\/|\/shorts\/|\/embed\/)([\w-]{11})/.exec(s);
	return m ? m[1] : null;
}

/**
 * Достать ссылку на YouTube-канал из произвольного URL (из socialMedias/панелей Twitch).
 * @returns {{ kind: 'id'|'handle'|'user'|'url', value: string } | null}
 */
export function parseYoutubeChannelRef(rawUrl) {
	const s = String(rawUrl || '').trim();
	if (!s) return null;
	if (/^UC[\w-]{20,}$/.test(s)) return { kind: 'id', value: s };
	if (/^@[\w.-]{2,}$/.test(s)) return { kind: 'handle', value: s };
	let url;
	try {
		url = new URL(s.startsWith('http') ? s : `https://${s}`);
	} catch {
		return null;
	}
	// youtu.be — всегда короткие ссылки на отдельные ролики, а не каналы
	if (!/(?:^|\.)youtube\.com$/i.test(url.hostname)) return null;
	const p = url.pathname.replace(/\/+$/, '');
	const idMatch = /^\/channel\/(UC[\w-]{20,})(?:\/|$)/i.exec(p);
	if (idMatch) return { kind: 'id', value: idMatch[1] };
	const handleMatch = /^\/(@[^/?#]+)(?:\/|$)/.exec(p);
	if (handleMatch) return { kind: 'handle', value: decodeURIComponent(handleMatch[1]) };
	const userMatch = /^\/user\/([^/?#]+)(?:\/|$)/i.exec(p);
	if (userMatch) return { kind: 'user', value: decodeURIComponent(userMatch[1]) };
	const customMatch = /^\/c\/([^/?#]+)(?:\/|$)/i.exec(p);
	if (customMatch) return { kind: 'url', value: `https://www.youtube.com${p}` };
	const bareMatch = /^\/([a-zA-Z0-9._-]{3,})$/.exec(p);
	if (bareMatch && !/^(?:watch|shorts|live|playlist|feed|results|channel|embed|clip|post|redirect|attribution_link)$/i.test(bareMatch[1])) {
		return { kind: 'url', value: `https://www.youtube.com/${bareMatch[1]}` };
	}
	return null;
}

async function fetchJson(url, options = {}, tries = 3) {
	for (let i = 1; ; i++) {
		try {
			const r = await fetch(url, { ...options, signal: AbortSignal.timeout(25_000) });
			const text = await r.text();
			const isQuota = (r.status === 429 || r.status === 403) && /quota\s*exceeded|quotaExceeded|daily\s*limit/i.test(text);
			if (!isQuota && (r.status >= 500 || r.status === 429)) {
				if (i < tries) {
					await sleep(1500 * i);
					continue;
				}
			}
			if (!r.ok) {
				throw Object.assign(
					new Error(`YouTube HTTP ${r.status}: ${text.slice(0, 220)}`),
					{ status: r.status, quotaExceeded: isQuota, final: isQuota || (r.status < 500 && r.status !== 429) },
				);
			}
			return JSON.parse(text);
		} catch (e) {
			if (e.final || i >= tries) throw e;
			await sleep(1500 * i);
		}
	}
}

async function dataGet(endpoint, params) {
	const q = new URLSearchParams({ ...params, key: config.youtubeApiKey });
	return fetchJson(`${DATA_API}/${endpoint}?${q}`, {
		headers: { 'Accept-Language': 'ru-RU,ru;q=0.9' },
	});
}

async function innertubePost(endpoint, body) {
	return fetchJson(`${INNERTUBE}/${endpoint}?prettyPrint=false`, {
		method: 'POST',
		headers: YT_HEADERS,
		body: JSON.stringify({ context: YT_CONTEXT, ...body }),
	});
}

function normalizeDataVideo(item) {
	if (!item?.id) return null;
	const sn = item.snippet || {};
	const cd = item.contentDetails || {};
	const st = item.statistics || {};
	const status = item.status || {};
	const live = item.liveStreamingDetails || null;
	const isLive = sn.liveBroadcastContent && sn.liveBroadcastContent !== 'none'
		|| Boolean(live?.actualStartTime && !live?.actualEndTime);
	const length = parseIsoDuration(cd.duration);
	const views = st.viewCount != null && Number.isFinite(Number(st.viewCount)) ? Number(st.viewCount) : null;
	const ageRestricted = cd.contentRating?.ytRating === 'ytAgeRestricted';
	return {
		id: String(item.id),
		vodId: `yt:${item.id}`,
		channelId: String(sn.channelId || ''),
		channelTitle: String(sn.channelTitle || ''),
		title: String(sn.title || ''),
		description: String(sn.description || ''),
		publishedAt: Date.parse(sn.publishedAt) || 0,
		length,
		views,
		embeddable: status.embeddable !== false,
		ageRestricted,
		isLive,
	};
}

function isBotCheck(ps) {
	if (ps?.status !== 'LOGIN_REQUIRED') return false;
	const reason = `${ps.reason || ''} ${(ps.messages || []).join(' ')}`;
	return /not a bot|confirm you.{0,5}re not|войдите.*подтверд|подтвердите.*не бот/i.test(reason)
		|| (!ps.desktopLegacyAgeGateReason && !/age|возраст|18\+|inappropriate/i.test(reason));
}

function normalizePlayerVideo(id, data) {
	const ps = data?.playabilityStatus || {};
	const vd = data?.videoDetails || {};
	const mf = data?.microformat?.playerMicroformatRenderer || {};
	const length = Number(vd.lengthSeconds || mf.lengthSeconds || 0);
	const botCheck = isBotCheck(ps);
	if (ps.status === 'ERROR' || (!length && !vd.title && !mf.title?.simpleText)) {
		return botCheck ? { botCheck: true } : null;
	}
	const liveDetails = mf.liveBroadcastDetails || null;
	const isLive = Boolean(vd.isLive || liveDetails?.isLiveNow || (vd.isUpcoming) || (liveDetails?.startTimestamp && !liveDetails?.endTimestamp));
	const ageGate = Boolean(ps.desktopLegacyAgeGateReason)
		|| (ps.status === 'LOGIN_REQUIRED' && !botCheck && /age|возраст|18\+|inappropriate/i.test(ps.reason || ''));
	const ageRestricted = mf.isFamilySafe === false || ageGate;
	const embeddable = ps.playableInEmbed === false ? false : (mf.embed ? Boolean(mf.embed.iframeUrl) : true);
	const rawViews = vd.viewCount ?? mf.viewCount;
	const views = rawViews != null && Number.isFinite(Number(rawViews)) ? Number(rawViews) : null;
	const pubRaw = mf.publishDate || mf.uploadDate || '';
	const publishedAt = pubRaw ? (Date.parse(pubRaw) || 0) : 0;
	return {
		id: String(vd.videoId || id),
		vodId: `yt:${vd.videoId || id}`,
		channelId: String(vd.channelId || mf.externalChannelId || ''),
		channelTitle: String(vd.author || mf.ownerChannelName || ''),
		title: String(vd.title || mf.title?.simpleText || ''),
		description: String(vd.shortDescription || mf.description?.simpleText || ''),
		publishedAt,
		length,
		views,
		embeddable,
		ageRestricted,
		isLive,
	};
}

async function searchVideosInnertube(query, { maxPages = 1, days = 7, order = 'date', ids = [], items = [], seen = new Set() } = {}) {
	// Безключевой запасной путь (InnerTube search):
	// EgIIAw%3D%3D = за эту неделю, EgIIBA%3D%3D = за этот месяц,
	// EgIYAg%3D%3D = длинные (> 20 мин) по релевантности, CAISBBgC = длинные (> 20 мин) по дате.
	let sp = order === 'relevance' ? 'EgIYAg%3D%3D' : 'CAISBBgC';
	if (days > 0 && days <= 7) sp = 'EgIIAw%3D%3D';
	else if (days > 7 && days <= 31) sp = 'EgIIBA%3D%3D';
	else if (days > 31 && order !== 'relevance') sp = 'CAISBBgC';

	let continuation = null;
	let calls = 0;

	for (let page = 0; page < maxPages; page++) {
		const payload = continuation ? { continuation } : { query, params: sp };
		const data = await innertubePost('search', payload);
		calls++;

		const sections = continuation
			? (data?.onResponseReceivedCommands?.[0]?.appendContinuationItemsAction?.continuationItems || [])
			: (data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || []);

		let nextToken = null;
		for (const sec of sections) {
			if (sec.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
				nextToken = sec.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
			}
			for (const entry of sec.itemSectionRenderer?.contents || []) {
				const vr = entry.videoRenderer;
				if (!vr?.videoId || seen.has(vr.videoId)) continue;
				const dur = parseClockDuration(vr.lengthText?.simpleText);
				const isLive = Boolean(
					(vr.badges || []).some(b => /LIVE/i.test(b.metadataBadgeRenderer?.style || '') || /эфир/i.test(b.metadataBadgeRenderer?.label || ''))
					|| (!dur && !vr.lengthText?.simpleText)
				);
				// Если в выдаче видна длина и ролик короче 15 мин — не тратим на него videosById
				if (dur > 0 && dur < 900) continue;
				seen.add(vr.videoId);
				const title = (vr.title?.runs || []).map(r => r.text).join('') || vr.title?.simpleText || '';
				const channelTitle = vr.ownerText?.runs?.[0]?.text || '';
				ids.push(String(vr.videoId));
				items.push({
					id: String(vr.videoId),
					channelId: String(vr.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || ''),
					channelTitle,
					title,
					publishedAt: 0,
					length: dur,
					isLive,
				});
			}
		}

		continuation = nextToken;
		if (!continuation) break;
	}
	return { ids, items, calls };
}

/**
 * Поиск видео по запросу. Возвращает ID и превью (title/channelTitle/publishedAt/length/isLive),
 * чтобы шум отсекался ДО пачек videosById.
 *
 * Если Data API v3 упёрся в суточный лимит Search Queries (429 / quotaExceeded), автоматически
 * переключается на InnerTube для этого и всех последующих запросов в запуске.
 * При `useInnertube: true` сразу ходит через InnerTube (бережёт 100/сут квоту ключа для облака).
 *
 * @param {string} query
 * @param {{ publishedAfter?: number, maxPages?: number, innertubeMaxPages?: number|null, days?: number, order?: 'date'|'relevance', useInnertube?: boolean }} [opts]
 * @returns {Promise<{ ids: string[], items: Array<object>, calls: number, mode: 'data-v3'|'innertube', quotaFallback: boolean }>}
 */
export async function searchVideos(query, {
	publishedAfter = 0,
	maxPages = 1,
	innertubeMaxPages = null,
	days = 7,
	order = 'date',
	useInnertube = false,
} = {}) {
	const itPages = innertubeMaxPages ?? maxPages;

	if (!useInnertube && config.youtubeApiKey && !dataSearchQuotaHit && !dataQuotaHit) {
		const ids = [];
		const items = [];
		const seen = new Set();
		let pageToken = null;
		let calls = 0;
		try {
			for (let page = 0; page < maxPages; page++) {
				const params = {
					// part=snippet стоит ту же 1 единицу search-бакета, что и part=id,
					// но сразу отдаёт заголовок, канал и live-статус для отсева до videos.list
					part: 'snippet',
					type: 'video',
					videoDuration: 'long',
					order: order === 'relevance' ? 'relevance' : 'date',
					relevanceLanguage: 'ru',
					maxResults: '50',
					q: query,
				};
				if (publishedAfter > 0) params.publishedAfter = new Date(publishedAfter).toISOString();
				if (pageToken) params.pageToken = pageToken;
				const data = await dataGet('search', params);
				calls++;
				for (const item of data.items || []) {
					const id = item?.id?.videoId;
					if (!id || seen.has(id)) continue;
					seen.add(id);
					const sn = item.snippet || {};
					ids.push(String(id));
					items.push({
						id: String(id),
						channelId: String(sn.channelId || ''),
						channelTitle: decodeHtml(sn.channelTitle || ''),
						title: decodeHtml(sn.title || ''),
						publishedAt: Date.parse(sn.publishedAt) || 0,
						length: 0,
						isLive: Boolean(sn.liveBroadcastContent && sn.liveBroadcastContent !== 'none'),
					});
				}
				pageToken = data.nextPageToken || null;
				if (!pageToken) break;
			}
			return { ids, items, calls, mode: 'data-v3', quotaFallback: false };
		} catch (e) {
			if (!e.quotaExceeded && e.status !== 429) throw e;
			dataSearchQuotaHit = true;
			if (e.quotaExceeded) markDataQuotaHit('search.list');
			const fb = await searchVideosInnertube(query, { maxPages: itPages, days, order, ids, items, seen });
			return { ids: fb.ids, items: fb.items, calls: calls + fb.calls, mode: 'innertube', quotaFallback: true };
		}
	}

	const res = await searchVideosInnertube(query, { maxPages: itPages, days, order });
	return {
		...res,
		mode: 'innertube',
		quotaFallback: Boolean(!useInnertube && config.youtubeApiKey && (dataSearchQuotaHit || dataQuotaHit)),
	};
}

async function videosByIdInnertube(ids, { videos, missing }) {
	let calls = 0;
	let botChecked = 0;
	if (!ids.length) return { calls, botChecked };

	// InnerTube player: параллельно по 6 запросов (каждый ~150 мс)
	const CONCURRENCY = 6;
	let cursor = 0;
	const worker = async () => {
		while (cursor < ids.length) {
			const id = ids[cursor++];
			try {
				const data = await innertubePost('player', { videoId: id });
				calls++;
				const v = normalizePlayerVideo(id, data);
				if (v?.botCheck) {
					// Бот-проверка YouTube с этого IP — не считаем видео удалённым, но учитываем для диагностики
					botChecked++;
				} else if (v) {
					videos.set(v.id, v);
				} else {
					missing.push(id);
				}
			} catch {
				// Сбой сети — не считаем видео удалённым
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
	return { calls, botChecked };
}

/**
 * Подробности видео по списку ID. Удалённые/недоступные отсутствуют в Map (или null).
 * При исчерпании квоты Data API v3 (403/429) автоматически добирает остаток через InnerTube player.
 *
 * @param {string[]} ids
 * @returns {Promise<{ videos: Map<string, object>, missing: string[], calls: number, botChecked: number }>}
 */
export async function videosById(ids) {
	const unique = [...new Set(ids.map(cleanVideoId).filter(Boolean))];
	const videos = new Map();
	const missing = [];
	let calls = 0;
	let botChecked = 0;

	if (!unique.length) return { videos, missing, calls, botChecked };

	let fallbackIds = unique;
	if (config.youtubeApiKey && !dataQuotaHit) {
		fallbackIds = [];
		for (let i = 0; i < unique.length; i += 50) {
			const part = unique.slice(i, i + 50);
			try {
				const data = await dataGet('videos', {
					part: 'snippet,contentDetails,statistics,status,liveStreamingDetails',
					id: part.join(','),
					hl: 'ru',
				});
				calls++;
				const got = new Set();
				for (const item of data.items || []) {
					const v = normalizeDataVideo(item);
					if (v) {
						videos.set(v.id, v);
						got.add(v.id);
					}
				}
				for (const id of part) if (!got.has(id)) missing.push(id);
			} catch (e) {
				if (e.quotaExceeded || e.status === 429) {
					markDataQuotaHit('videos.list');
					fallbackIds = unique.slice(i);
					break;
				}
				throw e;
			}
		}
	}

	if (fallbackIds.length) {
		const fb = await videosByIdInnertube(fallbackIds, { videos, missing });
		calls += fb.calls;
		botChecked += fb.botChecked;
	}

	return { videos, missing, calls, botChecked };
}

/**
 * Извлечь превью видео из сетки InnerTube (поддерживает и lockupViewModel 2026, и videoRenderer).
 * Возвращает { id, title, length, isLive }, чтобы шум отсеивался ДО player-запросов.
 */
function extractGridVideos(gridItems, channelId = '', channelTitle = '') {
	const out = [];
	for (const item of gridItems || []) {
		const content = item?.richItemRenderer?.content;
		if (!content) continue;
		const vr = content.videoRenderer;
		if (vr?.videoId) {
			const dur = parseClockDuration(vr.lengthText?.simpleText);
			const isLive = Boolean(
				(vr.badges || []).some(b => /LIVE/i.test(b.metadataBadgeRenderer?.style || '') || /эфир/i.test(b.metadataBadgeRenderer?.label || ''))
				|| (!dur && !vr.lengthText?.simpleText)
			);
			const title = (vr.title?.runs || []).map(r => r.text).join('') || vr.title?.simpleText || '';
			out.push({ id: String(vr.videoId), channelId, channelTitle, title, publishedAt: 0, length: dur, isLive });
			continue;
		}
		const lm = content.lockupViewModel;
		if (lm?.contentId && /^[\w-]{11}$/.test(lm.contentId)) {
			const badges = (lm.contentImage?.thumbnailViewModel?.overlays || [])
				.flatMap(o => o.thumbnailBottomOverlayViewModel?.badges || [])
				.map(b => b.thumbnailBadgeViewModel)
				.filter(Boolean);
			const badgeText = badges.map(b => b.text).find(Boolean) || '';
			const isLive = badges.some(b => /LIVE/i.test(b.badgeStyle || '') || /эфир/i.test(b.text || ''))
				|| (!badgeText && badges.length === 0);
			const dur = parseClockDuration(badgeText);
			const title = lm.metadata?.lockupMetadataViewModel?.title?.content || '';
			out.push({ id: String(lm.contentId), channelId, channelTitle, title, publishedAt: 0, length: dur, isLive });
		}
	}
	return out;
}

async function channelUploadsInnertube(channelId, { maxResults = 25, channelTitle = '', seen = new Set(), ids = [], items = [] } = {}) {
	// InnerTube: вкладка «Видео» (EgZ2aWRlb3PyBgQKAjoA) и вкладка «Трансляции» (EgdzdHJlYW1z8gYECgJ6AA==).
	// Каждой вкладке даём собственный лимит (до maxResults), чтобы канал с 500 видео
	// не обрезал вкладку «Трансляции», где и лежат записи стримов SIGame.
	let calls = 0;
	const maxTabPages = Math.max(1, Math.ceil(maxResults / 30));
	for (const params of ['EgZ2aWRlb3PyBgQKAjoA', 'EgdzdHJlYW1z8gYECgJ6AA==']) {
		let continuation = null;
		let tabCount = 0;
		for (let page = 0; page < maxTabPages && tabCount < maxResults; page++) {
			try {
				const payload = continuation ? { continuation } : { browseId: channelId, params };
				const data = await innertubePost('browse', payload);
				calls++;
				let grid = [];
				if (continuation) {
					grid = data?.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems || [];
				} else {
					const tab = (data?.contents?.twoColumnBrowseResultsRenderer?.tabs || []).find(t => t.tabRenderer?.selected);
					grid = tab?.tabRenderer?.content?.richGridRenderer?.contents || [];
				}
				for (const v of extractGridVideos(grid, channelId, channelTitle)) {
					if (!seen.has(v.id) && tabCount < maxResults) {
						seen.add(v.id);
						tabCount++;
						ids.push(v.id);
						items.push(v);
					}
				}
				const contItem = grid.find(it => it?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token);
				continuation = contItem?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token || null;
				if (!continuation) break;
			} catch {
				// У канала может не быть вкладки «Трансляции» — не ошибка
				break;
			}
		}
	}
	return { ids, items, calls };
}

/**
 * Последние загрузки канала (через UU-плейлист в Data API v3 с пагинацией
 * или вкладки Видео+Трансляции в InnerTube с continuation).
 * При исчерпании квоты Data API v3 автоматически переключается на InnerTube.
 * Возвращает ids и превью items (title, publishedAt, length, isLive) для предфильтрации.
 *
 * @param {string} channelId UC...
 * @param {{ maxResults?: number, channelTitle?: string, publishedAfter?: number }} [opts]
 * @returns {Promise<{ ids: string[], items: Array<object>, calls: number }>}
 */
export async function channelUploads(channelId, { maxResults = 25, channelTitle = '', publishedAfter = 0 } = {}) {
	if (!/^UC[\w-]{20,}$/.test(String(channelId || ''))) return { ids: [], items: [], calls: 0 };

	const ids = [];
	const items = [];
	const seen = new Set();
	let calls = 0;

	if (config.youtubeApiKey && !dataQuotaHit) {
		const playlistId = `UU${channelId.slice(2)}`;
		let pageToken = null;
		const maxPages = Math.max(1, Math.ceil(maxResults / 50));
		let hitQuota = false;
		for (let page = 0; page < maxPages && ids.length < maxResults; page++) {
			try {
				const params = {
					// part=snippet,contentDetails стоит ту же 1 единицу, что и part=contentDetails,
					// но сразу отдаёт title и publishedAt для отсева шума ДО videos.list
					part: 'snippet,contentDetails',
					playlistId,
					maxResults: String(Math.min(50, maxResults - ids.length)),
				};
				if (pageToken) params.pageToken = pageToken;
				const data = await dataGet('playlistItems', params);
				calls++;
				let hitOld = false;
				for (const it of data.items || []) {
					const id = it?.contentDetails?.videoId || it?.snippet?.resourceId?.videoId;
					if (!id || seen.has(id)) continue;
					const sn = it.snippet || {};
					const publishedAt = Date.parse(it.contentDetails?.videoPublishedAt || sn.publishedAt) || 0;
					if (publishedAfter > 0 && publishedAt > 0 && publishedAt < publishedAfter) {
						hitOld = true;
						continue;
					}
					seen.add(id);
					ids.push(String(id));
					items.push({
						id: String(id),
						channelId,
						channelTitle: sn.channelTitle || channelTitle,
						title: sn.title || '',
						publishedAt,
						length: 0,
						isLive: false,
					});
				}
				pageToken = data.nextPageToken || null;
				if (!pageToken || hitOld) break;
			} catch (e) {
				if (e.status === 404) return { ids, items, calls: calls + 1 };
				if (e.quotaExceeded || e.status === 429) {
					markDataQuotaHit('playlistItems.list');
					hitQuota = true;
					break;
				}
				if (ids.length) break;
				throw e;
			}
		}
		if (!hitQuota) return { ids, items, calls };
	}

	const fb = await channelUploadsInnertube(channelId, { maxResults, channelTitle, seen, ids, items });
	return { ids: fb.ids, items: fb.items, calls: calls + fb.calls };
}

/**
 * Преобразовать ссылки/хэндлы каналов в { channelId, title, handle }.
 *
 * @param {Array<{ kind: 'id'|'handle'|'url', value: string, twitchLogin?: string }>} refs
 * @returns {Promise<Array<{ channelId: string, title: string, handle: string|null, twitchLogin: string|null }>>}
 */
export async function resolveChannels(refs) {
	const out = [];
	const seen = new Set();

	const resolveByInnertube = async (ref, currentHandle) => {
		const url = ref.kind === 'handle'
			? `https://www.youtube.com/${ref.value}`
			: (ref.kind === 'user' ? `https://www.youtube.com/user/${ref.value}` : ref.value);
		const data = await innertubePost('navigation/resolve_url', { url });
		const bid = data?.endpoint?.browseEndpoint?.browseId;
		if (!bid || !/^UC[\w-]{20,}$/.test(bid)) return null;
		const canonical = data?.endpoint?.browseEndpoint?.canonicalBaseUrl || '';
		const handle = canonical.startsWith('/@') ? canonical.slice(1) : currentHandle;
		return { channelId: bid, title: '', handle };
	};

	for (const ref of refs) {
		if (!ref?.value) continue;
		try {
			let channelId = null;
			let title = '';
			let handle = ref.kind === 'handle' ? ref.value : null;
			const useData = Boolean(config.youtubeApiKey && !dataQuotaHit);

			if (ref.kind === 'id') {
				channelId = ref.value;
				if (useData) {
					try {
						const data = await dataGet('channels', { part: 'snippet', id: channelId });
						const item = data.items?.[0];
						if (item) {
							title = item.snippet?.title || '';
							handle = item.snippet?.customUrl || handle;
						}
					} catch (e) {
						if (e.quotaExceeded || e.status === 429) markDataQuotaHit('channels.list');
						else throw e;
					}
				}
			} else if (useData && (ref.kind === 'handle' || ref.kind === 'user')) {
				try {
					const params = ref.kind === 'handle'
						? { part: 'snippet', forHandle: ref.value.replace(/^@/, '') }
						: { part: 'snippet', forUsername: ref.value };
					const data = await dataGet('channels', params);
					const item = data.items?.[0];
					if (item?.id) {
						channelId = String(item.id);
						title = item.snippet?.title || '';
						handle = item.snippet?.customUrl || handle;
					}
				} catch (e) {
					if (e.quotaExceeded || e.status === 429) {
						markDataQuotaHit('channels.list');
						const fb = await resolveByInnertube(ref, handle);
						if (fb) ({ channelId, title, handle } = fb);
					} else {
						throw e;
					}
				}
			} else {
				const fb = await resolveByInnertube(ref, handle);
				if (fb) {
					({ channelId, title, handle } = fb);
					if (config.youtubeApiKey && !dataQuotaHit) {
						try {
							const ch = await dataGet('channels', { part: 'snippet', id: channelId });
							const item = ch.items?.[0];
							if (item) {
								title = item.snippet?.title || '';
								handle = item.snippet?.customUrl || handle;
							}
						} catch (e) {
							if (e.quotaExceeded || e.status === 429) markDataQuotaHit('channels.list');
						}
					}
				}
			}

			if (channelId && !seen.has(channelId)) {
				seen.add(channelId);
				out.push({ channelId, title, handle, twitchLogin: ref.twitchLogin || null });
			}
		} catch {
			// Битая или протухшая ссылка из socialMedias Twitch — просто пропускаем
		}
		await sleep(120);
	}
	return out;
}
