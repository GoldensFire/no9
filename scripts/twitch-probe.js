// Этап 0 плана «стримы Twitch под паками»: пускают ли Twitch и SullyGnome
// с раннера GitHub и сколько стоит OCR одного кадра на нём.
//
// Ничего не пишет ни в базу, ни на полку, ни в D1 и не знает про остальной
// проект — только сеть, ffmpeg и tesseract. Запускается вручную задачей
// .github/workflows/twitch-probe.yml; дома тоже работает, если ffmpeg
// и tesseract есть в PATH.
//
//   node scripts/twitch-probe.js [--vod=<id>] [--frames=8] [--out=<папка>]
//                                [--fast=<папка с tessdata_fast>]
//
// Итог — таблица в $GITHUB_STEP_SUMMARY (или в консоль) и тексты OCR в --out.
// Когда этап 0 пройден, файл больше не нужен: дальше живёт scripts/twitch.js.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const run = promisify(execFile);
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
	const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
	return m ? [m[1], m[2] ?? '1'] : [a, '1'];
}));
const FRAMES = Number(args.frames || 8);
const OUT = path.resolve(args.out || path.join(os.tmpdir(), 'twitch-probe'));
const FAST = args.fast || '';
const CID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const SULLY_GAME = 160315;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

fs.mkdirSync(OUT, { recursive: true });

// Каждая проверка — строка итога: что, вышло ли, подробности.
const report = [];
const note = (what, ok, detail = '') => {
	report.push({ what, ok, detail });
	console.log(`${ok === true ? 'OK ' : ok === false ? 'ERR' : '-- '} ${what}${detail ? ': ' + detail : ''}`);
};
const extra = []; // строки под таблицей

async function step(what, fn) {
	const t0 = Date.now();
	try {
		const r = await fn();
		return r;
	} catch (e) {
		note(what, false, `${String(e.message || e).slice(0, 300)} (${Date.now() - t0} мс)`);
		return null;
	}
}

// ---------- Twitch GQL ----------

async function gqlRaw(body) {
	const r = await fetch('https://gql.twitch.tv/gql', {
		method: 'POST',
		headers: { 'Client-Id': CID, 'Content-Type': 'application/json', 'User-Agent': UA },
		body: JSON.stringify(body),
	});
	const text = await r.text();
	if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
	return JSON.parse(text);
}
async function gql(query, variables) {
	const j = await gqlRaw({ query, variables });
	if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
	return j.data;
}

const CHAPTERS = `moments(momentRequestType: VIDEO_CHAPTER_MARKERS){ edges{ node{ positionMilliseconds durationMilliseconds
  details{ ... on GameChangeMomentDetails{ game{ name } } } } } }`;

const chaptersOf = (video) => (video?.moments?.edges || []).map((e) => ({
	game: e.node.details?.game?.name || '',
	from: e.node.positionMilliseconds / 1000,
	len: e.node.durationMilliseconds / 1000,
}));

// ---------- SullyGnome ----------

async function sully(url) {
	const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' } });
	const text = await r.text();
	const head = `HTTP ${r.status}, ${r.headers.get('content-type') || '?'}, cf-ray ${r.headers.get('cf-ray') || '—'}`;
	if (!r.ok) throw new Error(`${head}: ${text.slice(0, 150).replace(/\s+/g, ' ')}`);
	try { return { head, json: JSON.parse(text) }; } catch {
		throw new Error(`${head}: не JSON — ${text.slice(0, 150).replace(/\s+/g, ' ')}`);
	}
}

// ---------- кадры ----------

function parseMaster(text) {
	const out = [];
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
		const codecs = /CODECS="([^"]+)"/.exec(lines[i])?.[1] || '?';
		const res = /RESOLUTION=(\d+x\d+)/.exec(lines[i])?.[1] || '?';
		const url = lines.slice(i + 1).find((l) => l.startsWith('https://'))?.trim();
		if (url) out.push({ url, codecs, res, name: url.split('/').at(-2) });
	}
	return out;
}

function parseMedia(text, variantUrl) {
	const base = variantUrl.slice(0, variantUrl.lastIndexOf('/') + 1);
	const segs = [];
	let acc = 0, dur = 0, init = null;
	for (const line of text.split('\n')) {
		if (line.startsWith('#EXT-X-MAP:')) init = base + /URI="([^"]+)"/.exec(line)?.[1];
		else if (line.startsWith('#EXTINF:')) dur = parseFloat(line.slice(8));
		else if (line && !line.startsWith('#')) { segs.push({ t: acc, url: base + line.trim() }); acc += dur; }
	}
	return { segs, init, length: acc };
}

