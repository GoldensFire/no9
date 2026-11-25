// Записи «Своей игры» на YouTube:
// найти ролики, посмотреть через Gemini Video API (в облаке) или локально на ПК
// через yt-dlp + ffmpeg + tesseract (--local / --hybrid), сверить темы с библиотекой
// и положить вердикты в D1 (pack_streams).
//
//   node scripts/youtube.js                             ежедневный проход (Gemini)
//   node scripts/youtube.js --local --backfill          локальный прогон на ПК (0 квоты Gemini)
//   node scripts/youtube.js --hybrid --backfill         локальный OCR + Gemini только на 18+
//   node scripts/youtube.js --discover --dry            только показать кандидатов
//   node scripts/youtube.js --videos=wfTsmf8n46k --dry  проверить ролики без D1
//
// Остальные ключи — в src/youtube/run.js; план — youtube-gemini-plan.md.

import { run } from '../src/youtube/run.js';

run().catch(error => {
	console.error(error);
	process.exit(1);
});
