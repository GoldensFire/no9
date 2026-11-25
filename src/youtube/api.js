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
			if (r.status >= 500 || r.status === 429) {
				if (i < tries) {
					await sleep(1500 * i);
					continue;
				}
			}
			if (!r.ok) {
				throw Object.assign(new Error(`YouTube HTTP ${r.status}: ${text.slice(0, 220)}`), { status: r.status, final: r.status < 500 && r.status !== 429 });
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

/**
 * Поиск видео по запросу. Возвращает массив ID (метаданные добираются пачкой в videosById).
 *
 * @param {string} query
 * @param {{ publishedAfter?: number, maxPages?: number, days?: number }} [opts]
 * @returns {Promise<{ ids: string[], calls: number }>}
 */
export async function searchVideos(query, { publishedAfter = 0, maxPages = 1, days = 7 } = {}) {
	if (config.youtubeApiKey) {
		const ids = [];
		let pageToken = null;
		let calls = 0;
		for (let page = 0; page < maxPages; page++) {
			const params = {
				part: 'id',
				type: 'video',
				videoDuration: 'long',
				order: 'date',
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
				if (id) ids.push(String(id));
			}
			pageToken = data.nextPageToken || null;
			if (!pageToken) break;
		}
		return { ids, calls };
	}

	// Безключевой запасной путь (InnerTube search):
	// EgIIAw%3D%3D = за эту неделю, EgIIBA%3D%3D = за этот месяц, EgIYAg%3D%3D = длинные (> 20 мин).
	// Когда days <= 7, берём «за эту неделю» (чтобы видеть и ролики 15–20 мин),
	// а когда backfill / days > 30 — «длинные > 20 мин» с сортировкой по дате (CAISBBgC).
	let sp = 'EgIYAg%3D%3D';
	if (days > 0 && days <= 7) sp = 'EgIIAw%3D%3D';
	else if (days > 7 && days <= 31) sp = 'EgIIBA%3D%3D';
	else if (days > 31) sp = 'CAISBBgC';

	const ids = [];
	const seen = new Set();
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
				// Если в выдаче видна длина и ролик короче 15 мин — не тратим на него videosById
				if (dur > 0 && dur < 900) continue;
				seen.add(vr.videoId);
				ids.push(String(vr.videoId));
			}
		}

		continuation = nextToken;
		if (!continuation) break;
	}
	return { ids, calls };
}

/**
 * Подробности видео по списку ID. Удалённые/недоступные отсутствуют в Map (или null).
 *
 * @param {string[]} ids
 * @returns {Promise<{ videos: Map<string, object>, missing: string[], calls: number }>}
 */
