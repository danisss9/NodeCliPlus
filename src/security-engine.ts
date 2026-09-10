import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { gunzipSync, inflateRawSync } from 'zlib';
import { spawnManaged } from './managed-process';
import { checkCancelled, readBounded } from './security-files';

export const ENGINE_VERSION = '1.20.0';
const MAX_ARCHIVE = 64 * 1024 * 1024;
const MAX_EXPANDED = 256 * 1024 * 1024;
export const ENGINE_ASSETS: Record<string, { target: string; sha256: string; extension: string }> = {
  'win32-x64': { target: 'x86_64-pc-windows-msvc', extension: 'zip', sha256: 'b1e2840bac593aea353d2b2b341f5a862c9d61c0c406d9abbbad9e1fa35163a1' },
  'darwin-arm64': { target: 'aarch64-apple-darwin', extension: 'tar.gz', sha256: '33685a589133c5112611c06b66a14f759c8788347dc438795ec895b214e2897a' },
  'darwin-x64': { target: 'x86_64-apple-darwin', extension: 'tar.gz', sha256: '4d06b46eea0231897a4e3561148a95d5895f74286f6dfe5f9da90e0e4fd36007' },
  'linux-arm64': { target: 'aarch64-unknown-linux-gnu', extension: 'tar.gz', sha256: 'c1d6f63a6fe55c17b5ddbfcb89d34599b737226a683ee492b12d92d1d541f304' },
  'linux-x64': { target: 'x86_64-unknown-linux-gnu', extension: 'tar.gz', sha256: 'cabb8df46492fff59c51261302c71ed9cb2cef393d3f0ca560801a34a8e24cbe' },
};
export const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function safeArchiveName(name: string): void {
  if (name.startsWith('/') || /^[a-z]:/i.test(name) || name.includes('\\') || name.split('/').includes('..') || name.includes('\0')) {
    throw new Error('Unsafe engine archive entry');
  }
}
/** Extract just the executable in memory. No archive-controlled path is written to disk. */
export function extractEngine(archive: Buffer, format: string, executable: string): Buffer {
  let result: Buffer | undefined;
  const accept = (name: string, bytes: Buffer) => {
    safeArchiveName(name);
    if (path.posix.basename(name) === executable) {
      if (result) { throw new Error('Duplicate engine executable in archive'); }
      if (!bytes.length || bytes.length > MAX_EXPANDED) { throw new Error('Invalid engine executable size'); }
      result = bytes;
    }
  };
  if (format === 'zip') {
    let eocd = archive.length - 22;
    while (eocd >= Math.max(0, archive.length - 65557) && archive.readUInt32LE(eocd) !== 0x06054b50) { eocd--; }
    if (eocd < 0 || archive.readUInt32LE(eocd) !== 0x06054b50) { throw new Error('Invalid engine ZIP'); }
    let cursor = archive.readUInt32LE(eocd + 16);
    const count = archive.readUInt16LE(eocd + 10);
    if (count > 1000) { throw new Error('Engine ZIP entry limit exceeded'); }
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== 0x02014b50) { throw new Error('Invalid ZIP directory'); }
      const method = archive.readUInt16LE(cursor + 10), compressedSize = archive.readUInt32LE(cursor + 20), size = archive.readUInt32LE(cursor + 24);
      const nameLength = archive.readUInt16LE(cursor + 28), extraLength = archive.readUInt16LE(cursor + 30), commentLength = archive.readUInt16LE(cursor + 32);
      const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString();
      safeArchiveName(name);
      if (path.posix.basename(name) === executable) {
        const local = archive.readUInt32LE(cursor + 42);
        if (local + 30 > archive.length || archive.readUInt32LE(local) !== 0x04034b50 || size > MAX_EXPANDED) { throw new Error('Invalid ZIP executable'); }
        const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
        if (start + compressedSize > archive.length) { throw new Error('Truncated ZIP executable'); }
        const compressed = archive.subarray(start, start + compressedSize);
        const bytes = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed, { maxOutputLength: MAX_EXPANDED }) : undefined;
        if (!bytes || bytes.length !== size) { throw new Error('Unsupported ZIP executable'); }
        accept(name, bytes);
      }
      cursor += 46 + nameLength + extraLength + commentLength;
    }
  } else {
    const tar = gunzipSync(archive, { maxOutputLength: MAX_EXPANDED });
    let count = 0;
    for (let cursor = 0; cursor + 512 <= tar.length;) {
      if (tar.subarray(cursor, cursor + 512).every(byte => byte === 0)) { break; }
      if (++count > 1000) { throw new Error('Engine TAR entry limit exceeded'); }
      const field = (offset: number, length: number) => tar.subarray(cursor + offset, cursor + offset + length).toString().replace(/\0.*$/s, '');
      const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
      safeArchiveName(name);
      const size = parseInt(field(124, 12).trim(), 8);
      if (!Number.isSafeInteger(size) || size < 0 || cursor + 512 + size > tar.length) { throw new Error('Invalid TAR size'); }
      if (path.posix.basename(name) === executable) {
        if (![0, 48].includes(tar[cursor + 156])) { throw new Error('Engine executable is not a regular archive file'); }
        accept(name, tar.subarray(cursor + 512, cursor + 512 + size));
      }
      cursor += 512 + Math.ceil(size / 512) * 512;
    }
  }
  if (!result) { throw new Error('Engine archive does not contain the executable'); }
  return result;
}
export async function downloadEngine(url: string, signal?: AbortSignal): Promise<Buffer> {
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
  const response = await fetch(url, { signal: combined });
  if (!response.ok || !response.body) { throw new Error(`YARA-X download failed: HTTP ${response.status}`); }
  const reader = response.body.getReader();
  const chunks: Buffer[] = []; let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) { break; }
      length += chunk.value.length;
      if (length > MAX_ARCHIVE) { throw new Error('YARA-X archive download exceeds size limit'); }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
