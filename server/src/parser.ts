import { Range, Location, Position, TextDocument, Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';

import { 
	validCommands, 
	multiStartPattern,
	replacementStartPattern,
	variableManipulationCommands,
	variableReferenceCommands,
	flowControlCommands,
	symbolCreationCommands,
	commandPattern,
	argumentRequiringCommands,
	startupCommands,
	uriIsStartupFile,
	extractTokenAtIndex,
	statChartCommands,
	statChartBlockCommands,
	numberSetOperators,
	stringSetOperators,
	numberFunctions,
	booleanFunctions
} from './language';
import {
	Expression,
	ExpressionTokenType,
	tokenizeMultireplace,
	ExpressionToken
} from './tokens';
import {
	findLineEnd,
	extractToMatchingDelimiter,
	createDiagnostic
} from './utilities';


let numberFunctionsLookup: ReadonlyMap<string, number> = new Map(numberFunctions.map(x => [x, 1]));
let booleanFunctionsLookup: ReadonlyMap<string, number> = new Map(booleanFunctions.map(x => [x, 1]));
let validCommandsLookup: ReadonlyMap<string, number> = new Map(validCommands.map(x => [x, 1]));
let argumentRequiringCommandsLookup: ReadonlyMap<string, number> = new Map(argumentRequiringCommands.map(x => [x, 1]));
let startupCommandsLookup: ReadonlyMap<string, number> = new Map(startupCommands.map(x => [x, 1]));
let symbolManipulationCommandsLookup: ReadonlyMap<string, number> = new Map(symbolCreationCommands.concat(variableManipulationCommands).map(x => [x, 1]));
let variableReferenceCommandsLookup: ReadonlyMap<string, number> = new Map(variableReferenceCommands.map(x => [x, 1]));
let flowControlCommandsLookup: ReadonlyMap<string, number> = new Map(flowControlCommands.map(x => [x, 1]));
let numberSetOperatorsLookup: ReadonlyMap<string, number> = new Map(numberSetOperators.map(x => [x, 1]));
let stringSetOperatorsLookup: ReadonlyMap<string, number> = new Map(stringSetOperators.map(x => [x, 1]));


export interface ParserCallbacks {
	/** Called for anything that looks like a *command, valid or not */
	onCommand(prefix: string, command: string, spacing: string, line: string, commandLocation: Location, state: ParsingState): void;
	onGlobalVariableCreate(symbol: string, location: Location, state: ParsingState): void;
	onLocalVariableCreate(symbol: string, location: Location, state: ParsingState): void;
	onLabelCreate(symbol: string, location: Location, state: ParsingState): void;
	onVariableReference(symbol: string, location: Location, state: ParsingState): void;
	onFlowControlEvent(command: string, commandLocation: Location, label: string, scene: string,
		labelLocation: Location | undefined, sceneLocation: Location | undefined, state: ParsingState): void;
	onSceneDefinition(scenes: string[], location: Location, state: ParsingState): void;
	onAchievementCreate(codename: string, location: Location, state: ParsingState): void;
	onAchievementReference(codename: string, location: Location, state: ParsingState): void;
	onParseError(error: Diagnostic): void;
}

/**
 * Captures information about the current state of parsing
 */
export class ParsingState {
	/**
	 * Document being validated
	 */
	textDocument: TextDocument;
	/**
	 * Callbacks for parsing events
	 */
	callbacks: ParserCallbacks;
	/**
	 * Command being parsed, or undefined if not parsing a command
	 */
	currentCommand: string | undefined;
	/**
	 * Stack of nested elements being parsed
	 */
	parseStack: ParseElement[];

	constructor(textDocument: TextDocument, callbacks: ParserCallbacks) {
		this.textDocument = textDocument;
		this.callbacks = callbacks;
		this.currentCommand = undefined;
		this.parseStack = [];
	}
}

/**
 * What element is being parsed.
 * 
 * Note that a variable replacement is treated as a VariableReference since they act the same.
 */
enum ParseElement {
	Command,
	VariableReference,
	Parentheses,
	Multireplacement
}

/**
 * Determine if an expression token is compatible with a number.
 * @param type Type of the expression token.
 */
function isNumberCompatible(token: ExpressionToken): boolean {
	let isNumberFunction = false;
	if (token.type == ExpressionTokenType.Function && numberFunctionsLookup.has(token.text)) {
		isNumberFunction = true;
	}
	else if (token.type == ExpressionTokenType.FunctionAndContents) {
		let functionName = token.text.split('(')[0];
		isNumberFunction = numberFunctionsLookup.has(functionName);
	}
	return (isNumberFunction ||
		token.type == ExpressionTokenType.Number ||
		token.type == ExpressionTokenType.VariableReference ||
		token.type == ExpressionTokenType.Variable ||
		token.type == ExpressionTokenType.Parentheses);
}

/**
 * Determine if an expression token is compatible with a boolean.
 * @param type Type of the expression token.
 */
function isBooleanCompatible(token: ExpressionToken): boolean {
	let isBooleanFunction = false;
	if (token.type == ExpressionTokenType.Function && booleanFunctionsLookup.has(token.text)) {
		isBooleanFunction = true;
	}
	else if (token.type == ExpressionTokenType.FunctionAndContents) {
		let functionName = token.text.split('(')[0];
		isBooleanFunction = booleanFunctionsLookup.has(functionName);
	}
	return (isBooleanFunction ||
		token.type == ExpressionTokenType.BooleanNamedValue ||
		token.type == ExpressionTokenType.VariableReference ||
		token.type == ExpressionTokenType.Variable ||
		token.type == ExpressionTokenType.Parentheses);
}

/**
 * Determine if an expression token is compatible with a string.
 * @param type Type of the expression token.
 */
function isStringCompatible(token: ExpressionToken): boolean {
	return (token.type == ExpressionTokenType.String ||
		token.type == ExpressionTokenType.VariableReference ||
		token.type == ExpressionTokenType.Variable ||
		token.type == ExpressionTokenType.Parentheses);
}

/**
 * Determine if an expression token is any kind of operator.
 * @param type Type of the expression token.
 */
function isAnyOperator(token: ExpressionToken): boolean {
	return (token.type == ExpressionTokenType.Operator ||
		token.type == ExpressionTokenType.BooleanNamedOperator ||
		token.type == ExpressionTokenType.NumericNamedOperator);
}

/**
 * Validate an expression that sets a variable value.
 * 
 * @param tokenizedExpression The expression that sets a variable's value.
 * @param globalIndex Global index to the start of the tokens.
 * @param state Parsing state.
 */
function validateValueSettingExpression(tokenizedExpression: Expression, globalIndex: number, state: ParsingState) {
	let tokens = tokenizedExpression.combinedTokens;
	if (tokens.length == 0) {
		return;  // No error -- that's handled elsewhere
	}

	let lastToken = tokens[tokens.length - 1];

	// Variable setting expressions can be:
	//   - a literal (number, bool, string, variable, variable reference)
	//   - math (2 + 3, or with the leading operand missing: + 3, %+10)
	//   - concatenate ("foo" & var)
	//   - parentheses
	switch (tokens[0].type) {
		case ExpressionTokenType.Operator:
			// ex: *set var +3
			// The only thing we allow is a single element after the operator
			if (tokens.length > 2) {
				let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
					globalIndex + tokens[2].index,
					globalIndex + lastToken.index + lastToken.text.length,
					"Too many elements - are you missing parentheses?");
				state.callbacks.onParseError(diagnostic);
			}
			else if (tokens.length == 1) {
				let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
					globalIndex + tokens[0].index + tokens[0].text.length,
					globalIndex + tokens[0].index + tokens[0].text.length,
					"Missing number after the operator");
				state.callbacks.onParseError(diagnostic);
			}
			else if (!isNumberCompatible(tokens[1])) {
				let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
					globalIndex + tokens[1].index,
					globalIndex + tokens[1].index + tokens[1].text.length,
					"Not a number, variable, or variable reference");
				state.callbacks.onParseError(diagnostic);
			}
			break;
		case ExpressionTokenType.Number:
		case ExpressionTokenType.BooleanNamedValue:
		case ExpressionTokenType.Variable:
		case ExpressionTokenType.VariableReference:
		case ExpressionTokenType.Parentheses:
		case ExpressionTokenType.String:
		case ExpressionTokenType.FunctionAndContents:
		case ExpressionTokenType.Function:  // For functions that miss their contents
			// We only allow the token by itself or math
			if (tokens.length == 1) {
				break;
			}
			if (tokens.length > 3) {
				let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
					globalIndex + tokens[3].index,
					globalIndex + lastToken.index + lastToken.text.length,
					"Too many elements - are you missing parentheses?");
				state.callbacks.onParseError(diagnostic);
			}
			if (!isAnyOperator(tokens[1])) {
				let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
					globalIndex + tokens[1].index,
					globalIndex + tokens[1].index + tokens[1].text.length,
					"Missing operator like + or -");
				state.callbacks.onParseError(diagnostic);
			}
			else if (tokens.length < 3) {
				let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
					globalIndex + tokens[1].index + tokens[1].text.length,
					globalIndex + tokens[1].index + tokens[1].text.length,
					"Missing number after the operator");
				state.callbacks.onParseError(diagnostic);
			}
			else if (tokens[0].type == ExpressionTokenType.Number) {
				if (!(numberSetOperatorsLookup.has(tokens[1].text))) {
					let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
						globalIndex + tokens[1].index,
						globalIndex + tokens[1].index + tokens[1].text.length,
						"Operator isn't allowed for numbers");
					state.callbacks.onParseError(diagnostic);
				}
				else if (!isNumberCompatible(tokens[2])) {
					let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
						globalIndex + tokens[2].index,
						globalIndex + tokens[2].index + tokens[2].text.length,
						"Must be a number, variable, function, or parentheses");
					state.callbacks.onParseError(diagnostic);
				}
			}
			else if (tokens[0].type == ExpressionTokenType.String) {
				if (!(stringSetOperatorsLookup.has(tokens[1].text))) {
					let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
						globalIndex + tokens[1].index,
						globalIndex + tokens[1].index + tokens[1].text.length,
						"Operator isn't allowed for strings");
					state.callbacks.onParseError(diagnostic);
				}
				else if (!isStringCompatible(tokens[2])) {
					let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
						globalIndex + tokens[2].index,
						globalIndex + tokens[2].index + tokens[2].text.length,
						"Must be a string, variable, function, or parentheses");
					state.callbacks.onParseError(diagnostic);
				}
			}
			break;
		case ExpressionTokenType.UnknownOperator:
			// Already handled elsewhere
			break;
		default:
			let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
				globalIndex + tokens[0].index,
				globalIndex + tokens[0].index + tokens[0].text.length,
				"Must be a string, variable, or parentheses");
			state.callbacks.onParseError(diagnostic);
			break;
	}
}

