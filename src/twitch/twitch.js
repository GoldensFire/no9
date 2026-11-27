// Twitch: GQL, токен записи, usher и плейлист варианта.
//
// GQL — тот же, которым живёт сайт Twitch, с его открытым Client-Id; ключа
// не просит. Так годами живут yt-dlp и streamlink. Проверено с домашнего IP
// и с раннера GitHub (twitch-streams.md, 3.2 и 3.6). Запросы — plan.md
// TwitchFinder, 10.1–10.2.

import { isSigame, isSvoyakShow, SIGAME_TITLE_RE } from './plan.js';

const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
export const HEADERS = { 'User-Agent': UA };

const CHAPTERS = `moments(momentRequestType: VIDEO_CHAPTER_MARKERS){ edges{ node{ positionMilliseconds durationMilliseconds
  details{ ... on GameChangeMomentDetails{ game{ name } } } } } }`;
const VIDEO = `id title lengthSeconds createdAt status viewCount broadcastType game{ name } owner{ login displayName } ${CHAPTERS}`;

/** Минимальная длина HIGHLIGHT и UPLOAD (10 мин): отсекает минутные нарезки. */
export const MIN_NON_ARCHIVE_S = 600;
const ALLOWED_TYPES = new Set(['ARCHIVE', 'HIGHLIGHT', 'UPLOAD']);

function isAcceptedVideo(v) {
	if (!v) return false;
	if (!ALLOWED_TYPES.has(v.type)) return false;
	if (v.type !== 'ARCHIVE' && v.length < MIN_NON_ARCHIVE_S) return false;
	return true;
}

async function post(body, tries = 3) {
	for (let i = 1; ; i++) {
		try {
			const r = await fetch('https://gql.twitch.tv/gql', {
				method: 'POST',
				headers: { 'Client-Id': CLIENT_ID, 'Content-Type': 'application/json', ...HEADERS },
				body: JSON.stringify(body),
			});
			const text = await r.text();
			if (r.status >= 500 || r.status === 429) throw new Error(`GQL HTTP ${r.status}`);
			if (!r.ok) throw Object.assign(new Error(`GQL HTTP ${r.status}: ${text.slice(0, 200)}`), { final: true });
			return JSON.parse(text);
		} catch (e) {
			if (e.final || i >= tries) throw e;
			await new Promise(res => setTimeout(res, 2000 * i));
		}
	}
}

export async function gql(query, variables = {}) {
	const j = await post({ query, variables });
	if (j.errors?.length && !j.data) throw new Error(`GQL: ${JSON.stringify(j.errors).slice(0, 300)}`);
	return j.data;
}

/**
 * Пачка запросов одним POST — по 30, больше GQL не принимает.
 * Если внутри пачки отдельные элементы вернули errors (таймаут бэкенда Twitch),
 * они логируются и повторяются меньшими пачками (по 5, затем по 1).
 * Отказы IntegrityCheckFailed не повторяются (с этого IP они детерминированы),
 * а частичный ответ data при них сохраняется.
 */
