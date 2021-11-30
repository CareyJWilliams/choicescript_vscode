import * as crypto from 'crypto';
import * as fs from 'fs';
import * as getPort from 'get-port';
import * as Koa from 'koa';
import * as bodyParser from 'koa-bodyparser';
import * as path from 'path';
import { env, Uri, window } from 'vscode';



interface GameInfo {
	csRootPath: string
	sceneRootPath?: string
	csErrorCallback: (scene: string, line: number, message: string) => void | undefined;
}


const app = new Koa();
const _gameStore: Map<string, GameInfo> = new Map();
let _listenPort = 52330;
let _gameInfo: GameInfo;


async function _updateListenPort() {
	_listenPort = await getPort({port: 52330});
}
_updateListenPort();


app.use(async function(ctx, next) {
	let handled = false;

	if (ctx.method == "GET") {
		const gameInfo = _gameStore.get(ctx.URL.searchParams.get("id"));
		if (gameInfo !== undefined) {
			_gameInfo = gameInfo;
		}
		if (_gameInfo !== undefined) {
			let filepath = path.resolve(_gameInfo.csRootPath, ctx.URL.pathname.replace(/^\//, ''));

			if (_gameInfo.sceneRootPath !== undefined) {
				const ext = path.extname(filepath);
				if ((ctx.URL.pathname.startsWith('/scenes/') && ext == '.txt') || ext == '.jpg' || ext == '.png' || ext == '.gif') {
					filepath = path.join(_gameInfo.sceneRootPath, path.basename(filepath));
				}
			}

			let fstat = await fs.promises.stat(filepath);
			if (fstat.isDirectory()) {
				filepath = path.join(filepath, 'index.html');
				fstat = await fs.promises.stat(filepath);
			}
			if (fstat.isFile()) {
				ctx.type = path.extname(filepath);
				ctx.body = fs.createReadStream(filepath);
				handled = true;
			}
		}
	}

	if (!handled) {
		return await next();
	}
});


app.use(bodyParser());

app.use(async function(ctx, next) {
	let handled = false;

	if (ctx.method == "POST" && ctx.URL.pathname == "/cs-error" && _gameInfo !== undefined && _gameInfo.csErrorCallback !== undefined) {
		const body = ctx.request.body;
		const scene = body['scene'];
		const line = parseInt(body['line']);
		const message = body['message'];
		_gameInfo.csErrorCallback(scene, line, message);
		handled = true;
	}

	if (!handled) {
		return await next();
	}
});


app.use(async function pageNotFound(ctx) {
	// we need to explicitly set 404 here
	// so that koa doesn't assign 200 on body=
	ctx.status = 404;
  
	switch (ctx.accepts('html', 'json')) {
		case 'html':
			ctx.type = 'html';
			ctx.body = '<p>Page Not Found</p>';
			break;
		case 'json':
			ctx.body = {
				message: 'Page Not Found'
			};
			break;
		default:
			ctx.type = 'text';
			ctx.body = 'Page Not Found';
	}
});


export function startServer(): void {
	app.listen(_listenPort);
}


export async function createGame(
	csRootPath: string,
	csErrorCallback?: (scene: string, line: number, message: string) => void | undefined
): Promise<string> {
	const gameId = crypto.randomBytes(16).toString('hex');
	_gameStore.set(gameId, {
		csRootPath: csRootPath,
		csErrorCallback: csErrorCallback
	});
	return gameId;
}


export function updateScenePath(gameId: string, scenePath: string): void {
	const gameInfo = _gameStore.get(gameId);
	if (gameInfo === undefined) {
		window.showErrorMessage(`Tried to update a non-existent game with ID ${gameId}`);
	}
	else {
		gameInfo.sceneRootPath = scenePath;
	}

}


export function openGameInBrowser(gameId: string): void {
	const gameInfo = _gameStore.get(gameId);
	if (gameInfo === undefined) {
		window.showErrorMessage(`Tried to open a non-existent game with ID ${gameId}`);
	}
	else {
		const url = `http://localhost:${_listenPort}?id=${gameId}`;
		env.openExternal(Uri.parse(url));
	}
}


export function closeGame(gameId: string): void {
	_gameStore.delete(gameId);
}
