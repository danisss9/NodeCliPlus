import type { DependencyKind } from './npm-graph';

export type Severity = 'critical' | 'high' | 'moderate' | 'low';
export type ReviewState = 'complete' | 'partial' | 'cancelled' | 'failed';
export type FindingCategory = 'known-malicious' | 'vulnerability' | 'script-pattern';
export interface InstalledPackage {
  id: string; name: string; version: string; directory: string;
  manifest: Record<string, unknown>; locations: string[];
  kinds: DependencyKind[]; dependencyPath: string[]; workspace: boolean;
}
export interface Evidence {
  file: string; line: number; column: number; snippet: string;
  lifecycle?: string; chain: string[]; derived?: string;
}
export interface SecurityFinding {
  id: string; category: FindingCategory; severity: Severity; confidence: 'high' | 'medium' | 'low';
  packageId: string; packageName: string; version: string; location: string; dependencyPath: string[];
  ruleId: string; title: string; description: string; recommendation: string;
  references: string[]; evidence: Evidence[];
}
export interface ScanCoverage {
  component: 'inventory' | 'catalog' | 'scripts' | 'npm-audit' | 'yara-x';
  state: ReviewState | 'skipped'; messages: string[]; checked: number;
}
export interface SecurityReviewReport {
  schemaVersion: 1; id: string; projectName: string; startedAt: string; finishedAt: string; state: ReviewState;
  installOutcome?: 'success' | 'failed'; engineVersion: string; catalogVersion: string; rulesetVersion: string;
  packageCount: number; inputCount: number; inputBytes: number; findings: SecurityFinding[]; coverage: ScanCoverage[];
}
export interface ScanInput {
  key: string; bytes: Buffer; packageId: string; evidence: Evidence[];
  kind: 'source' | 'command' | 'literal' | 'decoded';
}
export const SECURITY_LIMITS = {
  fileBytes: 5 * 1024 * 1024, totalBytes: 250 * 1024 * 1024,
  decodedBytes: 1024 * 1024, files: 20_000, packages: 20_000, depth: 32,
  yaraSeconds: 120, auditMs: 60_000, threads: 2, outputBytes: 16 * 1024 * 1024,
} as const;
export const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, moderate: 2, low: 3 };
export const REVIEW_NOTICE = 'Static review of files present after installation. Lifecycle scripts may already have executed. Suspicious patterns are indicators for investigation, not proof of malware. Code outside installation-script references and removed or downloaded runtime payloads are not covered.';
