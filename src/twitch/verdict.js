// Какие паки играли на записи и с какой минуты — по темам, найденным
// на её кадрах (src/twitch/match.js).
//
// Правила — twitch-streams.md, 5.2:
//   - в счёт идут только опознающие темы (index.js): общие «Аниме», «Фильмы»
//     ничего не решают;
//   - пак засчитывается при ≥ 3 опознающих темах. Шум со всей библиотеки
//     даёт по одной теме на пак (3.5 плана), настоящий пак — пять и больше;
//   - паки берутся жадно: самый сильный, его темы вычёркиваются, следующий.
//     Так копия, перезалив и плагиат не получают чужих тем, а второй пак
//     той же записи — получает свои;
//   - при равенстве побеждает тот, что раньше (меньший номер — донор);
//   - редкое название пака на экране начала игры (5.3) снижает порог
//     до двух опознающих тем, и таймкод тогда — время этого экрана.
//     Не до одной: серии делят рубрики, а название соседней части
//     встречалось на экране (список паков в конце стрима).

/** Сколько опознающих тем нужно паку. */
export const MIN_THEMES = 3;

/** Сколько опознающих тем нужно паку, чьё название видели на экране. */
export const NAME_MIN_THEMES = 2;

/** Таймкод — на две минуты раньше первой найденной темы: шаг выборки. */
const LEAD_S = 120;

/**
 * Темы записи из кадров.
 *
 * @param {Array<{t:number, matches:Array}>} frames
 * @returns {Map<number, {th, first, last, frames, kinds, d, seen}>}
 */
export function collectHits(frames) {
	const hits = new Map();
	for (const f of frames) {
		for (const m of f.matches || []) {
			let h = hits.get(m.th.id);
			if (!h) hits.set(m.th.id, h = { th: m.th, first: f.t, last: f.t, frames: 0, kinds: {}, d: m.d, seen: m.seen });
			h.first = Math.min(h.first, f.t);
			h.last = Math.max(h.last, f.t);
			h.frames++;
			h.kinds[m.kind] = (h.kinds[m.kind] || 0) + 1;
			if (m.d < h.d) { h.d = m.d; h.seen = m.seen; }
		}
	}
	return hits;
}

/**
 * Названия паков, увиденные на кадрах: ключ пака → когда впервые и как.
 *
 * @returns {Map<string, {first: number, frames: number, seen: string, d: number}>}
 */
export function collectNames(frames) {
	const out = new Map();
	for (const f of frames) {
		for (const n of f.names || []) {
			for (const key of n.name.packs) {
				const e = out.get(key);
				if (!e) out.set(key, { first: f.t, frames: 1, seen: n.seen, d: n.d });
				else { e.first = Math.min(e.first, f.t); e.frames++; }
			}
		}
	}
	return out;
}

/**
 * @param {Map} hits темы записи (collectHits)
 * @param {Map} [names] названия паков на кадрах (collectNames)
 * @returns {{packs: Array, near: Array}} packs — засчитанные; near — лучшие
 *   из незасчитанных (1–2 темы), чтобы глазами подогнать порог
 */
export function judge(hits, index, names = new Map(), min = MIN_THEMES) {
	const byPack = new Map(); // ключ → Set(id темы)
	for (const h of hits.values()) {
		if (!h.th.distinctive) continue;
		for (const key of h.th.packs) {
			let s = byPack.get(key);
			if (!s) byPack.set(key, s = new Set());
			s.add(h.th.id);
		}
	}

	const order = (a, b) => b[1].size - a[1].size || index.packs.get(a[0]).id - index.packs.get(b[0]).id;
	const packs = [];
	const taken = new Set();
	for (;;) {
		const ranked = [...byPack.entries()]
			.map(([key, s]) => [key, new Set([...s].filter(id => !taken.has(id)))])
			.filter(([, s]) => s.size)
			.sort(order);
		const need = key => (names.has(key) ? NAME_MIN_THEMES : min);
		const pick = ranked.find(([key, s]) => s.size >= need(key));
		if (!pick) break;
		const [key, ids] = pick;
		const own = [...ids].map(id => hits.get(id));
		// Общие темы того же пака в счёт не шли, но в итог попадают: их видно
		// на записи, и таймкод от них точнее
		const all = [...hits.values()].filter(h => h.th.packs.includes(key));
		const first = Math.min(...own.map(h => h.first));
		const last = Math.max(...own.map(h => h.last));
		// Экран с названием — начало игры, если он перед темами этого пака,
		// а не через полдня после них (повтор того же пака вечером)
		const name = names.get(key);
		const nameAt = name && name.first <= last && name.first >= first - 3600 ? name.first : null;
		// Тот, кто делит с победителем его темы и отстал не больше чем на одну, —
		// повод посмотреть глазами: перезалив, серия, плагиат
		const rival = ranked.filter(r => r !== pick).find(([, s]) => s.size >= ids.size - 1 && [...s].filter(id => ids.has(id)).length >= s.size / 2);
		packs.push({
			key,
			pack: index.packs.get(key),
			themes: own.length,
			allThemes: all.length,
			from: nameAt != null ? Math.min(nameAt, Math.max(0, first - LEAD_S)) : Math.max(0, first - LEAD_S),
			name: name ? { at: name.first, frames: name.frames, seen: name.seen, d: name.d } : null,
			to: last,
			names: own.sort((a, b) => a.first - b.first).map(h => h.th.name),
			rival: rival ? { key: rival[0], pack: index.packs.get(rival[0]), themes: rival[1].size } : null,
		});
		for (const id of ids) taken.add(id);
	}

	const near = [...byPack.entries()]
		.map(([key, s]) => [key, [...s].filter(id => !taken.has(id))])
		.filter(([, s]) => s.length)
		.sort((a, b) => b[1].length - a[1].length)
		.slice(0, 3)
		.map(([key, s]) => ({ key, pack: index.packs.get(key), themes: s.length, names: s.map(id => hits.get(id).th.name) }));

	// Названия, которые видели, а пак так и не засчитан, — для итога
	const taken2 = new Set(packs.map(p => p.key));
	const shown = [...names].filter(([key]) => !taken2.has(key)).slice(0, 3)
		.map(([key, n]) => ({ key, pack: index.packs.get(key), at: n.first, seen: n.seen }));

	return { packs, near, names: shown };
}
