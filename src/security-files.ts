import * as fs from 'fs/promises';
import * as path from 'path';

export function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export function relativeFile(root: string, target: string): string {
  return path.relative(root, target).replace(/\\/g, '/') || '.';
}
export async function safeRealpath(root: string, file: string): Promise<string> {
  const real = await fs.realpath(file);
  if (!contained(root, real)) { throw new Error(`Excluded link outside workspace: ${relativeFile(root, file)}`); }
  return real;
}
export async function readBounded(file: string, maximum: number): Promise<Buffer> {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) { throw new Error('Not a regular file'); }
    if (stat.size > maximum) { throw new Error(`File exceeds ${maximum} byte limit`); }
    const bytes = Buffer.alloc(Math.min(stat.size + 1, maximum + 1));
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) { break; }
      length += read.bytesRead;
    }
    if (length > stat.size) { throw new Error('File changed while being read'); }
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function checkCancelled(signal?: AbortSignal): void { signal?.throwIfAborted(); }
