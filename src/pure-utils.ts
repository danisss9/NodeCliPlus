/**
 * Pure utility functions with zero VS Code dependencies.
 * These are extracted here so they can be unit-tested without a VS Code host process.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';
import type { NodeWorkspaceProject } from './types';

// ── String helpers ─────────────────────────────────────────────────────────────

export function toKebabCase(str: string): string {
  return str.replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

// ── Semver ────────────────────────────────────────────────────────────────────

/**
 * Returns true if `installed` satisfies the `required` semver range.
 * Non-semver specifiers (git, file, workspace, URLs) always return true.
 *
 * The installed version is compared with its prerelease/build metadata intact
 * (via `semver.valid`), so a prerelease install such as `18.1.0-rc.0` correctly
 * satisfies a matching prerelease range like `^18.1.0-rc.0`. `semver.coerce` is
 * only used as a fallback for loosely-formatted versions (e.g. `v14.21.0`,
 * `1.2`) that `semver.valid` rejects — coercion there drops prerelease tags,
 * which is acceptable because such inputs are not strict semver to begin with.
 */
export function semverSatisfies(installed: string, required: string): boolean {
  const req = required.trim();
  if (!req || req === '*' || req === 'latest') {
    return true;
  }
  if (/^(git|file:|workspace:|https?:|github:)/.test(req)) {
    return true;
  }

  try {
    // Prefer the exact version so prerelease/build metadata is preserved.
    const parsed = semver.valid(installed) ?? semver.coerce(installed);
    if (!parsed) {
      return true;
    } // unparseable installed version: safe default
    return semver.satisfies(parsed, req);
  } catch {
    return true;
  }
}

// ── Command validation ────────────────────────────────────────────────────────

/**
 * Validates a user-provided shell command before passing it to spawn.
 * Returns an error message string if invalid, or null if valid.
 */
