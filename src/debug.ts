import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import type { BrowserDebugConfig, DebugConfig, DebugMode, NodeWorkspaceProject } from './types';
import { activeServeTerminals, logDiagnostic } from './state';
import {
  resolveWorkspaceAndProjects,
  runInTerminal,
  pickProjectWithCurrentFile,
} from './utils';
import { detectBrowserLikelihood, parsePortFromScript, validateCustomCommand } from './pure-utils';
import { pickScriptWithPrefs } from './script-prefs';

// ── Timing constants ───────────────────────────────────────────────────────────
const RESTART_DEBUG_STOP_DELAY_MS = 500;
const RESTART_CTRL_C_DELAY_MS = 300;
const PORT_CHECK_INTERVAL_MS = 1000;
const PORT_CHECK_SOCKET_TIMEOUT_MS = 1000;
const STOP_ALL_DELAYED_MS = 2000;

// ── Script preferences ─────────────────────────────────────────────────────────

const SERVE_SCRIPT_ALIASES = [
  'dev',
  'serve',
  'start',
  'start:dev',
  'server',
  'develop',
  'watch',
  'run',
];

const BUILD_WATCH_SCRIPT_ALIASES = ['build:watch', 'watch', 'build:dev', 'dev:build'];

// ── Browser helpers ────────────────────────────────────────────────────────────

function findExecutable(candidates: string[]): string | undefined {
  return candidates.find((p) => fs.existsSync(p));
}

export function getBrowserDebugConfig(
  browser: string,
  executableOverride: string,
): BrowserDebugConfig | null {
  if (executableOverride) {
    if (!fs.existsSync(executableOverride)) {
      vscode.window.showErrorMessage(`Browser executable not found: ${executableOverride}`);
      return null;
    }
    const type = browser === 'edge' ? 'msedge' : browser === 'firefox' ? 'firefox' : 'chrome';
    return { type, runtimeExecutable: executableOverride };
  }

  switch (browser) {
    case 'chrome':
      return { type: 'chrome' };
    case 'edge':
      return { type: 'msedge' };
    case 'brave': {
      const exe = findExecutable(
        process.platform === 'win32'
          ? [
              path.join(
                process.env['PROGRAMFILES'] ?? 'C:\\Program Files',
                'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
              ),
              path.join(
                process.env['LOCALAPPDATA'] ?? '',
                'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
              ),
            ]
          : process.platform === 'darwin'
            ? ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser']
            : ['/usr/bin/brave-browser', '/usr/bin/brave'],
      );
      if (!exe) {
        vscode.window.showErrorMessage(
          'Brave browser not found. Install it or set "nodeCliPlus.debug.browserExecutablePath".',
        );
        return null;
      }
      return { type: 'chrome', runtimeExecutable: exe };
    }
    case 'opera': {
      const exe = findExecutable(
        process.platform === 'win32'
          ? [
              path.join(process.env['LOCALAPPDATA'] ?? '', 'Programs\\Opera\\opera.exe'),
              path.join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Opera\\opera.exe'),
            ]
          : process.platform === 'darwin'
            ? ['/Applications/Opera.app/Contents/MacOS/Opera']
            : ['/usr/bin/opera'],
      );
      if (!exe) {
        vscode.window.showErrorMessage(
          'Opera not found. Install it or set "nodeCliPlus.debug.browserExecutablePath".',
        );
        return null;
      }
      return { type: 'chrome', runtimeExecutable: exe };
    }
    case 'opera-gx': {
      const exe = findExecutable(
        process.platform === 'win32'
          ? [path.join(process.env['LOCALAPPDATA'] ?? '', 'Programs\\Opera GX\\opera.exe')]
          : process.platform === 'darwin'
            ? ['/Applications/Opera GX.app/Contents/MacOS/Opera GX']
            : [],
      );
      if (!exe) {
        vscode.window.showErrorMessage(
          'Opera GX not found. Install it or set "nodeCliPlus.debug.browserExecutablePath".',
        );
        return null;
      }
      return { type: 'chrome', runtimeExecutable: exe };
    }
    case 'firefox':
      return { type: 'firefox' };
    case 'safari':
      if (process.platform !== 'darwin') {
        vscode.window.showErrorMessage('Safari debugging is only supported on macOS.');
        return null;
      }
      return { type: 'safari' };
    default:
      logDiagnostic(`Unknown browser setting "${browser}", defaulting to Chrome`);
      return { type: 'chrome' };
  }
}

