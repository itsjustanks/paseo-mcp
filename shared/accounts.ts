/**
 * Codex sign-in state per MCP server, read without starting Codex where the
 * files allow it. Pure so it can be unit-tested; server/codex-auth.ts does the
 * reading, the caching, and the rare background `codex mcp list`.
 *
 * Codex keeps MCP OAuth grants in the OS keyring, or, where there is no
 * keyring (a Linux container, or `mcp_oauth_credentials_store = "file"`), in
 * `$CODEX_HOME/.credentials.json`: a map of entries carrying `server_name` and
 * `server_url` in the clear. A usable entry there is a definite "connected".
 * Anything else needs Codex itself, which checks the keyring and asks each
 * server over the network whether it speaks OAuth (5 s per server).
 */
import type { McpAuthAccount } from "./contracts";

export type AuthState = McpAuthAccount["authStatus"][string];

/** Codex refreshes a token this long before it expires; the same margin applies here. */
const REFRESH_SKEW_MS = 30_000;

/**
 * One `auth_status` value from `codex mcp list --json` (serde snake_case of
 * Codex's `McpAuthStatus`): `unknown`, `unsupported`, `not_logged_in`,
 * `bearer_token`, `o_auth`. A static bearer token is not an OAuth sign-in, so
 * it reads as unknown here (the card shows no sign-in row for it).
 */
export function codexCliState(raw: unknown): AuthState {
  switch (raw) {
    case "o_auth":
    case "oauth":
      return "connected";
    case "not_logged_in":
      return "not-connected";
    case "unsupported":
      return "unsupported";
    default:
      return "unknown";
  }
}

/** `codex mcp list --json` stdout into a state per server name. Throws on output that is not the expected list. */
export function parseCodexMcpList(stdout: string): Record<string, AuthState> {
  const rows = JSON.parse(stdout) as unknown;
  if (!Array.isArray(rows)) throw new Error("codex mcp list --json did not print a list");
  const states: Record<string, AuthState> = {};
  for (const row of rows as Array<{ name?: unknown; auth_status?: unknown }>) {
    if (typeof row?.name !== "string" || !row.name) continue;
    states[row.name] = codexCliState(row.auth_status);
  }
  return states;
}

/** What this module keeps from a stored grant: who it is for and whether Codex would use it. Never a token. */
export type StoredGrant = { serverName: string; serverUrl: string; usable: boolean };

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * Entries of a parsed `.credentials.json`, reduced to name, URL and a usable
 * flag by Codex's own rule: a client id, and either an unexpired access token
 * or (once expired) an issuer and a refresh token. Executor-owned entries
 * belong to Codex's cloud executor, not to this account's servers.
 */
export function codexStoredGrants(file: unknown, nowMs: number): StoredGrant[] {
  if (!file || typeof file !== "object" || Array.isArray(file)) return [];
  const grants: StoredGrant[] = [];
  for (const raw of Object.values(file as Record<string, unknown>)) {
    const entry = raw as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object" || entry.executor_owned === true) continue;
    const serverName = text(entry.server_name);
    const serverUrl = text(entry.server_url);
    if (!serverName || !serverUrl) continue;
    const expiresAt = typeof entry.expires_at === "number" ? entry.expires_at : null;
    const expired = expiresAt !== null && nowMs + REFRESH_SKEW_MS >= expiresAt;
    const usable = text(entry.client_id) !== "" && (expired ? text(entry.issuer) !== "" && text(entry.refresh_token) !== "" : text(entry.access_token) !== "");
    grants.push({ serverName, serverUrl, usable });
  }
  return grants;
}

type ServerShape = { url?: string; headers?: Record<string, string>; extra?: string[] };

/** A server that authenticates with a static token has no OAuth sign-in to report. */
function staticToken(def: ServerShape): boolean {
  if (Object.keys(def.headers ?? {}).some((key) => key.toLowerCase() === "authorization")) return true;
  return (def.extra ?? []).some((line) => /^bearer_token_env_var\s*=/.test(line));
}

/**
 * States the stored grants settle for this account's HTTP servers: a usable
 * grant is `connected`, an unusable one is `not-connected`. A server with no
 * stored grant is left out; only Codex can say whether it wants one.
 */
export function codexStatesFromGrants(grants: StoredGrant[], servers: Record<string, ServerShape>): Record<string, AuthState> {
  const states: Record<string, AuthState> = {};
  for (const [name, def] of Object.entries(servers)) {
    if (!def.url || staticToken(def)) continue;
    const grant = grants.find((entry) => entry.serverName === name && entry.serverUrl === def.url);
    if (grant) states[name] = grant.usable ? "connected" : "not-connected";
  }
  return states;
}

/**
 * The state shown for an account: Codex's last good answer, overridden by what
 * the grant file says now (the file is read on every call, so a sign-in done
 * since Codex was last asked shows at once).
 */
export function mergeCodexStates(fromCli: Record<string, AuthState>, fromFile: Record<string, AuthState>): Record<string, AuthState> {
  return { ...fromCli, ...fromFile };
}