export async function gqlBatch(items, { chunkSize = 30 } = {}) {
	const out = new Array(items.length).fill(null);
	let integrityErrors = 0;
	let momentsErrors = 0;

	const isIntegrityOnly = errors => Array.isArray(errors) && errors.length > 0
		&& errors.every(e => e?.extensions?.code === 'IntegrityCheckFailed' || /failed integrity check/i.test(e?.message || ''));

	// На отдельных старых VOD Twitch часто отдаёт service error на подзапросе глав (moments),
	// при этом весь список видео канала (data) приходит целиком. Повторять весь канал 3 раза из-за
	// одного битого moments только перегружает бэкенд и валит соседние каналы.
	const isMomentsOnly = errors => Array.isArray(errors) && errors.length > 0
		&& errors.every(e => Array.isArray(e?.path) && e.path[e.path.length - 1] === 'moments');

	const runChunks = async (indices, size) => {
		const failed = [];
		for (let i = 0; i < indices.length; i += size) {
			if (i > 0) await new Promise(res => setTimeout(res, 250));
			const idxPart = indices.slice(i, i + size);
			const part = idxPart.map(idx => items[idx]);
			let res;
			try {
				res = await post(part);
			} catch (e) {
				if (size > 1) {
					failed.push(...idxPart);
					continue;
				}
				console.warn(`GQL batch item failed: ${e.message}`);
				continue;
			}
			if (!Array.isArray(res) || res.length !== idxPart.length) {
				if (size > 1) {
					failed.push(...idxPart);
					continue;
				}
				console.warn(`GQL: на пачку пришёл не массив: ${JSON.stringify(res).slice(0, 200)}`);
				continue;
			}
			for (let k = 0; k < idxPart.length; k++) {
				const r = res[k];
				if (r && r.errors?.length && isIntegrityOnly(r.errors)) {
					integrityErrors++;
					out[idxPart[k]] = r.data ?? null;
					continue;
				}
				if (r && r.data && r.errors?.length && isMomentsOnly(r.errors)) {
					momentsErrors++;
					out[idxPart[k]] = r.data;
					continue;
				}
				if (!r || r.errors?.length || r.data === undefined) {
					failed.push(idxPart[k]);
					if (size === 1) {
						const msg = r?.errors ? JSON.stringify(r.errors).slice(0, 200) : 'пустой ответ';
						console.warn(`GQL item #${idxPart[k]} error after retries: ${msg}`);
						out[idxPart[k]] = r?.data ?? null;
					}
				} else {
					out[idxPart[k]] = r.data ?? null;
				}
			}
		}
		return failed;
	};

	const allIdx = items.map((_, i) => i);
	let failed = await runChunks(allIdx, chunkSize);
	if (integrityErrors) {
		console.warn(`GQL batch: ${integrityErrors} отказов IntegrityCheckFailed (часть полей закрыта Twitch с этого IP, повторы пропущены)`);
	}
	if (momentsErrors) {
		console.warn(`GQL batch: ${momentsErrors} частичных отказов moments (список видео получен, повторы пропущены)`);
	}
	if (failed.length && chunkSize > 5) {
		console.warn(`GQL batch: ${failed.length} сбоев в пачках по ${chunkSize} — повторяю по 5`);
		await new Promise(res => setTimeout(res, 1000));
		failed = await runChunks(failed, 5);
	}
	if (failed.length) {
		console.warn(`GQL batch: ${failed.length} сбоев в пачках по 5 — повторяю по одному`);
		await new Promise(res => setTimeout(res, 1500));
		await runChunks(failed, 1);
	}
	return out;
}

/** Запись в общем виде: главы в секундах, время — в мс. */
export function videoOf(node) {
	if (!node) return null;
	return {
		id: String(node.id),
		type: node.broadcastType || 'ARCHIVE',
		title: node.title || '',
		length: node.lengthSeconds || 0,
		createdAt: Date.parse(node.createdAt),
		status: node.status || '',
		views: Number.isFinite(node.viewCount) ? node.viewCount : null,
		game: node.game?.name || '',
		channel: node.owner?.login || '',
		channelName: node.owner?.displayName || node.owner?.login || '',
		chapters: (node.moments?.edges || []).map(e => ({
			game: e.node.details?.game?.name || '',
			from: e.node.positionMilliseconds / 1000,
			len: e.node.durationMilliseconds / 1000,
		})),
	};
}

/** Записи категории SIGame (архивы, хайлайты и загрузки ≥ 10 мин). */
export async function categoryVideos() {
	const out = [];
	let after = null;
	for (let page = 0; page < 10; page++) {
		const d = await gql(`query($a:Cursor){ game(name:"SIGame"){ videos(first:100, after:$a, sort:TIME, types:[ARCHIVE, HIGHLIGHT, UPLOAD]){
		  edges{ cursor node{ ${VIDEO} } } pageInfo{ hasNextPage } } } }`, { a: after });
		const v = d.game?.videos;
		for (const e of v?.edges || []) {
			const item = videoOf(e.node);
			if (isAcceptedVideo(item)) out.push(item);
		}
		if (!v?.pageInfo?.hasNextPage || !v.edges.length) break;
		after = v.edges.at(-1).cursor;
	}
	return out;
}

