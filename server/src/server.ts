import {
	createConnection,
	WorkspaceFolder,
	TextDocuments,
	ProposedFeatures,
	InitializeParams,
	ReferenceParams,
	CompletionItem,
	TextDocumentPositionParams,
	Location,
	Definition,
	RenameParams,
	WorkspaceEdit,
	TextDocumentSyncKind,
	DocumentSymbolParams,
	SymbolInformation
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
const fsPromises = require('fs').promises;
import url = require('url');
import globby = require('globby');

import { updateProjectIndex } from './indexer';
import { ProjectIndex, Index } from "./index";
import { generateDiagnostics } from './validator';
import { uriIsStartupFile } from './language';
import { generateInitialCompletions } from './completions';
import { findDefinitions, findReferences, generateRenames } from './searches';
import { generateSymbols } from './structure';

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);
connection.console.info(`ChoiceScript language server running in node ${process.version}`);

// Create a simple text document manager. The text document manager
// supports full document sync only
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// TODO handle multiple directories with startup.txt
const projectIndex = new Index();

connection.onInitialize((params: InitializeParams) => {  // eslint-disable-line @typescript-eslint/no-unused-vars
	const syncKind: TextDocumentSyncKind = TextDocumentSyncKind.Full;
	return {
		capabilities: {
			textDocumentSync: {
				openClose: true,
				change: syncKind,
				willSaveWaitUntil: false,
				save: {
					includeText: false
				}
			},
			completionProvider: {
				resolveProvider: false,
				triggerCharacters: [ '*', '{' ]
			},
			definitionProvider: true,
			referencesProvider: true,
			renameProvider: true,
			documentSymbolProvider: true
		}
	};
});

connection.onInitialized(() => {
	// TODO this should be handled through server-to-client communications
	// using custom messages like "workspace/xfind" or the like
	// see https://stackoverflow.com/questions/51041337/vscode-language-client-extension-how-to-send-a-message-from-the-server-to-the/51081743#51081743
	// and https://stackoverflow.com/questions/51806347/visual-studio-language-extension-how-do-i-call-my-own-functions?noredirect=1&lq=1
	// for examples
	connection.workspace.getWorkspaceFolders().then(workspaces => {
		if (workspaces && workspaces.length > 0)
			findStartupFiles(workspaces);
	});
});

function findStartupFiles(workspaces: WorkspaceFolder[]): void {
	workspaces.forEach((workspace) => {
		const rootPath = url.fileURLToPath(workspace.uri);
		globby('**/startup.txt', {
			cwd: rootPath
		}).then(paths => indexProject(paths));
	});
}

function indexProject(pathsToProjectFiles: string[]): void {
	pathsToProjectFiles.map(async (path) => {
		// TODO handle multiple startup.txt files in multiple directories

		let projectPath = path;
		const startupFilename = path.split('/').pop();
		if (startupFilename) {
			projectPath = projectPath.replace(startupFilename, '');
		}

		console.info(`Indexing the CS project at ${path}`);

		// Index the startup.txt file
		await indexFile(path);

		// Try to index the stats page (which might not exist)
		indexFile(projectPath+"choicescript_stats.txt");

		// Try to index all of the scene files
		const scenePaths = projectIndex.getSceneList().map(name => projectPath+name+".txt");
		const promises = scenePaths.map(x => indexFile(x));

		await Promise.all(promises);

		// Revalidate all open text documents
		documents.all().forEach(doc => validateTextDocument(doc, projectIndex));
	});
}

async function indexFile(path: string): Promise<void> {
	const fileUri = url.pathToFileURL(path).toString();

	try {
		const data = await fsPromises.readFile(path, 'utf8');
		const textDocument = TextDocument.create(fileUri, 'ChoiceScript', 0, data);
		updateProjectIndex(textDocument, uriIsStartupFile(fileUri), projectIndex);
	}
	catch (err) {
		connection.console.error(`Could not read file ${path} (${err.name}: ${err.message} ${err.filename} ${err.lineNumber})`);
		return;
	}
}

connection.onDidChangeConfiguration(change => {  // eslint-disable-line @typescript-eslint/no-unused-vars
	// Revalidate all open text documents
	documents.all().forEach(doc => validateTextDocument(doc, projectIndex));
});

// TODO deal with files being deleted, so that they're removed from the above

documents.onDidOpen(e => {
	updateProjectIndex(e.document, uriIsStartupFile(e.document.uri), projectIndex);
});

// A document has been opened or its content has been changed.
documents.onDidChangeContent(change => {
	const isStartupFile = uriIsStartupFile(change.document.uri);

	updateProjectIndex(change.document, isStartupFile, projectIndex);

	if (isStartupFile) {
		// Since the startup file defines global variables, if it changes, re-validate all other files
		documents.all().forEach(doc => validateTextDocument(doc, projectIndex));
	}
	else {
		validateTextDocument(change.document, projectIndex);
	}
});

function validateTextDocument(textDocument: TextDocument, projectIndex: ProjectIndex): void {
	const diagnostics = generateDiagnostics(textDocument, projectIndex);
	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onCompletion(
	(textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
		const document = documents.get(textDocumentPosition.textDocument.uri);
		if (document === undefined) {
			return [];
		}
		return generateInitialCompletions(document, textDocumentPosition.position, projectIndex);
	}
);

connection.onDefinition(
	(textDocumentPosition: TextDocumentPositionParams): Definition | undefined => {
		const document = documents.get(textDocumentPosition.textDocument.uri);
		if (document !== undefined) {
			const definitionAndLocations = findDefinitions(document, textDocumentPosition.position, projectIndex);
			if (definitionAndLocations !== undefined) {
				return definitionAndLocations[0].location;
			}
		}
		return undefined;
	}
);

connection.onReferences(
	(referencesParams: ReferenceParams): Location[] | undefined => {
		const document = documents.get(referencesParams.textDocument.uri);
		if (document === undefined) {
			return undefined;
		}
		const references = findReferences(document, referencesParams.position, referencesParams.context, projectIndex);
		return references?.map(reference => { return reference.location; });
	}
);

connection.onRenameRequest(
	(renameParams: RenameParams): WorkspaceEdit | null => {
		const document = documents.get(renameParams.textDocument.uri);
		if (document === undefined) {
			return null;
		}
		return generateRenames(document, renameParams.position, renameParams.newName, projectIndex);
	}
);

connection.onDocumentSymbol(
	(documentSymbolParams: DocumentSymbolParams): SymbolInformation[] | null => {
		const document = documents.get(documentSymbolParams.textDocument.uri);
		if (document === undefined) {
			return null;
		}
		return generateSymbols(document, projectIndex);
	}
);

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
