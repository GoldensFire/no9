// Записи «Своей игры» на YouTube через Gemini Video API:
// найти свежие ролики, посмотреть короткими срезами через Gemini,
// сверить темы с библиотекой и положить вердикты в D1 (pack_streams).
//
//   node scripts/youtube.js                             ежедневный проход
//   node scripts/youtube.js --discover --dry            только показать кандидатов
//   node scripts/youtube.js --videos=wfTsmf8n46k --dry  проверить ролики без D1
//
// Остальные ключи — в src/youtube/run.js; план — youtube-gemini-plan.md.

import { run } from '../src/youtube/run.js';

run().catch(error => {
	console.error(error);
	process.exit(1);
});