async function frameAt(media, t, rangeBytes, file) {
	const seg = media.segs.findLast((s) => s.t <= t) || media.segs[0];
	const t0 = Date.now();
	const r = await fetch(seg.url, { headers: { Range: `bytes=0-${rangeBytes - 1}`, 'User-Agent': UA } });
	if (!r.ok && r.status !== 206) throw new Error(`сегмент: HTTP ${r.status}`);
	let buf = Buffer.from(await r.arrayBuffer());
	const dlMs = Date.now() - t0;
	const bytes = buf.length;
	if (media.init) {
		const ri = await fetch(media.init, { headers: { 'User-Agent': UA } });
		buf = Buffer.concat([Buffer.from(await ri.arrayBuffer()), buf]);
	}
	const raw = file + (media.init ? '.mp4' : '.ts');
	fs.writeFileSync(raw, buf);
	const d0 = Date.now();
	await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-frames:v', '1', '-vf', 'scale=1280:-2', file]);
	fs.rmSync(raw, { force: true });
	return { t, status: r.status, bytes, dlMs, decMs: Date.now() - d0 };
}

// ---------- OCR ----------

async function ocr(png, tessdata) {
	const a = [png, 'stdout', '-l', 'rus+eng', '--psm', '11'];
	if (tessdata) a.push('--tessdata-dir', tessdata);
	const t0 = Date.now();
	const { stdout } = await run('tesseract', a, { env: { ...process.env, OMP_THREAD_LIMIT: '1' }, maxBuffer: 1 << 22 });
	return { ms: Date.now() - t0, text: stdout };
}

// Строки «Тема, цена» — то, по чему опознаётся пак; по ним видно качество OCR.
const headers = (text) => text.split('\n').map((l) => l.trim()).filter((l) => /^(.*?\S)\s*[,，]\s*(\d{2,5})\s*$/.test(l));

const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
const sec = (ms) => (ms / 1000).toFixed(2) + ' с';
const hm = (t) => `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}`;

// =====================================================================

console.log(`раннер: ${os.cpus().length} ядер, ${os.cpus()[0]?.model}, ${Math.round(os.totalmem() / 2 ** 30)} ГБ`);
extra.push(`Раннер: ${os.cpus().length} ядер (${os.cpus()[0]?.model}), ${Math.round(os.totalmem() / 2 ** 30)} ГБ памяти.`);

// 1. Категория SIGame на Twitch.
const list = await step('GQL game.videos', async () => {
	const t0 = Date.now();
	const d = await gql(`query{ game(name:"SIGame"){ videos(first:100, sort:TIME, types:[ARCHIVE]){ edges{ node{
	  id title lengthSeconds createdAt owner{ login } } } } } }`);
	const vids = (d.game?.videos?.edges || []).map((e) => e.node);
	const week = vids.filter((v) => Date.now() - Date.parse(v.createdAt) < 7 * 864e5);
	note('GQL game.videos', vids.length > 0, `${vids.length} записей, за 7 дней ${week.length} (${Math.round(week.reduce((a, v) => a + v.lengthSeconds, 0) / 3600)} ч), ${Date.now() - t0} мс`);
	return vids;
}) || [];

// 2. Главы пачкой (массив тел одним POST) — заодно проверка пачек.
const withChapters = await step('GQL пачка глав', async () => {
	const t0 = Date.now();
	const out = [];
	for (let i = 0; i < list.length; i += 30) {
		const part = list.slice(i, i + 30);
		const res = await gqlRaw(part.map((v) => ({ query: `query($id:ID!){ video(id:$id){ id game{ name } ${CHAPTERS} } }`, variables: { id: v.id } })));
		if (!Array.isArray(res)) throw new Error('ответ не массив: ' + JSON.stringify(res).slice(0, 200));
		res.forEach((r, k) => out.push({ ...part[k], chapters: chaptersOf(r.data?.video) }));
	}
	const n = out.filter((v) => v.chapters.length).length;
	const sigH = out.reduce((a, v) => a + v.chapters.filter((c) => /sigame/i.test(c.game)).reduce((b, c) => b + c.len, 0), 0) / 3600;
	note('GQL пачка глав', out.length === list.length, `${out.length} записей пачками по 30, с главами ${n}, SIGame в главах ${sigH.toFixed(0)} ч, ${Date.now() - t0} мс`);
	return out;
}) || list.map((v) => ({ ...v, chapters: [] }));

// 3. SullyGnome: каналы за 3 дня и стримы первого канала.
const channels = await step('SullyGnome: каналы', async () => {
	const t0 = Date.now();
	const { head, json } = await sully(`https://sullygnome.com/api/tables/gametables/getgamechannels/3/${SULLY_GAME}/%20/0/1/3/desc/0/100`);
	note('SullyGnome: каналы', Array.isArray(json.data), `${head}; recordsTotal ${json.recordsTotal}, строк ${json.data?.length}, ${Date.now() - t0} мс`);
	return json.data || [];
}) || [];