/**
 * Validate the contents of an expression.
 * 
 * This includes any parsing errors found while tokenizing the expression.
 * @param tokenizedExpression Tokens making up the expression to be validated.
 * @param globalIndex Global index to the start of the tokens.
 * @param state Parsing state.
 * @returns Tokens after validation.
 */
function validateExpression(tokenizedExpression: Expression, globalIndex: number, state: ParsingState) {
	let currentElement = state.parseStack[state.parseStack.length-1];

	// Expressions should be a singleton value or two values plus an operator
	// TODO HERE I AM SEE WHAT KIND OF EXPRESSIONS DO AND DON'T WORK IN CS
	for (let error of tokenizedExpression.parseErrors) {
		state.callbacks.onParseError(error);
	}
}

/**
 * Parse a tokenized expression.
 * @param tokenizedExpression Tokenized expression.
 * @param globalIndex Expression's index in the document being indexed.
 * @param state Parsing state.
 */
function parseTokenizedExpression(tokenizedExpression: Expression, globalIndex: number, state: ParsingState) {
	for (let token of tokenizedExpression.tokens) {
		let tokenGlobalIndex = globalIndex + token.index;
		switch (token.type) {
			case ExpressionTokenType.VariableReference:
				parseReference(token.text, 0, tokenGlobalIndex, 1, state);
				break;
			case ExpressionTokenType.String:
				parseString(token.text, tokenGlobalIndex, 1, state);
				break;
			case ExpressionTokenType.Parentheses:
				parseParentheses(token.text, tokenGlobalIndex, 1, state);
				break;
			case ExpressionTokenType.Variable:
				let location = Location.create(state.textDocument.uri, Range.create(
					state.textDocument.positionAt(tokenGlobalIndex),
					state.textDocument.positionAt(tokenGlobalIndex + token.text.length)
				));
				state.callbacks.onVariableReference(token.text, location, state);
				break;
			case ExpressionTokenType.UnknownOperator:
				let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
					tokenGlobalIndex,
					tokenGlobalIndex + token.text.length,
					"Unknown operator");
				state.callbacks.onParseError(diagnostic);
				break;
		}
	}

	validateExpression(tokenizedExpression, globalIndex, state);
}