export async function videosById(ids) {
	const unique = [...new Set(ids.map(cleanVideoId).filter(Boolean))];
	const videos = new Map();
	const missing = [];
	let calls = 0;

	if (!unique.length) return { videos, missing, calls };

	if (config.youtubeApiKey) {
		for (let i = 0; i < unique.length; i += 50) {
			const part = unique.slice(i, i + 50);
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
		}
		return { videos, missing, calls };
	}

	// InnerTube player: параллельно по 6 запросов (каждый ~150 мс)
	const CONCURRENCY = 6;
	let cursor = 0;
	const worker = async () => {
		while (cursor < unique.length) {
			const id = unique[cursor++];
			try {
				const data = await innertubePost('player', { videoId: id });
				calls++;
				const v = normalizePlayerVideo(id, data);
				if (v?.botCheck) {
					// Бот-проверка YouTube с датацентрового IP — не считаем видео удалённым
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
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, worker));
	return { videos, missing, calls };
}

/**
 * Извлечь видео ID из сетки InnerTube (поддерживает и lockupViewModel 2026, и videoRenderer).
 */
function extractGridVideos(gridItems) {
	const out = [];
	for (const item of gridItems || []) {
		const content = item?.richItemRenderer?.content;
		if (!content) continue;
		const vr = content.videoRenderer;
		if (vr?.videoId) {
			const dur = parseClockDuration(vr.lengthText?.simpleText);
			if (dur === 0 || dur >= 900) out.push(String(vr.videoId));
			continue;
		}
		const lm = content.lockupViewModel;
		if (lm?.contentId && /^[\w-]{11}$/.test(lm.contentId)) {
			const badge = lm.contentImage?.thumbnailViewModel?.overlays
				?.flatMap(o => o.thumbnailBottomOverlayViewModel?.badges || [])
				?.map(b => b.thumbnailBadgeViewModel?.text)
				?.find(Boolean);
			const dur = parseClockDuration(badge);
			if (dur === 0 || dur >= 900) out.push(String(lm.contentId));
		}
	}
	return out;
}

/**
 * Последние загрузки канала (через UU-плейлист в Data API v3 или вкладки Видео+Трансляции в InnerTube).
 *
 * @param {string} channelId UC...
 * @param {{ maxResults?: number }} [opts]
 * @returns {Promise<{ ids: string[], calls: number }>}
 */
export async function channelUploads(channelId, { maxResults = 25 } = {}) {
	if (!/^UC[\w-]{20,}$/.test(String(channelId || ''))) return { ids: [], calls: 0 };

	if (config.youtubeApiKey) {
		const playlistId = `UU${channelId.slice(2)}`;
		try {
			const data = await dataGet('playlistItems', {
				part: 'contentDetails',
				playlistId,
				maxResults: String(Math.min(50, maxResults)),
			});
			const ids = (data.items || [])
				.map(it => it?.contentDetails?.videoId)
				.filter(Boolean)
				.map(String);
			return { ids, calls: 1 };
		} catch (e) {
			if (e.status === 404) return { ids: [], calls: 1 };
			throw e;
		}
	}

	// InnerTube: вкладка «Видео» (EgZ2aWRlb3PyBgQKAjoA) и вкладка «Трансляции» (EgdzdHJlYW1z8gYECgJ6AA==)
	const seen = new Set();
	const ids = [];
	let calls = 0;
	for (const params of ['EgZ2aWRlb3PyBgQKAjoA', 'EgdzdHJlYW1z8gYECgJ6AA==']) {
		try {
			const data = await innertubePost('browse', { browseId: channelId, params });
			calls++;
			const tab = (data?.contents?.twoColumnBrowseResultsRenderer?.tabs || []).find(t => t.tabRenderer?.selected);
			const grid = tab?.tabRenderer?.content?.richGridRenderer?.contents || [];
			for (const id of extractGridVideos(grid)) {
				if (!seen.has(id) && ids.length < maxResults) {
					seen.add(id);
					ids.push(id);
				}
			}
		} catch {
			// У канала может не быть вкладки «Трансляции» — не ошибка
		}
	}
	return { ids, calls };
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

	for (const ref of refs) {
		if (!ref?.value) continue;
		try {
			let channelId = null;
			let title = '';
			let handle = ref.kind === 'handle' ? ref.value : null;

			if (ref.kind === 'id') {
				channelId = ref.value;
				if (config.youtubeApiKey) {
					const data = await dataGet('channels', { part: 'snippet', id: channelId });
					const item = data.items?.[0];
					if (item) {
						title = item.snippet?.title || '';
						handle = item.snippet?.customUrl || handle;
					}
				}
			} else if (config.youtubeApiKey && ref.kind === 'handle') {
				const data = await dataGet('channels', { part: 'snippet', forHandle: ref.value.replace(/^@/, '') });
				const item = data.items?.[0];
				if (item?.id) {
					channelId = String(item.id);
					title = item.snippet?.title || '';
					handle = item.snippet?.customUrl || ref.value;
				}
			} else if (config.youtubeApiKey && ref.kind === 'user') {
				const data = await dataGet('channels', { part: 'snippet', forUsername: ref.value });
				const item = data.items?.[0];
				if (item?.id) {
					channelId = String(item.id);
					title = item.snippet?.title || '';
					handle = item.snippet?.customUrl || handle;
				}
			} else {
				const url = ref.kind === 'handle'
					? `https://www.youtube.com/${ref.value}`
					: (ref.kind === 'user' ? `https://www.youtube.com/user/${ref.value}` : ref.value);
				const data = await innertubePost('navigation/resolve_url', { url });
				const bid = data?.endpoint?.browseEndpoint?.browseId;
				if (bid && /^UC[\w-]{20,}$/.test(bid)) {
					channelId = bid;
					const canonical = data?.endpoint?.browseEndpoint?.canonicalBaseUrl || '';
					if (canonical.startsWith('/@')) handle = canonical.slice(1);
					if (config.youtubeApiKey) {
						const ch = await dataGet('channels', { part: 'snippet', id: channelId });
						const item = ch.items?.[0];
						if (item) {
							title = item.snippet?.title || '';
							handle = item.snippet?.customUrl || handle;
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
