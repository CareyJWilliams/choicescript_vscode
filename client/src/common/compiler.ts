import { RelativePattern, Uri, workspace } from 'vscode';

export type AllScenesResult = { [key: string]: { labels: { [key: string]: number }, lines: string[] }; }
export type CompiledChoiceScriptGame = {
	title: string,
	scenes: AllScenesResult
}

export const labelRegex = /^\s*\*label\s+(\w+)/;
export const titleRegex = /^\s*\*title\s+([\w\s]+)/;

export async function compileToAllScenes(projectPath: Uri): Promise<CompiledChoiceScriptGame>{
	const allScenes: AllScenesResult = {};
	// Ideally
	const scenes = await workspace.findFiles(new RelativePattern(projectPath, '*.txt'));
	let title: string;

	for (const s of scenes) {
		const sceneName = s.fsPath.substring(s.fsPath.lastIndexOf('/') + 1, (s.fsPath.length - ".txt".length));
		allScenes[sceneName] = { labels: {}, lines: [] };
		const content = new TextDecoder().decode((await workspace.fs.readFile(s)));
		allScenes[sceneName].lines = content.split('\n');
		for (let l = 0; l < allScenes[sceneName].lines.length; l++) {
			if (sceneName === 'startup' && !title) {
				const match = allScenes[sceneName].lines[l].match(titleRegex);
				if (match) {
					title = match[1];
				}
			}
			const labelMatch = allScenes[sceneName].lines[l].match(labelRegex);
			if (labelMatch) {
				allScenes[sceneName].labels[labelMatch[1].toLowerCase()] = l;
			}
		}
	}
	return {
		title: title,
		scenes: allScenes
	};
}