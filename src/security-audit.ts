import * as fs from 'fs/promises';
import * as path from 'path';
import * as semver from 'semver';
import { asObject } from './npm-graph';
import { packageFinding } from './security-catalog';
import { checkCancelled, contained } from './security-files';
import { spawnManaged, type SpawnManagedResult } from './managed-process';
import { SECURITY_LIMITS, type InstalledPackage, type ScanCoverage, type SecurityFinding, type Severity } from './security-types';

export const AUDIT_ARGS = ['audit', '--json', '--ignore-scripts', '--include=dev', '--include=optional', '--include=peer'];
const severity = (value: unknown): Severity => ['critical', 'high', 'moderate', 'low'].includes(String(value)) ? value as Severity : 'moderate';
export function parseAudit(data: unknown, packages: InstalledPackage[]): { findings: SecurityFinding[]; diagnostics: string[] } {
  const audit = asObject(data);
  if (audit.error) { throw new Error(`npm audit error: ${String(asObject(audit.error).code ?? 'registry error')}`); }
  if (!audit.vulnerabilities || typeof audit.vulnerabilities !== 'object' || Array.isArray(audit.vulnerabilities)) { throw new Error('Unsupported npm audit JSON; expected vulnerabilities object'); }
  const vulnerabilities = asObject(audit.vulnerabilities);
  const findings = new Map<string, SecurityFinding>(); const diagnostics: string[] = [];
  function advisories(name: string, visited = new Set<string>()): Record<string, unknown>[] {
    if (visited.has(name)) { return []; } visited.add(name);
    const via = asObject(vulnerabilities[name]).via;
    return Array.isArray(via) ? via.flatMap(item => typeof item === 'string' ? advisories(item, visited) : [asObject(item)]) : [];
  }
  for (const [name, value] of Object.entries(vulnerabilities)) {
    const info = asObject(value);
    const nodes = Array.isArray(info.nodes) ? info.nodes.filter((node): node is string => typeof node === 'string').map(node => node.replace(/\\/g, '/')) : [];
    const affected = packages.filter(pkg => !pkg.workspace && (nodes.length ? pkg.locations.some(location => nodes.includes(location)) : pkg.name === name)
      && (typeof info.range !== 'string' || !semver.valid(pkg.version) || semver.satisfies(pkg.version, info.range, { includePrerelease: true })));
    if (!affected.length) { diagnostics.push(`${name}: audit describes a dependency not mapped to an affected installed version (lockfile may differ).`); continue; }
    const sources = advisories(name);
    if (!sources.length) { diagnostics.push(`${name}: audit supplied no resolvable advisory evidence`); }
    for (const pkg of affected) {
      for (const source of sources) {
        const id = String(source.source ?? source.url ?? source.title ?? 'unknown-advisory');
        const finding = packageFinding(pkg, 'vulnerability', id);
        findings.set(finding.id, { ...finding, confidence: 'high', severity: severity(source.severity ?? info.severity),
          title: String(source.title ?? `Vulnerability affecting ${name}`),
          description: `npm audit reports ${name}${source.name !== name ? ` through ${String(source.name ?? 'a dependency')}` : ''}. Affected range: ${String(source.range ?? info.range ?? 'unspecified')}.`,
          recommendation: info.fixAvailable ? 'Review the advisory and available dependency update before changing the lockfile.' : 'Review the advisory for mitigation or replacement guidance.',
          references: typeof source.url === 'string' && /^https?:\/\//.test(source.url) ? [source.url] : [] });
      }
    }
  }
  return { findings: [...findings.values()], diagnostics };
}
export async function findNpmExecutable(root: string): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(directory) || contained(root, directory)) { continue; }
    try {
      const candidate = await fs.realpath(path.join(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm'));
      if (!contained(root, candidate) && (await fs.stat(candidate)).isFile()) { return candidate; }
    } catch { /* Try the next system PATH entry, never workspace-local commands. */ }
  }
  throw new Error('npm executable is unavailable on the system PATH');
}
export async function runNpmAudit(root: string, packages: InstalledPackage[], enabled: boolean, signal?: AbortSignal,
  runner?: () => Promise<SpawnManagedResult>): Promise<{ findings: SecurityFinding[]; coverage: ScanCoverage }> {
  const coverage: ScanCoverage = { component: 'npm-audit', state: 'complete', messages: [], checked: 0 };
  if (!enabled) { coverage.state = 'skipped'; coverage.messages.push('Live npm audit disabled in settings.'); return { findings: [], coverage }; }
  const locks = await Promise.all(['package-lock.json', 'npm-shrinkwrap.json'].map(file => fs.access(path.join(root, file)).then(() => true, () => false)));
  if (!locks.some(Boolean)) { coverage.state = 'partial'; coverage.messages.push('No npm lockfile; live npm audit is unavailable for this installation.'); return { findings: [], coverage }; }
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, npm_config_ignore_scripts: 'true' };
    delete env.NODE_OPTIONS; delete env.NODE_PATH;
    const args = [...AUDIT_ARGS];
    if (packages.find(pkg => pkg.directory === root)?.manifest.workspaces) { args.push('--workspaces', '--include-workspace-root'); }
    const result = runner ? await runner() : await spawnManaged(await findNpmExecutable(root), args,
      { cwd: root, shell: process.platform === 'win32', timeoutMs: SECURITY_LIMITS.auditMs, maxOutputBytes: SECURITY_LIMITS.outputBytes, signal, env });
    checkCancelled(signal);
    if (result.timedOut || result.outputLimited || result.cancelled || ![0, 1].includes(result.exitCode)) { throw new Error(result.timedOut ? 'npm audit timed out' : result.outputLimited ? 'npm audit output exceeded the limit' : `npm audit failed (exit ${result.exitCode})`); }
    const parsed = parseAudit(JSON.parse(result.standardOutput), packages);
    coverage.checked = packages.length;
    if (parsed.diagnostics.length) { coverage.state = 'partial'; coverage.messages = parsed.diagnostics; }
    return { findings: parsed.findings, coverage };
  } catch (error) {
    checkCancelled(signal); coverage.state = 'failed';
    coverage.messages.push(error instanceof Error ? error.message : String(error));
    return { findings: [], coverage };
  }
}
