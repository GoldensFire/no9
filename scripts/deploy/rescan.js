// Заявки на точечный перескан паков, оставленные админом на сайте
// (таблица pack_rescans в D1, см. cf/src/library/rescan.js).
//
// Обход забирает ожидающие заявки до обычных шагов, прогоняет их выбранной
// моделью Gemini и отмечает выполненными (или с ошибкой), чтобы не гонять
// повторно на следующем запуске.

import { askRows } from './d1.js';

const str = v => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

/**
 * Забрать из D1 все заявки со статусом pending.
 * Если ключей Cloudflare нет или таблицы ещё нет — вернуть пустой список,
 * не мешая обычному обходу.
 *
 * @returns {Promise<Array<{packId: number, model: string}>>}
 */
export async function pullPendingRescans() {
	try {
		const rows = await askRows(
			"SELECT pack_id, model FROM pack_rescans WHERE status = 'pending' ORDER BY requested_at ASC",
		);

		return rows
			.map(row => ({ packId: Number(row.pack_id), model: String(row.model ?? '').trim() }))
			.filter(item => Number.isFinite(item.packId) && item.packId > 0 && item.model);
	} catch {
		return [];
	}
}

/**
 * Отметить заявки завершёнными (done) или сорвавшимися (error).
 *
 * @param {number[]} packIds
 * @param {{ status?: 'done'|'error', error?: string|null }} result
 */
export async function markRescans(packIds, { status = 'done', error = null } = {}) {
	if (!packIds.length) {
		return;
	}

	const now = Date.now();
	const ids = packIds.map(id => Math.trunc(Number(id))).filter(id => Number.isFinite(id) && id > 0);

	if (!ids.length) {
		return;
	}

	try {
		await askRows(`UPDATE pack_rescans
			SET status = ${str(status)}, done_at = ${now}, error = ${str(error ? String(error).slice(0, 300) : null)}
			WHERE pack_id IN (${ids.join(', ')})`);
	} catch {
		// Не срываем обход и выкладку из-за отметки статуса
	}
}
