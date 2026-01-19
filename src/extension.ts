import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as chokidar from 'chokidar';
import picomatch from 'picomatch';

interface TaskInput {
	'id': string;
	'type': 'promptString' | 'pickString';
	'description'?: string;
	'default'?: string;
	'options'?: string[];
}

type Script = [string, ...string[]] | never[] | undefined;

interface TaskMatcher {
	'filePattern': string;
	'taskPattern': string;
	'scripts': [Script, Script, Script]; // [Run, Debug, Coverage]
	'name'?: string;
	'terminal'?: 'new' | 'active' | string;
	'killSignal'?: string;
	// not parsed from JSON--so not quoted
	matchFn: (filePath: string) => boolean;
	compiledRegex?: RegExp;
}

function getMatcherId(matcher: TaskMatcher): string {
	return `${matcher['filePattern']}:${matcher['taskPattern']}`;
}

function unescapeControlChars(str: string): string {
	return str.replaceAll(/\\u([0-9a-fA-F]{4})/g, (match, hex) =>
		String.fromCharCode(parseInt(hex, 16))
	);
}

interface TaskPatterns {
	'version'?: string;
	'matchers': TaskMatcher[];
	'inputs'?: TaskInput[];
}

let taskMatchers: TaskMatcher[] = [];
let inputCache: Map<string, Map<string, string>> = new Map(); // matcherId -> inputId -> value
let inputDefinitions: Map<string, TaskInput> = new Map(); // inputId -> TaskInput

function logWarn(message: string, ...args: unknown[]) {
	outputChannel.warn(message, ...args);
	const config = vscode.workspace.getConfiguration('gutteraid');
	if (config.get<boolean>('alertOnError', false)) {
		vscode.window.showWarningMessage(message)
	}
}

function logError(message: string, ...args: unknown[]) {
	outputChannel.error(message, ...args);
	const config = vscode.workspace.getConfiguration('gutteraid');
	if (config.get<boolean>('alertOnError', false)) {
		vscode.window.showErrorMessage(message)
	}
}

class ResettingFunctionDebouncer<K extends string | number | boolean, T extends [K, ...any[]]> {
	private readonly timeouts: Map<K, NodeJS.Timeout> = new Map();
	constructor(private readonly fn: (...args: T) => void, private readonly timeout: number) {}

	/* First function arg is a primitive and is used as a key for timeouts */
	public enqueue(...args: T) {
		const key = args[0];
		const existingTimeout = this.timeouts.get(key);
		if (existingTimeout) {
			clearTimeout(existingTimeout);
		}
		const timeoutHandle = setTimeout(() => {
			this.fn(...args);
			this.timeouts.delete(key);
		}, this.timeout);
		this.timeouts.set(key, timeoutHandle);
	}

	public clear() {
		for (const timeoutHandle of this.timeouts.values()) {
			clearTimeout(timeoutHandle);
		}
		this.timeouts.clear();
	}
}