/**
 * Parse an expression.
 * @param expression String containing the expression (and only the expression).
 * @param globalIndex Expression's index in the document being indexed.
 * @param state Parsing state.
 * @returns Tokenized expression.
 */
function parseExpression(expression: string, globalIndex: number, state: ParsingState): Expression {
	let tokenizedExpression = new Expression(expression, globalIndex, state.textDocument);
	parseTokenizedExpression(tokenizedExpression, globalIndex, state);
	return tokenizedExpression;
}

/**
 * Parse a variable reference {var}.
 * 
 * Variable references can either be parsed from the large global document or from a subsection of it.
 * 
 * openDelimeterLength is needed in case this is called to parse a replacement.
 * 
 * @param section Section being parsed.
 * @param openDelimiterLength Length of the opening delimiter.
 * @param globalIndex Reference content's index in the global document.
 * @param localIndex The content's index in the section. If undefined, globalIndex is used.
 * @param state Parsing state.
 * @returns The local index to the end of the variable reference.
 */
function parseReference(section: string, openDelimiterLength: number, globalIndex: number,
	localIndex: number | undefined, state: ParsingState): number {
	state.parseStack.push(ParseElement.VariableReference);

	let sectionToDocumentDelta: number;
	if (localIndex === undefined) {
		localIndex = globalIndex;
		sectionToDocumentDelta = 0;
	}
	else {
		sectionToDocumentDelta = globalIndex;
	}
	let newLocalIndex = localIndex;

	let reference = extractToMatchingDelimiter(section, '{', '}', localIndex);
	if (reference === undefined) {
		let lineEndIndex = findLineEnd(section, localIndex);
		if (lineEndIndex === undefined)
			lineEndIndex = section.length;
		let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
			localIndex - openDelimiterLength + sectionToDocumentDelta,
			lineEndIndex + sectionToDocumentDelta,
			"Replacement is missing its }");
		state.callbacks.onParseError(diagnostic);
	}
	else if (reference.trim() == "") {
		let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
			localIndex - openDelimiterLength + sectionToDocumentDelta,
			localIndex + reference.length + 1 + sectionToDocumentDelta,
			"Replacement is empty");
		state.callbacks.onParseError(diagnostic);
	}
	else {
		// References contain expressions, so let the expression parser handle that
		parseExpression(reference, localIndex + sectionToDocumentDelta, state);
		newLocalIndex = localIndex + reference.length + 1;
	}

	state.parseStack.pop();
	return newLocalIndex;
}

/**
 * Parse a bare string.
 * 
 * A bare string is a part of the document that we treat as if it were a string, even though
 * it isn't surrounded by quotes. Parsing continues to the end of the string.
 * 
 * @param section Section being parsed.
 * @param startGlobalIndex String content's starting index relative to the global document.
 * @param startLocalIndex String content's starting index relative to the section.
 * @param endLocalIndex String content's ending index relative to the section.
 * @param state Parsing state.
 */
function parseBareString(
	section: string, startGlobalIndex: number, startLocalIndex: number, endLocalIndex: number, state: ParsingState) {
	let subsection = section.slice(startLocalIndex, endLocalIndex);

	// Deal with any replacements or multireplacements
	let delimiterPattern = RegExp(`${replacementStartPattern}|${multiStartPattern}`, 'g');
	delimiterPattern.lastIndex = startLocalIndex;
	let m: RegExpExecArray | null;
	while (m = delimiterPattern.exec(subsection)) {
		if (m.groups === undefined)
			break;

		let contentsLocalIndex = m.index + m[0].length;
		let newLocalIndex: number;

		if (m.groups.replacement !== undefined) {
			newLocalIndex = parseReplacement(
				section, m.groups.replacement.length, startGlobalIndex, contentsLocalIndex, state);
		}
		else if (m.groups.multi !== undefined) {
			newLocalIndex = parseMultireplacement(
				section, m.groups.multi.length, startGlobalIndex, contentsLocalIndex, state);
		}
		else {
			newLocalIndex = contentsLocalIndex;  // b/c contentsIndex points beyond the end of the string
		}

		delimiterPattern.lastIndex = newLocalIndex;
	}
}

/**
 * Parse a string in an expression as delimited by quote marks.
 * 
 * Strings can either be parsed from the large global document or from a subsection of it.
 * 
 * @param section Section being parsed.
 * @param globalIndex String content's index in the global document.
 * @param localIndex The content's index in the section. If undefined, globalIndex is used.
 * @param state Parsing state.
 * @returns Local index to the end of the string.
 */
