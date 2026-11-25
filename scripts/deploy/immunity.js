// Иммунитет от плагиата для паков хозяина сайта: забрать из D1 состояние
// переключателя и список его подтверждённых страниц ВК и подписей.
//
// Переключатель живёт в настройках профиля в D1 (user_settings.plagiarism_immunity,
// см. cf/src/library/preferences.js), а плагиат считается дома и в GitHub Actions
// по отпечаткам вопросов (src/indexer/plagiarism.js). Устроено так же, как
// scripts/deploy/hidden.js: перед пересмотром привозим свежее состояние в файл
// в .wrangler/, а если D1 недоступен — опираемся на последнюю привезённую копию.
//
// Файл отслеживается в git и ездит в Actions: ничего из cf/src/ сюда тащить
// нельзя (см. .gitignore).

import fs from 'node:fs';
import path from 'node:path';
import { root } from './options.js';
import { askRows } from './d1.js';

/** Где лежит последняя привезённая копия состояния иммунитета. */
export const IMMUNITY_FILE = path.join(root, '.wrangler', 'plagiarism-immunity.json');

const EMPTY = { enabled: false, vkIds: [], authorKeys: [] };

const listOf = value => String(value ?? '')
	.split(',')
	.map(part => part.trim().toLowerCase())
	.filter(Boolean);

const sqlStr = value => `'${String(value).replace(/'/g, "''")}'`;

/**
 * Кто хозяин сайта — из wrangler.jsonc (та же пара ADMIN_DISCORD / ADMIN_VK,
 * которую читает isAdmin в cf/src/library/moderation.js).
 */
function readAdminConfig() {
	try {
		const raw = fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8');
		const discord = /^\s*"ADMIN_DISCORD"\s*:\s*"([^"]*)"/m.exec(raw)?.[1] ?? '';
		const vk = /^\s*"ADMIN_VK"\s*:\s*"([^"]*)"/m.exec(raw)?.[1] ?? '';

		return { discord: listOf(discord), vk: listOf(vk) };
	} catch {
		return { discord: [], vk: [] };
	}
}

/** Последняя привезённая копия состояния иммунитета. Нет файла — выключено. */
export function readPlagiarismImmunity() {
	try {
		const parsed = JSON.parse(fs.readFileSync(IMMUNITY_FILE, 'utf8'));

		return {
			enabled: parsed?.enabled === true,
			vkIds: Array.isArray(parsed?.vkIds) ? parsed.vkIds.map(String).filter(Boolean) : [],
			authorKeys: Array.isArray(parsed?.authorKeys) ? parsed.authorKeys.map(String).filter(Boolean) : [],
		};
	} catch {
		return { ...EMPTY };
	}
}

function saveImmunity(state) {
	fs.mkdirSync(path.dirname(IMMUNITY_FILE), { recursive: true });
	fs.writeFileSync(IMMUNITY_FILE, JSON.stringify(state), 'utf8');
}

/**
 * Привезти из D1 состояние иммунитета и опознанные страницы ВК / подписи
 * хозяина сайта. Не вышло дотянуться до D1 — берётся прежняя копия.
 *
 * @returns {Promise<{enabled: boolean, vkIds: string[], authorKeys: string[]}>}
 */
export async function pullPlagiarismImmunity() {
	const { discord, vk } = readAdminConfig();

	if (discord.length === 0 && vk.length === 0) {
		return { ...EMPTY };
	}

	const conditions = [];

	if (discord.length > 0) {
		const inList = discord.map(sqlStr).join(', ');
		conditions.push(`(u.discord_id IS NOT NULL AND (LOWER(u.discord_id) IN (${inList}) OR LOWER(u.username) IN (${inList})))`);
	}

	if (vk.length > 0) {
		const inList = vk.map(sqlStr).join(', ');
		conditions.push(`(u.vk_id IS NOT NULL AND LOWER(u.vk_id) IN (${inList}))`);
	}

	const where = conditions.join(' OR ');

	let admins;

	try {
		admins = await askRows(`
			SELECT u.id, u.vk_id, COALESCE(us.plagiarism_immunity, 1) AS immunity
			FROM users u
			LEFT JOIN user_settings us ON us.user_id = u.id
			WHERE ${where}
		`);
	} catch (error) {
		// Колонка могла ещё не доехать на боевую базу до ближайшей выкладки:
		// по умолчанию иммунитет включён, поэтому спрашиваем хозяев без неё
		if (/no such column/i.test(error?.message ?? '')) {
			try {
				admins = await askRows(`SELECT u.id, u.vk_id, 1 AS immunity FROM users u WHERE ${where}`);
			} catch (fallbackError) {
				console.log(`Иммунитет от плагиата наверху прочитать не вышло (${fallbackError.message}). Беру прежнее состояние.`);
				return readPlagiarismImmunity();
			}
		} else {
			console.log(`Иммунитет от плагиата наверху прочитать не вышло (${error.message}). Беру прежнее состояние.`);
			return readPlagiarismImmunity();
		}
	}

	const immuneAdmins = admins.filter(row => Number(row.immunity) === 1);
	const disabledVk = new Set(
		admins
			.filter(row => Number(row.immunity) !== 1 && row.vk_id)
			.map(row => String(row.vk_id).trim().toLowerCase()),
	);

	const vkIds = new Set();
	const authorKeys = new Set();

	for (const id of vk) {
		if (!disabledVk.has(id) && (immuneAdmins.length > 0 || admins.length === 0)) {
			vkIds.add(id);
		}
	}

	if (immuneAdmins.length > 0) {
		const adminIds = immuneAdmins
			.map(row => Math.trunc(Number(row.id)))
			.filter(id => Number.isFinite(id) && id > 0);

		for (const row of immuneAdmins) {
			if (row.vk_id) {
				vkIds.add(String(row.vk_id).trim());
			}
		}

		if (adminIds.length > 0) {
			const idList = adminIds.join(', ');

			try {
				const vkRows = await askRows(`SELECT DISTINCT vk_id FROM user_vk WHERE user_id IN (${idList})`);

				for (const row of vkRows) {
					if (row.vk_id) {
						vkIds.add(String(row.vk_id).trim());
					}
				}

				const badgeRows = await askRows(`SELECT DISTINCT author_key FROM author_badges WHERE user_id IN (${idList})`);

				for (const row of badgeRows) {
					if (row.author_key) {
						authorKeys.add(String(row.author_key).trim());
					}
				}
			} catch (error) {
				console.log(`Привязанные страницы хозяина прочитать не вышло (${error.message}). Беру прежнее состояние.`);
				return readPlagiarismImmunity();
			}
		}
	}

	const state = {
		enabled: vkIds.size > 0 || authorKeys.size > 0,
		vkIds: [...vkIds],
		authorKeys: [...authorKeys],
	};

	saveImmunity(state);
	return state;
}