function watchTaskPatternsFile({dirName, basePatternsPath, localPatternsPath, controller, context}: {
	dirName: string;
	basePatternsPath: string;
	localPatternsPath: string;
	controller: vscode.TestController;
	context: vscode.ExtensionContext
}) {
	outputChannel.trace(`Watching patterns dir: ${dirName}`);
	// Use chokidar for more reliable file watching, especially across version control operations
	// vscode claims that its built-in file watcher will monitor files that do not yet exist,
	// and that watchers for deleted files will get deleted and reactivated upon recreation,
	// but neither seems to be true.
	const patternsFileWatcher = chokidar.watch(dirName, {
		persistent: true,
		ignoreInitial: true,
	});

	// Debounce handling of file changes to avoid multiple reloads in quick succession
	// Also gives time for file to be deleted-and-recreated by version control operations
	const handlePatternsFileChange = new ResettingFunctionDebouncer((changedFilePath: string, stats: fs.Stats | undefined) => {
		if ((changedFilePath === basePatternsPath || changedFilePath === localPatternsPath)) {
			if (!fs.existsSync(basePatternsPath) && !fs.existsSync(localPatternsPath)) {
				outputChannel.debug('All patterns files deleted, clearing tasks...');
				taskMatchers = [];
				inputDefinitions.clear();
				inputCache.clear();
				controller.items.replace([]);
			} else {
				outputChannel.debug(`Patterns file changed: ${changedFilePath}, reloading...`);
				loadTaskPatterns(basePatternsPath, localPatternsPath);
				if (vscode.window.activeTextEditor) {
					processDocument(vscode.window.activeTextEditor.document, controller);
				}
			}
		}
	}, 100);

	patternsFileWatcher
		.on('add',(changedFilePath: string, stats: fs.Stats | undefined) => handlePatternsFileChange.enqueue(changedFilePath, stats))
		.on('change', (changedFilePath: string, stats: fs.Stats | undefined) => handlePatternsFileChange.enqueue(changedFilePath, stats))
		.on('unlink', (changedFilePath: string, stats: fs.Stats | undefined) => handlePatternsFileChange.enqueue(changedFilePath, stats));

	const unwatch = () => {
		patternsFileWatcher.close();
		handlePatternsFileChange.clear();
	};

	context.subscriptions.push({dispose: unwatch});
}

let outputChannel: vscode.LogOutputChannel

export function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel("GutterAid", {log: true});
	outputChannel.trace('Activating GutterAid extension...');
	
	const controller = vscode.tests.createTestController('gutteraid', 'GutterAid Tests');
	context.subscriptions.push(controller);

	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		logError('No workspace folder found. GutterAid requires an open workspace.');
		return;
	}
	
	const fullPatternsDir = path.join(workspaceFolder.uri.fsPath, '.gutteraid');
	const basePatternsPath = path.join(fullPatternsDir, 'patterns.json');
	const localPatternsPath = path.join(fullPatternsDir, 'patterns.local.json');
	outputChannel.trace(`Using patterns directory: ${fullPatternsDir}`);

	// Load task patterns on activation
	loadTaskPatterns(basePatternsPath, localPatternsPath);

	watchTaskPatternsFile({dirName: fullPatternsDir, basePatternsPath, localPatternsPath, controller, context});

	// Set up task run handler
	controller.createRunProfile('Run Tasks', vscode.TestRunProfileKind.Run, (request, token) => {
		runTasks(request, token, context, controller, vscode.TestRunProfileKind.Run);
	});

	controller.createRunProfile('Debug Tasks', vscode.TestRunProfileKind.Debug, (request, token) => {
		runTasks(request, token, context, controller, vscode.TestRunProfileKind.Debug);
	});

	controller.createRunProfile('Coverage Tasks', vscode.TestRunProfileKind.Coverage, (request, token) => {
		runTasks(request, token, context, controller, vscode.TestRunProfileKind.Coverage);
	});

	// Watch for when files are opened in the editor
	const openFileChangeWatcher = vscode.window.onDidChangeActiveTextEditor(editor => {
		outputChannel.trace(`Active editor changed: ${editor ? editor.document.uri.fsPath : 'None'}`);
		if (editor) {
			processDocument(editor.document, controller);
		}
	});
	context.subscriptions.push(openFileChangeWatcher);

	// Watch for changes to currently open files
	// Does not use onDidSaveTextDocument because files may be changed and persisted without being saved
	const documentChangeWatcher = vscode.workspace.onDidChangeTextDocument(event => {
		if (!event.document.isDirty) {
			processDocument(event.document, controller);
		}
	});
	context.subscriptions.push(documentChangeWatcher);

	// Process the currently active document if there is one
	if (vscode.window.activeTextEditor) {
		processDocument(vscode.window.activeTextEditor.document, controller);
	}

	// Register reset inputs commands
	const resetInputsCommand = vscode.commands.registerCommand('gutteraid.resetInputs', () => {
		inputCache.clear();
		vscode.window.showInformationMessage('Task input choices have been reset.');
	});
	context.subscriptions.push(resetInputsCommand);

	const resetInputsForTaskCommand = vscode.commands.registerCommand('gutteraid.resetInputsForTask', (taskItem: vscode.TestItem) => {
		if (taskItem && (taskItem as any).matcher) {
			const matcher = (taskItem as any).matcher as TaskMatcher;
			const matcherId = getMatcherId(matcher);
			inputCache.delete(matcherId);
			vscode.window.showInformationMessage(`Input choices reset for task: ${taskItem.label}`);
		}
	});
	context.subscriptions.push(resetInputsForTaskCommand);

	outputChannel.trace('GutterAid extension activated.');
}