export function validateCustomCommand(command: string): string | null {
  if (!command || command.trim() === '') {
    return 'Command cannot be empty';
  }
  if (/[;|&`$]\s*(rm|del|format|mkfs|dd)\b/i.test(command)) {
    return 'Command contains potentially dangerous operations';
  }
  if (/\$\(|`/.test(command)) {
    return 'Command contains shell substitution which is not allowed';
  }
  if (/[;|&]\s*(powershell|cmd|bash|sh|curl|wget|nc|ncat)\b/i.test(command)) {
    return 'Command contains potentially dangerous chained operations';
  }
  if (/>\s*\/dev\/|>\s*[A-Za-z]:\\/.test(command)) {
    return 'Command contains suspicious output redirection';
  }
  return null;
}

// ── Path containment ───────────────────────────────────────────────────────────

/**
 * Returns true when `child` is inside (or equal to) `parent`. Uses `path.relative`
 * instead of `startsWith` so a sibling directory with the same prefix (e.g.
 * `C:\proj` vs `C:\proj-other`) isn't mistaken for a containment match, and
 * compares case-insensitively on Windows.
 */
export function isPathInside(parent: string, child: string): boolean {
  const caseSensitive = process.platform !== 'win32';
  const p = caseSensitive ? parent : parent.toLowerCase();
  const c = caseSensitive ? child : child.toLowerCase();
  const rel = path.relative(p, c);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ── Workspace project matching ─────────────────────────────────────────────────

/**
 * Returns the names of all projects whose directory contains `folderPath`.
 * Used when resolving right-clicked folders / active files to a project.
 */
export function findMatchingProjects(
  folderPath: string,
  projects: NodeWorkspaceProject[],
): string[] {
  const caseSensitive = process.platform !== 'win32';
  const folder = caseSensitive ? folderPath : folderPath.toLowerCase();
  return projects
    .filter((p) => {
      const dir = caseSensitive ? p.dir : p.dir.toLowerCase();
      return folder === dir || folder.startsWith(dir + path.sep);
    })
    .map((p) => p.name);
}

/**
 * Returns the name of the project whose directory most specifically contains
 * `filePath` (longest matching directory wins). Used to infer the current
 * project from the active editor file. Falls back to the root project when no
 * workspace package contains the file.
 */
export function findBestProjectForPath(
  filePath: string,
  projects: NodeWorkspaceProject[],
): string | null {
  const caseSensitive = process.platform !== 'win32';
  const fileDir = path.dirname(filePath);

  let bestMatch: { name: string; dirLen: number } | null = null;

  for (const project of projects) {
    const dir = caseSensitive ? project.dir : project.dir.toLowerCase();
    const target = caseSensitive ? fileDir : fileDir.toLowerCase();
    if (target === dir || target.startsWith(dir + path.sep)) {
      if (!bestMatch || dir.length > bestMatch.dirLen) {
        bestMatch = { name: project.name, dirLen: dir.length };
      }
    }
  }

  return bestMatch?.name ?? null;
}

// ── npm workspaces glob expansion ───────────────────────────────────────────────

/** Converts a single path-segment glob ('pack*', 'apps') into a RegExp. */
function globSegmentToRegExp(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Expands one npm `workspaces` pattern (e.g. 'packages/*', 'apps/**',
 * 'tools') into the list of relative directories it matches. Only directories
 * that actually contain a package.json are returned; node_modules is skipped
 * at every level. Uses `exists` so it can be stubbed in tests.
 */
export function expandWorkspacePattern(
  root: string,
  pattern: string,
  exists: (p: string) => boolean = fs.existsSync,
  readdir: (
    p: string,
  ) => Array<{ name: string; isDirectory: boolean }> = (p) =>
    fs.readdirSync(p, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
    })),
): string[] {
  const segments = pattern.split('/').filter((s) => s.length > 0 && s !== '.');
  const results: string[] = [];

  function walk(dirRel: string[], segIdx: number): void {
    if (segIdx >= segments.length) {
      results.push(dirRel.join('/'));
      return;
    }
    const seg = segments[segIdx];
    const absDir = dirRel.length === 0 ? root : path.join(root, ...dirRel);

    if (seg === '**') {
      // '**' matches zero or more path segments.
      walk(dirRel, segIdx + 1);
      let entries: Array<{ name: string; isDirectory: boolean }>;
      try {
        entries = readdir(absDir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory && entry.name !== 'node_modules') {
          walk([...dirRel, entry.name], segIdx);
        }
      }
      return;
    }

    if (seg.includes('*')) {
      const re = globSegmentToRegExp(seg);
      let entries: Array<{ name: string; isDirectory: boolean }>;
      try {
        entries = readdir(absDir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory && entry.name !== 'node_modules' && re.test(entry.name)) {
          walk([...dirRel, entry.name], segIdx + 1);
        }
      }
      return;
    }

    // Plain segment — must be an existing directory.
    if (exists(path.join(absDir, seg))) {
      walk([...dirRel, seg], segIdx + 1);
    }
  }

  walk([], 0);

  return results.filter((rel) => rel !== '' && exists(path.join(root, rel, 'package.json')));
}

/**
 * Expands the `workspaces` field of a root package.json (string array or
 * `{ packages: [...] }`) into a deduplicated list of relative directories.
 */
export function expandWorkspaces(
  root: string,
  workspaces: string[] | { packages?: string[] } | undefined,
  exists: (p: string) => boolean = fs.existsSync,
  readdir: (
    p: string,
  ) => Array<{ name: string; isDirectory: boolean }> = (p) =>
    fs.readdirSync(p, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
    })),
): string[] {
  const patterns = Array.isArray(workspaces)
    ? workspaces
    : Array.isArray(workspaces?.packages)
      ? workspaces.packages
      : [];
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') {
      continue;
    }
    for (const rel of expandWorkspacePattern(root, pattern, exists, readdir)) {
      if (!seen.has(rel)) {
        seen.add(rel);
        dirs.push(rel);
      }
    }
  }
  return dirs.sort();
}

// ── Source / test file switching ────────────────────────────────────────────────

/** Test-file suffixes in longest-first order (so '.test.ts' matches before '.ts'). */
const TEST_SUFFIXES = [
  '.test.ts',
  '.spec.ts',
  '.test.tsx',
  '.spec.tsx',
  '.test.js',
  '.spec.js',
  '.test.jsx',
  '.spec.jsx',
  '.test.mjs',
  '.spec.mjs',
  '.test.cjs',
  '.spec.cjs',
  '.test.mts',
  '.spec.mts',
  '.test.cts',
  '.spec.cts',
];

/** Source-file suffixes in longest-first order. */
const SOURCE_SUFFIXES = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.mts', '.cts'];