/** Записи каналов: до 100 архивов + до 10 хайлайтов и загрузок ≥ 10 мин на канал, пачками. */
export async function channelVideos(logins) {
	const res = await gqlBatch(logins.map(l => ({
		query: `query($l:String!){ user(login:$l){ login
			videos(first:100, type:ARCHIVE, sort:TIME){ edges{ node{ ${VIDEO} } } }
			highlights: videos(first:10, type:HIGHLIGHT, sort:TIME){ edges{ node{ ${VIDEO} } } }
			uploads: videos(first:10, type:UPLOAD, sort:TIME){ edges{ node{ ${VIDEO} } } }
		} }`,
		variables: { l: l },
	})), { chunkSize: 15 });
	const out = [];
	for (const d of res) {
		const u = d?.user;
		if (!u) continue;
		for (const edges of [u.videos?.edges, u.highlights?.edges, u.uploads?.edges]) {
			for (const e of edges || []) {
				const item = videoOf(e.node);
				if (isAcceptedVideo(item)) out.push(item);
			}
		}
	}
	return out;
}

/** Клипы категории SIGame за последнюю неделю: 1 GQL-запрос для добора пропущенных каналов и VOD. */
export async function categoryClips(period = 'LAST_WEEK') {
	const d = await gql(`query($p:ClipsPeriod!){ game(name:"SIGame"){ clips(first:100, criteria:{period:$p}){
		edges{ node{ broadcaster{ login } video{ id } } }
	} } }`, { p: period });
	const channels = new Set();
	const videoIds = new Set();
	for (const e of d?.game?.clips?.edges || []) {
		const login = e?.node?.broadcaster?.login;
		if (login) channels.add(String(login).toLowerCase());
		const vid = e?.node?.video?.id;
		if (vid) videoIds.add(String(vid));
	}
	return { channels: [...channels], videoIds: [...videoIds] };
}

/** Записи по номерам. Удалённая — null на её месте. */
export async function videosById(ids) {
	const res = await gqlBatch(ids.map(id => ({ query: `query($id:ID!){ video(id:$id){ ${VIDEO} } }`, variables: { id } })));
	return res.map(d => videoOf(d?.video));
}

/**
 * Запросы для поиска VOD через GQL searchFor.
 * «si game» с пробелом нарочно не включён: Twitch ищет по отдельным словам
 * и тащит поток испаноязычных стримов (si + game).
 */
export const SEARCH_QUERIES = [
	'sigame', 'сигейм', 'си гейм', 'сигаме', 'си гаме', 'сишечка', 'сисигейм',
	'своя игра', 'свояигра', 'свою игру', 'своячок', 'свояк', 'свояка', 'свояком',
];

/**
 * Поиск VOD (архивы, хайлайты и загрузки ≥ 10 мин) по ключевым словам в GQL searchFor.
 * Главы здесь не запрашиваются — их добирает discover.js через channelVideos()
 * или videosById(). Сортировка в searchFor по релевантности, а не строго по дате,
 * поэтому остановка идёт по maxPages, а старые ARCHIVE/UPLOAD отсеиваются по since
 * (для вечных HIGHLIGHT порог since не применяется).
 */
export async function searchVideos(queries = SEARCH_QUERIES, { maxPages = 5, since = 0 } = {}) {
	const out = [];
	const seen = new Set();
	let first = true;
	for (const q of queries) {
		let cursor = null;
		for (let page = 0; page < maxPages; page++) {
			if (!first) await new Promise(res => setTimeout(res, 200));
			first = false;
			const d = await gql(`query($q: String!, $c: String) {
				searchFor(userQuery: $q, platform: "web", target: { index: VOD, cursor: $c }) {
					videos {
						items {
							id title lengthSeconds createdAt status viewCount broadcastType
							game { name }
							owner { login displayName }
						}
						cursor
					}
				}
			}`, { q, c: cursor });
			const box = d?.searchFor?.videos;
			const items = box?.items || [];
			for (const node of items) {
				if (!node) continue;
				const v = videoOf(node);
				if (!isAcceptedVideo(v) || seen.has(v.id)) continue;
				if (since && v.type !== 'HIGHLIGHT' && v.createdAt < since) continue;
				if (!SIGAME_TITLE_RE.test(v.title) && !isSigame(v.game)) continue;
				if (isSvoyakShow(v)) continue;
				seen.add(v.id);
				out.push(v);
			}
			cursor = box?.cursor || null;
			if (!cursor || !items.length) break;
		}
	}
	return out;
}

