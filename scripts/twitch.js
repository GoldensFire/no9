// Стримы Twitch под паками: найти свежие записи с SIGame, снять кадры,
// распознать и узнать по темам, какой пак играли.
//
//   node scripts/twitch.js                 обычный ежедневный проход
//   node scripts/twitch.js --discover      только показать, что смотреть
//   node scripts/twitch.js --vods=1,2 --dry   эти записи, без D1
//
// Остальные ключи и всё устройство — src/twitch/run.js; замысел —
// twitch-streams.md (дома, в гит не идёт).

import { run } from '../src/twitch/run.js';

run().catch(error => {
	console.error(error);
	process.exit(1);
});
