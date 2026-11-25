// Листинг и метаданные Мастерской Steam (PublishedFile.QueryFiles#1 и HTTP Details).
//
// Только для дома и GitHub Actions: в cf/src/** не используется.

import {
	decodeMessage,
	encodeMessage,
	fieldString,
	fieldVarint,
	getAll,
	getBigInt,
	getBool,
	getString,
	getUint,
} from './proto.js';

export const WORKSHOP_QUERY = {
	RankedByPublicationDate: 1,
	RankedByTotalUniqueSubscriptions: 9,
	RankedByLastUpdatedDate: 21,
};

function decodeFileDetails(buf) {
	const f = decodeMessage(buf);
	const tags = getAll(f, 52)
		.map(item => getString(decodeMessage(item.value), 1))
		.filter(Boolean);

	return {
		result: getUint(f, 1, 0),
		steamId: getBigInt(f, 2, 0n).toString(),
		creatorId: getBigInt(f, 3, 0n).toString(),
		filename: getString(f, 7),
		fileSize: Number(getBigInt(f, 8, 0n)),
		fileUrl: getString(f, 10),
		previewUrl: getString(f, 11),
		hcontent: getBigInt(f, 14, 0n).toString(),
		title: getString(f, 16),
		createdAt: getUint(f, 19, 0) * 1000,
		updatedAt: getUint(f, 20, 0) * 1000,
		visibility: getUint(f, 21, 0),
		banned: getBool(f, 28, false),
		subscriptions: getUint(f, 36, 0),
		lifetimeSubscriptions: getUint(f, 39, 0),
		views: getUint(f, 42, 0),
		revision: Number(getBigInt(f, 67, 0n)),
		tags,
	};
}

/**
 * Листает элементы Мастерской через Steam3 CM (`PublishedFile.QueryFiles#1`).
 * Работает и после анонимного входа, и после входа по Refresh Token.
 */
export async function queryWorkshopFiles(cm, {
	appId = 3553500,
	queryType = WORKSHOP_QUERY.RankedByTotalUniqueSubscriptions,
	numPerPage = 20,
	cursor = '*',
} = {}) {
	const req = encodeMessage([
		fieldVarint(1, queryType),
		fieldVarint(3, numPerPage),
		fieldVarint(5, appId),
		fieldVarint(18, true), // return_tags
		fieldVarint(32, true), // return_metadata
		fieldVarint(37, true), // return_details
		fieldString(39, cursor),
	]);

	const res = await cm.callService('PublishedFile.QueryFiles#1', req);
	const fields = decodeMessage(res);

	return {
		total: getUint(fields, 1, 0),
		nextCursor: getString(fields, 3),
		items: getAll(fields, 2).map(item => decodeFileDetails(item.value)),
	};
}

/**
 * Получает актуальные метаданные конкретных элементов Мастерской по ID.
 * Безключавой HTTP POST (до 100 ID за один запрос).
 */
export async function getPublishedFileDetails(ids) {
	const list = ids.map(id => String(id).trim()).filter(Boolean);

	if (list.length === 0) {
		return [];
	}

	const params = new URLSearchParams();
	params.set('itemcount', String(list.length));
	list.forEach((id, i) => params.set(`publishedfileids[${i}]`, id));

	const res = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: params,
		signal: AbortSignal.timeout(15000),
	});

	if (!res.ok) {
		throw new Error(`GetPublishedFileDetails ответил HTTP ${res.status}`);
	}

	const data = await res.json();
	const details = data?.response?.publishedfiledetails ?? [];

	return details.map(item => ({
		result: Number(item.result ?? 0),
		steamId: String(item.publishedfileid ?? ''),
		creatorId: String(item.creator ?? ''),
		filename: item.filename ?? '',
		fileSize: Number(item.file_size ?? 0),
		fileUrl: item.file_url ?? '',
		previewUrl: item.preview_url ?? '',
		hcontent: String(item.hcontent_file ?? ''),
		title: item.title ?? '',
		createdAt: Number(item.time_created ?? 0) * 1000,
		updatedAt: Number(item.time_updated ?? 0) * 1000,
		visibility: Number(item.visibility ?? 0),
		banned: Boolean(item.banned),
		subscriptions: Number(item.subscriptions ?? 0),
		lifetimeSubscriptions: Number(item.lifetime_subscriptions ?? 0),
		views: Number(item.views ?? 0),
		tags: Array.isArray(item.tags) ? item.tags.map(t => t.tag).filter(Boolean) : [],
	}));
}
