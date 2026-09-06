// Выпустить новый refresh-токен для Google Search Console и вписать его
// в ~/.claude.json. Работает с уже заведённым клиентом типа Desktop:
// таким клиентам Google разрешает возврат на http://localhost:<порт>,
// и регистрировать этот адрес где-либо заранее не нужно — потому Playground
// и не понадобился.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const CONFIG = path.join(os.homedir(), '.claude.json');
const SCOPE = 'https://www.googleapis.com/auth/webmasters';

const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const env = config.mcpServers?.['google-search-console']?.env;

if (!env?.GOOGLE_CLIENT_ID || !env?.GOOGLE_CLIENT_SECRET) {
	console.error('В ~/.claude.json нет client_id или secret для google-search-console.');
	process.exit(1);
}

const clientId = env.GOOGLE_CLIENT_ID;
const clientSecret = env.GOOGLE_CLIENT_SECRET;

// Ключ разговора: свяжет ответ Google с этим запуском, а не с чьим-то чужим,
// если на том же порту вдруг окажется кто-то ещё.
const state = crypto.randomBytes(16).toString('hex');

const server = http.createServer();

server.listen(0, '127.0.0.1', () => {
	const { port } = server.address();
	const redirect = `http://localhost:${port}`;

	const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirect,
		response_type: 'code',
		scope: SCOPE,
		// offline — иначе refresh-токена не будет вовсе, приедет только часовой
		// access_token; consent — иначе Google при повторном согласии молча
		// пришлёт ответ без refresh-токена, решив, что он у нас уже есть
		access_type: 'offline',
		prompt: 'consent',
		state,
	});

	console.log('\nОткрываю браузер. Если не открылся — вот ссылка:\n');
	console.log(url + '\n');
	console.log('Приложение непроверенное, поэтому Google покажет предупреждение:');
	console.log('  «Google hasn\'t verified this app» → Advanced → Go to FirePacks (unsafe)\n');
	console.log('Жду ответа…\n');

	// Через explorer.exe, а не «cmd /c start»: в адресе полно «&», и cmd
	// разобрал бы их как разделители команд, оборвав ссылку на первом же.
	spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' })
		.on('error', () => {})
		.unref();
});

server.on('request', async (request, response) => {
	const query = new URL(request.url, 'http://localhost').searchParams;

	const done = text => {
		response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
		response.end(`<meta charset="utf-8"><body style="font:16px system-ui;padding:3rem">${text}</body>`);
	};

	if (query.get('error')) {
		done('Отказано в доступе. Можно закрыть вкладку.');
		console.error('Google ответил отказом:', query.get('error'));
		server.close();
		process.exit(1);
	}

	const code = query.get('code');

	if (!code) {
		response.writeHead(404).end();
		return;
	}

	if (query.get('state') !== state) {
		done('Ответ пришёл не от этого запуска. Можно закрыть вкладку.');
		console.error('Не совпал state — ответ отброшен.');
		server.close();
		process.exit(1);
	}

	const { port } = server.address();

	const reply = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			code,
			client_id: clientId,
			client_secret: clientSecret,
			redirect_uri: `http://localhost:${port}`,
			grant_type: 'authorization_code',
		}),
	});

	const token = await reply.json();

	if (!token.refresh_token) {
		done('Refresh-токен не пришёл. Смотри в терминал.');
		console.error('\nОтвет Google без refresh_token:\n', token);
		console.error('\nЧаще всего это значит, что доступ уже выдавался. Отозвать:');
		console.error('https://myaccount.google.com/permissions — и запустить снова.');
		server.close();
		process.exit(1);
	}

	// Пишем рядом запасную копию прежде, чем трогать сам конфиг: файл этот
	// держит настройки всех проектов, а не только Search Console.
	fs.copyFileSync(CONFIG, CONFIG + '.bak');

	const fresh = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
	fresh.mcpServers['google-search-console'].env.GOOGLE_REFRESH_TOKEN = token.refresh_token;
	fs.writeFileSync(CONFIG, JSON.stringify(fresh, null, 2), 'utf8');

	done('Готово. Токен записан — можно закрыть вкладку и вернуться в Claude Code.');

	console.log('Токен получен и вписан в ~/.claude.json');
	console.log('Запасная копия прежнего конфига: ~/.claude.json.bak');
	console.log('\nТеперь перезапусти сессию Claude Code, чтобы MCP поднялся заново.');

	server.close();
	process.exit(0);
});