if (channels.length) {
	const ch = channels[0];
	await step('SullyGnome: стримы канала', async () => {
		const t0 = Date.now();
		const { head, json } = await sully(`https://sullygnome.com/api/tables/channeltables/streams/7/${ch.id}/%20/1/1/desc/0/100`);
		const rows = json.data || [];
		const sig = rows.filter((r) => /sigame/i.test(r.gamesplayed || ''));
		note('SullyGnome: стримы канала', Array.isArray(json.data), `${ch.url}: ${head}; стримов ${rows.length}, с SIGame ${sig.length}, ${Date.now() - t0} мс`);
	});
	await step('GQL user.videos', async () => {
		const t0 = Date.now();
		const d = await gql(`query($l:String!){ user(login:$l){ videos(first:20, type:ARCHIVE, sort:TIME){ edges{ node{ id createdAt lengthSeconds } } } } }`, { l: ch.url });
		const n = d.user?.videos?.edges?.length ?? 0;
		note('GQL user.videos', d.user != null, `${ch.url}: ${n} записей, ${Date.now() - t0} мс`);
	});
}

// 4. Одна запись: токен, usher, плейлист, кадры.
const sigLen = (v) => v.chapters.filter((c) => /sigame/i.test(c.game)).reduce((a, c) => a + c.len, 0);
const candidates = args.vod
	? [{ id: args.vod, chapters: [] }]
	: [...withChapters].sort((a, b) => sigLen(b) - sigLen(a) || b.lengthSeconds - a.lengthSeconds).slice(0, 6);

let vod = null, media = null, variant = null;
for (const c of candidates) {
	const r = await step(`запись ${c.id}`, async () => {
		const meta = (await gql(`query($id:ID!){ video(id:$id){ id title lengthSeconds createdAt status owner{ login } game{ name } ${CHAPTERS} } }`, { id: c.id })).video;
		if (!meta) throw new Error('video = null (запись удалена)');
		const tok = (await gql(`query($id:ID!){ videoPlaybackAccessToken(id:$id, params:{platform:"web", playerBackend:"mediaplayer", playerType:"site"}){ value signature } }`, { id: c.id })).videoPlaybackAccessToken;
		const usher = (codecs) => `https://usher.ttvnw.net/vod/${c.id}.m3u8?allow_source=true&allow_audio_only=true&playlist_include_framerate=true&player_backend=mediaplayer&supported_codecs=${codecs}&sig=${tok.signature}&token=${encodeURIComponent(tok.value)}`;
		const t0 = Date.now();
		const mr = await fetch(usher('h264'), { headers: { 'User-Agent': UA } });
		const master = await mr.text();
		if (!master.startsWith('#EXTM3U')) throw new Error(`usher HTTP ${mr.status}: ${master.slice(0, 200)}`);
		const variants = parseMaster(master);
		note('usher (h264)', true, `${meta.owner.login}: ${variants.map((v) => `${v.name} ${v.res} ${v.codecs}`).join('; ')}, ${Date.now() - t0} мс`);
		// Отдаёт ли Twitch что-то кроме h264, если не просить только его.
		const any = await (await fetch(usher('av1,h265,h264'), { headers: { 'User-Agent': UA } })).text();
		const anyCodecs = [...new Set(parseMaster(any).map((v) => v.codecs.split(',')[0]))];
		note('usher (av1,h265,h264)', null, `кодеки видео: ${anyCodecs.join(', ') || '—'}`);
		const v = variants.find((x) => x.name === '720p60' || x.name === '720p30') || variants.find((x) => x.name === 'chunked') || variants[0];
		const pr = await fetch(v.url, { headers: { 'User-Agent': UA } });
		const m = parseMedia(await pr.text(), v.url);
		if (!m.segs.length) throw new Error(`плейлист ${v.name}: HTTP ${pr.status}, сегментов нет`);
		note('плейлист варианта', true, `${v.name}, сегментов ${m.segs.length}, ${Math.round(m.length / 60)} мин, ${m.init ? 'fMP4 (init)' : 'MPEG-TS'}`);
		return { meta, m, v };
	});
	if (r) { vod = r.meta; media = r.m; variant = r.v; break; }
}