function parseString(section: string, globalIndex: number, localIndex: number, state: ParsingState): number {
	if (localIndex === undefined) {
		localIndex = globalIndex;
	}

	// Find the end of the string while dealing with any replacements or multireplacements we run into along the way
	let delimiterPattern = RegExp(`${replacementStartPattern}|${multiStartPattern}|(?<!\\\\)\\"`, 'g');
	delimiterPattern.lastIndex = localIndex;
	let m: RegExpExecArray | null;
	while (m = delimiterPattern.exec(section)) {
		if (m.groups === undefined)
			break;

		let contentsLocalIndex = m.index + m[0].length;
		let newLocalIndex: number;

		if (m.groups.replacement !== undefined) {
			newLocalIndex = parseReplacement(
				section, m.groups.replacement.length, globalIndex, contentsLocalIndex, state);
		}
		else if (m.groups.multi !== undefined) {
			newLocalIndex = parseMultireplacement(
				section, m.groups.multi.length, globalIndex, contentsLocalIndex, state);
		}
		else {
			newLocalIndex = contentsLocalIndex;  // b/c contentsIndex points beyond the end of the string
		}

		delimiterPattern.lastIndex = newLocalIndex;
		localIndex = newLocalIndex;
	}

	return localIndex;
}

/**
 * Parse a parenthesized expression (expr).
 * 
 * Parentheses can either be parsed from the large global document or from a subsection of it.
 * 
 * @param section Section being parsed.
 * @param globalIndex Parenthesized content's index in the global document.
 * @param localIndex The content's index in the section. If undefined, globalIndex is used.
 * @param state Parsing state.
 * @returns Local index to the end of the expression.
 */
function parseParentheses(section: string, globalIndex: number,
	localIndex: number | undefined, state: ParsingState): number {
	state.parseStack.push(ParseElement.Parentheses);

	let sectionToDocumentDelta: number;
	if (localIndex === undefined) {
		localIndex = globalIndex;
		sectionToDocumentDelta = 0;
	}
	else {
		sectionToDocumentDelta = globalIndex;
	}

	let reference = extractToMatchingDelimiter(section, '(', ')', localIndex);
	if (reference === undefined) {
		let lineEndIndex = findLineEnd(section, localIndex);
		if (lineEndIndex === undefined)
			lineEndIndex = section.length;
		let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
			localIndex - 1 + sectionToDocumentDelta,
			lineEndIndex + sectionToDocumentDelta,
			"Missing close parentheses");
		state.callbacks.onParseError(diagnostic);
	}
	else {
		// Parentheses contain expressions, so let the expression indexer handle that
		parseExpression(reference, localIndex + sectionToDocumentDelta, state);
		localIndex += reference.length + 1;
	}

	state.parseStack.pop();
	return localIndex;
}

/**
 * Parse a replacement ${var}.
 * 
 * Replacements can either be parsed from the large global document or from a subsection of it.
 * 
 * @param section Section being parsed.
 * @param openDelimiterLength Length of the opening delimiter (${ or $!{ or $!!{).
 * @param globalIndex Replacement content's index in the global document.
 * @param localIndex The content's index in the section. If undefined, globalIndex is used.
 * @param state Parsing state.
 * @returns The local index to the end of the replacement.
 */
function parseReplacement(section: string, openDelimiterLength: number, globalIndex: number, 
	localIndex: number | undefined, state: ParsingState): number {
	// Internally, a replacement acts like a reference, so we can forward to it
	return parseReference(section, openDelimiterLength, globalIndex, localIndex, state);
}

/**
 * Parse a multireplacement @{var true | false}.
 * 
 * Multireplacements can either be parsed from the large global document or from a subsection of it.
 * 
 * @param section Section being parsed.
 * @param openDelimiterLength Length of the opening delimiter (@{ or @!{ or @!!{).
 * @param globalIndex Multireplacement content's index in the global document.
 * @param localIndex The content's index in the section. If undefined, globalIndex is used.
 * @param state Parsing state.
 * @returns The local index to the end of the multireplacement.
 */
function parseMultireplacement(section: string, openDelimiterLength: number, globalIndex: number, 
	localIndex: number | undefined, state: ParsingState): number {
	state.parseStack.push(ParseElement.Multireplacement);

	let sectionToDocumentDelta: number;
	if (localIndex === undefined) {
		localIndex = globalIndex;
		sectionToDocumentDelta = 0;
	}
	else {
		sectionToDocumentDelta = globalIndex;
	}

	let tokens = tokenizeMultireplace(section, localIndex);

	if (tokens === undefined) {
		let lineEndIndex = findLineEnd(section, localIndex);
		if (lineEndIndex === undefined)
			lineEndIndex = section.length;
		let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
			localIndex - openDelimiterLength + sectionToDocumentDelta, lineEndIndex + sectionToDocumentDelta,
			"Multireplace is missing its }");
		state.callbacks.onParseError(diagnostic);
	}
	else {
		// Flag any nested multireplacements
		let multiPattern = RegExp(multiStartPattern);
		let m = tokens.text.match(multiPattern);
		if (m !== null && m.index !== undefined) {
			let startLocalIndex = localIndex + m.index;
			let endLocalIndex: number;
			let contents = extractToMatchingDelimiter(section, '{', '}', startLocalIndex + m[0].length);
			if (contents !== undefined) {
				// Starting index + opening delimiter length + contents length + closing delimiter length
				endLocalIndex = startLocalIndex + m[0].length + contents.length + 1;
			}
			else {
				endLocalIndex = startLocalIndex + tokens.text.length;
			}
			let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
				startLocalIndex + sectionToDocumentDelta,
				endLocalIndex + sectionToDocumentDelta,
				"Multireplaces cannot be nested");
			state.callbacks.onParseError(diagnostic);
		}

		if (tokens.test.text.trim() == "") {
			let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
				localIndex - openDelimiterLength + sectionToDocumentDelta,
				tokens.endIndex + sectionToDocumentDelta,
				"Multireplace is empty");
			state.callbacks.onParseError(diagnostic);
		}
		else if (tokens.body.length == 0 || (tokens.body.length == 1 && tokens.body[0].text.trim() == "")) {
			let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
				tokens.test.index + tokens.test.text.length + sectionToDocumentDelta,
				tokens.endIndex + sectionToDocumentDelta,
				"Multireplace has no options");
			state.callbacks.onParseError(diagnostic);
		}
		else if (tokens.body.length == 1) {
			let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
				tokens.body[0].index + tokens.body[0].text.length + sectionToDocumentDelta,
				tokens.endIndex + sectionToDocumentDelta,
				"Multireplace must have at least two options separated by |");
			state.callbacks.onParseError(diagnostic);
		}
		else {
			// The test portion is an expression
			parseExpression(tokens.test.text, tokens.test.index + sectionToDocumentDelta, state);

			// Treat the body portions as strings without surrounding quote marks
			for (let token of tokens.body) {
				// Since we can't nest multireplaces, and we've already flagged them above as errors,
				// get rid of any opening multireplaces in the string
				let text = token.text.replace('@{', '  ');
				parseBareString(text, token.index + sectionToDocumentDelta, 0, token.text.length, state);
			}
			localIndex = tokens.endIndex;
		}
	}

	state.parseStack.pop();
	return localIndex;
}

