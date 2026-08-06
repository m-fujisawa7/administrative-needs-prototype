import { spawn } from 'node:child_process';
import { AiAnalyzerError, AiConfigurationError } from './errors.ts';

export type ChildProcessRequest = {
  executable: string;
  args: string[];
  stdin: string;
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
};

export type ChildProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

export type ChildProcessRunner = (request: ChildProcessRequest) => Promise<ChildProcessResult>;

export const runChildProcess: ChildProcessRunner = async (request) => new Promise(
  (resolve, reject) => {
    const detached = process.platform !== 'win32';
    let child;
    try {
      child = spawn(request.executable, request.args, {
        cwd: request.cwd,
        shell: false,
        detached,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(asSpawnError(error, request.executable));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: Error | undefined;
    let settled = false;
    let hardKillTimer: NodeJS.Timeout | undefined;

    const timeout = setTimeout(() => {
      failure = new AiAnalyzerError('AI analysis timed out.');
      terminateChild(child.pid, detached, 'SIGTERM');
      hardKillTimer = setTimeout(() => terminateChild(child.pid, detached, 'SIGKILL'), 2_000);
    }, request.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > request.maxStdoutBytes) {
        failure ??= new AiAnalyzerError('Claude CLI stdout exceeded the size limit.');
        terminateChild(child.pid, detached, 'SIGTERM');
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > request.maxStderrBytes) {
        failure ??= new AiAnalyzerError('Claude CLI stderr exceeded the size limit.');
        terminateChild(child.pid, detached, 'SIGTERM');
        return;
      }
      stderrChunks.push(chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (hardKillTimer !== undefined) clearTimeout(hardKillTimer);
      reject(asSpawnError(error, request.executable));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (hardKillTimer !== undefined) clearTimeout(hardKillTimer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (failure !== undefined) {
        reject(failure);
        return;
      }
      resolve({ stdout, stderr, exitCode: code, signal });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(request.stdin, 'utf8');
  },
);

function terminateChild(
  pid: number | undefined,
  detached: boolean,
  signal: NodeJS.Signals,
): void {
  if (pid === undefined) return;
  try {
    if (detached) process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch {
    // 終了済みなら何もしない。
  }
}

function asSpawnError(error: unknown, executable: string): Error {
  if (
    error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
  ) {
    return new AiConfigurationError(
      `Claude CLI was not found. Check CLAUDE_CLI_PATH: ${executable}`,
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new AiAnalyzerError(`Claude CLI execution failed: ${detail}`);
}