/**
 * Какие записи из списка Twitch уже не отдаёт и сколько просмотров у живых.
 * Умершей считается только та, на которую GQL ответил «такой нет» (video: null);
 * упавший кусок пачки — не ответ, и такие записи остаются живыми до завтра:
 * иначе минутный сбой Twitch стёр бы полосу у всех паков разом.
 */
export async function checkVideos(ids) {
	const dead = [];
	const views = [];
	for (let i = 0; i < ids.length; i += 30) {
		const part = ids.slice(i, i + 30);
		const res = await post(part.map(id => ({ query: 'query($id:ID!){ video(id:$id){ id viewCount } }', variables: { id } })));
		if (!Array.isArray(res)) continue;
		part.forEach((id, k) => {
			const r = res[k];
			if (!r || r.errors?.length || !r.data) return;
			if (r.data.video === null) dead.push(id);
			else if (Number.isFinite(r.data.video.viewCount)) views.push([id, r.data.video.viewCount]);
		});
	}
	return { dead, views };
}

export async function deadVideos(ids) {
	return (await checkVideos(ids)).dead;
}

export class SubOnly extends Error {}

/**
 * Плейлист записи: вариант 720p, иначе исходник, и сегменты с накопленным
 * временем. Записи только для подписчиков usher отвечает 403 — SubOnly.
 */
export async function openMedia(id) {
	const d = await gql(`query($id:ID!){ videoPlaybackAccessToken(id:$id, params:{platform:"web", playerBackend:"mediaplayer", playerType:"site"}){ value signature } }`, { id });
	const tok = d.videoPlaybackAccessToken;
	if (!tok) throw new Error('нет токена записи');
	const url = `https://usher.ttvnw.net/vod/${id}.m3u8?allow_source=true&allow_audio_only=true&playlist_include_framerate=true`
		+ `&player_backend=mediaplayer&supported_codecs=h264&sig=${tok.signature}&token=${encodeURIComponent(tok.value)}`;
	const r = await fetch(url, { headers: HEADERS });
	const master = await r.text();
	if (r.status === 403) throw new SubOnly('только для подписчиков');
	if (!master.startsWith('#EXTM3U')) throw new Error(`usher HTTP ${r.status}: ${master.slice(0, 150)}`);

	const variants = [];
	const lines = master.split('\n');
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
		const u = lines.slice(i + 1).find(l => l.startsWith('https://'))?.trim();
		if (u) variants.push({ url: u, name: u.split('/').at(-2), codecs: /CODECS="([^"]+)"/.exec(lines[i])?.[1] || '' });
	}
	const video = variants.filter(v => v.name !== 'audio_only' && !/^mp4a/.test(v.codecs));
	const v = video.find(x => /^720p/.test(x.name)) || video.find(x => x.name === 'chunked') || video[0];
	if (!v) throw new Error('в плейлисте нет видео');

	const pr = await fetch(v.url, { headers: HEADERS });
	const text = await pr.text();
	const base = v.url.slice(0, v.url.lastIndexOf('/') + 1);
	const segs = [];
	let acc = 0, dur = 0, init = null;
	for (const line of text.split('\n')) {
		if (line.startsWith('#EXT-X-MAP:')) init = base + /URI="([^"]+)"/.exec(line)?.[1];
		else if (line.startsWith('#EXTINF:')) dur = parseFloat(line.slice(8));
		else if (line.trim() && !line.startsWith('#')) { segs.push({ t: acc, url: base + line.trim() }); acc += dur; }
	}
	if (!segs.length) throw new Error(`плейлист ${v.name}: HTTP ${pr.status}, сегментов нет`);
	return { variant: v.name, big: v.name === 'chunked', segs, init, length: acc };
}