// ── Debug commands ─────────────────────────────────────────────────────────────

export async function debugNodeProject(context: vscode.ExtensionContext) {
  const resolved = await resolveWorkspaceAndProjects();
  if (!resolved) {
    return;
  }
  const { workspaceFolder, projects } = resolved;

  const project = await pickProjectWithCurrentFile(projects, 'Node Debug: Select Project', 'debug');
  if (!project) {
    return;
  }

  const script = await pickScriptWithPrefs({
    project,
    aliases: SERVE_SCRIPT_ALIASES,
    title: `Node Debug: ${project.name}`,
    placeHolder: 'Select the script that starts your app',
    commandKey: 'debugServe',
  });
  if (!script) {
    return;
  }

  const config = vscode.workspace.getConfiguration('nodeCliPlus');
  const modeSetting = config.get<string>('debug.mode', 'auto') as DebugMode;
  const mode: 'browser' | 'node' =
    modeSetting === 'auto' ? (detectBrowserLikelihood(project) ? 'browser' : 'node') : modeSetting;

  if (mode === 'node') {
    await launchNodeInspectorSession(context, workspaceFolder, project, script);
    return;
  }

  // ── Browser mode ───────────────────────────────────────────────────────────
  const scriptCommand = project.scripts[script] ?? '';
  const detectedPort = parsePortFromScript(scriptCommand);
  const port = detectedPort > 0 ? detectedPort : config.get<number>('debug.port', 3000);

  const browserSetting = config.get<string>('debug.browser', 'chrome');
  const executableOverride = (config.get<string>('debug.browserExecutablePath') ?? '').trim();
  const browserDebugConfig = getBrowserDebugConfig(browserSetting, executableOverride);
  if (!browserDebugConfig) {
    return;
  }
  const sessionName = `Node Debug (${project.name})`;

  const serveCommand = `npm run ${script}`;
  const serveTerminalName = `serve: ${script} (${project.name})`;
  const terminal = await runInTerminal(serveTerminalName, serveCommand, project.dir, {
    trackAsServe: true,
  });

  const serveEntry = activeServeTerminals.get(serveTerminalName);
  if (serveEntry) {
    serveEntry.debugConfig = {
      workspaceFolder,
      port,
      sessionName,
      browserSetting,
      browserDebugConfig,
    };
  }

  logDiagnostic(
    `Starting browser debug session for ${project.name} (script "${script}") on port ${port}`,
  );

  launchBrowserDebugSession(context, workspaceFolder, terminal, {
    port,
    sessionName,
    browserSetting,
    browserDebugConfig,
    progressTitle: `Starting "npm run ${script}" for "${project.name}" on port ${port}…`,
    serverName: 'dev server',
    onSessionStarted: (session) => {
      const e = activeServeTerminals.get(serveTerminalName);
      if (e) {
        e.activeDebugSession = session;
      }
    },
  });
}

/**
 * Launches an npm script under the VS Code Node.js debugger via a dynamic
 * launch config (`runtimeExecutable: npm`). No terminal management or port
 * waiting is needed — the debugger starts the process itself.
 */
