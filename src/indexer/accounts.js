// Постоянные адреса отправителей ВК у паков, найденных старым HTML-обходом.
// Только Node: читает SQLite и сверяет сообщения через VK API.
//
// Короткое имя страницы меняется и может достаться другому человеку. Поэтому
// номер берётся не из нынешнего владельца имени и не из владельца документа
// (чужой файл можно приложить к своему сообщению), а из from_id самого поста.

import { db } from '../db.js';
import { callVk, hasVkApi, parseTopicUrl } from '../vkapi.js';
import { say } from './progress.js';

/** Путь страницы ВК, без различий между доменами, протоколами и хвостами. */
function accountPath(value) {
	try {
		const url = new URL(String(value ?? '').trim());

		if (!['http:', 'https:'].includes(url.protocol)
			|| !/^(?:(?:www|m)\.)?vk\.(?:com|ru)$/.test(url.hostname)) {
			return null;
		}

		return /^\/([a-z\d_.]+)\/?$/i.exec(url.pathname)?.[1].toLowerCase() ?? null;
	} catch {
		return null;
	}
}

/** Привести адреса к числовым: после первого прохода сети обычно не нужно. */
export async function normalizeVkAccounts() {
	const rows = db.prepare(`SELECT id, vk_author_url, vk_topic, vk_comment FROM packages
		WHERE TRIM(COALESCE(vk_author_url, '')) <> '' ORDER BY vk_comment, id`).all();
	const write = db.prepare('UPDATE packages SET vk_author_url = ? WHERE id = ? AND vk_author_url = ?');
	const topics = new Map();
	let changed = 0;
	let unresolved = 0;

	for (const row of rows) {
		const path = accountPath(row.vk_author_url);

		if (!path) {
			continue;
		}

		const numbered = /^(id|club|public)([1-9]\d*)$/.exec(path);

		if (numbered) {
			const url = `https://vk.com/${numbered[1] === 'id' ? 'id' : 'club'}${numbered[2]}`;

			if (url !== row.vk_author_url) {
				changed += write.run(url, row.id, row.vk_author_url).changes;
			}

			continue;
		}

		if (!Number.isSafeInteger(row.vk_comment) || row.vk_comment <= 0) {
			unresolved++;
			continue;
		}

		let topic;

		try {
			topic = parseTopicUrl(row.vk_topic ?? '');
		} catch {
			unresolved++;
			continue;
		}

		const key = `${topic.groupId}:${topic.topicId}`;
		const group = topics.get(key) ?? { ...topic, comments: new Map() };
		const packs = group.comments.get(row.vk_comment) ?? [];
		packs.push(row);
		group.comments.set(row.vk_comment, packs);
		topics.set(key, group);
	}

	const pending = [...topics.values()].reduce((n, topic) => n
		+ [...topic.comments.values()].reduce((count, packs) => count + packs.length, 0), 0);

	if (pending && !hasVkApi()) {
		say('vk', `у ${pending} паков короткие адреса отправителей; без ключа VK API номера не подтверждены`);
		unresolved += pending;
		topics.clear();
	}

	if (pending && topics.size > 0) {
		say('vk', `подтверждаю отправителей ${pending} паков по старым сообщениям`);
	}

	for (const topic of topics.values()) {
		const waiting = topic.comments;

		while (waiting.size > 0) {
			const anchor = waiting.keys().next().value;
			let response;

			try {
				response = await callVk('board.getComments', {
					group_id: topic.groupId, topic_id: topic.topicId,
					start_comment_id: anchor, count: 100, sort: 'asc',
				});
			} catch (error) {
				say('vk', `отправитель сообщения ${topic.topicId}/${anchor} не подтверждён: ${error.message}`);
			}

			for (const comment of response?.items ?? []) {
				const packs = waiting.get(comment.id);

				if (!packs || !Number.isSafeInteger(comment.from_id) || comment.from_id === 0) {
					continue;
				}

				const url = comment.from_id > 0
					? `https://vk.com/id${comment.from_id}`
					: `https://vk.com/club${Math.abs(comment.from_id)}`;

				for (const pack of packs) {
					changed += write.run(url, pack.id, pack.vk_author_url).changes;
				}

				waiting.delete(comment.id);
			}

			// Удалённый пост или отказ API оставляет прежний адрес. Из нынешнего
			// владельца короткого имени исторического автора не выдумываем.
			unresolved += waiting.get(anchor)?.length ?? 0;
			waiting.delete(anchor);
		}
	}

	if (changed || unresolved) {
		say('vk', `адреса отправителей приведены к номерам у ${changed} паков`
			+ (unresolved ? `; не подтверждены у ${unresolved}, оставлены прежними` : ''));
	}
}
