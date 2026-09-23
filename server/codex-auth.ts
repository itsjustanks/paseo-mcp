import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { codexStatesFromGrants, codexStoredGrants, mergeCodexStates, parseCodexMcpList, type AuthState } from "../shared/accounts";
import { backoffMs } from "../shared/schedule";
import { fileStamp } from "./files";
import { findOnPath, resolveSearchPath } from "./path";
import { runFile } from "./run";

/**
 * Codex MCP sign-in state per account, without a Codex process on the read path.
 *
 * Up to 0.7.0 every panel read ran `codex mcp list --json` once per Codex
 * account, synchronously. That command asks every HTTP server over the network
 * whether it speaks OAuth (5 s each for one that does not answer), so each run
 * took seconds and froze the whole plugin while it did; a workspace panel, the
 * agent panel and the surface each triggered a round, and the daemon's 30 s
 * RPC timeout made the app retry into the backlog.
 *
 * Now a read returns at once with what the grant file says plus Codex's last
 * good answer, and asks Codex again in the background only when that answer
 * is missing, older than CLI_TTL_MS, or the account's config or grant file
 * changed, or someone pressed Refresh. One Codex process runs at a time, a
 * failure is retried with backoff and never replaces the last good answer, and
 * the process's own warnings are captured instead of flooding the plugin log.
 */

export const CLI_TTL_MS = 30 * 60_000;
export const CLI_TIMEOUT_MS = 20_000;
const RETRY_BASE_MS = 60_000;
const RETRY_CAP_MS = 30 * 60_000;
const TAG = "[paseo-mcp]";

type Good = { states: Record<string, AuthState>; checkedAt: string; stamp: string };
type Failure = { count: number; retryAt: number; reason: string };

const lastGood = new Map<string, Good>();
const failures = new Map<string, Failure>();
const inFlight = new Map<string, Promise<void>>();
const warnedArg0 = new Set<string>();
let queue: Promise<unknown> = Promise.resolve();

/** Test seam: how Codex is run. */
let runCodex = async (codexHome: string): Promise<Record<string, AuthState>> => {
  await resolveSearchPath();
  const binary = findOnPath("codex");
  if (!binary) throw new Error("Codex is not installed on this host, so sign-in state for its servers can only be read from its grant file");
  const result = await runFile(binary, ["mcp", "list", "--json"], {
    env: { ...process.env, CODEX_HOME: codexHome },
    timeoutMs: CLI_TIMEOUT_MS,
  });
  noteArg0Warning(codexHome, result.stderr);
  if (result.timedOut) {
    throw new Error(`Codex took longer than ${CLI_TIMEOUT_MS / 1000} s to list its MCP servers (it asks each one over the network whether it uses OAuth)`);
  }
  if (result.code !== 0) {
    const last = result.stderr.split("\n").map((line) => line.trim()).filter((line) => line && !/stale arg0 temp dirs/.test(line)).at(-1) ?? "";
    throw new Error(`codex mcp list stopped with exit code ${result.code}${last ? `: ${last.replace(/https?:\/\/\S+/g, "<url>").slice(0, 160)}` : ""}`);
  }
  try {
    return parseCodexMcpList(result.stdout);
  } catch {
    throw new Error("codex mcp list --json printed something other than a server list; this Codex version may have changed its output");
  }
};

export function setCodexRunnerForTests(runner: typeof runCodex): void {
  runCodex = runner;
}

export function resetCodexAuthForTests(): void {
  lastGood.clear();
  failures.clear();
  inFlight.clear();
  warnedArg0.clear();
  queue = Promise.resolve();
}

/**
 * Codex cleans `$CODEX_HOME/tmp/arg0` on every start and prints this warning
 * when it cannot: an entry there belongs to another user. On a Docker daemon
 * that is usually root, left behind by running `codex` through `docker exec`
 * without `--user`. Harmless, but it repeats on every Codex start, so it is
 * explained once per account here instead.
 */
