/**
 * Read/write helpers for JSONC config files (tsconfig.json, eslint config,
 * package.json) built on `jsonc-parser`. Writes are surgical: a single key is
 * modified or removed while comments, key order, and formatting are preserved.
 */
import * as fs from 'fs';
import * as jsonc from 'jsonc-parser';
import { logDiagnostic } from './state';

/** Detects the dominant line ending so edits don't mix CRLF/LF in an existing file. */
function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Detects indentation from the first indented line, falling back to 2 spaces. */
function detectIndent(text: string): { tabSize: number; insertSpaces: boolean } {
  const match = text.match(/\n([ \t]+)\S/);
  if (!match) {
    return { tabSize: 2, insertSpaces: true };
  }
  const indent = match[1];
  if (indent.includes('\t')) {
    return { tabSize: 1, insertSpaces: false };
  }
  return { tabSize: indent.length, insertSpaces: true };
}

function formattingOptionsFor(text: string): jsonc.FormattingOptions {
  return { ...detectIndent(text), eol: detectEol(text) };
}

/** Writes a file via a temp file + rename so a crash mid-write can't truncate it. */
export function writeFileAtomic(filePath: string, content: string): void {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/** A path into the JSON tree, e.g. `['compilerOptions', 'strict']`. */
export type JsonPath = jsonc.JSONPath;

/**
 * Reads and parses a JSONC file. Tolerates comments and trailing commas.
 * Returns `null` when the file is missing or cannot be parsed.
 */
export function readJsonc<T = unknown>(filePath: string): T | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  const errors: jsonc.ParseError[] = [];
  const result = jsonc.parse(raw, errors, { allowTrailingComma: true }) as T;
  if (errors.length > 0) {
    logDiagnostic(`jsonc parse issues in ${filePath}: ${errors.length} error(s)`);
  }
  return result ?? null;
}

/** Reads the raw text of a file, or `null` when it cannot be read. */
export function readRaw(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Sets a value at the given JSON path, creating intermediate objects as needed,
 * and writes the file back with comments/formatting preserved.
 * Returns `true` on success.
 */
export function setKey(filePath: string, jsonPath: JsonPath, value: unknown): boolean {
  return applyModification(filePath, jsonPath, value);
}

/**
 * Removes the key at the given JSON path and writes the file back. Removing a
 * missing key is a no-op that still reports success.
 */
export function removeKey(filePath: string, jsonPath: JsonPath): boolean {
  return applyModification(filePath, jsonPath, undefined);
}

function applyModification(filePath: string, jsonPath: JsonPath, value: unknown): boolean {
  const raw = readRaw(filePath);
  if (raw === null) {
    logDiagnostic(`Cannot read ${filePath} for modification`);
    return false;
  }
  try {
    const edits = jsonc.modify(raw, jsonPath, value, {
      formattingOptions: formattingOptionsFor(raw),
    });
    const updated = jsonc.applyEdits(raw, edits);
    writeFileAtomic(filePath, updated);
    return true;
  } catch (err) {
    logDiagnostic(`Failed to modify ${filePath} at ${jsonPath.join('.')}: ${err}`);
    return false;
  }
}
