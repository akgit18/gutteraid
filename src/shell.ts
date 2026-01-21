import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

type ShellType = 'bash' | 'zsh' | 'fish' | 'pwsh' | 'cmd' | 'sh' | 'ksh' | 'tcsh' | 'nu';

const SHELL_NAME_MAP: Record<string, ShellType> = {
	'bash': 'bash',
	'zsh': 'zsh',
	'fish': 'fish',
	'sh': 'sh',
	'ksh': 'ksh',
	'tcsh': 'tcsh',
	'csh': 'tcsh',
	'nu': 'nu',
	'nushell': 'nu',
	'pwsh': 'pwsh',
	'powershell': 'pwsh',
	'cmd': 'cmd',
};

function shellTypeFromPath(shellPath: string): ShellType | undefined {
	const name = path.basename(shellPath, '.exe').toLowerCase();
	return SHELL_NAME_MAP[name];
}

type ShellDetectionSource = 'shellPath' | 'env.shell' | 'platform';

type DetectedShell = {
	shell: ShellType;
	source: ShellDetectionSource;
}

function detectShell(terminal?: vscode.Terminal): DetectedShell {
	if (terminal && 'shellPath' in terminal.creationOptions) {
		const shellPath = terminal.creationOptions.shellPath;
		if (shellPath) {
			const shellType = shellTypeFromPath(shellPath);
			if (shellType) {
				return { shell: shellType, source: 'shellPath' };
			}
		}
	}

	const envShell = shellTypeFromPath(vscode.env.shell);
	if (envShell) {
		return { shell: envShell, source: 'env.shell' };
	}

	// Default shell for modern versions of the platforms
	let shell: ShellType;
	switch (process.platform) {
		case 'win32':
			shell = 'pwsh';
			break;
		case 'darwin':
			shell = 'zsh';
			break;
		case 'aix':
		case 'openbsd':
			shell = 'ksh';
			break;
		case 'freebsd':
			shell = 'sh';
			break;
		case 'linux':
		case 'sunos':
		default:
			shell = 'bash';
	}
	return { shell, source: 'platform' };
}

function escapeShellArg(arg: string, shell: ShellType): string {
	switch (shell) {
		case 'fish':
			// Fish: single quotes recognize \\ and \' as escape sequences
			return `'${arg.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
		case 'pwsh':
		case 'nu':
			// PowerShell & Nushell: single quotes are literal, escape ' as ''
			return `'${arg.replace(/'/g, "''")}'`;
		case 'cmd':
			// cmd.exe: double quotes
			// Note that % cannot be escaped in interactive cmd.
			// Since this extension can only be run in trusted repos anyway,
			// trust that authors won't try to leak your environment variables.
			return `"${arg.replace(/"/g, '""')}"`;
		case 'tcsh':
			// tcsh: like bash but ! is special even in single quotes
			return `'${arg.replace(/'/g, "'\\''").replace(/!/g, "'\\!'")}'`;
		case 'bash':
		case 'zsh':
		case 'sh':
		case 'ksh':
		default:
			// POSIX standard: single quotes, escape ' as '\''
			return `'${arg.replace(/'/g, "'\\''")}'`;
	}
}

function getShellSyntax(shell: ShellType): { prefix: string; separator: string; exitCodeCommand: string } {
	switch (shell) {
		case 'fish':
			return { prefix: '', separator: '; ', exitCodeCommand: 'echo $status' };
		case 'tcsh':
			return { prefix: '', separator: '; ', exitCodeCommand: 'echo $status' };
		case 'pwsh':
			// PowerShell needs & to invoke quoted command paths
			return { prefix: '& ', separator: '; ', exitCodeCommand: 'echo $LASTEXITCODE' };
		case 'cmd':
			return { prefix: '', separator: '& ', exitCodeCommand: 'echo %ERRORLEVEL%' };
		case 'nu':
			return { prefix: '', separator: '; ', exitCodeCommand: 'echo $env.LAST_EXIT_CODE' };
		case 'bash':
		case 'zsh':
		case 'sh':
		case 'ksh':
		default:
			// POSIX shells (bash, zsh, sh, ksh)
			return { prefix: '', separator: '; ', exitCodeCommand: 'EXIT_CODE=$?; echo $EXIT_CODE' };
	}
}

