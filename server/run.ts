import { spawn } from "node:child_process";

export type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

/**
 * Run a program without blocking the plugin's event loop. Output is captured,
 * never passed through to the plugin log (a CLI's warnings would otherwise
 * repeat there on every run), and capped. On timeout the process gets SIGTERM,
 * then SIGKILL two seconds later.
 */
export function runFile(
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number; maxBytes?: number },
): Promise<RunResult> {
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killer);
      done(result);
    };
    let killer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(file, args, { env: options.env, cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killer = setTimeout(() => child.kill("SIGKILL"), 2000);
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < maxBytes) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString();
    });
    child.once("error", (error) => finish({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut }));
    child.once("close", (code) => finish({ code, stdout, stderr, timedOut }));
  });
}

/** How long a call back into the Paseo daemon may take before the plugin gives up on it. */
export const DAEMON_CALL_TIMEOUT_MS = 10_000;

/**
 * A daemon call with a deadline and a plain-English failure. The daemon gives
 * a whole RPC 30 s; a single lookup inside one should not be allowed to use
 * all of it.
 */
export function withDeadline<T>(call: Promise<T>, what: string, ms = DAEMON_CALL_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Paseo did not return ${what} within ${ms / 1000} s; the daemon may be busy. Try again in a moment.`)), ms);
  });
  return Promise.race([call, deadline]).finally(() => clearTimeout(timer));
}