/**
 * Parse parameters created by *params
 * @param line Line after *params that contains the parameters.
 * @param lineGlobalIndex Location of the line in the text.
 * @param state Indexing state.
 */
function parseParams(line: string, lineGlobalIndex: number, state: ParsingState) {
	// Split into words
	let wordsPattern = /\w+/g;
	let m: RegExpExecArray | null;
	while (m = wordsPattern.exec(line)) {
		if (m === null)
			continue;

		let location = Location.create(state.textDocument.uri, Range.create(
			state.textDocument.positionAt(lineGlobalIndex + m.index),
			state.textDocument.positionAt(lineGlobalIndex + m.index + m[0].length)
		));
		state.callbacks.onLocalVariableCreate(m[0], location, state);
	}
}

/**
 * 
 * @param line Line after *set that contains the variable and the value to set it to.
 * @param lineGlobalIndex Location of the line in the text.
 * @param state Indexing state.
 */
function parseSet(line: string, lineGlobalIndex: number, state: ParsingState) {
	let tokenizedExpression = new Expression(line, lineGlobalIndex, state.textDocument);
	let tokens = tokenizedExpression.tokens;

	if (tokens.length == 0) {
		let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
			lineGlobalIndex, lineGlobalIndex,
			"Missing variable name");
		state.callbacks.onParseError(diagnostic);
		return;
	}
	// The first token must be a variable or a variable reference
	if (tokens[0].type != ExpressionTokenType.Variable && tokens[0].type != ExpressionTokenType.VariableReference) {
		let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
			lineGlobalIndex + tokens[0].index,
			lineGlobalIndex + tokens[0].index + tokens[0].text.length,
			"Not a variable or variable reference");
		state.callbacks.onParseError(diagnostic);
	}
	else {
		parseTokenizedExpression(tokenizedExpression.slice(0, 1), lineGlobalIndex, state);
	}

	// Now parse the remaining elements as an expression and then validate them as part of a *set command
	let remainingExpression = tokenizedExpression.slice(1);
	if (remainingExpression.tokens.length == 0) {
		let index = lineGlobalIndex + tokens[0].index + tokens[0].text.length;
		let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
			index, index,
			"Missing value to set the variable to");
		state.callbacks.onParseError(diagnostic);
	}
	else {
		parseTokenizedExpression(remainingExpression, remainingExpression.globalIndex, state);
		validateValueSettingExpression(remainingExpression, remainingExpression.globalIndex, state);
	}
}

/**
 * Parse a symbol creating or manipulating command
 * @param command Command that defines or references a symbol.
 * @param line Remainder of the line after the command. Guaranteed to have content.
 * @param lineGlobalIndex Location of the line in the text.
 * @param state Indexing state.
 */
function parseSymbolManipulationCommand(command: string, line: string, lineGlobalIndex: number, state: ParsingState) {

	// The *params command is odd in that it takes an entire expression, and *set has two
	// different expressions to handle, so parse them separately
	if (command == "params") {
		parseParams(line, lineGlobalIndex, state);
	}
	else if (command == "set") {
		parseSet(line, lineGlobalIndex, state);
	}
	else {
		let linePattern = /(?<symbol>\w+)((?<spacing>\s+?)(?<expression>.+))?/g;
		linePattern.lastIndex = 0;
		let lineMatch = linePattern.exec(line);
		if (lineMatch === null || lineMatch.groups === undefined) {
			return;
		}
		let symbol: string = lineMatch.groups.symbol;
		let symbolLocation = Location.create(state.textDocument.uri, Range.create(
			state.textDocument.positionAt(lineGlobalIndex),
			state.textDocument.positionAt(lineGlobalIndex + symbol.length)
		));
		let expression: string | undefined = lineMatch.groups.expression;
		let expressionGlobalIndex = lineGlobalIndex + symbol.length;
		if (lineMatch.groups.spacing) {
			expressionGlobalIndex += lineMatch.groups.spacing.length;
		}
		switch (command) {
			case "create":
				// *create instantiates global variables
				state.callbacks.onGlobalVariableCreate(symbol, symbolLocation, state);
				if (expression === undefined) {
					let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
						lineGlobalIndex + symbol.length, lineGlobalIndex + symbol.length,
						"Missing value to set the variable to");
					state.callbacks.onParseError(diagnostic);
				}
				else {
					let tokenizedExpression = parseExpression(expression, expressionGlobalIndex, state);
					validateValueSettingExpression(tokenizedExpression, expressionGlobalIndex, state);
				}
				break;
			case "temp":
				// *temp instantiates variables local to the scene file
				state.callbacks.onLocalVariableCreate(symbol, symbolLocation, state);
				if (expression !== undefined) {
					let tokenizedExpression = parseExpression(expression, expressionGlobalIndex, state);
					validateValueSettingExpression(tokenizedExpression, expressionGlobalIndex, state);
				}
				break;
			case "label":
				// *label creates a goto/gosub label local to the scene file
				state.callbacks.onLabelCreate(symbol, symbolLocation, state);
				break;
			case "delete":
			case "rand":
			case "input_text":
			case "input_number":
				// these reference a variable
				state.callbacks.onVariableReference(symbol, symbolLocation, state);
				break;
			default:
				throw Error(`Unexpected command ${command} in parseSymbolManipulatingCommand`);
		}
	}
}

