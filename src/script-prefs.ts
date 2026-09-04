import * as vscode from 'vscode';
import * as path from 'path';
import type { NodeWorkspaceProject } from './types';
import { getExtensionContext } from './state';
import { pickScriptCandidates } from './pure-utils';

// ── Saved npm-script preferences ───────────────────────────────────────────────
//
// When auto-detection can't find a script for a command (Serve, Build, …) and
// the user picks one manually, the choice can be remembered per project.
// "Never ask again" suppresses the save prompt for that command + project.

interface ScriptPrefsState {
  /** `${commandKey}::${projectName}` -> saved script name */
  saved: Record<string, string>;
  /** `${commandKey}::${projectName}` -> true when the user chose "Never ask again" */
  neverAsk: Record<string, true>;
}

const SCRIPT_PREFS_KEY = 'scriptPrefs';

const COMMAND_KEY_LABELS: Record<string, string> = {
  serve: 'Serve',
  build: 'Build',
  buildWatch: 'Build Watch',
  test: 'Test',
  debugServe: 'Debug',
  debugBuildWatch: 'Debug Build Watch',
  checkBuildErrors: 'Check Build Errors',
};

function commandKeyLabel(commandKey: string): string {
  return COMMAND_KEY_LABELS[commandKey] ?? commandKey;
}

function prefKey(commandKey: string, projectName: string): string {
  return `${commandKey}::${projectName}`;
}

function parsePrefKey(key: string): { commandKey: string; projectName: string } {
  const sep = key.indexOf('::');
  if (sep === -1) {
    return { commandKey: key, projectName: '' };
  }
  return { commandKey: key.slice(0, sep), projectName: key.slice(sep + 2) };
}

function loadScriptPrefs(): ScriptPrefsState {
  return (
    getExtensionContext().workspaceState.get<ScriptPrefsState>(SCRIPT_PREFS_KEY) ?? {
      saved: {},
      neverAsk: {},
    }
  );
}

async function storeScriptPrefs(state: ScriptPrefsState): Promise<void> {
  await getExtensionContext().workspaceState.update(SCRIPT_PREFS_KEY, state);
}

/** Returns the user-saved script for a command + project, when it still exists. */
export function getSavedScript(
  commandKey: string,
  project: NodeWorkspaceProject,
): string | undefined {
  const saved = loadScriptPrefs().saved[prefKey(commandKey, project.name)];
  return saved && saved in project.scripts ? saved : undefined;
}

async function promptToSaveScriptPref(
  commandKey: string,
  project: NodeWorkspaceProject,
  script: string,
): Promise<void> {
  const state = loadScriptPrefs();
  const key = prefKey(commandKey, project.name);
  if (state.neverAsk[key]) {
    return;
  }

  const action = await vscode.window.showInformationMessage(
    `Remember "${script}" as the ${commandKeyLabel(commandKey)} script for "${project.name}"?`,
    'Save',
    "Don't Save",
    'Never Ask Again',
  );
  if (action === 'Save') {
    state.saved[key] = script;
  } else if (action === 'Never Ask Again') {
    delete state.saved[key];
    state.neverAsk[key] = true;
  } else {
    return;
  }
  await storeScriptPrefs(state);
}

/**
 * Picks an npm script for a command: a previously saved choice wins, then
 * alias auto-detection, then a manual QuickPick. After a manual pick the user
 * can save the choice or opt out of future prompts.
 */
export async function pickScriptWithPrefs(options: {
  project: NodeWorkspaceProject;
  aliases: string[];
  title: string;
  placeHolder: string;
  commandKey: string;
}): Promise<string | null> {
  const { project, aliases, title, placeHolder, commandKey } = options;
  const scripts = project.scripts;
  if (!scripts || Object.keys(scripts).length === 0) {
    vscode.window.showWarningMessage(
      `No npm scripts found in ${path.join(project.relativeDir || '.', 'package.json')}.`,
    );
    return null;
  }

  const saved = getSavedScript(commandKey, project);
  if (saved) {
    return saved;
  }

  if (aliases.some((alias) => alias in scripts)) {
    return pickScriptCandidates(scripts, aliases)[0]!;
  }

  const ordered = pickScriptCandidates(scripts, aliases);
  const items: vscode.QuickPickItem[] = ordered.map((name) => ({
    label: name,
    description: scripts[name],
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder,
    title,
    matchOnDescription: true,
  });
  if (!picked) {
    return null;
  }

  await promptToSaveScriptPref(commandKey, project, picked.label);
  return picked.label;
}

// ── Reset command ──────────────────────────────────────────────────────────────

type PrefItem = vscode.QuickPickItem & { key: string };

/** Command: review and remove saved script preferences ("Save" / "Never ask"). */
export async function resetSavedScripts(): Promise<void> {
  const state = loadScriptPrefs();

  const items: PrefItem[] = [];
  for (const [key, script] of Object.entries(state.saved)) {
    const { commandKey, projectName } = parsePrefKey(key);
    items.push({
      label: `$(bookmark) ${commandKeyLabel(commandKey)} — ${projectName}`,
      description: `"${script}"`,
      key,
    });
  }
  for (const key of Object.keys(state.neverAsk)) {
    const { commandKey, projectName } = parsePrefKey(key);
    items.push({
      label: `$(mute) ${commandKeyLabel(commandKey)} — ${projectName}`,
      description: 'Never ask again',
      key,
    });
  }

  if (items.length === 0) {
    vscode.window.showInformationMessage('No saved script preferences found.');
    return;
  }

  const qp = vscode.window.createQuickPick<PrefItem>();
  qp.items = items;
  qp.canSelectMany = true;
  qp.selectedItems = items;
  qp.placeholder = 'Select preferences to remove…';
  qp.title = 'Reset Saved Scripts';

  const chosen = await new Promise<PrefItem[]>((resolve) => {
    qp.onDidAccept(() => {
      resolve([...qp.selectedItems]);
      qp.hide();
    });
    qp.onDidHide(() => resolve([]));
    qp.show();
  });
  qp.dispose();

  if (chosen.length === 0) {
    return;
  }

  for (const item of chosen) {
    delete state.saved[item.key];
    delete state.neverAsk[item.key];
  }
  await storeScriptPrefs(state);
  vscode.window.showInformationMessage(
    `Removed ${chosen.length} script preference${chosen.length > 1 ? 's' : ''}.`,
  );
}
