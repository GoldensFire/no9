// Итог обхода YouTube: сводка в $GITHUB_STEP_SUMMARY (или в консоль)
// и подробности по каждому ролику в JSON.

import fs from 'node:fs';

const hm = t => `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}`;
const day = ms => (ms ? new Date(ms).toISOString().slice(0, 10) : '—');
const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const ytUrl = (v, t = 0) => `https://youtu.be/${v.id}${t > 0 ? `?t=${Math.floor(t)}` : ''}`;
const ytLink = v => `[${v.id}](${ytUrl(v)})`;
const playLink = (v, p) => `[${hm(p.from)}–${hm(p.to)}](${ytUrl(v, p.from)})`;

export function markdown({ alive, bridge, discovery, results, index, took, stoppedReason }) {
	const out = ['## Записи YouTube (Gemini Video API)', ''];

	if (alive) {
		out.push(alive.error
			? `- ❌ живость YouTube не проверилась: ${cell(alive.error)}`
			: `Живость YouTube: проверено ${alive.checked} записей, удалено ${alive.dead}.`, '');
	}
	if (bridge) {
		const note = bridge.integrityBlocked ? ' *(socialMedias закрыты Twitch Integrity с этого IP — использованы панели/описания)*' : '';
		out.push(bridge.error
			? `- ⚠️ мост Twitch → YouTube: ${cell(bridge.error)}`
			: `Мост Twitch → YouTube: проверено ${bridge.checked} Twitch-каналов, найдено ${bridge.added} новых YouTube-каналов.${note}`, '');
	}
	if (index) {
		out.push(`Словарь: ${index.packs.size} паков, ${index.themes.length} тем (${index.ms} мс).`, '');
	}
	if (discovery) {
		const { stats, skipped, todo } = discovery;
		out.push(`Поиск (${stats.mode}): ${stats.searchQueries} запросов (${stats.searchCalls} вызовов, ${stats.searchRaw} сырых),`
			+ ` ${stats.channelsChecked} каналов (${stats.channelRaw} видео) → метаданные ${stats.videosFetched}.`
			+ ` К просмотру ${todo.length}; пропущено: уже смотрели ${skipped.seen}, не дались ${skipped.failed},`
			+ ` старые ${skipped.old}, <15 мин ${skipped.short}, live ${skipped.live}, шум ${skipped.noise}, недоступны ${skipped.missing}.`, '');
		for (const e of stats.errors) out.push(`- ❌ ${cell(e)}`);
		if (stats.errors.length) out.push('');
	}
	if (stoppedReason) {
		out.push(`> ⚠️ Запуск остановлен мягко: ${cell(stoppedReason)}`, '');
	}
	if (results.length) {
		const found = results.filter(r => r.res.packs?.length);
		const calls = results.reduce((a, r) => a + (r.res.calls || 0), 0);
		const tokens = results.reduce((a, r) => a + (r.res.tokensIn || 0), 0);
		out.push(`Просмотрено ${results.length} видео, ${calls} вызовов Gemini, ${tokens.toLocaleString('ru-RU')} входных токенов, с паками ${found.length}${took ? `, ${Math.max(1, Math.round(took / 60000))} мин` : ''}.`, '');
		out.push('| Видео | Канал | Дата | Длина | Вызовы / токены | Итог |', '|---|---|---|---|---|---|');
		for (const { video: v, res: r, source } of results) {
			let verdict;
			if (r.status !== 'done') {
				verdict = `${r.status}${r.error ? `: ${r.error}` : ''}`;
			} else {
				verdict = r.packs.map(p => `✅ ${playLink(v, p)} «${p.pack.name}» #${p.pack.id}, ${p.themes} тем${p.name ? `, название на ${hm(p.name.at)}` : ''}`).join('<br>');
				const near = (r.near || []).filter(n => n.themes >= 1).slice(0, 2).map(n => `«${n.pack.name}» #${n.pack.id} ×${n.themes}: ${n.names.slice(0, 3).join('; ')}`);
				if (near.length) verdict += `${verdict ? '<br>' : ''}<sub>не дотянули: ${near.join(' · ')}</sub>`;
				if (!verdict) verdict = r.signs > 0 ? 'SIGame, пака нет в базе' : '—';
				if (r.errors) verdict += `<br><sub>ошибок батчей ${r.errors}: ${r.lastError}</sub>`;
			}
			const flags = [v.ageRestricted ? '18+' : '', v.embeddable === false ? 'no-embed' : '', source || ''].filter(Boolean).join(' · ');
			const titleLine = `${ytLink(v)} ${cell((v.title || '').slice(0, 55))}${flags ? `<br><sub>${cell(flags)}</sub>` : ''}`;
			out.push(`| ${titleLine} | ${cell(v.channelTitle || v.channelId)} | ${day(v.publishedAt)} | ${hm(v.length)} | ${r.calls ?? 0} / ${r.tokensIn ?? 0} (SIGame: ${r.signs ?? 0}) | ${cell(verdict)} |`);
		}
		out.push('');
	}
	return out.join('\n');
}

export function writeSummary(md) {
	if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
	console.log('\n' + md);
}

export function details({ video, res, source }) {
	return {
		id: video.id,
		channelId: video.channelId,
		channelTitle: video.channelTitle,
		title: video.title,
		publishedAt: video.publishedAt,
		length: video.length,
		views: video.views,
		embeddable: video.embeddable,
		ageRestricted: video.ageRestricted,
		source,
		status: res.status,
		error: res.error,
		calls: res.calls,
		tokensIn: res.tokensIn,
		signs: res.signs,
		planKey: res.planKey,
		packs: (res.packs || []).map(p => ({
			id: p.pack.id,
			name: p.pack.name,
			themes: p.themes,
			allThemes: p.allThemes,
			from: p.from,
			to: p.to,
			names: p.names,
			marks: p.marks || '',
		})),
		near: (res.near || []).map(n => ({ id: n.pack.id, name: n.pack.name, themes: n.themes, names: n.names })),
	};
}