/**
 * Parse the scenes defined by a *scene_list command.
 * @param document Document text to scan.
 * @param startIndex Index at the start of the scenes.
 * @param state Parsing state.
 */
function parseScenes(document: string, startIndex: number, state: ParsingState) {
	let sceneList: Array<string> = [];
	let scenePattern = /(\s+)(\$\s+)?(\S+)\s*\r?\n/;
	let lineStart = startIndex;

	// Process the first line to get the indent level and first scene
	let lineEnd = findLineEnd(document, lineStart);
	if (!lineEnd) {
		return sceneList;  // No scene found
	}
	let line = document.slice(lineStart, lineEnd);
	let m = scenePattern.exec(line);
	if (!m) {
		return sceneList;
	}
	let padding = m[1];
	sceneList.push(m[3]);
	lineStart = lineEnd;

	// Now loop as long as the scene pattern matches and the padding is consistent
	while (true) {
		lineEnd = findLineEnd(document, lineStart);
		if (!lineEnd) {
			break;
		}
		line = document.slice(lineStart, lineEnd);
		m = scenePattern.exec(line);
		if (!m || m[1] != padding) {
			break;
		}
		sceneList.push(m[3]);
		lineStart = lineEnd;
	}
	
	let startPosition = state.textDocument.positionAt(startIndex);
	let endPosition = Position.create(
		startPosition.line + sceneList.length, 0
	);
	let range = Range.create(
		startPosition, endPosition
	);
	let location = Location.create(state.textDocument.uri, range);
	state.callbacks.onSceneDefinition(sceneList, location, state);
}

/**
 * Parse a stat chart.
 * @param document Document text to scan.
 * @param commandIndex Index after the "*" in the *stat_chart command.
 * @param contentStartIndex Index at the start of the stat chart contents.
 * @param state Parsing state.
 */
function parseStatChart(document: string, commandIndex: number, contentStartIndex: number, state: ParsingState) {
	let subcommandPattern = /(?<padding>[ \t]+)(?<command>\S+)((?<spacing>[ \t]*)(?<remainder>.*))?(\r?\n)?/g;
	let lineStart = contentStartIndex;

	// No need to worry about ${} references in the stat chart, as the top-level parser
	// will go back over the lines after the *stat_chart command and process them

	subcommandPattern.lastIndex = lineStart;
	let padding = "NONE";
	let m: RegExpExecArray | null;

	while (m = subcommandPattern.exec(document)) {
		if (m.index !== lineStart) {
			break;
		}
		if (padding == "NONE") {
			padding = m.groups!.padding;
		}
		else if (m.groups!.padding.length < padding.length) {
			break;
		}
		else if (m.groups!.padding != padding) {
			let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
				m.index, m.index + m[0].length,
				"Line is indented too far.");
			state.callbacks.onParseError(diagnostic);
			break;
		}

		let command = m.groups!.command;
		let commandStart = m.index + padding.length;

		if (statChartCommands.includes(command)) {
			let spacing = m.groups!.spacing;
			if (spacing === undefined) {
				let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
					commandStart, commandStart + command.length,
					`Missing variable after ${command}`);
				state.callbacks.onParseError(diagnostic);
			}
			else {
				let remainderStart = commandStart + command.length + spacing.length;
				let variable = extractTokenAtIndex(document, remainderStart);
				if (variable === undefined) {
					let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
						remainderStart, remainderStart,
						"Not a valid variable.");
					state.callbacks.onParseError(diagnostic);
				}
				else if (variable[0] == '{') {
					parseExpression(variable?.slice(1, -1), remainderStart+1, state);
				}
				else {
					let location = Location.create(state.textDocument.uri, Range.create(
						state.textDocument.positionAt(remainderStart),
						state.textDocument.positionAt(remainderStart + variable.length)
					));
					state.callbacks.onVariableReference(variable, location, state);
				}
			}

			if (statChartBlockCommands.includes(command)) {
				// Consume any sub-indented lines
				lineStart = subcommandPattern.lastIndex;
				while (lineStart < document.length) {
					let nextLineStart = findLineEnd(document, lineStart);
					if (nextLineStart === undefined) {
						break;
					}
					let line = document.slice(lineStart, nextLineStart);
					let paddingMatch = line.match(/^(?<padding>\s+)/);
					if (!paddingMatch || paddingMatch.groups!.padding.length <= padding.length) {
						break;
					}
					lineStart = nextLineStart;
				}
				subcommandPattern.lastIndex = lineStart;
			}
		}
		else {
			let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
				commandStart, commandStart + command.length,
				`Must be one of ${statChartCommands.join(", ")}`);
			state.callbacks.onParseError(diagnostic);
		}

		lineStart = subcommandPattern.lastIndex;
	}

	if (lineStart == contentStartIndex) {
		let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
			commandIndex - 1, commandIndex + "stat_chart".length,
			`*stat_chart must have at least one stat`);
		state.callbacks.onParseError(diagnostic);
	}
}

/**
 * Validate an expression that's being tested for true/falseness.
 * 
 * @param tokenizedExpression The expression that's being tested.
 * @param state Parsing state.
 */
