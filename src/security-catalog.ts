import * as semver from 'semver';
import { createHash } from 'crypto';
import { type InstalledPackage, type SecurityFinding, type Severity } from './security-types';

export const CATALOG_VERSION = '2026-09-08.1';
export interface MaliciousPackageEntry {
  name: string; range: string; advisory: string; severity: Severity; description: string; reviewedAt: string;
}
// Seeded from easy-dep-graph (MIT, copyright 2026 danisss9), then checked against
// the linked GitHub advisories. Unsupported seed claims are deliberately omitted.
const entries: [string, string, string, Severity, string][] = [
  ['ua-parser-js', '0.7.29 || 0.8.0 || 1.0.0', 'GHSA-pjwm-rvh2-c87w', 'critical', 'Compromised releases containing installation-time malware.'],
  ['coa', '2.0.3 || 2.0.4 || 2.1.1 || 2.1.3 || 3.0.1 || 3.1.3', 'GHSA-73qr-pfmq-6rp8', 'critical', 'Compromised releases containing embedded malware.'],
  ['rc', '1.2.9 || 1.3.9 || 2.3.9', 'GHSA-g2q5-5433-rhrf', 'critical', 'Compromised releases containing embedded malware.'],
  ['event-stream', '3.3.6', 'GHSA-mh6f-8j2x-4483', 'critical', 'Release introducing the malicious flatmap-stream dependency.'],
  ['flatmap-stream', '>=0', 'GHSA-mh6f-8j2x-4483', 'critical', 'Package identified as malicious in the event-stream compromise.'],
  ['node-ipc', '>=10.1.1 <10.1.3', 'GHSA-97m3-w2cp-4xx6', 'critical', 'Releases containing geographically targeted file destruction.'],
  ['eslint-scope', '3.7.2', 'GHSA-hxxf-q3w9-4xgw', 'critical', 'Unauthorized release containing token-stealing installation code.'],
  ['eslint-config-eslint', '5.0.2', 'GHSA-hxxf-q3w9-4xgw', 'critical', 'Unauthorized release containing token-stealing installation code.'],
  ['crossenv', '<=1.0.1', 'GHSA-c2m4-w5hm-vqjw', 'high', 'Malicious package impersonating a legitimate environment utility.'],
  ['cross-env.js', '>=0.0.0', 'GHSA-hwhq-3hrj-v6v5', 'moderate', 'Package reported as malware.'],
  ['axios', '1.14.1 || 0.30.4', 'GHSA-fw8c-xr5c-95f9', 'critical', 'Compromised releases introducing a malicious installation dependency.'],
];
export const MALICIOUS_PACKAGES: MaliciousPackageEntry[] = entries.map(([name, range, advisory, severity, description]) =>
  ({ name, range, advisory, severity, description, reviewedAt: '2026-09-08' }));
export function findingId(...parts: string[]): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24); }
export function packageFinding(pkg: InstalledPackage, category: SecurityFinding['category'], ruleId: string): SecurityFinding {
  return { id: findingId(pkg.id, category, ruleId), category, severity: 'low', confidence: 'low',
    packageId: pkg.id, packageName: pkg.name, version: pkg.version, location: pkg.id, dependencyPath: pkg.dependencyPath,
    ruleId, title: '', description: '', recommendation: '', references: [], evidence: [] };
}
export function checkMaliciousPackages(packages: InstalledPackage[]): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  for (const pkg of packages) {
    if (pkg.workspace || !semver.valid(pkg.version)) { continue; }
    for (const entry of MALICIOUS_PACKAGES) {
      if (entry.name !== pkg.name || !semver.satisfies(pkg.version, entry.range, { includePrerelease: true })) { continue; }
      findings.push({ ...packageFinding(pkg, 'known-malicious', entry.advisory), confidence: 'high', severity: entry.severity,
        title: `Known malicious release: ${pkg.name}@${pkg.version}`, description: entry.description,
        recommendation: 'Review the linked incident advisory, replace the affected dependency, and investigate the host because installation scripts may already have run.',
        references: [`https://github.com/advisories/${entry.advisory}`] });
    }
  }
  return findings;
}
