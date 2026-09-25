/**
 * What one chat actually did with its MCP servers, read from the agent's
 * timeline. Pure: the host pages the timeline, this sorts it.
 *
 * Tool-call names (read 2026-09-24 in the Paseo 0.9.1 daemon bundle):
 *
 *  - Claude: `mcp__<server>__<tool>`, the Claude Agent SDK's own name, passed
 *    through unchanged. Claude Code writes the server part with every
 *    character outside `[A-Za-z0-9_-]` as `_`, so `my.server` appears as
 *    `mcp__my_server__…`; both spellings are matched.
 *  - Codex: `<server>.<tool>`, built by the daemon's `buildMcpToolName` from
 *    the `mcpToolCall` item's `server` and `tool` (just `<tool>` when Codex
 *    sends no server).
 *
 * Server names may hold underscores (`my_server`) and tool names often do, so
 * a name is matched against the servers the agent loads, longest first, before
 * falling back to the first separator.
 *
 * Nothing from a tool call's arguments, output or error leaves this module:
 * only server and tool names, counts, and yes/no verdicts.
 */
import type { AgentServer } from "./contracts";

export const SIGN_IN_KIND = "mcp-sign-in";
export const SIGN_IN_VERSION = 1;
export const PLUGIN_ID = "paseo-mcp";
/** The timeline is read back to this many items at most. */
export const CHAT_SCAN_LIMIT = 2000;

/**
 * `owners` is set only when more than one known server could own the name
 * (`github` with a tool `enterprise__login`, and `github__enterprise`): a call
 * then counts for all of them, and no sign-in card names either.
 */
export type ToolServer = { server: string; tool: string; known: boolean; owners?: string[] };

/** Claude Code's spelling of a server name inside a tool name. */
export function claudeServerSlug(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

const PLAIN = /^[A-Za-z0-9_-]+$/;

/** Known servers whose `<spelling><separator>` starts `rest`, longest first, each with its tool part. */
function knownOwners(rest: string, known: readonly string[], spellings: (server: string) => string[], separator: string): Array<{ server: string; tool: string }> {
  const restLower = rest.toLowerCase();
  const out: Array<{ server: string; tool: string }> = [];
  for (const server of [...known].sort((a, b) => b.length - a.length)) {
    for (const spelling of new Set(spellings(server))) {
      const prefix = `${spelling.toLowerCase()}${separator}`;
      if (restLower.startsWith(prefix) && rest.length > prefix.length) {
        out.push({ server, tool: rest.slice(prefix.length) });
        break;
      }
    }
  }
  return out;
}

function matched(owners: Array<{ server: string; tool: string }>): ToolServer | null {
  const [first] = owners;
  if (!first) return null;
  const servers = [...new Set(owners.map((entry) => entry.server))];
  return { server: first.server, tool: first.tool, known: true, ...(servers.length > 1 ? { owners: servers } : {}) };
}

/** The server a tool call belongs to, or null for a tool that is not an MCP server's. */
export function serverForTool(toolName: string, known: readonly string[]): ToolServer | null {
  const name = typeof toolName === "string" ? toolName.trim() : "";
  if (!name) return null;
  const lower = name.toLowerCase();
  if (lower.startsWith("mcp__")) {
    const rest = name.slice(5);
    const hit = matched(knownOwners(rest, known, (server) => [server, claudeServerSlug(server)], "__"));
    if (hit) return hit;
    const cut = rest.indexOf("__");
    if (cut <= 0 || cut + 2 >= rest.length) return null;
    return { server: rest.slice(0, cut), tool: rest.slice(cut + 2), known: false };
  }
  if (name.includes(".")) {
    const hit = matched(knownOwners(name, known, (server) => [server], "."));
    if (hit) return hit;
    const cut = name.indexOf(".");
    const server = name.slice(0, cut);
    const tool = name.slice(cut + 1);
    // Only a plain `server.tool` pair; anything else is some other kind of name.
    if (!server || !tool || !PLAIN.test(server) || !/^[A-Za-z0-9_.-]+$/.test(tool)) return null;
    return { server, tool, known: false };
  }
  return null;
}

// ------------------------------------------------------------------ calls

type ItemLike = { type?: unknown; name?: unknown; status?: unknown; error?: unknown; kind?: unknown; pluginId?: unknown; data?: unknown };

function asItem(raw: unknown): ItemLike | null {
  return raw && typeof raw === "object" ? (raw as ItemLike) : null;
}

export type ServerCalls = { server: string; calls: number; known: boolean };

/** MCP tool calls per server in a list of timeline items, busiest first. */
export function countCalls(items: readonly unknown[], known: readonly string[]): ServerCalls[] {
  const counts = new Map<string, ServerCalls>();
  for (const raw of items) {
    const item = asItem(raw);
    if (!item || item.type !== "tool_call" || typeof item.name !== "string") continue;
    const match = serverForTool(item.name, known);
    if (!match) continue;
    // A name more than one known server could own counts for each of them.
    for (const server of match.owners ?? [match.server]) {
      const entry = counts.get(server) ?? { server, calls: 0, known: match.known };
      entry.calls += 1;
      counts.set(server, entry);
    }
  }
  return [...counts.values()].sort((a, b) => b.calls - a.calls || a.server.localeCompare(b.server));
}

/** Loaded servers split into those this chat called and those it never did (or might have, see `unknownCouldBe`). */
export function usedUnused(loaded: readonly string[], calls: readonly ServerCalls[]): { used: ServerCalls[]; unused: string[] } {
  const called = new Set(calls.map((entry) => entry.server));
  const unknown = calls.filter((entry) => !entry.known).map((entry) => entry.server);
  return { used: [...calls], unused: loaded.filter((name) => !called.has(name) && !unknown.some((other) => unknownCouldBe(other, name))) };
}

/** "supabase ×4, linear ×1". */
export function usedLine(used: readonly ServerCalls[]): string {
  return used.map((entry) => `${entry.server} ×${entry.calls}`).join(", ");
}

// --------------------------------------------------------- turn off unused

export type TurnOffPlan = {
  /** Unused servers with a per-workspace switch that is on now: exactly the ones that change. */
  off: string[];
  /** Unused servers left alone, with why. */
  kept: Array<{ name: string; reason: string }>;
};

/** One name starts the other at a separator (not a letter or digit), or they are equal. */
function prefixAtBoundary(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!long.startsWith(short)) return false;
  return long.length === short.length || !/[a-z0-9]/.test(long[short.length]!);
}