export function deactivate() {
	outputChannel.trace('GutterAid extension deactivated.');
	outputChannel.dispose()
}


function processDocument(document: vscode.TextDocument, controller: vscode.TestController) {
	// always ignore this extension's output channel
	if (document.uri.scheme === 'output' && document.fileName.endsWith(outputChannel.name)) {
		return;
	}

	outputChannel.debug(`Processing document: ${document.uri.fsPath}`);

	const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
	outputChannel.trace(`Workspace folder: ${workspaceFolder ? workspaceFolder.uri.fsPath : 'None'}`);
	if (!workspaceFolder) {
		return;
	}

	const relativePath = path.relative(workspaceFolder.uri.fsPath, document.uri.fsPath);
	outputChannel.trace(`Relative path: ${relativePath}`);

	// Remove existing test items for this document
	const documentPrefix = `${document.uri.toString()}:`;
	controller.items.forEach(item => {
		outputChannel.debug(`Removing existing test item: ${item.id}`);
		if (item.id.startsWith(documentPrefix)) {
			controller.items.delete(item.id);
		}
	});

	// Find the first matching pattern
	const matcher = taskMatchers.find(m => m.matchFn(relativePath));
	outputChannel.debug(`Found matcher: ${matcher ? JSON.stringify(matcher) : 'None'}`);
	if (!matcher) {
		return;
	}

	const text = document.getText();
	outputChannel.trace(`Document text length: ${text.length}`);

	const regex = matcher.compiledRegex;
	if (!regex) {
		logError(`No compiled regex available for matcher with pattern '${matcher['taskPattern']}'`);
		return;
	}
	outputChannel.debug(`Using cached regex matcher: `, regex);
	for (const match of text.matchAll(regex)) {
		const {line, character} = document.positionAt(match.index);
		const taskId = `${documentPrefix}${line}`;

		const taskName = matcher['name']?.replace(/\$\{group:(\d+)\}/g, (_, index) => {
				const groupIndex = parseInt(index);
				return match[groupIndex] || '';
			})?.replace(/\$\{vscode:([^}]+)\}/g, (_, variable) => {
				return resolveVSCodeVariable(variable, document.uri, workspaceFolder);
			}) ?? match[1] ?? taskId;

		// Create test item
		const testItem = controller.createTestItem(taskId, taskName, document.uri);
		testItem.range = new vscode.Range(line, character, line, Number.MAX_SAFE_INTEGER);

		testItem.tags = [new vscode.TestTag('gutteraid')];

		// Store matcher info for execution
		(testItem as any).matcher = matcher;
		(testItem as any).matchGroups = match.slice(1);

		controller.items.add(testItem);
	}
}

function testKindToString(kind: vscode.TestRunProfileKind): string {
	switch (kind) {
		case vscode.TestRunProfileKind.Run:
			return 'Run';
		case vscode.TestRunProfileKind.Debug:
			return 'Debug';
		case vscode.TestRunProfileKind.Coverage:
			return 'Coverage';
		default:
			return 'Run';
	}
}