async function launchNodeInspectorSession(
  context: vscode.ExtensionContext,
  workspaceFolder: vscode.WorkspaceFolder,
  project: NodeWorkspaceProject,
  script: string,
): Promise<void> {
  const sessionName = `Node Debug (${project.name})`;

  const started = await vscode.debug.startDebugging(workspaceFolder, {
    type: 'node',
    request: 'launch',
    name: sessionName,
    cwd: project.dir,
    runtimeExecutable: 'npm',
    runtimeArgs: ['run', script],
    console: 'integratedTerminal',
    skipFiles: ['<node_internals>/**'],
  });

  if (!started) {
    vscode.window.showErrorMessage(
      `Failed to start the Node.js debug session for "npm run ${script}". ` +
        `Make sure the built-in Node debugger is available (it ships with VS Code).`,
    );
    return;
  }

  logDiagnostic(`Started Node inspector session for ${project.name} (script "${script}")`);
  void context; // registered via startDebugging; nothing extra to dispose
}

export async function debugBuildWatchProject(context: vscode.ExtensionContext) {
  const resolved = await resolveWorkspaceAndProjects();
  if (!resolved) {
    return;
  }
  const { workspaceFolder, projects } = resolved;

  const project = await pickProjectWithCurrentFile(
    projects,
    'Node Debug Build Watch: Select Project',
    'debugBuildWatch',
  );
  if (!project) {
    return;
  }

  const watchScript = await pickScriptWithPrefs({
    project,
    aliases: BUILD_WATCH_SCRIPT_ALIASES,
    title: 'Node Debug Build Watch: Select Script',
    placeHolder: 'Select the watch script that rebuilds on change',
    commandKey: 'debugBuildWatch',
  });
  if (!watchScript) {
    return;
  }

  const vsConfig = vscode.workspace.getConfiguration('nodeCliPlus');
  const outDirSetting = (vsConfig.get<string>('buildWatch.outDir', 'dist') ?? 'dist').trim();
  const outDir = path.isAbsolute(outDirSetting) ? outDirSetting : path.join(project.dir, outDirSetting);
  if (!fs.existsSync(outDir)) {
    const proceed = await vscode.window.showWarningMessage(
      `Output directory "${outDirSetting}" does not exist yet. Start anyway?`,
      'Start anyway',
    );
    if (proceed !== 'Start anyway') {
      return;
    }
  }

  const port = vsConfig.get<number>('buildWatch.servePort', 4173);
  if (await isPortInUse(port)) {
    vscode.window.showErrorMessage(
      `Port ${port} is already in use. Stop the existing process or change "nodeCliPlus.buildWatch.servePort" before starting debug build watch.`,
    );
    return;
  }

  const serverCommandTemplate = vsConfig.get<string>(
    'buildWatch.staticServerCommand',
    'npx serve {outDir} -l {port}',
  );
  const escapedOutDir = outDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const serverCommand = serverCommandTemplate
    .replace('{outDir}', `"${escapedOutDir}"`)
    .replace('{port}', String(port));
  const serverCommandError = validateCustomCommand(serverCommand);
  if (serverCommandError) {
    vscode.window.showErrorMessage(
      `Invalid build watch static server command: ${serverCommandError}`,
    );
    return;
  }

  const browserSetting = vsConfig.get<string>('debug.browser', 'chrome');
  const executableOverride = (vsConfig.get<string>('debug.browserExecutablePath') ?? '').trim();
  const browserDebugConfig = getBrowserDebugConfig(browserSetting, executableOverride);
  if (!browserDebugConfig) {
    return;
  }

  const buildTerminalName = `build --watch (${project.name})`;
  const serveTerminalName = `serve dist (${project.name})`;
  const sessionName = `Node Debug Build Watch (${project.name})`;

  const buildTerminal = await runInTerminal(
    buildTerminalName,
    `npm run ${watchScript}`,
    project.dir,
    { trackAsServe: true },
  );
  const serveTerminal = await runInTerminal(serveTerminalName, serverCommand, project.dir, {
    trackAsServe: true,
  });

  const serveEntry = activeServeTerminals.get(serveTerminalName);
  if (serveEntry) {
    serveEntry.debugConfig = {
      workspaceFolder,
      port,
      sessionName,
      browserSetting,
      browserDebugConfig,
    };
  }

  logDiagnostic(`Starting build watch debug session for ${project.name} on port ${port}`);

  launchBrowserDebugSession(context, workspaceFolder, serveTerminal, {
    port,
    sessionName,
    browserSetting,
    browserDebugConfig,
    progressTitle: `Starting build watch + static server for "${project.name}" on port ${port}…`,
    serverName: 'static server',
    additionalTerminals: [buildTerminal],
    onSessionStarted: (session) => {
      const e = activeServeTerminals.get(serveTerminalName);
      if (e) {
        e.activeDebugSession = session;
      }
    },
  });
}