export interface ParsedNodeFilePath {
  /** Everything before the matched suffix */
  basePath: string;
  /** The matched suffix (e.g. '.test.ts' or '.ts') */
  suffix: string;
  /** True when the matched suffix is a test suffix */
  isTest: boolean;
}

/**
 * Given a source or test file path, splits it into a base path and its suffix.
 * Returns `null` for files that don't match any known source/test suffix.
 */
export function parseNodeFilePath(filePath: string): ParsedNodeFilePath | null {
  const lower = filePath.toLowerCase();
  for (const suffix of TEST_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return { basePath: filePath.slice(0, filePath.length - suffix.length), suffix, isTest: true };
    }
  }
  for (const suffix of SOURCE_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return { basePath: filePath.slice(0, filePath.length - suffix.length), suffix, isTest: false };
    }
  }
  return null;
}

/**
 * Returns all candidate sibling file paths (source and test variants) for a
 * base path. The current file is included in the result.
 */
export function getNodeSiblingPaths(basePath: string): string[] {
  return [...TEST_SUFFIXES, ...SOURCE_SUFFIXES].map((s) => basePath + s);
}

// ── Build error parsing ─────────────────────────────────────────────────────────

export interface ParsedBuildError {
  /** Path as printed by the tool (may be relative to the project dir) */
  file: string;
  line: number;
  col: number;
  /** Error code (e.g. 'TS2322'); '' when the tool printed none */
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

/**
 * Parses compiler/bundler output into structured errors. Supported formats:
 *  - tsc:      `src/foo.ts(12,5): error TS2322: Type 'number' ...`
 *  - generic:  `src/foo.ts:12:5 - error TS2322: message` (also webpack-ish)
 *  - esbuild:  `X [ERROR] message` followed by an indented `file:line:col:` line
 *
 * Multi-line messages are continued onto the following lines until a blank
 * line or the next error header. Errors are deduplicated by file:line:code.
 */
export function parseBuildErrors(rawOutput: string): ParsedBuildError[] {
  // Strip ANSI color codes tools may inject.
  const output = rawOutput.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  const lines = output.split(/\r?\n/);
  const errors: ParsedBuildError[] = [];
  let current: ParsedBuildError | null = null;

  // tsc: path(line,col): error TS2322: message
  const tscRegex =
    /^((?:[A-Za-z]:)?[^:(\r\n]+)\((\d+),(\d+)\):\s*(error|warning)\s+([A-Za-z0-9-]+):\s*(.*)/;
  // generic: path:line:col - error CODE: message
  const genericRegex =
    /^(?:Error:\s*)?((?:[A-Za-z]:)?[^:\s][^:\r\n]*):(\d+):(\d+)\s*-\s*(error|warning)\s+([A-Za-z0-9-]+):\s*(.*)/;
  // esbuild header: X [ERROR] message
  const esbuildHeaderRegex = /^(?:X|✘)\s*\[(ERROR|WARNING)\]:?\s*(.*)/;
  // esbuild location: "  path:line:col:" (possibly followed by ": message")
  const esbuildLocationRegex = /^\s+((?:[A-Za-z]:)?[^:\s][^:\r\n]*):(\d+):(\d+):?\s*(.*)/;

  const pushCurrent = () => {
    if (current && current.file) {
      errors.push(current);
    }
    current = null;
  };

  for (const line of lines) {
    const tscMatch = line.match(tscRegex);
    if (tscMatch) {
      pushCurrent();
      current = {
        file: tscMatch[1].trim(),
        line: parseInt(tscMatch[2], 10),
        col: parseInt(tscMatch[3], 10),
        code: tscMatch[5],
        message: tscMatch[6],
        severity: tscMatch[4] === 'warning' ? 'warning' : 'error',
      };
      continue;
    }

    const genericMatch = line.match(genericRegex);
    if (genericMatch) {
      pushCurrent();
      current = {
        file: genericMatch[1].trim(),
        line: parseInt(genericMatch[2], 10),
        col: parseInt(genericMatch[3], 10),
        code: genericMatch[5],
        message: genericMatch[6],
        severity: genericMatch[4] === 'warning' ? 'warning' : 'error',
      };
      continue;
    }

    const esbuildMatch = line.match(esbuildHeaderRegex);
    if (esbuildMatch) {
      pushCurrent();
      current = {
        file: '', // extracted from the following location line
        line: 0,
        col: 0,
        code: '',
        message: esbuildMatch[2],
        severity: esbuildMatch[1].toLowerCase() === 'warning' ? 'warning' : 'error',
      };
      continue;
    }

    if (current) {
      if (!current.file) {
        const locMatch = line.match(esbuildLocationRegex);
        if (locMatch) {
          current.file = locMatch[1].trim();
          current.line = parseInt(locMatch[2], 10);
          current.col = parseInt(locMatch[3], 10);
          if (locMatch[4]) {
            current.message += '\n' + locMatch[4];
          }
          continue;
        }
        // esbuild prints a blank line between the header and the location —
        // keep waiting for the location while the error has no file yet.
        if (line.trim() === '') {
          continue;
        }
        pushCurrent();
        continue;
      }
      if (line.trim() === '' || /^(?:✖|✘|X\s*\[|Warnings?:|Errors?:|at\s)/.test(line.trim())) {
        pushCurrent();
        continue;
      }
      current.message += '\n' + line;
    }
  }
  pushCurrent();

  // Deduplicate identical errors on the same line and file.
  const uniqueErrors: ParsedBuildError[] = [];
  const seen = new Set<string>();
  for (const err of errors) {
    const key = `${err.file}:${err.line}:${err.code}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueErrors.push(err);
    }
  }

  return uniqueErrors;
}

// ── Debug heuristics ────────────────────────────────────────────────────────────

/** Packages that imply the npm scripts start a web server worth debugging in a browser. */
const WEB_SERVER_PACKAGES = new Set([
  'express',
  'fastify',
  'koa',
  '@hapi/hapi',
  'hapi',
  '@nestjs/core',
  'restify',
  'polka',
  'next',
  'nuxt',
  'vite',
  'webpack-dev-server',
  'http-server',
  'live-server',
  'lite-server',
  'serve',
  'sirv',
  'socket.io',
]);

/**
 * Heuristic: does this project look like it serves a web page? Used by the
 * 'auto' debug mode to choose between the browser debugger and the Node
 * inspector.
 */
export function detectBrowserLikelihood(
  project: Pick<NodeWorkspaceProject, 'allDependencies'>,
): boolean {
  return Object.keys(project.allDependencies).some((dep) => WEB_SERVER_PACKAGES.has(dep));
}

/**
 * Extracts a port number from an npm script string. Recognises the common
 * forms `PORT=3000`, `--port 3000`, `--port=3000`, and `-p 3000`.
 * Returns 0 when no port can be found.
 */
export function parsePortFromScript(script: string): number {
  const patterns = [
    /PORT=(\d{2,5})\b/,
    /--port[ =](\d{2,5})\b/,
    /(?:^|\s)-p\s+(\d{2,5})\b/,
  ];
  for (const pattern of patterns) {
    const match = script.match(pattern);
    if (match) {
      const port = parseInt(match[1], 10);
      if (port > 0 && port < 65536) {
        return port;
      }
    }
  }
  return 0;
}

// ── npm script selection ────────────────────────────────────────────────────────

/**
 * Orders a project's script names by preference: scripts whose name matches a
 * preferred alias come first (in alias order), then everything else in
 * declaration order.
 */
export function pickScriptCandidates(
  scripts: Record<string, string>,
  preferred: string[],
): string[] {
  const names = Object.keys(scripts);
  const hits: string[] = [];
  for (const alias of preferred) {
    if (names.includes(alias)) {
      hits.push(alias);
    }
  }
  // Also honour `<alias>:*` variants (e.g. `build:watch`) after the exact hit.
  for (const alias of preferred) {
    for (const name of names) {
      if (name.startsWith(`${alias}:`) && !hits.includes(name)) {
        hits.push(name);
      }
    }
  }
  return [...hits, ...names.filter((n) => !hits.includes(n))];
}

// ── JSON extraction from noisy CLI output ───────────────────────────────────────

/** Extracts the first balanced `{…}` JSON object from noisy command output. */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Extracts the ESLint results array from noisy CLI output. The ESLint JSON
 * formatter prints either `[]` or `[{"filePath":…}]`, so we look for the first
 * `[` whose next non-whitespace character is `{` or `]` (skipping log lines like
 * `[12:00:00]`) and scan to its matching `]`, respecting string literals.
 */
export function extractJsonArray(text: string): string | null {
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '[') {
      continue;
    }
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j])) {
      j++;
    }
    if (j < text.length && (text[j] === '{' || text[j] === ']')) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}
