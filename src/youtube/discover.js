// Поиск кандидатов YouTube для сканера Gemini:
//   1. Поиск свежих роликов по 9 проверенным запросам (searchVideos);
//   2. Обход известных SIGame YouTube-каналов из youtube_channels (channelUploads);
//   3. Еженедельный мост Twitch → YouTube по socialMedias подтверждённых
//      SIGame-стримеров из twitch_vods (одной пачкой Twitch GQL + resolveChannels).

import { gqlBatch } from '../twitch/twitch.js';
import { MAX_TRIES } from '../twitch/store.js';
import { apiMode, channelUploads, parseYoutubeChannelRef, resolveChannels, searchVideos, videosById } from './api.js';
import { shouldSkipVideo } from './plan.js';

/** 9 проверенных запросов из youtube-gemini-plan.md (3.2). */
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
];

/** Вытащить все http(s)-ссылки из свободного текста (описание канала или панели Twitch). */
function extractUrls(text) {
	if (!text) return [];
	return (String(text).match(/https?:\/\/[^\s<>"')\]]+/gi) || [])
		.map(u => u.replace(/[.,;:!?]+$/, ''));
}

/**
 * Мост Twitch → YouTube: вытащить ссылки на YouTube-каналы из socialMedias,
 * панелей и описания подтверждённых SIGame-стримеров Twitch и отрезолвить новые в UC... ID.
 * На облачных IP Twitch закрывает socialMedias ошибкой IntegrityCheckFailed,
 * но панели и описание в том же GQL-ответе продолжают приходить.
 *
 * @param {string[]} twitchLogins
 * @param {Set<string>} knownChannelIds уже известные channel_id
 * @param {Set<string>} knownLogins уже привязанные twitch_login
 */
export async function bridgeTwitchChannels(twitchLogins, knownChannelIds, knownLogins) {
	const freshLogins = twitchLogins.filter(l => l && !knownLogins.has(l.toLowerCase()));
	if (!freshLogins.length) return { channels: [], checked: 0, integrityBlocked: false };

	const res = await gqlBatch(freshLogins.map(l => ({
		query: `query($l:String!){
			user(login:$l){
				login
				description
				panels{ __typename ... on DefaultPanel { linkURL description } }
				channel{ socialMedias{ name url } }
			}
		}`,
		variables: { l },
	})));

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

	for (const d of res) {
		const u = d?.user;
		const login = u?.login?.toLowerCase();
		if (!login) continue;
		if (u.channel) {
			usersWithChannel++;
			if (u.channel.socialMedias === null) nullSocialMedias++;
		}
		for (const s of u.channel?.socialMedias || []) pushUrl(s?.url, login);
		for (const p of u.panels || []) {
			if (p?.linkURL) pushUrl(p.linkURL, login);
			for (const url of extractUrls(p?.description)) pushUrl(url, login);
		}
		for (const url of extractUrls(u.description)) pushUrl(url, login);
	}

	const integrityBlocked = usersWithChannel > 0 && nullSocialMedias >= Math.ceil(usersWithChannel * 0.8);
	const resolved = refs.length ? await resolveChannels(refs) : [];
	return {
		channels: resolved.filter(c => !knownChannelIds.has(c.channelId)),
		checked: freshLogins.length,
		integrityBlocked,
	};
}

/**
 * Найти новые ролики YouTube для сканирования.
 *
 * @param {object} opts
 * @param {number} [opts.days] горизонт поиска в днях (по умолчанию 7; при backfill — без порога)
 * @param {boolean} [opts.backfill] глубокий обход (больше страниц поиска и до 50 видео на канал)
 * @param {Map<string, object>} [opts.known] уже известные видео из youtube_videos
 * @param {Array<object>} [opts.channels] известные каналы из youtube_channels
 * @param {boolean} [opts.rescan] пересматривать уже просмотренные
 */
export async function discover({
	days = 7,
	backfill = false,
	known = new Map(),
	channels = [],
	rescan = false,
} = {}) {
	const now = Date.now();
	const publishedAfter = backfill || days <= 0 ? 0 : now - days * 864e5;
	const maxPages = backfill ? 2 : 1;

	const stats = {
		mode: apiMode(),
		searchQueries: 0,
		searchCalls: 0,
		searchRaw: 0,
		channelsChecked: 0,
		channelRaw: 0,
		videosFetched: 0,
		errors: [],
	};

	// videoId → Set(источники: 'search' | 'channel')
	const sourcesById = new Map();
	const addSource = (id, src) => {
		let s = sourcesById.get(id);
		if (!s) sourcesById.set(id, s = new Set());
		s.add(src);
	};

	// 1. Поиск по 9 запросам
	for (const q of SEARCH_QUERIES) {
		try {
			const { ids, calls } = await searchVideos(q, { publishedAfter, maxPages, days: backfill ? 0 : days });
			stats.searchQueries++;
			stats.searchCalls += calls;
			stats.searchRaw += ids.length;
			for (const id of ids) addSource(id, 'search');
		} catch (e) {
			stats.errors.push(`поиск «${q}»: ${e.message}`);
		}
	}

	// 2. Известные YouTube-каналы (приоритет тем, где уже были SIGame или пришли с Twitch)
	const channelPool = [...channels]
		.filter(c => (c.sigame_videos || 0) > 0 || c.source === 'twitch' || c.source === 'manual')
		.sort((a, b) => (a.last_checked_at || 0) - (b.last_checked_at || 0))
		.slice(0, backfill ? 250 : 120);

	const checkedChannelIds = [];
	for (const ch of channelPool) {
		try {
			const { ids } = await channelUploads(ch.channel_id, { maxResults: backfill ? 50 : 25 });
			stats.channelsChecked++;
			stats.channelRaw += ids.length;
			checkedChannelIds.push(ch.channel_id);
			for (const id of ids) addSource(id, 'channel');
		} catch (e) {
			stats.errors.push(`канал ${ch.title || ch.channel_id}: ${e.message}`);
		}
	}

	const skipped = {
		seen: 0,
		failed: 0,
		old: 0,
		short: 0,
		live: 0,
		noise: 0,
		missing: 0,
	};

	// Отсеиваем уже известные до videos.list, чтобы не тратить лишние запросы
	const toFetch = [];
	for (const id of sourcesById.keys()) {
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
		toFetch.push(id);
	}

	// 3. Метаданные пачкой (videos.list / player)
	const { videos, missing } = await videosById(toFetch);
	stats.videosFetched = videos.size;
	skipped.missing = missing.length;

	const todo = [];
	for (const [id, v] of videos) {
		const srcs = [...(sourcesById.get(id) || [])];
		// Для ежедневного обхода (не backfill) отсекаем ролики старше days * 2
		// (даём двойной запас, чтобы не пропустить недавние загрузки каналов)
		if (!backfill && publishedAfter > 0 && v.publishedAt > 0 && v.publishedAt < now - Math.max(days, 14) * 864e5) {
			skipped.old++;
			continue;
		}
		const check = shouldSkipVideo(v, { requireTitleMatch: true });
		if (check.skip) {
			if (check.reason === 'прямой эфир / анонс') skipped.live++;
			else if (check.reason === 'короче 15 мин') skipped.short++;
			else skipped.noise++;
			continue;
		}
		todo.push({ video: v, source: srcs.join('+') });
	}

	// Свежие впереди, чтобы при ограниченном --limit или --minutes сначала шли новые ролики
	todo.sort((a, b) => (b.video.publishedAt || 0) - (a.video.publishedAt || 0));

	return { todo, stats, skipped, checkedChannelIds };
}