/**
 * Whether a call this chat made to a server outside the known list could have
 * been this server's: the same name, Claude's `_`-for-`.` spelling of it, or
 * either name a prefix of the other (`ikit` from Codex's
 * `ikit.attio.search_records` against `ikit.attio`). Errs towards yes.
 */
export function unknownCouldBe(unknownServer: string, server: string): boolean {
  const unknown = unknownServer.toLowerCase();
  const spellings = new Set([server.toLowerCase(), claudeServerSlug(server).toLowerCase()]);
  return [...spellings].some((spelling) => spelling === unknown || claudeServerSlug(unknown).toLowerCase() === spelling || prefixAtBoundary(unknown, spelling));
}

/**
 * "Turn off the unused ones for this workspace": only servers whose editor has
 * a per-workspace switch for this provider (README, Per-workspace switches),
 * that are on now, and that this chat never called. A server a call outside
 * the known list could belong to counts as called. The host decides with this
 * on a fresh, complete read (server/chat.ts `handleMcpTurnOffUnused`); the
 * panel runs it only to show what it will ask for.
 */
export function planTurnOffUnused(servers: readonly Pick<AgentServer, "name" | "enabled">[], calls: readonly ServerCalls[]): TurnOffPlan {
  const used = new Set(calls.filter((entry) => entry.known).map((entry) => entry.server));
  const unknown = calls.filter((entry) => !entry.known).map((entry) => entry.server);
  const off: string[] = [];
  const kept: TurnOffPlan["kept"] = [];
  for (const server of servers) {
    if (used.has(server.name) || unknown.some((name) => unknownCouldBe(name, server.name))) continue;
    if (server.enabled.state === "disabled") continue;
    if (!server.enabled.writable || server.enabled.lever === "none") kept.push({ name: server.name, reason: "no per-workspace switch for this provider" });
    else off.push(server.name);
  }
  return { off, kept };
}

// ------------------------------------------------------------- sign-in

/** Past this, an error is not read further: the auth words sit at the start of any real message. */
const ERROR_SCAN_CHARS = 4000;

const AUTH_PATTERNS: readonly RegExp[] = [
  /\bunauthori[sz]ed\b/,
  /\binvalid[_ -]?token\b/,
  /\bneeds?[ _-](re-?)?auth(entication|orization)?\b/,
  /\bauthentication (is )?required\b/,
  /\b(http|status|code|error)[^a-z0-9]{0,4}(401|403)\b/,
  /\b(401|403)[^a-z0-9]{0,3}(unauthori[sz]ed|forbidden)\b/,
];

/** Whether an error text reads like a missing or expired sign-in (401/403, "unauthorized", "invalid_token", "needs authentication"). */
export function authShaped(text: string): boolean {
  const lower = text.slice(0, ERROR_SCAN_CHARS).toLowerCase();
  return AUTH_PATTERNS.some((pattern) => pattern.test(lower));
}

/** An error value as text, for matching only; never stored, logged or returned. */
function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error === null || error === undefined) return "";
  try {
    return JSON.stringify(error)?.slice(0, ERROR_SCAN_CHARS) ?? "";
  } catch {
    return "";
  }
}

/**
 * The server of a failed MCP tool call whose error is auth-shaped, or null.
 * Only a known server, and only when exactly one known server owns the name:
 * a card never names a server this agent does not load, or the wrong one.
 */
export function authFailureServer(raw: unknown, known: readonly string[]): string | null {
  const item = asItem(raw);
  if (!item || item.type !== "tool_call" || item.status !== "failed" || typeof item.name !== "string") return null;
  const match = serverForTool(item.name, known);
  if (!match || !match.known || match.owners) return null;
  return authShaped(errorText(item.error)) ? match.server : null;
}

/** Servers this plugin already put a sign-in card in the timeline for. */
export function cardedServers(items: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  for (const raw of items) {
    const item = asItem(raw);
    if (!item || item.type !== "plugin" || item.kind !== SIGN_IN_KIND) continue;
    if (item.pluginId !== undefined && item.pluginId !== PLUGIN_ID) continue;
    const server = (item.data as { server?: unknown } | null)?.server;
    if (typeof server === "string" && server) out.add(server);
  }
  return out;
}

export type SignInCard = { server: string; provider: string };

/**
 * The cards to append for these items: one per server whose call failed for
 * sign-in, never one already carded, never Paseo's own server. `carded` is not
 * changed here; the caller records what it appends.
 */
export function signInCardsFor(items: readonly unknown[], known: readonly string[], carded: ReadonlySet<string>, provider: string, skip: ReadonlySet<string> = new Set(["paseo"])): SignInCard[] {
  const out: SignInCard[] = [];
  const picked = new Set<string>();
  for (const raw of items) {
    const server = authFailureServer(raw, known);
    if (!server || carded.has(server) || picked.has(server) || skip.has(server)) continue;
    picked.add(server);
    out.push({ server, provider });
  }
  return out;
}