function validateConditionExpression(tokenizedExpression: Expression, state: ParsingState) {
	let tokens = tokenizedExpression.combinedTokens;
	let globalIndex = tokenizedExpression.globalIndex;
	if (tokens.length == 0) {
		return;  // No error -- handled elsewhere
	}

	let lastToken = tokens[tokens.length - 1];

	// *if conditions can be:
	//   - a literal (bool, variable, variable reference)
	//   - the function not()
	//   - boolean comparison (literal and literal)
	//   - parentheses
	switch (tokens[0].type) {
		case ExpressionTokenType.FunctionAndContents:
			if (!tokens[0].text.startsWith("not")) {
				let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
					globalIndex + tokens[0].index,
					globalIndex + tokens[0].index + tokens[0].text.length,
					"Only boolean functions like not() are allowed");
				state.callbacks.onParseError(diagnostic);
			}
		case ExpressionTokenType.BooleanNamedValue:
		case ExpressionTokenType.VariableReference:
		case ExpressionTokenType.Variable:
		case ExpressionTokenType.Parentheses:
			// We only allow the token by itself or math
			if (tokens.length == 1) {
				break;
			}
			if (tokens.length > 3) {
				let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
					globalIndex + tokens[3].index,
					globalIndex + lastToken.index + lastToken.text.length,
					"Too many elements - are you missing parentheses?");
				state.callbacks.onParseError(diagnostic);
			}
			if (tokens[1].type != ExpressionTokenType.BooleanNamedOperator) {
				let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
					globalIndex + tokens[1].index,
					globalIndex + tokens[1].index + tokens[1].text.length,
					"Missing boolean comparison like 'and' or 'or'");
				state.callbacks.onParseError(diagnostic);
			}
			else if (tokens.length < 3) {
				let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
					globalIndex + tokens[1].index + tokens[1].text.length,
					globalIndex + tokens[1].index + tokens[1].text.length,
					"Missing value after the boolean comparison");
				state.callbacks.onParseError(diagnostic);
			}
			else if (tokens[2].type == ExpressionTokenType.FunctionAndContents) {
				if (!tokens[2].text.startsWith("not")) {
					let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
						globalIndex + tokens[2].index,
						globalIndex + tokens[2].index + tokens[2].text.length,
						"Only boolean functions like not() are allowed");
					state.callbacks.onParseError(diagnostic);
				}
			}
			else if (!isBooleanCompatible(tokens[2])) {
				let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
					globalIndex + tokens[2].index,
					globalIndex + tokens[2].index + tokens[2].text.length,
					"Must be true, false, variable, not(), reference, or parentheses");
				state.callbacks.onParseError(diagnostic);
			}
			break;
		case ExpressionTokenType.Function:
			break;  // No error -- that's caught elsewhere
		default:
			let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
				globalIndex + tokens[0].index,
				globalIndex + tokens[0].index + tokens[0].text.length,
				"Must be true, false, variable, not(), reference, or parentheses");
			state.callbacks.onParseError(diagnostic);
			break;
	}
}

/**
 * Parse a command that can reference variables, such as *if.
 * @param command ChoiceScript command, such as "if", that may contain a reference.
 * @param line The rest of the line after the command.
 * @param lineGlobalIndex Index at the start of the line.
 * @param state Parsing state.
 */
function parseVariableReferenceCommand(command: string, line: string, lineGlobalIndex: number, state: ParsingState) {
	// The *if and *selectable_if commands can be used with options, so take that into account
	if (command == "if" || command == "selectable_if") {
		let choiceSplit = line.split('#');
		if (choiceSplit !== undefined)
			line = choiceSplit[0];
	}
	// The line that follows a command that can reference a variable is an expression
	let tokenizedExpression = parseExpression(line, lineGlobalIndex, state);
	validateConditionExpression(tokenizedExpression, state);
}

/**
 * Parse a command that references labels, such as *goto.
 * @param command Command.
 * @param commandGlobalIndex: Index of the command in the document.
 * @param line Line after the command.
 * @param lineGlobalIndex Index of the line in the document.
 * @param state Parsing state.
 */
function parseFlowControlCommand(command: string, commandGlobalIndex: number, line: string, lineGlobalIndex: number, state: ParsingState) {
	let commandLocation = Location.create(state.textDocument.uri, Range.create(
		state.textDocument.positionAt(commandGlobalIndex),
		state.textDocument.positionAt(commandGlobalIndex + command.length)
	));
	let label = "";
	let scene = "";
	let labelLocation: Location | undefined = undefined;
	let sceneLocation: Location | undefined = undefined;

	if (command != "return") {
		let firstToken = "";
		let secondToken = "";
		let spacing = "";
		// Get the first token, which may be a {} reference
		let token = extractTokenAtIndex(line, 0, "{}", "\\w-");
		firstToken = (token !== undefined) ? token : "";
		if (firstToken != "") {
			line = line.substring(firstToken.length);
			let m = line.match(/^(?<spacing>[ \t]+)/);
			if (m !== null && m.groups !== undefined) {
				spacing = m.groups.spacing;
				token = extractTokenAtIndex(line, spacing.length);
				secondToken = (token !== undefined) ? token : "";
			}
		}

		// Evaluate expressions (if any)
		if (firstToken != "" && firstToken[0] == '{') {
			parseExpression(firstToken.slice(1, -1), lineGlobalIndex+1, state);
		}
		if (secondToken != "" && secondToken[0] == '{') {
			parseExpression(secondToken.slice(1, -1), lineGlobalIndex+firstToken.length+spacing.length+1, state);
		}
	
		if (command.includes("_scene")) {
			scene = firstToken;
			sceneLocation = Location.create(state.textDocument.uri, Range.create(
				state.textDocument.positionAt(lineGlobalIndex),
				state.textDocument.positionAt(lineGlobalIndex + scene.length)
			));

			if (secondToken != "") {
				label = secondToken;
				let labelIndex = lineGlobalIndex + scene.length + spacing.length;
				labelLocation = Location.create(state.textDocument.uri, Range.create(
					state.textDocument.positionAt(labelIndex),
					state.textDocument.positionAt(labelIndex + label.length)
				));
			}
		}
		else {
			label = firstToken;
			labelLocation = Location.create(state.textDocument.uri, Range.create(
				state.textDocument.positionAt(lineGlobalIndex),
				state.textDocument.positionAt(lineGlobalIndex + label.length)
			));
		}
	}

	state.callbacks.onFlowControlEvent(command, commandLocation, label, scene, labelLocation, sceneLocation, state);
}