function noteArg0Warning(codexHome: string, stderr: string): void {
  if (!/failed to clean up stale arg0 temp dirs/.test(stderr) || warnedArg0.has(codexHome)) return;
  warnedArg0.add(codexHome);
  let user = "the daemon user";
  try {
    user = userInfo().username;
  } catch {
    // keep the generic word
  }
  console.warn(
    `${TAG} Codex could not tidy ${join(codexHome, "tmp", "arg0")}: something in it belongs to another user ` +
      `(usually root, from running codex via 'docker exec' without --user). It is harmless but Codex warns about it on every start. ` +
      `Fix it once, as root on the daemon host: chown -R ${user} '${join(codexHome, "tmp")}'`,
  );
}

/**
 * The grant file, reduced to who each grant is for and whether it is usable.
 * Read fresh each time (it is small) and deliberately not through the file
 * cache, so no token stays in this process's memory after the read.
 */
function readGrants(codexHome: string, now: number) {
  try {
    return codexStoredGrants(JSON.parse(readFileSync(join(codexHome, ".credentials.json"), "utf8")), now);
  } catch {
    return [];
  }
}

/** What stamps a cached Codex answer: the account's config and grant file. */
function accountStamp(codexHome: string): string {
  return `${fileStamp(join(codexHome, "config.toml"))}|${fileStamp(join(codexHome, ".credentials.json"))}`;
}

function wantsCli(codexHome: string, now: number, force: boolean): boolean {
  if (inFlight.has(codexHome)) return false;
  const failure = failures.get(codexHome);
  if (failure && now < failure.retryAt && !force) return false;
  if (force) return true;
  const good = lastGood.get(codexHome);
  if (!good) return true;
  return good.stamp !== accountStamp(codexHome) || now - Date.parse(good.checkedAt) >= CLI_TTL_MS;
}

/** Queue one background `codex mcp list` for this account. Only a success is kept. */
function askCodex(codexHome: string): Promise<void> {
  const stamp = accountStamp(codexHome);
  const job = queue
    .then(() => runCodex(codexHome))
    .then((states) => {
      lastGood.set(codexHome, { states, checkedAt: new Date().toISOString(), stamp });
      failures.delete(codexHome);
    })
    .catch((error: unknown) => {
      const previous = failures.get(codexHome)?.count ?? 0;
      const count = previous + 1;
      const reason = error instanceof Error ? error.message : String(error);
      failures.set(codexHome, { count, retryAt: Date.now() + backoffMs(count - 1, RETRY_BASE_MS, RETRY_CAP_MS), reason });
      if (previous === 0) console.warn(`${TAG} Codex sign-in check for ${codexHome} failed: ${reason}`);
    })
    .finally(() => {
      inFlight.delete(codexHome);
    });
  queue = job;
  inFlight.set(codexHome, job);
  return job;
}

export type CodexAuthView = {
  states: Record<string, AuthState>;
  /** When Codex last answered for this account, or null if it never has. */
  asOf: string | null;
  /** A background check is running; ask again shortly for its answer. */
  checking: boolean;
  /** Why the latest background check failed, when the states shown are older than it. */
  staleReason: string | null;
};

/**
 * Sign-in state for one Codex account's servers, answered from memory and the
 * grant file. `askCli` lets this read start a background check when the last
 * one is missing or out of date; `force` starts one regardless (Refresh).
 */
export function codexAuthView(
  codexHome: string,
  servers: Record<string, { url?: string; headers?: Record<string, string>; extra?: string[] }>,
  options: { askCli: boolean; force?: boolean; now?: number },
): CodexAuthView {
  const now = options.now ?? Date.now();
  if (options.askCli && wantsCli(codexHome, now, Boolean(options.force))) void askCodex(codexHome);
  const grants = readGrants(codexHome, now);
  const good = lastGood.get(codexHome);
  return {
    states: mergeCodexStates(good?.states ?? {}, codexStatesFromGrants(grants, servers)),
    asOf: good?.checkedAt ?? null,
    checking: inFlight.has(codexHome),
    staleReason: failures.get(codexHome)?.reason ?? null,
  };
}

/** For tests: wait for queued background checks. */
export async function codexChecksSettled(): Promise<void> {
  await Promise.all([...inFlight.values()]);
}
