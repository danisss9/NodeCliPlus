import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { asObject } from './npm-graph';
import { CATALOG_VERSION, checkMaliciousPackages, packageFinding } from './security-catalog';
import { collectPackages } from './security-inventory';
import { discoverInstallInputs } from './security-scripts';
import { runNpmAudit } from './security-audit';
import { ENGINE_VERSION, ensureYaraEngine } from './security-engine';
import { checkCancelled, contained, errorMessage } from './security-files';
import { spawnManaged, type SpawnManagedResult } from './managed-process';
import { SECURITY_LIMITS, SEVERITY_ORDER, type Evidence, type InstalledPackage, type ScanCoverage, type ScanInput, type SecurityFinding, type SecurityReviewReport } from './security-types';

export const RULESET_VERSION = '1.0.0';
export interface ReviewOptions {
  root: string; storage: string; rules: string; auditEnabled: boolean; signal?: AbortSignal;
  installOutcome?: 'success' | 'failed'; onProgress?: (stage: string) => void;
  engineProvider?: (storage: string, signal?: AbortSignal) => Promise<string>;
  auditRunner?: () => Promise<SpawnManagedResult>;
}
export function parseYaraOutput(stdout: string, snapshots: Map<string, ScanInput>, packages: InstalledPackage[]): SecurityFinding[] {
  const findings = new Map<string, SecurityFinding>();
  for (const line of stdout.split(/\r?\n/).filter(line => line.trim())) {
    const item = asObject(JSON.parse(line));
    if (typeof item.path !== 'string' || !Array.isArray(item.rules)) { throw new Error('Malformed YARA-X result'); }
    const input = snapshots.get(path.resolve(item.path));
    if (!input) { throw new Error('YARA-X returned an unexpected scan path'); }
    const pkg = packages.find(pkg => pkg.id === input.packageId);
    if (!pkg) { throw new Error('YARA-X result has no package owner'); }
    for (const raw of item.rules) {
      const rule = asObject(raw);
      if (typeof rule.identifier !== 'string' || !rule.identifier.startsWith('acp_') || !Array.isArray(rule.meta)) { throw new Error('Malformed YARA-X rule metadata'); }
      const meta = Object.fromEntries(rule.meta.filter((entry): entry is [string, unknown] => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'));
      if (!['high', 'moderate', 'low'].includes(String(meta.severity)) || !['high', 'medium', 'low'].includes(String(meta.confidence))
        || typeof meta.title !== 'string' || typeof meta.description !== 'string') { throw new Error('Invalid YARA-X finding classification'); }
      const base = packageFinding(pkg, 'script-pattern', rule.identifier);
      const matches = Array.isArray(rule.strings) ? rule.strings.map(asObject) : [];
      const evidence: Evidence[] = input.evidence.map(origin => {
        const offset = matches.map(match => match.offset).find((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < input.bytes.length) ?? 0;
        if (input.kind !== 'source') { return { ...origin, snippet: matches.map(match => String(match.match ?? '')).join(' … ').slice(0, 500) || origin.snippet }; }
        const prefix = input.bytes.subarray(0, offset).toString();
        const lines = prefix.split('\n');
        return { ...origin, line: lines.length, column: lines[lines.length - 1].length + 1,
          snippet: input.bytes.subarray(Math.max(0, offset - 80), Math.min(input.bytes.length, offset + 300)).toString() };
      });
      const existing = findings.get(base.id);
      if (existing) { existing.evidence.push(...evidence); }
      else { findings.set(base.id, { ...base, severity: meta.severity as SecurityFinding['severity'], confidence: meta.confidence as SecurityFinding['confidence'], title: meta.title,
        description: meta.description, recommendation: 'Inspect the installation hook and the reference chain. Confirm whether the behavior is expected before replacing or updating the dependency.', evidence,
        references: ['https://virustotal.github.io/yara-x/docs/'] }); }
    }
  }
  return [...findings.values()];
}

export async function reviewPackageSecurity(options: ReviewOptions): Promise<SecurityReviewReport> {
  const report: SecurityReviewReport = { schemaVersion: 1, id: randomUUID(), projectName: path.basename(options.root),
    startedAt: new Date().toISOString(), finishedAt: '', state: 'complete', installOutcome: options.installOutcome,
    engineVersion: ENGINE_VERSION, catalogVersion: CATALOG_VERSION, rulesetVersion: RULESET_VERSION,
    packageCount: 0, inputCount: 0, inputBytes: 0, findings: [], coverage: [] };
  let temporary: string | undefined;
  let stage: ScanCoverage['component'] = 'inventory';
  const progress = (component: ScanCoverage['component'], message: string) => { stage = component; options.onProgress?.(message); };
  try {
    checkCancelled(options.signal);
    progress('inventory', 'Reading installed package manifests…');
    const inventory = await collectPackages(options.root, options.signal);
    report.projectName = inventory.packages.find(pkg => pkg.directory === inventory.root)?.name ?? report.projectName;
    report.packageCount = inventory.packages.filter(pkg => !pkg.workspace).length;
    report.coverage.push(inventory.coverage);
    progress('catalog', 'Checking known malicious package versions…');
    report.findings.push(...checkMaliciousPackages(inventory.packages));
    report.coverage.push({ component: 'catalog', state: 'complete', checked: report.packageCount,
      messages: [`Curated catalog ${CATALOG_VERSION}; not a comprehensive malware feed.`] });
    progress('npm-audit', 'Checking live npm advisories…');
    const audit = await runNpmAudit(inventory.root, inventory.packages, options.auditEnabled, options.signal, options.auditRunner);
    report.coverage.push(audit.coverage); report.findings.push(...audit.findings);
    progress('scripts', 'Resolving installation scripts and local references…');
    const discovery = await discoverInstallInputs(inventory, options.signal);
    report.coverage.push(discovery.coverage); report.inputCount = discovery.inputs.length; report.inputBytes = discovery.bytes;
    progress('yara-x', 'Preparing the verified YARA-X engine…');
    if (!discovery.inputs.length) {
      report.coverage.push({ component: 'yara-x', state: 'complete', checked: 0, messages: ['No resolvable installation-script inputs to scan.'] });
    } else {
      const engine = await (options.engineProvider ?? ensureYaraEngine)(options.storage, options.signal);
      checkCancelled(options.signal);
      const scratchRoot = path.resolve(options.storage, 'scans');
      await fs.mkdir(scratchRoot, { recursive: true });
      temporary = await fs.mkdtemp(path.join(scratchRoot, 'review-'));
      const snapshots = new Map<string, ScanInput>();
      for (let index = 0; index < discovery.inputs.length; index++) {
        checkCancelled(options.signal);
        const input = discovery.inputs[index];
        const snapshot = path.join(temporary, `${index}.input`);
        await fs.writeFile(snapshot, input.bytes, { mode: 0o600, flag: 'wx' }); snapshots.set(snapshot, input);
      }
      const list = path.join(temporary, 'inputs.txt');
      await fs.writeFile(list, [...snapshots.keys()].join('\n'), { mode: 0o600 });
      const compiled = path.join(temporary, 'rules.yarc');
      const common = { cwd: temporary, shell: false, maxOutputBytes: SECURITY_LIMITS.outputBytes, signal: options.signal };
      const compile = await spawnManaged(engine, ['compile', path.resolve(options.rules), '--output', compiled], { ...common, timeoutMs: 30_000 });
      checkCancelled(options.signal);
      if (compile.exitCode !== 0) { throw new Error(`YARA-X rule compilation failed: ${compile.standardError.slice(0, 1000)}`); }
      progress('yara-x', `Scanning ${snapshots.size} installation inputs with YARA-X…`);
      const scan = await spawnManaged(engine, ['scan', '--compiled-rules', '--scan-list', '--output-format', 'ndjson',
        '--print-meta', '--print-strings=160', '--disable-console-logs', '--no-mmap', '--threads', String(SECURITY_LIMITS.threads),
        '--timeout', String(SECURITY_LIMITS.yaraSeconds), compiled, list], { ...common, timeoutMs: (SECURITY_LIMITS.yaraSeconds + 5) * 1000 });
      // Retain complete NDJSON records when interrupted, but never claim complete coverage.
      const output = scan.cancelled || scan.timedOut || scan.outputLimited ? scan.standardOutput.slice(0, scan.standardOutput.lastIndexOf('\n') + 1) : scan.standardOutput;
      report.findings.push(...parseYaraOutput(output, snapshots, inventory.packages));
      checkCancelled(options.signal);
      const messages = [scan.timedOut ? 'YARA-X scan timed out.' : '', scan.outputLimited ? 'YARA-X output limit reached.' : '', scan.standardError.trim().slice(0, 2000)].filter(Boolean);
      if (scan.exitCode !== 0) { messages.push(`YARA-X exited with code ${scan.exitCode}; results may be incomplete.`); }
      if (messages.length) { messages.push(`${snapshots.size} inputs submitted; completed input count is unavailable for this interrupted or incomplete scan.`); }
      report.coverage.push({ component: 'yara-x', state: messages.length ? 'partial' : 'complete', checked: messages.length ? 0 : snapshots.size, messages });
    }
  } catch (error) {
    const cancelled = options.signal?.aborted;
    report.coverage.push({ component: stage, state: cancelled ? 'cancelled' : 'failed', checked: 0,
      messages: [cancelled ? 'Review cancelled. Only completed checks are included.' : errorMessage(error)] });
    report.state = cancelled ? 'cancelled' : stage === 'inventory' ? 'failed' : 'partial';
  } finally {
    if (temporary && contained(path.resolve(options.storage, 'scans'), temporary) && path.basename(temporary).startsWith('review-')) {
      await fs.rm(temporary, { recursive: true, force: true }).catch(error => report.coverage.push({ component: 'yara-x', state: 'partial', checked: 0, messages: [`Temporary scan cleanup failed: ${errorMessage(error)}`] }));
    }
  }
  for (const component of ['inventory', 'catalog', 'npm-audit', 'scripts', 'yara-x'] as const) {
    if (!report.coverage.some(item => item.component === component)) { report.coverage.push({ component, state: 'skipped', checked: 0, messages: ['Not reached in this review.'] }); }
  }
  if (report.state === 'complete' && report.coverage.some(item => ['partial', 'failed', 'cancelled'].includes(item.state))) { report.state = 'partial'; }
  report.findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.packageName.localeCompare(b.packageName) || a.ruleId.localeCompare(b.ruleId));
  report.finishedAt = new Date().toISOString();
  return report;
}