/**
 * Parse an achievement.
 * @param codename Achievement's codename
 * @param startIndex Index at the start of the codename.
 * @param state Parsing state.
 */
function parseAchievement(codename: string, startIndex: number, state: ParsingState) {
	let location = Location.create(state.textDocument.uri, Range.create(
		state.textDocument.positionAt(startIndex),
		state.textDocument.positionAt(startIndex + codename.length)
	));
	state.callbacks.onAchievementCreate(codename, location, state);
}

/**
 * Parse an achievement reference.
 * @param codename Achievement's codename
 * @param startIndex Index at the start of the codename.
 * @param state Parsing state.
 */
function parseAchievementReference(codename: string, startIndex: number, state: ParsingState) {
	let location = Location.create(state.textDocument.uri, Range.create(
		state.textDocument.positionAt(startIndex),
		state.textDocument.positionAt(startIndex + codename.length)
	));
	state.callbacks.onAchievementReference(codename, location, state);
}

/**
 * Parse a command line.
 * 
 * @param document Document being parsed.
 * @param prefix Spaces before the command.
 * @param command Command.
 * @param spacing Spaces after the command, if any.
 * @param line The rest of the line after the command, if any.
 * @param commandIndex Index of the command in the document.
 * @param state Parsing state.
 */
function parseCommand(document: string, prefix: string, command: string, spacing: string, line: string, commandIndex: number, state: ParsingState) {
	state.currentCommand = command;
	state.parseStack.push(ParseElement.Command);

	let commandLocation = Location.create(state.textDocument.uri, Range.create(
		state.textDocument.positionAt(commandIndex),
		state.textDocument.positionAt(commandIndex + command.length)
	));

	state.callbacks.onCommand(prefix, command, spacing, line, commandLocation, state);

	if (!validCommandsLookup.has(command)) {
		let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
			commandIndex, commandIndex + command.length,
			`Command *${command} isn't a valid ChoiceScript command.`);
		state.callbacks.onParseError(diagnostic);
		return;  // Short-circuit: Nothing more to be done
	}
	else if (argumentRequiringCommandsLookup.has(command) && line.trim() == "") {
		let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
			commandIndex, commandIndex + command.length,
			`Command *${command} is missing its arguments.`);
		state.callbacks.onParseError(diagnostic);
		return;  // Short circuit
	}
	else if (startupCommandsLookup.has(command) && !uriIsStartupFile(state.textDocument.uri)) {
		let diagnostic = createDiagnostic(DiagnosticSeverity.Error, state.textDocument,
			commandIndex, commandIndex + command.length,
			`Command *${command} can only be used in startup.txt.`);
		state.callbacks.onParseError(diagnostic);
	}

	let lineIndex = commandIndex + command.length + spacing.length;

	if (symbolManipulationCommandsLookup.has(command)) {
		parseSymbolManipulationCommand(command, line, lineIndex, state);
	}
	else if (variableReferenceCommandsLookup.has(command)) {
		parseVariableReferenceCommand(command, line, lineIndex, state);
	}
	else if (flowControlCommandsLookup.has(command)) {
		parseFlowControlCommand(command, commandIndex, line, lineIndex, state);
	}
	else if (command == "scene_list") {
		let nextLineIndex = findLineEnd(document, commandIndex);
		if (nextLineIndex !== undefined) {
			parseScenes(document, nextLineIndex, state);
		}
	}
	else if (command == "stat_chart") {
		let nextLineIndex = findLineEnd(document, commandIndex);
		if (nextLineIndex !== undefined) {
			parseStatChart(document, commandIndex, nextLineIndex, state);
		}
	}
	else if (command == "achievement") {
		let codenameMatch = line.match(/^\S+/);
		if (codenameMatch) {
			let codename = codenameMatch[0];
			parseAchievement(codename, lineIndex, state);
		}
	}
	else if (command == "achieve") {
		let codenameMatch = line.match(/^\S+/);
		if (codenameMatch) {
			let codename = codenameMatch[0];
			parseAchievementReference(codename, lineIndex, state);
		}
	}

	state.parseStack.pop();
	state.currentCommand = undefined;
}

/**
 * Parse a ChoiceScript document.
 * 
 * @param textDocument Document to parse.
 * @param callbacks Parser event callbacks.
 */
export function parse(textDocument: TextDocument, callbacks: ParserCallbacks): void {
	let state = new ParsingState(textDocument, callbacks);
	let text = textDocument.getText();

	let pattern = RegExp(`${commandPattern}|${replacementStartPattern}|${multiStartPattern}`, 'g');
	let m: RegExpExecArray | null;

	while (m = pattern.exec(text)) {
		if (m.groups === undefined) {
			continue;
		}

		// Pattern options: command, replacement (${}), multi (@{})
		if (m.groups.command) {
			let command = m.groups.command;
			let prefix = m.groups.commandPrefix ? m.groups.commandPrefix : "";
			let spacing = m.groups.commandSpacing ? m.groups.commandSpacing : "";
			let line = m.groups.commandLine ? m.groups.commandLine : "";
			let commandIndex = m.index + prefix.length + 1;
			parseCommand(text, prefix, command, spacing, line, commandIndex, state);
		}
		else if (m.groups.replacement) {
			let sectionGlobalIndex = m.index + m[0].length;
			// Since the match doesn't consume the whole replacement, jigger the pattern's last index by hand
			let endIndex = parseReplacement(text, m[0].length, sectionGlobalIndex, undefined, state);
			pattern.lastIndex = endIndex;
		}
		else if (m.groups.multi) {
			let sectionGlobalIndex = m.index + m[0].length;
			// Since the match doesn't consume the whole replacement, jigger the pattern's last index by hand
			let endIndex = parseMultireplacement(text, m[0].length, sectionGlobalIndex, undefined, state);
			pattern.lastIndex = endIndex;
		}
	}
}
