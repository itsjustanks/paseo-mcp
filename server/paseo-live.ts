import { join } from "node:path";
import type { McpTool } from "../shared/contracts";
import { listToolsMcp, type FetchLike } from "../shared/tools";
import { readJsonCached } from "./files";
import { paseoHome } from "./settings";

/**
 * Paseo's tool list asked from the daemon itself, when it can be asked
 * honestly. Read from @getpaseo/server 0.9.1:
 *
 *  - `/mcp/agents` skips the daemon-password middleware and checks its own
 *    auth: with no password it is open; with one it wants the per-run token
 *    the daemon gives only its agents (server/auth.js
 *    `isAgentMcpRequestAuthorized`). The password is `PASEO_PASSWORD` or
 *    `daemon.auth.password` in `$PASEO_HOME/config.json` (config.js
 *    `resolveAuthConfig`); this process inherits the daemon's environment.
 *  - The address the daemon actually bound is the `listen` field of
 *    `$PASEO_HOME/paseo.pid` (JSON; scripts/supervisor-entrypoint.js
 *    `onWorkerReady` → pid-lock.js `updatePidLock`; `null` while no worker
 *    runs). That covers `--listen` too. When the file is missing, unreadable or
 *    has no address: `PASEO_LISTEN`, `daemon.listen`, or `127.0.0.1:$PORT`
 *    (default 6767) (config.js `resolveListenAddress`).
 *  - A request with no `callerAgentId` lists every registered tool with no
 *    per-provider policy; browser tools only while `browserTools.enabled`.
 *    The endpoint is stateless, so `initialize` then `tools/list` works.
 *
 * With a password, a socket listener, the MCP server off, or no answer, the
 * catalogue stands. No token is ever sent or guessed. One ask at a time, at
 * most every ten minutes unless Refresh asks; a failure is not retried until
 * then. A good answer is kept until a later one replaces it.
 */

export const LIVE_TTL_MS = 10 * 60_000;
const LIVE_TIMEOUT_MS = 5_000;

export type LiveEndpoint = { url: string; reason: "" } | { url: null; reason: string };

type Env = Record<string, string | undefined>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The address in `paseo.pid` parsed, or undefined when there is none. */
function boundListen(pidLock: unknown): string | undefined {
  const listen = record(pidLock).listen;
  return typeof listen === "string" && listen.trim() !== "" ? listen : undefined;
}

/**
 * Where to ask, or why not. `persisted` is `$PASEO_HOME/config.json` parsed,
 * `pidLock` is `$PASEO_HOME/paseo.pid` parsed; its `listen` wins. Pure.
 */
export function liveEndpoint(env: Env, persisted: unknown, pidLock?: unknown): LiveEndpoint {
  const daemon = record(record(persisted).daemon);
  const password = env.PASEO_PASSWORD?.trim() || record(daemon.auth).password;
  if (password) return { url: null, reason: "The daemon has a password, so its tool list needs a token only its agents get" };
  const listen = (boundListen(pidLock) ?? env.PASEO_LISTEN ?? (typeof daemon.listen === "string" ? daemon.listen : undefined) ?? `127.0.0.1:${env.PORT ?? 6767}`).trim();
  if (/^(unix:\/\/|pipe:\/\/|\/|~|\\\\)/.test(listen)) return { url: null, reason: "The daemon listens on a socket, which the plugin does not ask" };
  let host = "127.0.0.1";
  let port: number;
  if (/^\d+$/.test(listen)) port = Number(listen);
  else {
    const colon = listen.lastIndexOf(":");
    if (colon === -1) return { url: null, reason: `The daemon's listen address (${listen}) is not host:port` };
    const raw = listen.slice(0, colon);
    host = (raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw) || "127.0.0.1";
    port = Number.parseInt(listen.slice(colon + 1), 10);
  }
  if (!Number.isFinite(port)) return { url: null, reason: `The daemon's listen address (${listen}) has no port` };
  // The daemon's own client does the same (bootstrap.js resolveAgentMcpClientHost).
  if (host === "0.0.0.0") host = "127.0.0.1";
  if (host === "::") host = "::1";
  const formatted = host.includes(":") ? `[${host}]` : host;
  return { url: `http://${formatted}:${port}/mcp/agents`, reason: "" };
}

// ------------------------------------------------------------------ cache

type LiveSnapshot = { tools: McpTool[] | null; checkedAt: string; note: string };

let snapshot: LiveSnapshot = { tools: null, checkedAt: "", note: "" };
let attemptedAt = 0;
let inFlight: Promise<LiveSnapshot> | null = null;

let deps: { fetch?: FetchLike; env: () => Env; home: () => string } = { env: () => process.env, home: paseoHome };

/** For tests: a fake fetch, env and home; `reset` forgets what was asked. */
export function configureLive(next: { fetch?: FetchLike; env?: Env; home?: string } | null): void {
  deps = next
    ? { fetch: next.fetch, env: () => next.env ?? {}, home: () => next.home ?? "/nonexistent" }
    : { env: () => process.env, home: paseoHome };
  snapshot = { tools: null, checkedAt: "", note: "" };
  attemptedAt = 0;
  inFlight = null;
}

/** The last answer, without asking. `tools` is null while no live list is known. */
export function liveSnapshot(): LiveSnapshot {
  return snapshot;
}

async function ask(mcpEnabled: boolean): Promise<LiveSnapshot> {
  const at = new Date().toISOString();
  if (!mcpEnabled) return { tools: null, checkedAt: at, note: "Paseo's MCP server is off, so there is no live list" };
  const endpoint = liveEndpoint(deps.env(), readJsonCached(join(deps.home(), "config.json")), readJsonCached(join(deps.home(), "paseo.pid")));
  if (!endpoint.url) return { tools: null, checkedAt: at, note: endpoint.reason };
  const outcome = await listToolsMcp(endpoint.url, undefined, { fetch: deps.fetch, timeoutMs: LIVE_TIMEOUT_MS });
  if (outcome.kind === "listed" && outcome.tools.length > 0) return { tools: outcome.tools, checkedAt: at, note: "" };
  const why = outcome.kind === "auth-required" ? "the daemon asked for a token" : outcome.note || "no tools in the answer";
  // Keep an earlier good list; say why this ask did not replace it.
  return { tools: snapshot.tools, checkedAt: snapshot.tools ? snapshot.checkedAt : at, note: `The daemon did not list its tools (${why})` };
}

/**
 * Ask when the last ask is older than LIVE_TTL_MS, or now with `force`; one
 * ask at a time. Resolves to the snapshot after it (the current one when no
 * ask was due). Never throws.
 */
export function refreshLive(mcpEnabled: boolean, force = false): Promise<LiveSnapshot> {
  if (inFlight) return inFlight;
  if (!force && attemptedAt && Date.now() - attemptedAt < LIVE_TTL_MS) return Promise.resolve(snapshot);
  attemptedAt = Date.now();
  const entry = ask(mcpEnabled)
    .catch((error: unknown) => ({ tools: snapshot.tools, checkedAt: snapshot.checkedAt, note: `The daemon did not list its tools (${error instanceof Error ? error.message : String(error)})` }))
    .then((next) => {
      snapshot = next;
      return next;
    })
    .finally(() => {
      if (inFlight === entry) inFlight = null;
    });
  inFlight = entry;
  return entry;
}
