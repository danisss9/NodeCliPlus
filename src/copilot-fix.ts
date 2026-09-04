import * as vscode from 'vscode';

export type AIProvider = 'copilot' | 'claude';

export interface AIFixOptions {
  /** Absolute path of the file containing the issue */
  file: string;
  /** 1-based line number */
  line: number;
  /** Machine-readable issue kind (e.g. 'uncleared-interval') */
  kind: string;
  /** Human-readable label for the kind (e.g. 'Uncleared Interval') */
  kindLabel: string;
  /** The code snippet as shown in the webview */
  snippet: string;
  /** Short description of the problem */
  description: string;
  /** Concrete fix instruction */
  fixHint: string;
}

export interface AIFixFileOptions {
  /** Absolute path of the file */
  file: string;
  /** All issues in the file */
  issues: Array<{
    line: number;
    kind: string;
    kindLabel: string;
    snippet: string;
    description: string;
    fixHint: string;
  }>;
  /** Context label for the title (e.g. 'Memory Leak', 'Build Error') */
  issueType: string;
}

// Keep old interfaces for backward compatibility
export type CopilotFixOptions = AIFixOptions;
export type CopilotFixFileOptions = AIFixFileOptions;

/**
 * Gets the configured AI provider from settings.
 */
export function getAIProvider(): AIProvider {
  const config = vscode.workspace.getConfiguration('nodeCliPlus');
  const provider = config.get<string>('ai.provider', 'copilot');
  return provider === 'claude' ? 'claude' : 'copilot';
}

/**
 * Opens AI Chat (Copilot or Claude Code) with a fix prompt for a single issue.
 */
export async function sendAIAutoFix(opts: AIFixOptions): Promise<void> {
  const prompt = buildSinglePrompt(opts);
  await openAIChatWithPrompt(prompt, getAIProvider());
}

/**
 * Opens AI Chat (Copilot or Claude Code) with a fix prompt covering all issues in a single file.
 */
export async function sendAIAutoFixForFile(opts: AIFixFileOptions): Promise<void> {
  const prompt = buildFilePrompt(opts);
  await openAIChatWithPrompt(prompt, getAIProvider());
}

// Keep old functions for backward compatibility
export async function sendCopilotAutoFix(opts: CopilotFixOptions): Promise<void> {
  const prompt = buildSinglePrompt(opts);
  await openAIChatWithPrompt(prompt, 'copilot');
}

export async function sendCopilotAutoFixForFile(opts: CopilotFixFileOptions): Promise<void> {
  const prompt = buildFilePrompt(opts);
  await openAIChatWithPrompt(prompt, 'copilot');
}

async function openAIChatWithPrompt(prompt: string, provider: AIProvider): Promise<void> {
  const providerName = provider === 'claude' ? 'Claude Code' : 'GitHub Copilot';

  try {
    if (provider === 'claude') {
      // The Claude Code extension contributes `claude-vscode.editor.open`, which
      // accepts (sessionId, initialPrompt, viewColumn) and pre-fills the prompt
      // box in the Claude Code panel.
      await vscode.commands.executeCommand(
        'claude-vscode.editor.open',
        undefined,
        prompt,
        vscode.ViewColumn.Active,
      );
    } else {
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: prompt,
      });
    }
  } catch {
    // AI Chat not available — copy to clipboard as fallback
    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showWarningMessage(
      `${providerName} does not appear to be available. The fix prompt has been copied to your clipboard.`,
    );
  }
}

function buildSinglePrompt(opts: CopilotFixOptions): string {
  return [
    `**[Node CLI Plus] Auto Fix — ${opts.kindLabel}**`,
    ``,
    `**File:** \`${opts.file}\` (Line ${opts.line})`,
    `**Issue type:** ${opts.kindLabel} (\`${opts.kind}\`)`,
    ``,
    `**Code snippet (line ${opts.line}):**`,
    `\`\`\`typescript`,
    opts.snippet.trim(),
    `\`\`\``,
    ``,
    `**Problem:** ${opts.description}`,
    ``,
    `**Fix:** ${opts.fixHint}`,
    ``,
    `Please open \`${opts.file}\`, locate line ${opts.line}, and apply the fix described above. ` +
      `Ensure the change is minimal and correct. Do not alter unrelated code.`,
  ].join('\n');
}

function buildFilePrompt(opts: CopilotFixFileOptions): string {
  const issueCount = opts.issues.length;
  const issueLines = opts.issues
    .map((issue, i) => {
      return [
        `### Issue ${i + 1} — ${issue.kindLabel} (Line ${issue.line})`,
        ``,
        `**Code snippet:**`,
        `\`\`\`typescript`,
        issue.snippet.trim(),
        `\`\`\``,
        ``,
        `**Problem:** ${issue.description}`,
        `**Fix:** ${issue.fixHint}`,
      ].join('\n');
    })
    .join('\n\n');

  return [
    `**[Node CLI Plus] Auto Fix All — ${issueCount} ${opts.issueType}${issueCount !== 1 ? 's' : ''} in \`${opts.file}\`**`,
    ``,
    issueLines,
    ``,
    `Please open \`${opts.file}\` and fix all ${issueCount} issue${issueCount !== 1 ? 's' : ''} listed above. ` +
      `Apply each fix at the correct line. Ensure changes are minimal and correct. Do not alter unrelated code.`,
  ].join('\n');
}