async function runTasks(
	request: vscode.TestRunRequest,
	token: vscode.CancellationToken,
	context: vscode.ExtensionContext,
	controller: vscode.TestController,
	kind: vscode.TestRunProfileKind
) {
	const run = controller.createTestRun(request);
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	
	if (!workspaceFolder) {
		logError('No workspace folder found');
		run.end();
		return;
	}

	const queue: vscode.TestItem[] = [];
	if (request.include) {
		request.include.forEach(testItem => queue.push(testItem));
	} else {
		controller.items.forEach(testItem => queue.push(testItem));
	}

	while (queue.length > 0 && !token.isCancellationRequested) {
		const testItem = queue.pop()!;
		
		if (request.exclude?.includes(testItem)) {
			continue;
		}

		const matcher = (testItem as any).matcher as TaskMatcher;
		const matchGroups = (testItem as any).matchGroups as string[];
		
		if (!matcher) {
			continue;
		}

		run.started(testItem);

		try {
			const script = matcher['scripts'][kind - 1]
			if (!script || script.length === 0) {
				run.failed(testItem, new vscode.TestMessage(`No script defined for ${testKindToString(kind)} in matcher.`));
				continue;
			}

			const matcherId = getMatcherId(matcher);

			const terminalBehavior = matcher['terminal'];
			const inputs = await collectInputs(matcherId, script, terminalBehavior);
			if (!inputs) {
				run.skipped(testItem);
				continue;
			}
			
			// Process arguments
			const args = script.map(arg => {
				// Replace ${group:1}, ${group:2}, etc. with match groups
				let processedArg = arg.replace(/\$\{group:(\d+)\}/g, (match, index) => {
					const groupIndex = parseInt(index) - 1;
					return matchGroups[groupIndex] || '';
				});
				
				// Replace ${input:id} with input values
				processedArg = processedArg.replace(/\$\{input:([^}]+)\}/g, (match, inputId) => {
					return inputs.get(inputId) || '';
				});
				
				// Replace VS Code variables
				const testUri = testItem.uri
				if (testUri) {
					processedArg = processedArg.replace(/\$\{vscode:([^}]+)\}/g, (match, variable) => {
						return resolveVSCodeVariable(variable, testUri, workspaceFolder);
					});
				}

				return processedArg;
			});

			/**
			 * Running the command with shellPath/shellArgs closes the terminal immediately after command completion.
			 * 
			 * Using a vscode pty allows for programmatic capture of process outputs,
			 * but does not forward shell signals (Ctrl-C, etc.) well.
			 * 
			 * Using node-pty from node does not work in the VS Code extension environment.
			 * See https://github.com/microsoft/node-pty/issues/582
			 * 
			 * Importing node-pty from the version bundled with VS Code seems to work,
			 * but is not officially supported and is recommended against by Microsoft engineers.
			 * See https://github.com/microsoft/vscode/issues/658#issuecomment-982842847 for how.
			*/
			let terminal: vscode.Terminal;
			switch(terminalBehavior) {
				case 'new':
					terminal = vscode.window.createTerminal({
						name: `GutterAid: ${testItem.label}`,
						cwd: workspaceFolder.uri.fsPath,
						env: process.env,
					});	
					break;
				case 'active':
				case undefined:
				case null:
				case '':
					terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal({
							name: `GutterAid: ${testItem.label}`,
							cwd: workspaceFolder.uri.fsPath,
							env: process.env,
						});	
					break;
				default:
					const terminalName = terminalBehavior?.replace(/\$\{group:(\d+)\}/g, (match, index) => {
						const groupIndex = parseInt(index) - 1;
						return matchGroups[groupIndex] || '';
					}).replace(/\$\{input:([^}]+)\}/g, (match, inputId) => {
						return inputs.get(inputId) || '';
					}).replace(/\$\{vscode:([^}]+)\}/g, (match, variable) => {
						const testUri = testItem.uri;
						if (testUri) {
							return resolveVSCodeVariable(variable, testUri, workspaceFolder);
						} else {
							return match;
						}
					});
					terminal = vscode.window.terminals.find(t => t.name === terminalName) ?? vscode.window.createTerminal({
						name: terminalName,
						cwd: workspaceFolder.uri.fsPath,
						env: process.env,
					});
					break;
			}

			terminal.show();

			const escapeShellArg = (arg: string): string => {
				if (process.platform === 'win32') {
					// Escape quotes and backslashes for Windows cmd/PowerShell
					return `"${arg.replace(/"/g, '""').replace(/\\/g, '\\\\')}"`;
				} else {
					// Unix-style escaping: wrap in single quotes and escape any single quotes
					return `'${arg.replace(/'/g, "'\\''")}'`;
				}
			};
			
			const command = args.map(escapeShellArg).join(' ');
			
			// Create a temporary file to capture exit code
			const tempFile = path.join(os.tmpdir(), `gutteraid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.txt`);
			
			let fullCommand: string;
			if (process.platform === 'win32') {
				fullCommand = `${command} && echo %ERRORLEVEL% > "${tempFile}"`;
			} else {
				fullCommand = `${command}; EXIT_CODE=$?; echo $EXIT_CODE > "${tempFile}"`;
			}
			
			terminal.sendText(fullCommand, true);
			run.started(testItem);
			
			// Poll the temporary file for the exit code
			const result = await new Promise<{stdout: string, stderr: string, code: number | null}>((resolve) => {
				const pollInterval = 1000;
				let pollTimeout: NodeJS.Timeout | undefined = undefined;
				const pollForResult = () => {
					if (fs.existsSync(tempFile)) {
						try {
							// extract exit code, clean up temp file, resolve result
							const exitCodeStr = fs.readFileSync(tempFile, 'utf8').trim();
							const exitCode = parseInt(exitCodeStr, 10);
							fs.unlinkSync(tempFile);
							resolve({ stdout: '', stderr: '', code: isNaN(exitCode) ? null : exitCode });
						} catch (error) {
							// File exists but can't read it yet, try again
							pollTimeout = setTimeout(pollForResult, pollInterval);
						}
					} else {
						// File doesn't exist yet, try again
						pollTimeout = setTimeout(pollForResult, pollInterval);
					}
				};
				
				pollForResult();
				
				// Handle cancellation
				const cancellationListener = token.onCancellationRequested(() => {
					clearTimeout(pollTimeout);
					try { fs.unlinkSync(tempFile); } catch {}
					if (matcher['killSignal'] === 'dispose') {
						terminal.dispose();
					} else {
						const signal = unescapeControlChars(matcher['killSignal'] ?? '\\u0003');
						terminal.sendText(signal, true);
					}
					resolve({ stdout: '', stderr: 'Task cancelled', code: null });
				});
				context.subscriptions.push(cancellationListener, {dispose: () => clearTimeout(pollTimeout)});
			});

			// Mark task result based on exit code
			if (token.isCancellationRequested) {
				run.skipped(testItem);
			} else if (result.code === 0) {
				run.passed(testItem);
			} else {
				const errorMessage = result.stderr || result.stdout || `Process exited with code ${result.code}`;
				run.failed(testItem, new vscode.TestMessage(errorMessage));
			}
			
		} catch (error) {
			run.failed(testItem, new vscode.TestMessage(`Failed to run task: ${error}`));
		}
	}

	run.end();
}

