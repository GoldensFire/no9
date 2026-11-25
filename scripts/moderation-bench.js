// Эталон для модерации 18+ (nsfw-moderation.md, этап 1): набор картинок,
// размеченный руками, и замер на нём — какая модель, какой пачкой и на каком
// разрешении сколько пропускает. Гоняется заново при каждой смене рубрики
// или моделей; сам набор и разметка при этом остаются.
//
//   node scripts/moderation-bench.js collect   собрать набор из паков
//   node scripts/moderation-bench.js label     страница разметки, http://localhost:3018
//                                              (--disputes — только спорные)
//   node scripts/moderation-bench.js measure   спросить модели (--models= --sizes= --res=)
//   node scripts/moderation-bench.js second    второй взгляд по одной картинке (--models=)
//   node scripts/moderation-bench.js score     свести ответы с разметкой
//
// Дома ffmpeg называется переменной FFMPEG — полный путь к ffmpeg.exe.
// Всё собранное лежит в data/moderation/bench и в гит не едет.

const [command, ...rest] = process.argv.slice(2);

const flags = Object.fromEntries(rest
	.filter(arg => arg.startsWith('--'))
	.map(arg => {
		const [name, value = '1'] = arg.slice(2).split('=');
		return [name, value];
	}));

const list = (value, fallback) => (value ? value.split(',').map(item => item.trim()).filter(Boolean) : fallback);

switch (command) {
	case 'collect': {
		const { collect } = await import('../src/moderation/bench/collect.js');
		await collect({ limitPacks: Number(flags.packs) || 600 });
		break;
	}

	case 'label': {
		const { serveLabels } = await import('../src/moderation/bench/label.js');
		serveLabels(Number(flags.port) || 3018, { disputes: Boolean(flags.disputes) });
		break;
	}

	case 'measure': {
		const { measure } = await import('../src/moderation/bench/measure.js');
		await measure({
			models: list(flags.models, ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']),
			sizes: list(flags.sizes, ['32', '16', '64', '8']).map(Number),
			resolutions: list(flags.res, ['low', 'default']),
			budget: Number(flags.budget) || 440,
		});
		break;
	}

	case 'second': {
		const { second } = await import('../src/moderation/bench/second.js');
		await second({
			models: list(flags.models, ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']),
			budget: Number(flags.budget) || 200,
		});
		break;
	}

	case 'score': {
		const { score } = await import('../src/moderation/bench/score.js');
		score();
		break;
	}

	default:
		console.log('Команды: collect, label, measure, second, score — см. шапку scripts/moderation-bench.js');
		process.exitCode = 1;
}
