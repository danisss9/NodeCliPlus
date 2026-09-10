import * as cp from 'child_process';
import { StringDecoder } from 'string_decoder';

const activeChildren = new Set<cp.ChildProcess>();
export interface SpawnManagedOptions {
  cwd: string; shell: boolean; timeoutMs?: number; quoteCommand?: boolean;
  signal?: AbortSignal; maxOutputBytes?: number; env?: NodeJS.ProcessEnv;
  onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void;
}
export interface SpawnManagedResult {
  /** Combined stdout/stderr, retained for existing callers. */
  stdout: string; standardOutput: string; standardError: string; exitCode: number;
  timedOut?: boolean; cancelled?: boolean; outputLimited?: boolean;
}
export function spawnManaged(command: string, args: string[], options: SpawnManagedOptions): Promise<SpawnManagedResult> {
  return new Promise(resolve => {
    let out = '', standardOutput = '', standardError = '';
    let settled = false, timedOut = false, cancelled = false, outputLimited = false, byteCount = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let proc: cp.ChildProcess | undefined;
    const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
    const finish = (exitCode: number) => {
      if (settled) { return; }
      settled = true;
      if (proc) { activeChildren.delete(proc); }
      clearTimeout(timer); clearTimeout(forceTimer);
      options.signal?.removeEventListener('abort', abort);
      resolve({ stdout: out, standardOutput, standardError, exitCode,
        ...(timedOut ? { timedOut } : {}), ...(cancelled ? { cancelled } : {}), ...(outputLimited ? { outputLimited } : {}) });
    };
    const stop = () => {
      if (settled) { return; }
      if (proc?.pid && options.shell && process.platform === 'win32') {
        const killer = cp.spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => proc?.kill());
      } else { proc?.kill(); }
      forceTimer ??= setTimeout(() => { proc?.kill('SIGKILL'); finish(cancelled ? 130 : timedOut ? 124 : 1); }, 1000);
    };
    const abort = () => { cancelled = true; stop(); };
    if (options.signal?.aborted) { cancelled = true; finish(130); return; }
    const executable = options.shell && options.quoteCommand !== false && /[\s&|<>^]/.test(command)
      ? `"${command.replace(/"/g, '\\"')}"` : command;
    try {
      proc = cp.spawn(executable, args, { cwd: options.cwd, shell: options.shell, windowsHide: true, env: options.env });
    } catch (error) { out = standardError = String(error); finish(1); return; }
    activeChildren.add(proc);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) { abort(); }
    if (options.timeoutMs) { timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs); }
    const receive = (data: Buffer, stderr: boolean) => {
      if (settled || outputLimited) { return; }
      const remaining = Math.max(0, (options.maxOutputBytes ?? 64 * 1024 * 1024) - byteCount);
      const text = (stderr ? stderrDecoder : stdoutDecoder).write(data.subarray(0, remaining));
      byteCount += data.length; out += text;
      if (stderr) { standardError += text; options.onStderr?.(text); }
      else { standardOutput += text; options.onStdout?.(text); }
      if (data.length > remaining) { outputLimited = true; stop(); }
    };
    proc.stdout?.on('data', (data: Buffer) => receive(data, false));
    proc.stderr?.on('data', (data: Buffer) => receive(data, true));
    proc.on('error', error => { out += error.message; standardError += error.message; finish(1); });
    proc.on('close', code => finish(cancelled ? 130 : timedOut ? 124 : outputLimited ? 1 : code ?? 1));
  });
}
export function killAllManagedChildren(): void {
  for (const child of activeChildren) { child.kill(); }
  activeChildren.clear();
}
