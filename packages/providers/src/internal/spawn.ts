import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { excerpt } from './common.js';

export const AGENT_TIMEOUT_MS = 600_000;

export interface RunCliOptions {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  /** Prefix for error messages, e.g. `claude-code provider "cc"`. */
  label: string;
  /** Written to the child's stdin, which is then closed. Default: stdin is ignored. */
  stdin?: string;
}

export interface RunCliResult {
  stdout: string;
}

export function runCli(opts: RunCliOptions): Promise<RunCliResult> {
  const timeoutMs = opts.timeoutMs ?? AGENT_TIMEOUT_MS;
  let target: SpawnTarget;
  try {
    target = buildSpawnTarget(opts.command, opts.args);
  } catch (err) {
    return Promise.reject(err instanceof Error ? new Error(`${opts.label}: ${err.message}`) : err);
  }

  return new Promise<RunCliResult>((resolve, reject) => {
    const child = spawn(target.file, target.args, {
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: target.verbatim,
      stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });

    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        // EPIPE when the CLI exits before reading stdin; the close handler reports it.
      });
      child.stdin.end(opts.stdin);
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      killTree(child);
      settle(() =>
        reject(new Error(`${opts.label}: "${opts.command}" timed out after ${timeoutMs / 1000}s and was killed`)),
      );
    }, timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      settle(() =>
        reject(
          new Error(`${opts.label}: failed to launch "${opts.command}": ${err.message}. Is it installed and on PATH?`),
        ),
      );
    });

    child.on('close', (code, signal) => {
      settle(() => {
        if (code === 0) {
          resolve({ stdout });
        } else {
          // Agent CLIs (e.g. claude -p --output-format stream-json) report fatal
          // errors on stdout, so fall back to its tail when stderr is silent.
          const detail =
            excerpt(stderr) ||
            (stdout.trim() ? `(stdout tail) ${excerpt(stdout.trim().slice(-2000))}` : '(no output)');
          reject(
            new Error(
              `${opts.label}: "${opts.command}" exited with ${
                code === null ? `signal ${signal}` : `code ${code}`
              }: ${detail}`,
            ),
          );
        }
      });
    });
  });
}

interface SpawnTarget {
  file: string;
  args: string[];
  verbatim: boolean;
}

function buildSpawnTarget(command: string, args: string[]): SpawnTarget {
  if (process.platform !== 'win32') return { file: command, args, verbatim: false };
  const resolved = resolveWindowsCommand(command);
  if (/\.(cmd|bat)$/i.test(resolved)) {
    // Node refuses to spawn .cmd/.bat with shell:false (CVE-2024-27980), so route
    // through cmd.exe with explicit MSVCRT + cmd metacharacter escaping.
    const newlineArg = args.find((arg) => /[\r\n]/.test(arg));
    if (newlineArg !== undefined) {
      // cmd.exe treats a newline as end-of-command; there is no safe escape.
      throw new Error(
        `Cannot pass an argument containing newlines through the .cmd shim "${resolved}". ` +
          'Pass the payload via stdin instead, or point the provider "command" at the underlying executable.',
      );
    }
    // The command token must NOT be wrapped in caret-escaped quotes: caret-escaping
    // disables cmd quote parsing, so a quoted "C:\Program Files\..." path would be
    // split at the first space. Caret-escape its spaces/metachars instead, and keep
    // quote-then-escape for the arguments.
    const line = [escapeCmdCommand(resolved), ...args.map((arg) => escapeCmdMeta(quoteWindowsArg(arg)))].join(' ');
    return {
      file: process.env['ComSpec'] ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      verbatim: true,
    };
  }
  return { file: resolved, args, verbatim: false };
}

/**
 * `where`-style lookup: bare names (no separator, no extension) are tried as-is
 * (CreateProcess finds .exe) and then with .cmd/.bat, because npm global shims
 * on Windows are .cmd files that plain spawn cannot find.
 */
function resolveWindowsCommand(command: string): string {
  if (/[\\/]/.test(command) || path.extname(command) !== '') return command;
  const dirs = [process.cwd(), ...(process.env['PATH'] ?? '').split(path.delimiter)].filter(Boolean);
  for (const ext of ['.exe', '.cmd', '.bat']) {
    for (const dir of dirs) {
      const candidate = path.join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

function quoteWindowsArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg;
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
  escaped = escaped.replace(/(\\*)$/, '$1$1');
  return `"${escaped}"`;
}

function escapeCmdMeta(part: string): string {
  return part.replace(/[()%!^"<>&|]/g, '^$&');
}

/** Caret-escape a bare command path for cmd.exe, including spaces (cross-spawn style). */
function escapeCmdCommand(commandPath: string): string {
  return commandPath.replace(/[()%!^"<>&|;, ]/g, '^$&');
}

function killTree(child: ChildProcess): void {
  if (child.pid == null) return;
  if (process.platform === 'win32') {
    // child.kill only hits the direct child; agent CLIs spawn MCP subprocesses
    // that must die with them.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: false });
  } else {
    try {
      child.kill('SIGKILL');
    } catch {
      // already exited
    }
  }
}
