/**
 * Codex and Claude sign-in state per connector, read without starting either where the
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

// ------------------------------------------------------------------- Claude

/**
 * Claude Code's stored connector sign-ins (0.20.1): `.credentials.json` →
 * `mcpOAuth`, one entry per connector keyed `name|hash`, with `serverName` and
 * `serverUrl` in the clear. (On macOS they're in the Keychain instead, so there
 * is no file and nothing is known from it.) Usable by Claude's own rule: an
 * access token that hasn't expired, or a refresh token once it has. Claude
 * writes an entry with an EMPTY token as soon as a sign-in starts, so a
 * sign-in that never finished shows up here as unusable. Keeps no token.
 */
export function claudeStoredGrants(file: unknown, nowMs: number): StoredGrant[] {
  const store = file && typeof file === "object" && !Array.isArray(file) ? (file as Record<string, unknown>).mcpOAuth : null;
  if (!store || typeof store !== "object" || Array.isArray(store)) return [];
  const grants: StoredGrant[] = [];
  for (const [key, raw] of Object.entries(store as Record<string, unknown>)) {
    const entry = raw as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const serverName = text(entry.serverName) || (key.split("|")[0] ?? "").trim();
    if (!serverName) continue;
    const expiresAt = typeof entry.expiresAt === "number" && entry.expiresAt > 0 ? entry.expiresAt : null;
    const expired = expiresAt !== null && nowMs + REFRESH_SKEW_MS >= expiresAt;
    const usable = text(entry.accessToken) !== "" && (!expired || text(entry.refreshToken) !== "");
    grants.push({ serverName, serverUrl: text(entry.serverUrl), usable });
  }
  return grants;
}

/**
 * Whether Claude's sign-in store can be read, and what it holds (0.20.1).
 * `null` means it can't be inspected: on macOS Claude keeps connector sign-ins
 * in the Keychain, so a missing `.credentials.json` there says nothing. On
 * other systems Claude Code uses that file, so a missing file means no
 * sign-ins at all.
 */
export function claudeGrantsFrom(input: { file: unknown; exists: boolean; platform: string; nowMs: number }): StoredGrant[] | null {
  if (!input.exists) return input.platform === "darwin" ? null : [];
  return claudeStoredGrants(input.file, input.nowMs);
}

/**
 * Claude's sign-in state per connector (0.20.1). Before, only Claude's own
 * needs-sign-in list counted, so a connector Claude had never tried showed no
 * sign-in row at all, even when it needed one.
 * - On Claude's needs-sign-in list: `not-connected`.
 * - A usable stored sign-in for that connector's address: `connected`.
 * - A stored sign-in that isn't usable, or a connector another app signs in to
 *   with an account (`oauthElsewhere`): `not-connected`.
 * - Anything else stays unknown, as before. A connector with a static key has
 *   no sign-in.
 * `grants: null` (the store can't be read, macOS) leaves only Claude's own
 * list: nothing is inferred from the other app, so a Keychain sign-in is never
 * reported as missing.
 */
export function claudeStates(input: {
  grants: readonly StoredGrant[] | null;
  servers: Record<string, ServerShape>;
  needsAuth: readonly string[];
  oauthElsewhere: ReadonlySet<string>;
}): Record<string, AuthState> {
  const states: Record<string, AuthState> = {};
  for (const name of input.needsAuth) states[name] = "not-connected";
  if (input.grants === null) return states;
  const grants = input.grants;
  for (const [name, def] of Object.entries(input.servers)) {
    if (!def.url || staticToken(def)) continue;
    const mine = grants.filter((grant) => grant.serverName === name && (!grant.serverUrl || grant.serverUrl === def.url));
    if (mine.some((grant) => grant.usable)) states[name] = "connected";
    else if (mine.length > 0 || input.oauthElsewhere.has(name)) states[name] = "not-connected";
  }
  return states;
}

// ------------------------------------------------------- terminal sign-in

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * "Sign in from a terminal instead": the command for one account and connector.
 * An extra account names its own folder. The primary one names the daemon's
 * CLAUDE_CONFIG_DIR when that is set (`configDirEnv`, 0.20.1), so a terminal
 * without it still signs into the file this daemon's Claude reads.
 */
export function loginCommand(account: Pick<McpAuthAccount, "provider" | "dir" | "isPrimary" | "configDirEnv">, server: string, directory = ""): string {
  const variable = account.provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const dir = account.isPrimary ? (account.configDirEnv ?? "") : account.dir;
  const login = dir
    ? `${variable}=${shellQuote(dir)} ${account.provider} mcp login ${shellQuote(server)}`
    : `${account.provider} mcp login ${shellQuote(server)}`;
  return directory ? `cd ${shellQuote(directory)} && ${login}` : login;
}
