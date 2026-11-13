// Twitch: GQL, токен записи, usher и плейлист варианта.
//
// GQL — тот же, которым живёт сайт Twitch, с его открытым Client-Id; ключа
// не просит. Так годами живут yt-dlp и streamlink. Проверено с домашнего IP
// и с раннера GitHub (twitch-streams.md, 3.2 и 3.6). Запросы — plan.md
// TwitchFinder, 10.1–10.2.

const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
export const HEADERS = { 'User-Agent': UA };

const CHAPTERS = `moments(momentRequestType: VIDEO_CHAPTER_MARKERS){ edges{ node{ positionMilliseconds durationMilliseconds
  details{ ... on GameChangeMomentDetails{ game{ name } } } } } }`;
const VIDEO = `id title lengthSeconds createdAt status game{ name } owner{ login displayName } ${CHAPTERS}`;

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

/** Пачка запросов одним POST — по 30, больше GQL не принимает. */
export async function gqlBatch(items) {
	const out = [];
	for (let i = 0; i < items.length; i += 30) {
		const part = items.slice(i, i + 30);
		const res = await post(part);
		if (!Array.isArray(res)) throw new Error(`GQL: на пачку пришёл не массив: ${JSON.stringify(res).slice(0, 200)}`);
		out.push(...res.map(r => r.data ?? null));
	}
	return out;
}

/** Запись в общем виде: главы в секундах, время — в мс. */
export function videoOf(node) {
	if (!node) return null;
	return {
		id: String(node.id),
		title: node.title || '',
		length: node.lengthSeconds || 0,
		createdAt: Date.parse(node.createdAt),
		status: node.status || '',
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

/** Записи категории SIGame — Twitch отдаёт около недели, одной страницей. */
export async function categoryVideos() {
	const out = [];
	let after = null;
	for (let page = 0; page < 10; page++) {
		const d = await gql(`query($a:Cursor){ game(name:"SIGame"){ videos(first:100, after:$a, sort:TIME, types:[ARCHIVE]){
		  edges{ cursor node{ ${VIDEO} } } pageInfo{ hasNextPage } } } }`, { a: after });
		const v = d.game?.videos;
		for (const e of v?.edges || []) out.push(videoOf(e.node));
		if (!v?.pageInfo?.hasNextPage || !v.edges.length) break;
		after = v.edges.at(-1).cursor;
	}
	return out;
}

/** Записи каналов: по сотне последних на канал, пачками. */
export async function channelVideos(logins) {
	const res = await gqlBatch(logins.map(l => ({
		query: `query($l:String!){ user(login:$l){ login videos(first:100, type:ARCHIVE, sort:TIME){ edges{ node{ ${VIDEO} } } } } }`,
		variables: { l: l },
	})));
	const out = [];
	for (const d of res) for (const e of d?.user?.videos?.edges || []) out.push(videoOf(e.node));
	return out;
}

/** Записи по номерам. Удалённая — null на её месте. */
export async function videosById(ids) {
	const res = await gqlBatch(ids.map(id => ({ query: `query($id:ID!){ video(id:$id){ ${VIDEO} } }`, variables: { id } })));
	return res.map(d => videoOf(d?.video));
}

/**
 * Какие записи из списка Twitch уже не отдаёт. Умершей считается только
 * та, на которую GQL ответил «такой нет» (video: null); упавший кусок
 * пачки — не ответ, и такие записи остаются живыми до завтра: иначе
 * минутный сбой Twitch стёр бы полосу у всех паков разом.
 */
export async function deadVideos(ids) {
	const dead = [];
	for (let i = 0; i < ids.length; i += 30) {
		const part = ids.slice(i, i + 30);
		const res = await post(part.map(id => ({ query: 'query($id:ID!){ video(id:$id){ id } }', variables: { id } })));
		if (!Array.isArray(res)) continue;
		part.forEach((id, k) => {
			const r = res[k];
			if (r && !r.errors?.length && r.data && r.data.video === null) dead.push(id);
		});
	}
	return dead;
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