async function collectInputs(matcherId: string, argsToUse: string[], terminalBehavior: string | undefined): Promise<Map<string, string> | false> {
	const config = vscode.workspace.getConfiguration('gutteraid');
	const askEveryTime = config.get<boolean>('askForInputsEveryTime', true);
	
	// Extract input IDs that are actually used in the arguments
	const usedInputIds = new Set<string>();
	for (const arg of argsToUse) {
		const matches = arg.matchAll(/\$\{input:([^}]+)\}/g);
		for (const match of matches) {
			usedInputIds.add(match[1]);
		}
	}
	if (terminalBehavior) {
		const matches = terminalBehavior.matchAll(/\$\{input:([^}]+)\}/g);
		for (const match of matches) {
			usedInputIds.add(match[1]);
		}
	}

	if (usedInputIds.size === 0) {
		return new Map();
	}

	// Check if we have cached inputs and don't need to ask every time
	const cachedInputs = !askEveryTime &&  inputCache.get(matcherId);
	if (cachedInputs) {
		// Check if we have all the needed inputs cached
		// We can have partial inputs if input definitions changed and new inputs were added
		const hasAllInputs = Array.from(usedInputIds).every(id => cachedInputs.has(id));
		if (hasAllInputs) {
			return cachedInputs;
		}
	}

	const inputs = new Map<string, string>();
	
	// Start with cached inputs if available
	if (cachedInputs) {
		for (const [key, value] of cachedInputs) {
			inputs.set(key, value);
		}
	}

	// Only prompt for inputs that are actually used and not already cached (or if asking every time)
	for (const inputId of usedInputIds) {
		if (!askEveryTime && inputs.has(inputId)) {
			continue; // Skip if we already have this input cached
		}

		const inputDef = inputDefinitions.get(inputId);
		if (!inputDef) {
			logError(`Input definition not found for: ${inputId}`);
			continue;
		}

		let value: string | undefined;
		
		if (inputDef['type'] === 'promptString') {
			value = await vscode.window.showInputBox({
				prompt: inputDef['description'] ?? `Enter value for ${inputId}`,
				value: inputDef['default']
			});
		} else if (inputDef['type'] === 'pickString' && inputDef['options']) {
			const defaultValue = inputDef['default'];
			const defaultValueIndex = defaultValue && inputDef['options'].indexOf(defaultValue);
			if (defaultValueIndex && defaultValueIndex >= 0) {
				// Could be slightly more efficient by just swapping with the first index,
				// but maybe users want the rest of the list to stay in the same order.
				inputDef['options'].splice(defaultValueIndex, 1);
				inputDef['options'].unshift(defaultValue);
			}
			value = await vscode.window.showQuickPick(inputDef['options'], {
				placeHolder: inputDef['description'] ?? `Select value for ${inputId}`,
			});
		}
		
		if (value !== undefined) {
			inputs.set(inputId, value);
		} else {
			// User cancelled input--should cancel the whole task run
			return false;
		}
	}

	// Cache the inputs for future use
	inputCache.set(matcherId, inputs);
	
	return inputs;
}