export async function restartNodeServe(context: vscode.ExtensionContext) {
  if (activeServeTerminals.size === 0) {
    vscode.window.showErrorMessage('No active serve / watch terminals found.');
    return;
  }

  let terminalKey: string;
  if (activeServeTerminals.size === 1) {
    terminalKey = [...activeServeTerminals.keys()][0];
  } else {
    const items = [...activeServeTerminals.entries()].map(([name, e]) => ({
      label: name,
      description: e.debugConfig ? '$(debug) debug session active' : undefined,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select terminal to restart',
      title: 'Node Restart',
    });
    if (!picked) {
      return;
    }
    terminalKey = picked.label;
  }

  const entry = activeServeTerminals.get(terminalKey);
  if (!entry) {
    vscode.window.showErrorMessage(`Terminal "${terminalKey}" is no longer active.`);
    return;
  }

  if (entry.activeDebugSession) {
    await vscode.debug.stopDebugging(entry.activeDebugSession);
    entry.activeDebugSession = undefined;
    await new Promise<void>((r) => setTimeout(r, RESTART_DEBUG_STOP_DELAY_MS));
  }

  entry.terminal.show();
  entry.terminal.sendText('\x03');
  await new Promise<void>((r) => setTimeout(r, RESTART_CTRL_C_DELAY_MS));
  entry.terminal.sendText(entry.command);

  if (entry.debugConfig) {
    const { workspaceFolder, port, sessionName, browserSetting, browserDebugConfig } =
      entry.debugConfig;
    launchBrowserDebugSession(context, workspaceFolder, entry.terminal, {
      port,
      sessionName,
      browserSetting,
      browserDebugConfig,
      progressTitle: `Reattaching debugger for "${terminalKey}" on port ${port}…`,
      serverName: terminalKey,
    });
  }
}

// ── Core debug session launcher ───────────────────────────────────────────────

export function launchBrowserDebugSession(
  context: vscode.ExtensionContext,
  workspaceFolder: vscode.WorkspaceFolder,
  terminal: vscode.Terminal,
  options: {
    port: number;
    sessionName: string;
    browserSetting: string;
    browserDebugConfig: BrowserDebugConfig;
    progressTitle: string;
    serverName: string;
    additionalTerminals?: vscode.Terminal[];
    onSessionStarted?: (session: vscode.DebugSession) => void;
  },
): void {
  const allTerminals = [terminal, ...(options.additionalTerminals ?? [])];

  const stopAll = () => {
    for (const t of allTerminals) {
      t.sendText('\x03');
      t.dispose();
    }
  };

  const stopAllDelayed = () => {
    for (const t of allTerminals) {
      t.sendText('\x03');
    }
    setTimeout(() => allTerminals.forEach((t) => t.dispose()), STOP_ALL_DELAYED_MS);
  };

  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: options.progressTitle,
      cancellable: true,
    },
    async (progress, token) => {
      try {
        const ready = await waitForPort(options.port, 600_000, token);

        if (token.isCancellationRequested) {
          stopAll();
          return;
        }

        if (!ready) {
          vscode.window.showErrorMessage(
            `${options.serverName} did not become ready on port ${options.port} within 10 minutes`,
          );
          stopAll();
          return;
        }

        progress.report({ message: 'Server ready — launching debugger…' });

        let targetSession: vscode.DebugSession | undefined;

        const startListener = vscode.debug.onDidStartDebugSession((session) => {
          if (session.name === options.sessionName) {
            targetSession = session;
            options.onSessionStarted?.(session);
            startListener.dispose();
          }
        });
        context.subscriptions.push(startListener);

        const started = await vscode.debug.startDebugging(workspaceFolder, {
          ...options.browserDebugConfig,
          request: 'launch',
          name: options.sessionName,
          url: `http://localhost:${options.port}`,
          webRoot: '${workspaceFolder}',
        });

        if (!started) {
          startListener.dispose();
          const extensionHint: Record<string, string> = {
            firefox: 'Make sure the "Debugger for Firefox" extension is installed in VS Code.',
            safari: 'Make sure the "Safari Debugger" extension is installed in VS Code.',
          };
          const hint =
            extensionHint[options.browserDebugConfig.type] ??
            `Make sure the ${options.browserSetting} debugger extension is available in VS Code.`;
          vscode.window.showErrorMessage(
            `Failed to start ${options.browserSetting} debug session. ${hint}`,
          );
          stopAll();
          return;
        }

        let listenersDisposed = false;
        const disposeListeners = () => {
          if (listenersDisposed) {
            return;
          }
          listenersDisposed = true;
          endListener.dispose();
          terminalCloseListener.dispose();
        };

        const endListener = vscode.debug.onDidTerminateDebugSession((session) => {
          if (targetSession && session.id === targetSession.id) {
            for (const e of activeServeTerminals.values()) {
              if (e.activeDebugSession?.id === session.id) {
                e.activeDebugSession = undefined;
              }
            }
            stopAllDelayed();
            disposeListeners();
          }
        });

        // Clean up endListener if the terminal closes before the debug session ends
        const terminalCloseListener = vscode.window.onDidCloseTerminal((closed) => {
          if (closed === terminal) {
            disposeListeners();
          }
        });

        context.subscriptions.push(endListener, terminalCloseListener);
      } catch (err) {
        logDiagnostic(`Error in debug session launcher: ${err}`);
        vscode.window.showErrorMessage(`Failed to launch debug session: ${err}`);
        stopAll();
      }
    },
  );
}

