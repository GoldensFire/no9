// Итог обхода стримов: таблица в $GITHUB_STEP_SUMMARY (или в консоль)
// и, по желанию, подробности файлом JSON — для подгонки порогов.

import fs from 'node:fs';

const hm = t => `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}`;
const day = ms => new Date(ms).toISOString().slice(5, 10).split('-').reverse().join('.');
const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const vodUrl = (v, t = 0) => `https://www.twitch.tv/videos/${v.id}${t ? `?t=${Math.floor(t / 3600)}h${Math.floor(t / 60) % 60}m${Math.floor(t % 60)}s` : ''}`;
const vodLink = v => `[${v.id}](${vodUrl(v)})`;
const playLink = (v, p) => `[${hm(p.from)}–${hm(p.to)}](${vodUrl(v, p.from)})`;

export function windowsText(windows) {
	return windows.map(([a, b]) => `${hm(a)}–${hm(b)}`).join(', ');
}

export function markdown({ alive, discovery, results, index, took }) {
	const out = ['## Стримы Twitch', ''];
	if (alive) out.push(alive.error ? `- ❌ живость не проверилась: ${cell(alive.error)}` : `Живость: в полосе было ${alive.checked} записей, умерло ${alive.dead}.`, '');
	if (index) out.push(`Словарь: ${index.packs.size} паков, ${index.themes.length} тем, из них опознающих ${index.themes.filter(t => t.distinctive).length} (${index.ms} мс).`, '');
	if (discovery) {
		const { stats, skipped, todo } = discovery;
		out.push(`Поиск: категория ${stats.category} записей, SullyGnome ${stats.sully} каналов, всего каналов ${stats.channels} → ${stats.videos} записей.`
			+ ` К просмотру ${todo.length}; пропущено: уже смотрели ${skipped.seen}, не SIGame ${skipped.notSigame}, старше горизонта ${skipped.old},`
			+ ` пишется ${skipped.recording}, для подписчиков ${skipped.subonly}, удалены ${skipped.gone}, не дались ${skipped.failed}.`, '');
		for (const e of stats.errors) out.push(`- ❌ ${cell(e)}`);
		if (stats.errors.length) out.push('');
	}
	if (results.length) {
		const found = results.filter(r => r.res.packs?.length);
		const frames = results.reduce((a, r) => a + (r.res.frames || 0), 0);
		out.push(`Просмотрено ${results.length} записей, ${frames} кадров, с паками ${found.length}${took ? `, ${Math.round(took / 60000)} мин` : ''}.`, '');
		out.push('| Запись | Канал | Дата | Длина | Как | Окна | Кадров | Итог |', '|---|---|---|---|---|---|---|---|');
		for (const { video: v, res: r, source } of results) {
			let verdict;
			if (r.status !== 'done') verdict = `${r.status}${r.error ? `: ${r.error}` : ''}${r.reason ? `: ${r.reason}` : ''}`;
			else {
				verdict = r.packs.map(p => `✅ ${playLink(v, p)} «${p.pack.name}» #${p.pack.id}, ${p.themes} тем${p.name ? `, название на ${hm(p.name.at)}` : ''}${p.rival ? ` (рядом «${p.rival.pack.name}» #${p.rival.pack.id}, ${p.rival.themes})` : ''}`).join('<br>');
				const near = r.near.filter(n => n.themes >= 1).slice(0, 2).map(n => `«${n.pack.name}» #${n.pack.id} ×${n.themes}: ${n.names.slice(0, 3).join('; ')}`);
				if (near.length) verdict += `${verdict ? '<br>' : ''}<sub>не дотянули: ${near.join(' · ')}</sub>`;
				const inside = (r.inside || []).map(p => `«${p.pack.name}» #${p.pack.id} ×${p.themes} внутри «${p.host.pack.name}»`);
				if (inside.length) verdict += `${verdict ? '<br>' : ''}<sub>отброшены: ${inside.join(' · ')}</sub>`;
				const named = (r.names || []).map(n => `«${n.pack.name}» #${n.pack.id} на ${hm(n.at)} («${n.seen}»)`);
				if (named.length) verdict += `${verdict ? '<br>' : ''}<sub>название без тем: ${named.join(' · ')}</sub>`;
				if (!verdict) verdict = '—';
				if (r.errors) verdict += `<br><sub>ошибок кадров ${r.errors}: ${r.lastError}</sub>`;
			}
			out.push(`| ${vodLink(v)} | ${cell(v.channel)} | ${day(v.createdAt)} | ${hm(v.length)} | ${r.mode || '—'}${source ? ` · ${source}` : ''} | ${r.windows ? windowsText(r.windows) : '—'} | ${r.frames ?? 0}${r.signs != null ? ` (игра на ${r.signs})` : ''} | ${cell(verdict)} |`);
		}
		out.push('');
	}
	return out.join('\n');
}

export function writeSummary(md) {
	if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
	console.log('\n' + md);
}

/** Подробности по записи для файла JSON: темы с временем и видами. */
export function details({ video, res, source }) {
	return {
		id: video.id, channel: video.channel, title: video.title, createdAt: video.createdAt, length: video.length, source,
		status: res.status, error: res.error, mode: res.mode, windows: res.windows, frames: res.frames, signs: res.signs,
		packs: (res.packs || []).map(p => ({ id: p.pack.id, name: p.pack.name, themes: p.themes, allThemes: p.allThemes, from: p.from, to: p.to, names: p.names, name: p.name, rival: p.rival && { id: p.rival.pack.id, name: p.rival.pack.name, themes: p.rival.themes } })),
		inside: (res.inside || []).map(p => ({ id: p.pack.id, name: p.pack.name, themes: p.themes, from: p.from, to: p.to, names: p.names, host: p.host.pack.id })),
		namesSeen: (res.names || []).map(n => ({ id: n.pack.id, name: n.pack.name, at: n.at, seen: n.seen })),
		near: (res.near || []).map(n => ({ id: n.pack.id, name: n.pack.name, themes: n.themes, names: n.names })),
		hits: [...(res.hits?.values() || [])].filter(h => h.th.distinctive || h.frames >= 2).sort((a, b) => a.first - b.first).map(h => ({
			name: h.th.name, distinctive: h.th.distinctive, packs: h.th.packs.length, first: h.first, last: h.last, frames: h.frames, d: h.d, kinds: h.kinds, seen: h.seen,
		})),
	};
}