const frames = [];
if (media) {
	// Самая длинная глава SIGame: первая бывает пятиминутной заставкой.
	const ch = chaptersOf(vod).filter((c) => /sigame/i.test(c.game)).sort((x, y) => y.len - x.len);
	const [a, b] = ch.length ? [ch[0].from, ch[0].from + ch[0].len] : [0, media.length];
	const times = Array.from({ length: FRAMES }, (_, i) => a + 60 + ((b - a - 120) * i) / Math.max(1, FRAMES - 1));
	extra.push(`Запись: [${vod.id}](https://www.twitch.tv/videos/${vod.id}) ${vod.owner.login}, ${vod.createdAt}, ${Math.round(vod.lengthSeconds / 60)} мин, «${vod.title}». Окно кадров ${hm(a)}–${hm(b)}${ch.length ? ' (глава SIGame)' : ' (глав нет)'}.`);
	const range = variant.name === 'chunked' ? 786432 : 524288;
	for (const t of times) {
		const file = path.join(OUT, `${vod.id}_${Math.round(t)}.png`);
		const f = await step(`кадр ${hm(t)}`, () => frameAt(media, t, range, file));
		if (f) frames.push({ ...f, file });
	}
	note('кадры (Range + ffmpeg)', frames.length === times.length,
		`${frames.length}/${times.length}, ответ ${[...new Set(frames.map((f) => f.status))].join('/')}, в среднем ${(mean(frames.map((f) => f.bytes)) / 1e6).toFixed(2)} МБ за ${sec(mean(frames.map((f) => f.dlMs)))}, декодирование ${sec(mean(frames.map((f) => f.decMs)))}`);
}

// 5. OCR: модели из apt, по кадру в один поток; затем tessdata_fast; затем 4 процесса разом.
await step('tesseract', async () => {
	const { stdout, stderr } = await run('tesseract', ['--version']);
	const ver = (stdout + stderr).split('\n')[0];
	const langs = (await run('tesseract', ['--list-langs'])).stdout.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
	const dirs = ['/usr/share/tesseract-ocr/5/tessdata', '/usr/share/tesseract-ocr/4.00/tessdata'];
	const sizes = dirs.flatMap((d) => ['rus', 'eng'].map((l) => path.join(d, l + '.traineddata')))
		.filter((f) => fs.existsSync(f)).map((f) => `${path.basename(f)} ${(fs.statSync(f).size / 1e6).toFixed(1)} МБ`);
	note('tesseract', langs.includes('rus'), `${ver}; языки ${langs.join(',')}; ${sizes.join(', ') || 'размер моделей не нашёлся'}`);
});

const sets = [['apt', '']];
if (FAST && fs.existsSync(path.join(FAST, 'rus.traineddata'))) sets.push(['tessdata_fast', FAST]);

const ocrText = {};
for (const [name, dir] of sets) {
	if (!frames.length) break;
	await step(`OCR ${name}`, async () => {
		const res = [];
		for (const f of frames) res.push({ f, ...(await ocr(f.file, dir)) });
		const hs = res.flatMap((r) => headers(r.text));
		for (const r of res) (ocrText[path.basename(r.f.file)] ||= {})[name] = r.text;
		note(`OCR ${name}, один поток`, true, `${sec(mean(res.map((r) => r.ms)))} на кадр (от ${sec(Math.min(...res.map((r) => r.ms)))} до ${sec(Math.max(...res.map((r) => r.ms)))}); «Тема, цена» найдено ${hs.length}`);
		extra.push(`«Тема, цена» (${name}): ${hs.slice(0, 15).map((h) => '`' + h.replace(/`/g, '') + '`').join(', ') || '—'}`);
	});
}

if (frames.length) {
	await step('OCR 4 процесса', async () => {
		const t0 = Date.now();
		const queue = [...frames];
		const W = Math.min(4, os.cpus().length);
		await Promise.all(Array.from({ length: W }, async () => { for (let f; (f = queue.shift());) await ocr(f.file, ''); }));
		const wall = Date.now() - t0;
		note(`OCR apt, ${W} процесса разом`, true, `${frames.length} кадров за ${sec(wall)} — ${sec(wall / frames.length)} на кадр по часам`);
	});
}

for (const [file, byModel] of Object.entries(ocrText)) {
	for (const [model, text] of Object.entries(byModel)) fs.writeFileSync(path.join(OUT, `${file}.${model}.txt`), text);
}

// ---------- итог ----------

const md = [
	'## Проба Twitch на раннере',
	'',
	'| | Проверка | Подробности |',
	'|---|---|---|',
	...report.map((r) => `| ${r.ok === true ? '✅' : r.ok === false ? '❌' : 'ℹ️'} | ${r.what} | ${r.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`),
	'',
	...extra.map((s) => `- ${s}`),
	'',
].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
else console.log('\n' + md);
console.log(`тексты OCR и кадры: ${OUT}`);