function resolveVSCodeVariable(variable: string, fileUri: vscode.Uri, workspaceFolder: vscode.WorkspaceFolder): string {
	const filePath = fileUri.fsPath;
	const fileName = path.basename(filePath);
	const fileBasename = path.basename(filePath, path.extname(filePath));
	const fileExtname = path.extname(filePath);
	const fileDirname = path.dirname(filePath);
	const relativeFilePath = path.relative(workspaceFolder.uri.fsPath, filePath);
	const relativeFileDirname = path.dirname(relativeFilePath);

	switch (variable) {
		case 'workspaceFolder':
		case 'workspaceRoot':
			return workspaceFolder.uri.fsPath;
		case 'workspaceFolderBasename':
			return path.basename(workspaceFolder.uri.fsPath);
		case 'file':
			return filePath;
		case 'fileWorkspaceFolder':
			return workspaceFolder.uri.fsPath;
		case 'relativeFile':
			return relativeFilePath;
		case 'relativeFileDirname':
			return relativeFileDirname;
		case 'fileBasename':
			return fileName;
		case 'fileBasenameNoExtension':
			return fileBasename;
		case 'fileExtname':
			return fileExtname;
		case 'fileDirname':
			return fileDirname;
		case 'cwd':
			return workspaceFolder.uri.fsPath;
		case 'pathSeparator':
			return path.sep;
		default:
			logError(`Unknown VS Code variable: ${variable}`);
			return `\${${variable}}`; // Return unresolved if unknown
	}
}

/**
 * Extracts regex patterns of task files to read, regex patterns of what tasks to look for in such files, and what commands to run based on the regex matches
 * The default location for the settings file is `.gutteraid/patterns.json`, but this can be changed in extension settings.
 */
