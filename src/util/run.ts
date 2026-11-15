import { spawn } from 'node:child_process';

export interface RunResult {
  /** Exit code, or null when killed. */
  status: number | null;
  timedOut: boolean;
  /** The shell could not find the command (exit 127). */
  notFound: boolean;
  ms: number;
  /** Combined stdout + stderr, truncated to the last `maxOutput` characters. */
  output: string;
}

export interface RunCommandOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  maxOutput?: number;
}

const KILL_GRACE_MS = 2000;

/**
 * Run a shell command with a hard timeout. The command gets its own process group, so on timeout
 * the whole tree (test runners spawn workers) is killed, not just the shell.
 */
export function runCommand(cmd: string, opts: RunCommandOptions): Promise<RunResult> {
  const maxOutput = opts.maxOutput ?? 64 * 1024;
  const start = Date.now();
  const group = process.platform !== 'win32';
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let settled = false;
    // The project's own commands (package.json scripts, Makefile targets) are shell strings.
    // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true
    const child = spawn(cmd, {
      cwd: opts.cwd,
      shell: true,
      detached: group,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', ...opts.env },
    });
    const collect = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > maxOutput * 2) output = output.slice(-maxOutput);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (group && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // already gone
      }
    };
    let hardKill: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      hardKill = setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS);
    }, opts.timeoutMs);
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      // Leave no stragglers behind (e.g. a watcher the test command started).
      if (timedOut) kill('SIGKILL');
      resolve({
        status,
        timedOut,
        notFound: status === 127,
        ms: Date.now() - start,
        output: output.slice(-maxOutput),
      });
    };
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}
