import path = require('path');

export enum RandomtestPutResultsInDocumentOptions {
	Never = 'never',
	Always = 'always',
	Fulltext = 'fulltext'
}

export enum Configuration {
	BaseSection = 'choicescript',
	RandomtestIterations = 'randomtest.iterations',
	RandomtestSeed = 'randomtest.randomSeed',
	RandomtestPutResultsInDocument = 'randomtest.putResultsInDocument',
	RandomtestAvoidUsedOptions = 'randomtest.avoidUsedOptions',
	RandomtestShowChoices = 'randomtest.showChoices',
	RandomtestShowFullText = 'randomtest.showFullText',
	RandomtestShowLineCoverageStatistics = 'randomtest.showLineCoverageStatistics'
}

export enum CustomCommands {
	Bold = 'choicescript.bold',
	CancelTest = 'choicescript.cancelTest',
	GameOpened = 'choicescript.gameOpened',
	Italicize = 'choicescript.italicize',
	OpenGame = 'choicescript.openGame',
	ProjectLoaded = 'choicescript.projectLoaded',
	ReloadGame = 'choicescript.reloadGame',
	RunQuicktest = 'choicescript.runQuicktest',
	RunRandomtestDefault = 'choicescript.runRandomtestDefault',
	RunRandomtestInteractive = 'choicescript.runRandomtestInteractive',
	TestRunning = 'choicescript.testRunning'
}

export enum CustomMessages {
	SelectionWordCountRequest = 'choicescript/selectionwordcount',
	UpdatedProjectFiles = 'choicescript/projectfiles',
	UpdatedWordCount = 'choicescript/updatedwordcount',
	WordCountRequest = 'choicescript/wordcount',
}

// Paths relative to the extension
export const RelativePaths = {
	Choicescript: path.join('choicescript'),
	CSExtension: path.join('choicescript', 'cs-extension.js'),
	GameIndex: path.join('choicescript', 'cs-index.html'),
	Quicktest: path.join('choicescript', 'autotest.js'),
	Randomtest: path.join('choicescript', 'randomtest.js'),
	VSCodeExtensionServer: path.join('server', 'out', 'server.js')
}

export enum CSUrls {
	GameIndex = '/web/mygame/index.html'
}