// SullyGnome: какие каналы играли в SIGame за последние дни.
//
// Неофициальный API их же таблиц, без ключа. Отвечает и дому, и раннеру
// GitHub, но медленно — 4–9 с на запрос (twitch-streams.md, 3.1 и 3.6).
// Нужен ради каналов, чьи записи в категорию SIGame не попали: категория
// записи — одна, а SIGame часто идёт второй-третьей игрой стрима.
//
// Стримы канала отсюда не читаются: где внутри записи шла SIGame, лучше
// знают главы Twitch, а они приходят вместе со списком записей канала.

import { HEADERS } from './twitch.js';

const GAME = 160315; // SIGame у SullyGnome
const RANGES = [3, 7, 14, 30, 90, 180, 365];

/**
 * Логины каналов, игравших SIGame за days дней (берётся ближайший
 * из периодов SullyGnome не меньше days).
 */
export async function sigameChannels(days) {
	const range = RANGES.find(r => r >= days) ?? 365;
	const out = [];
	for (let start = 0; start < 5000; start += 100) {
		const url = `https://sullygnome.com/api/tables/gametables/getgamechannels/${range}/${GAME}/%20/0/1/3/desc/${start}/100`;
		const r = await fetch(url, { headers: { ...HEADERS, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
		const text = await r.text();
		if (!r.ok) throw new Error(`SullyGnome HTTP ${r.status}: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
		let j;
		try { j = JSON.parse(text); } catch { throw new Error(`SullyGnome: не JSON — ${text.slice(0, 120).replace(/\s+/g, ' ')}`); }
		for (const row of j.data || []) if (row.url) out.push(String(row.url).toLowerCase());
		if (!j.data?.length || start + 100 >= (j.recordsTotal ?? 0)) break;
	}
	return [...new Set(out)];
}
