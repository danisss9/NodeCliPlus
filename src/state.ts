import * as vscode from 'vscode';
import type { PersistedTerminalEntry, ServeEntry, TerminalCommandState } from './types';

export const npmOutput = vscode.window.createOutputChannel('Node CLI Plus: npm');
export const scriptsOutput = vscode.window.createOutputChannel('Node CLI Plus: scripts');
export const diagnosticOutput = vscode.window.createOutputChannel('Node CLI Plus: diagnostics');

export const activeServeTerminals = new Map<string, ServeEntry>();
export const extensionTerminals = new Set<vscode.Terminal>();
export const terminalCommandStates = new Map<vscode.Terminal, TerminalCommandState>();
export const depCheckTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

export function setTrackedTerminalRunning(terminal: vscode.Terminal): void {
  terminalCommandStates.set(terminal, 'running');
}

export function setTrackedTerminalFinished(
  terminal: vscode.Terminal,
  exitCode: number | undefined,
): void {
  if (exitCode === undefined) {
    terminalCommandStates.set(terminal, 'killed');
    return;
  }
  if (exitCode === 0) {
    terminalCommandStates.set(terminal, 'terminated');
    return;
  }
  terminalCommandStates.set(terminal, 'errored');
}

export function getTrackedTerminalState(
  terminal: vscode.Terminal,
): TerminalCommandState | undefined {
  return terminalCommandStates.get(terminal);
}

export function clearTrackedTerminalState(terminal: vscode.Terminal): void {
  terminalCommandStates.delete(terminal);
}

const TERMINAL_ENTRIES_KEY = 'terminalEntries';

let _extensionContext: vscode.ExtensionContext;

export function setExtensionContext(ctx: vscode.ExtensionContext): void {
  _extensionContext = ctx;
}

export function getExtensionContext(): vscode.ExtensionContext {
  return _extensionContext;
}

export function logDiagnostic(message: string): void {
  diagnosticOutput.appendLine(`[${new Date().toISOString()}] ${message}`);
}

// Chains reads/writes of the persisted-terminal map so two calls in quick
// succession (e.g. two terminals created back-to-back) can't interleave their
// get-modify-update and silently drop one entry.
let terminalStateQueue: Promise<void> = Promise.resolve();

function updateTerminalEntries(
  mutate: (map: Record<string, PersistedTerminalEntry>) => void,
): void {
  terminalStateQueue = terminalStateQueue.then(async () => {
    const map =
      _extensionContext.workspaceState.get<Record<string, PersistedTerminalEntry>>(
        TERMINAL_ENTRIES_KEY,
      ) ?? {};
    mutate(map);
    await _extensionContext.workspaceState.update(TERMINAL_ENTRIES_KEY, map);
  });
}

export function persistTerminalEntry(name: string, entry: PersistedTerminalEntry): void {
  updateTerminalEntries((map) => {
    map[name] = entry;
  });
}

export function removePersistedTerminalEntry(name: string): void {
  updateTerminalEntries((map) => {
    if (Object.prototype.hasOwnProperty.call(map, name)) {
      delete map[name];
    }
  });
}

export function loadPersistedTerminalEntries(): Record<string, PersistedTerminalEntry> {
  return (
    _extensionContext.workspaceState.get<Record<string, PersistedTerminalEntry>>(
      TERMINAL_ENTRIES_KEY,
    ) ?? {}
  );
}
