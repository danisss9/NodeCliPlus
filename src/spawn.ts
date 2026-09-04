/**
 * Shared child-process spawning used by every npm/eslint invocation. Centralizes
 * three things every call site needs:
 *  - quoting the executable when `shell: true` (Windows drops quoting for the
 *    program name when it joins command+args into one string for cmd.exe, so an
 *    unquoted path containing a space breaks — e.g. a workspace under "My Projects");
 *  - an optional timeout so a hung process doesn't block the extension forever;
 *  - tracking the child so `deactivate()` can kill any still-running processes
 *    instead of leaving zombies behind when the extension host shuts down.
 */
import * as cp from 'child_process';
import { quoteShellPath } from './utils';

const activeChildren = new Set<cp.ChildProcess>();

export interface SpawnManagedOptions {
  cwd: string;
  shell: boolean;
  /** Kills the process if it hasn't closed within this many ms. Omit for no timeout. */
  timeoutMs?: number;
  /** Set to false when `command` is already a full shell command line (not a single executable). */
  quoteCommand?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface SpawnManagedResult {
  stdout: string;
  exitCode: number;
}

/** Spawns a process, capturing combined stdout+stderr text. */
export function spawnManaged(
  command: string,
  args: string[],
  options: SpawnManagedOptions,
): Promise<SpawnManagedResult> {
  return new Promise((resolve) => {
    const spawnCommand =
      options.shell && options.quoteCommand !== false ? quoteShellPath(command) : command;
    const proc = cp.spawn(spawnCommand, args, { cwd: options.cwd, shell: options.shell });
    activeChildren.add(proc);

    let out = '';
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    if (options.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        if (!settled) {
          proc.kill();
        }
      }, options.timeoutMs);
    }

    const finish = (result: SpawnManagedResult) => {
      if (settled) {
        return;
      }
      settled = true;
      activeChildren.delete(proc);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      resolve(result);
    };

    proc.stdout?.on('data', (d: Buffer) => {
      const text = d.toString();
      out += text;
      options.onStdout?.(text);
    });
    proc.stderr?.on('data', (d: Buffer) => {
      const text = d.toString();
      out += text;
      options.onStderr?.(text);
    });
    proc.on('error', (err) => {
      finish({ stdout: out || `Failed to start process: ${err.message}`, exitCode: 1 });
    });
    proc.on('close', (code) => {
      finish({ stdout: out, exitCode: code ?? 1 });
    });
  });
}

/** Kills every process spawned via `spawnManaged` that hasn't exited yet. Called from `deactivate()`. */
export function killAllManagedChildren(): void {
  for (const proc of activeChildren) {
    proc.kill();
  }
  activeChildren.clear();
}
