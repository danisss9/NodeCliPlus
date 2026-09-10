import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { runNpmInstall } from '../dependencies';
import { resolveEvidenceFile } from '../security-command';
import { contained } from '../security-files';
import type { SecurityReviewReport } from '../security-types';

suite('Security review extension integration', () => {
  test('registers the command and defaults both review settings to enabled', async () => {
    const extension = vscode.extensions.getExtension('danisss9.node-cli-plus'); assert.ok(extension); await extension.activate();
    assert.ok((await vscode.commands.getCommands(true)).includes('node-cli-plus.reviewPackageSecurity'));
    const properties = extension.packageJSON.contributes.configuration.properties;
    assert.equal(properties['nodeCliPlus.securityReview.afterInstall.enabled'].default, true);
    assert.equal(properties['nodeCliPlus.securityReview.npmAudit.enabled'].default, true);
    assert.equal(extension.packageJSON.contributes.commands.find((command: { command: string }) => command.command === 'node-cli-plus.reviewPackageSecurity').enablement, 'isWorkspaceTrusted');
  });
  test('normal, forced, clean and custom installs produce one review after their final outcome', async () => {
    // Replace only the process boundary and review hooks; exercise the actual install/retry implementation.
    const managed = require('../managed-process') as typeof import('../managed-process');
    const security = require('../security-command') as typeof import('../security-command');
    const previous = { spawn: managed.spawnManaged, begin: security.beginSecurityInstall, end: security.endSecurityInstall,
      config: vscode.workspace.getConfiguration, info: vscode.window.showInformationMessage, error: vscode.window.showErrorMessage };
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-security-installs-'));
    let exitCodes: number[] = [], decisions: string[] = [], custom: Record<string, string | undefined> = {};
    const invocations: string[][] = [], starts: string[] = [], ends: unknown[] = [];
    try {
      managed.spawnManaged = async (command, args) => { invocations.push([command, ...args]); return { stdout: '', standardOutput: '', standardError: '', exitCode: exitCodes.shift() ?? 0 }; };
      security.beginSecurityInstall = async selected => { starts.push(selected); return selected; };
      security.endSecurityInstall = (selected, outcome) => { ends.push({ selected, outcome }); };
      vscode.workspace.getConfiguration = (() => ({ get: (key: string) => custom[key] })) as unknown as typeof vscode.workspace.getConfiguration;
      vscode.window.showInformationMessage = (async () => undefined) as typeof vscode.window.showInformationMessage;
      vscode.window.showErrorMessage = (async () => decisions.shift()) as typeof vscode.window.showErrorMessage;
      for (const scenario of [
        { clean: false, force: false, codes: [0], decisions: [], expected: 'success', calls: 1 },
        { clean: true, force: false, codes: [0], decisions: [], expected: 'success', calls: 1 },
        { clean: false, force: true, codes: [1], decisions: [], expected: 'failed', calls: 1 },
        { clean: false, force: false, codes: [1, 1, 0], decisions: ['Run Clean Install', 'Run with --force'], expected: 'success', calls: 3 },
        { clean: false, force: false, codes: [1], decisions: [], expected: 'failed', calls: 1, custom: { 'npm.installCommand': 'pnpm install' } },
        { clean: true, force: false, codes: [0], decisions: [], expected: 'success', calls: 1, custom: { 'npm.cleanInstallCommand': 'yarn install' } },
      ]) {
        starts.length = 0; ends.length = 0; invocations.length = 0;
        exitCodes = [...scenario.codes]; decisions = [...scenario.decisions]; custom = scenario.custom ?? {};
        await runNpmInstall(scenario.clean, scenario.force, root);
        assert.deepEqual(starts, [root]); assert.deepEqual(ends, [{ selected: root, outcome: scenario.expected }]); assert.equal(invocations.length, scenario.calls);
      }
    } finally {
      managed.spawnManaged = previous.spawn; security.beginSecurityInstall = previous.begin; security.endSecurityInstall = previous.end;
      vscode.workspace.getConfiguration = previous.config; vscode.window.showInformationMessage = previous.info; vscode.window.showErrorMessage = previous.error;
      assert.ok(contained(os.tmpdir(), root) && path.basename(root).startsWith('acp-security-installs-')); await fs.rm(root, { recursive: true, force: true });
    }
  });
  test('file navigation requires a report-owned ID/index and rejects paths or links outside the workspace', async () => {
    // Match validRoot(): containment checks use canonical paths, but TEMP may be a short path or junction.
    const temporaryRoot = await fs.realpath(os.tmpdir());
    const root = await fs.mkdtemp(path.join(temporaryRoot, 'acp-security-navigation-'));
    try {
      await fs.writeFile(path.join(root, 'install.js'), 'inert');
      await fs.symlink(os.tmpdir(), path.join(root, 'external'), 'junction');
      const report = { findings: [{ id: 'approved', evidence: [{ file: 'install.js', line: 2, column: 1 }, { file: '../outside', line: 1, column: 1 }, { file: 'external', line: 1, column: 1 }] }] } as SecurityReviewReport;
      assert.equal((await resolveEvidenceFile(root, report, 'approved', 0))?.file, path.join(root, 'install.js'));
      assert.equal(await resolveEvidenceFile(root, report, 'untrusted', 0), undefined);
      assert.equal(await resolveEvidenceFile(root, report, 'approved', -1), undefined);
      assert.equal(await resolveEvidenceFile(root, report, 'approved', 1), undefined);
      await assert.rejects(resolveEvidenceFile(root, report, 'approved', 2), /outside workspace/);
    } finally {
      assert.ok(contained(temporaryRoot, root) && path.basename(root).startsWith('acp-security-navigation-')); await fs.rm(root, { recursive: true, force: true });
    }
  });
});