function unescapeControlChars(str: string): string {
	return str.replaceAll(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
		String.fromCharCode(parseInt(hex, 16))
	);
}

type ExecuteOptions = {
	terminal: vscode.Terminal;
	args: string[];
	outputChannel: vscode.LogOutputChannel;
	token: vscode.CancellationToken;
	subscriptions: vscode.Disposable[];
	killSignal?: string;
}

/**
 * Execute a command in a terminal, using shell integration if available,
 * falling back to shell-specific escaping otherwise.
 *
 * @returns The exit code, or undefined if cancelled or unknown
 */
export async function executeInTerminal(options: ExecuteOptions): Promise<number | undefined> {
	const { terminal, args, token, subscriptions, killSignal, outputChannel } = options;

	const handleCancellation = () => {
		if (killSignal === 'dispose') {
			terminal.dispose();
		} else {
			const signal = unescapeControlChars(killSignal ?? '\\u0003');
			terminal.sendText(signal, false);
		}
	};

	const {shell, source} = detectShell(terminal);
	outputChannel.debug(`Detected shell: ${shell} (source: ${source})`);
	const escapedArgs = args.map(arg => escapeShellArg(arg, shell)).join(' ');
	const syntax = getShellSyntax(shell);

	// Note: it may take time for a shellIntegration to be attached to a fresh
	// terminal. Don't wait for it because the user probably cares more about
	// the code running without delay than avoiding the fallback polling method
	// of getting the exit code.
	const shellIntegration = terminal.shellIntegration;
	if (shellIntegration) {
		outputChannel.trace('Using shell integration for command exit code');

		// Use string form with our own escaping since VS Code's auto-escaping
		// doesn't handle args that already contain quotes
		const commandLine = `${syntax.prefix}${escapedArgs}`;
		const execution = shellIntegration.executeCommand(commandLine);

		const exitCodePromise = new Promise<number | undefined>((resolve) => {
			const disposable = vscode.window.onDidEndTerminalShellExecution((event) => {
				if (event.execution === execution) {
					disposable.dispose();
					resolve(event.exitCode);
				}
			});
			subscriptions.push(disposable);
		});

		const cancellationPromise = new Promise<undefined>((resolve) => {
			const disposable = token.onCancellationRequested(() => {
				disposable.dispose();
				handleCancellation();
				resolve(undefined)
			});
			subscriptions.push(disposable);
		});

		return Promise.race([exitCodePromise, cancellationPromise]);
	} else {
		outputChannel.trace('Shell integration not found; using polling fallback for command exit code');

		const tempFile = path.join(os.tmpdir(), `gutteraid-${Date.now()}-${Math.random().toString(36).substring(2, 11)}.txt`);
		const fullCommand = `${syntax.prefix}${escapedArgs}${syntax.separator}${syntax.exitCodeCommand} > "${tempFile}"`;

		terminal.sendText(fullCommand, true);

		return new Promise<number | undefined>((resolve) => {
			const pollInterval = 1000;
			let pollTimeout: NodeJS.Timeout | undefined = undefined;

			const pollForResult = () => {
				if (fs.existsSync(tempFile)) {
					try {
						const exitCodeStr = fs.readFileSync(tempFile, 'utf8').trim();
						const code = parseInt(exitCodeStr, 10);
						fs.unlinkSync(tempFile);
						resolve(isNaN(code) ? undefined : code);
					} catch {
						// File exists but can't read it yet, try again
						pollTimeout = setTimeout(pollForResult, pollInterval);
					}
				} else {
					pollTimeout = setTimeout(pollForResult, pollInterval);
				}
			};

			pollForResult();

			const cancellationListener = token.onCancellationRequested(() => {
				clearTimeout(pollTimeout);
				try { fs.unlinkSync(tempFile); } catch {}
				handleCancellation();
				resolve(undefined);
			});
			subscriptions.push(cancellationListener, { dispose: () => clearTimeout(pollTimeout) });
		});
	}
}