function loadTaskPatterns(patternsPath: string, localPatternsPath: string): TaskPatterns {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	outputChannel.trace(`Loading task patterns from workspace: ${workspaceFolder ? workspaceFolder.uri.fsPath : 'None'}`);
	if (!workspaceFolder) {
		return { 'matchers': [] };
	}
	
	outputChannel.trace(`Patterns file: ${patternsPath}`);
	outputChannel.trace(`Local patterns file: ${localPatternsPath}`);

	let basePatterns: TaskPatterns = { 'matchers': [] };
	let localPatterns: TaskPatterns = { 'matchers': [] };

	try {
		// Load base patterns.json
		if (fs.existsSync(patternsPath)) {
			const content = fs.readFileSync(patternsPath, 'utf8');
			basePatterns = JSON.parse(content) as TaskPatterns;
			outputChannel.trace(`Loaded ${basePatterns['matchers'].length} base matchers`);
		}

		// Load patterns.local.json
		if (fs.existsSync(localPatternsPath)) {
			const localContent = fs.readFileSync(localPatternsPath, 'utf8');
			localPatterns = JSON.parse(localContent) as TaskPatterns;
			outputChannel.trace(`Loaded ${localPatterns['matchers'].length} local matchers`);
		}

		// If backwards-incompatibilities are to-be-released, warn
		// if (basePatterns['version'] !== localPatterns['version']) {
		// 	logWarn(`Version mismatch between base patterns (${basePatterns['version']}) and local patterns (${localPatterns['version']})`);
		// }

		// Merge patterns
		const merged = mergePatterns(basePatterns, localPatterns);
		
		// Parse input definitions
		inputDefinitions.clear();
		if (merged['inputs']) {
			for (const input of merged['inputs']) {
				inputDefinitions.set(input['id'], input);
			}
		}

		// Store match functions and compiled regexes for each matcher
		for (const matcher of merged['matchers']) {
			try {
				const config = vscode.workspace.getConfiguration('gutteraid');
				const debug = config.get<boolean>('alertOnError', false);
				matcher.matchFn = picomatch(matcher['filePattern'], {debug});
			} catch (error) {
				logError(`Error creating match functions for file pattern '${matcher['filePattern']}':`, error);
				matcher.matchFn = () => false;
			}

			try {
				matcher.compiledRegex = new RegExp(matcher['taskPattern'], 'gm');
			} catch (error) {
				logError(`Error compiling regex for task pattern '${matcher['taskPattern']}':`, error);
				matcher.compiledRegex = undefined;
			}
		}

		taskMatchers = merged['matchers'];
		return merged;
	} catch (error) {
		logError('Failed to load task patterns:', error);
	}

	return { 'matchers': [] };
}

function mergePatterns(base: TaskPatterns, local: TaskPatterns): TaskPatterns {
	const mergedInputs = new Map<string, TaskInput>();
	const mergedMatchers = new Map<string, TaskMatcher>();

	if (base['inputs']) {
		for (const input of base['inputs']) {
			mergedInputs.set(input['id'], input);
		}
	}

	for (const matcher of base['matchers']) {
		const matcherId = getMatcherId(matcher);
		mergedMatchers.set(matcherId, matcher);
	}

	// Merge/override with local inputs and matchers
	if (local['inputs']) {
		for (const input of local['inputs']) {
			const baseInput = mergedInputs.get(input['id']);
			if (baseInput) {
				// modify existing input
				Object.assign(baseInput, input);
			} else {
				// whole new input
				mergedInputs.set(input['id'], input);
			}
		}
	}

	for (const matcher of local['matchers']) {
		const matcherId = getMatcherId(matcher);
		const baseMatcher = mergedMatchers.get(matcherId);
		if (baseMatcher) {
			// modify existing matcher
			Object.assign(baseMatcher, matcher);
		} else {
			// whole new matcher
			mergedMatchers.set(matcher['filePattern'], matcher);
		}
	}

	return {
		'matchers': Array.from(mergedMatchers.values()),
		'inputs': mergedInputs.size > 0 ? Array.from(mergedInputs.values()) : undefined
	};
}