// ── Port waiting ──────────────────────────────────────────────────────────────

export function waitForPort(
  port: number,
  timeout: number,
  token: vscode.CancellationToken,
): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeout;

    function attempt() {
      if (token.isCancellationRequested || Date.now() >= deadline) {
        resolve(false);
        return;
      }

      const socket = new net.Socket();
      socket.setTimeout(PORT_CHECK_SOCKET_TIMEOUT_MS);

      let handled = false;

      socket.on('connect', () => {
        if (handled) {
          return;
        }
        handled = true;
        socket.destroy();
        resolve(true);
      });

      const onFail = () => {
        if (handled) {
          return;
        }
        handled = true;
        socket.destroy();
        if (token.isCancellationRequested || Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(attempt, PORT_CHECK_INTERVAL_MS);
      };

      socket.on('timeout', onFail);
      socket.on('error', onFail);
      socket.connect(port, 'localhost');
    }

    attempt();
  });
}

async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(PORT_CHECK_SOCKET_TIMEOUT_MS);

    let handled = false;
    const finish = (inUse: boolean) => {
      if (handled) {
        return;
      }
      handled = true;
      socket.destroy();
      resolve(inUse);
    };

    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
    socket.connect(port, 'localhost');
  });
}

// ── Debug config helper ───────────────────────────────────────────────────────

export function resolveBrowserConfig(
  vsConfig: vscode.WorkspaceConfiguration,
): { browserSetting: string; browserDebugConfig: BrowserDebugConfig } | null {
  const browserSetting = vsConfig.get<string>('debug.browser', 'chrome');
  const executableOverride = (vsConfig.get<string>('debug.browserExecutablePath') ?? '').trim();
  const browserDebugConfig = getBrowserDebugConfig(browserSetting, executableOverride);
  if (!browserDebugConfig) {
    return null;
  }
  return { browserSetting, browserDebugConfig };
}

// ── Re-export DebugConfig for use in commands ─────────────────────────────────
export type { DebugConfig };