const pending = new Map<string, Promise<string>>();
export async function ensureYaraEngine(storage: string, signal?: AbortSignal,
  platform = `${process.platform}-${process.arch}`, download = downloadEngine): Promise<string> {
  checkCancelled(signal);
  const asset = ENGINE_ASSETS[platform];
  if (!asset) { throw new Error(`Managed YARA-X is unavailable for ${platform}`); }
  const directory = path.resolve(storage, 'engines', ENGINE_VERSION, platform);
  const existing = pending.get(directory);
  if (existing) {
    let abort: (() => void) | undefined;
    try {
      const cancellation = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal?.reason ?? new Error('Cancelled'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); }
      });
      await Promise.race([existing, cancellation]);
    } catch { checkCancelled(signal); /* A different review may have been cancelled. */ }
    finally { if (abort) { signal?.removeEventListener('abort', abort); } }
    checkCancelled(signal);
  }
  const work = async () => {
    await fs.mkdir(directory, { recursive: true });
    const archiveFile = path.join(directory, `engine.${asset.extension}`);
    let archive: Buffer | undefined;
    try { const cached = await readBounded(archiveFile, MAX_ARCHIVE); if (sha256(cached) === asset.sha256) { archive = cached; } } catch { /* Download on cache miss. */ }
    if (!archive) {
      archive = await download(`https://github.com/VirusTotal/yara-x/releases/download/v${ENGINE_VERSION}/yara-x-v${ENGINE_VERSION}-${asset.target}.${asset.extension}`, signal);
      if (archive.length > MAX_ARCHIVE || sha256(archive) !== asset.sha256) { throw new Error('YARA-X archive checksum mismatch'); }
      await atomicWrite(archiveFile, archive);
    }
    checkCancelled(signal);
    const filename = platform.startsWith('win32') ? 'yr.exe' : 'yr';
    const bytes = extractEngine(archive, asset.extension, filename);
    const executable = path.join(directory, filename);
    let matches = false;
    try { matches = sha256(await readBounded(executable, MAX_EXPANDED)) === sha256(bytes); } catch { /* First install. */ }
    if (!matches) { await atomicWrite(executable, bytes); }
    if (!platform.startsWith('win32')) { await fs.chmod(executable, 0o700); }
    const result = await spawnManaged(executable, ['--version'], { cwd: directory, shell: false, timeoutMs: 10_000, signal, maxOutputBytes: 4096 });
    checkCancelled(signal);
    if (result.exitCode !== 0 || !result.standardOutput.includes(ENGINE_VERSION)) { throw new Error('Pinned YARA-X engine failed its version check'); }
    return executable;
  };
  const promise = work(); pending.set(directory, promise);
  try { return await promise; } finally { if (pending.get(directory) === promise) { pending.delete(directory); } }
}
async function atomicWrite(file: string, bytes: Buffer): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, file); }
  finally { await fs.unlink(temporary).catch(() => undefined); }
}
