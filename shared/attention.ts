/**
 * Does this chat need the user? (0.19.1, the user: our plugins add "too many…
 * like composer chips".) The composer chip used to be always on ("12 MCP ·
 * ~38k tokens"). Now it shows only when a connector this chat loads is
 * failing or needs sign-in; a calm chat gets no chip, and the counts live in
 * the agent panel. Pure, so the chip, the sidebar row's dot and the tests all
 * read the same verdict.
 *
 * Which connectors a chat loads, from what the chip already knows (no extra
 * reads): a user-level config counts when its Paseo provider id is the
 * agent's provider; a project `.mcp.json` counts when the agent works in that
 * project or below it. A report from a host older than 0.19.1 has no provider
 * id on its scopes, so every user-level config counts there.
 *
 * 0.19.2 (a real-app audit): the chip sat on a chat from three weeks before,
 * about connectors that chat never loaded. Now a config that switches the
 * connector off (everywhere, or for the folder the chat works in) doesn't
 * count, a tool the Codex app ships never counts, and an old finished chat
 * gets no chip at all (`chatIsLive`). Account-wide problems stay on the
 * sidebar row's dot.
 */
import { resultNeedsAttention, scopedToDirectory, type McpHealthReport, type McpHealthScope } from "./contracts";
import { EVERYWHERE, thisProject } from "./scope";

/** The agent a chat runs: its Paseo provider id and its working directory ("" when unknown). */
export type AttentionAgent = { provider: string; cwd: string };

/** A connector some account still has to sign in to, and the Paseo provider ids whose agents use that account. */
export type SignInNeed = { name: string; providerIds: string[] };

/** `where` (0.20.0, the sidebar popover only): each name's scope in plain words, "Everywhere" or "This project · data-glue". */
export type ChatAttention = { failing: string[]; signIn: string[]; where?: Record<string, string> };

/** Where a connector the report knows is set up: Everywhere when any app's own settings have it, else its project(s). */
export function whereLabel(scopes: readonly Pick<McpHealthScope, "level" | "label">[]): string {
  if (scopes.length === 0 || scopes.some((scope) => scope.level === "user")) return EVERYWHERE;
  const projects = [...new Set(scopes.map((scope) => scope.label))];
  return projects.length === 1 ? thisProject(projects[0]) : `${projects.length} projects`;
}

/** Trailing slashes off, so `/a/b/` and `/a/b` are one folder. */
const folder = (path: string) => path.replace(/[\\/]+$/, "");

function scopeIsThisChats(scope: McpHealthScope, agent: AttentionAgent): boolean {
  if (scope.level === "project") return scopedToDirectory(scope, agent.cwd);
  if (scope.providerId !== undefined && scope.providerId !== agent.provider) return false;
  if (scope.off) return false;
  return !(scope.offIn ?? []).some((dir) => agent.cwd !== "" && folder(dir) === folder(agent.cwd));
}

/** The connectors this chat loads that are failing or need sign-in. Both empty: the chat is calm. */
export function chatAttention(report: McpHealthReport | null | undefined, signIn: readonly SignInNeed[] | null | undefined, agent: AttentionAgent): ChatAttention {
  const results = report?.results ?? [];
  const failing = results
    .filter((entry) => resultNeedsAttention(entry) && entry.scopes.some((scope) => scopeIsThisChats(scope, agent)))
    .map((entry) => entry.name);
  // Sign-in counts only for a connector this chat loads (0.19.2): one the report lists, not built in, not switched off here.
  // A name no config lists (a Claude Code plugin's own connector) isn't one this page can show, so it isn't counted either.
  const known = new Map(results.map((entry) => [entry.name, entry] as const));
  const loads = (name: string) => {
    const entry = known.get(name);
    return Boolean(entry && !entry.builtIn && entry.scopes.some((scope) => scopeIsThisChats(scope, agent)));
  };
  const names = new Set((signIn ?? []).filter((need) => need.providerIds.includes(agent.provider) && loads(need.name)).map((need) => need.name));
  // A connector that is failing says so once, as failing.
  for (const name of failing) names.delete(name);
  return { failing, signIn: [...names].sort() };
}

/**
 * The chip's words, or null for no chip. Short enough for the composer's chip
 * (about 110 px of text at 12 px, measured in the app): "2 broken", "1 needs
 * sign-in". The Plug icon says it is about connectors. When both apply the
 * broken count leads; the panel lists the sign-ins too.
 */
export function attentionLabel(attention: ChatAttention): string | null {
  const failing = attention.failing.length;
  const signIn = attention.signIn.length;
  if (failing > 0) return `${failing} broken`;
  if (signIn > 0) return `${signIn} need${signIn === 1 ? "s" : ""} sign-in`;
  return null;
}

/** The chip's face for a chat, or null for no chip. The words carry the kind, so colour is never the only channel. */
export function attentionFace(attention: ChatAttention): { label: string; icon: string } | null {
  const label = attentionLabel(attention);
  if (!label) return null;
  return { label, icon: "Plug" };
}

/** An idle chat counts as finished this long after its last activity: no chip until it runs again. */
export const LIVE_CHAT_WINDOW_MS = 60 * 60_000;

/**
 * Whether a chat is live enough for a chip: running or starting, or idle with
 * activity in the last hour. An old finished chat gets none; it gets its chip
 * back the moment it runs again. A host that doesn't say when (older Paseo)
 * keeps the chip, as before.
 */
export function chatIsLive(agent: { status?: string; lastActivityAt?: string | null }, now: number): boolean {
  if (agent.status === "running" || agent.status === "initializing") return true;
  if (agent.status === "closed") return false;
  if (!agent.lastActivityAt) return true;
  const at = Date.parse(agent.lastActivityAt);
  return Number.isNaN(at) || now - at <= LIVE_CHAT_WINDOW_MS;
}

/** For the sidebar row's dot: anything on this computer that needs the user, whichever chat it belongs to. */
export function hostNeedsAttention(report: McpHealthReport | null | undefined, signIn: readonly SignInNeed[] | null | undefined): "failing" | "sign-in" | null {
  const names = hostAttentionNames(report, signIn);
  return names.failing.length > 0 ? "failing" : names.signIn.length > 0 ? "sign-in" : null;
}

/** A sign-in need the page lists too (0.19.2): wired to a Paseo provider, and a connector the report knows (when there is a report), not built in. */
function listedNeed(report: McpHealthReport | null | undefined, need: SignInNeed): boolean {
  if (need.providerIds.length === 0) return false;
  if (!report) return true;
  const entry = report.results.find((result) => result.name === need.name);
  return Boolean(entry && !entry.builtIn);
}

/** For the sidebar row's popover: which connectors on this computer are broken, and which need sign-in (0.19.2). */
export function hostAttentionNames(report: McpHealthReport | null | undefined, signIn: readonly SignInNeed[] | null | undefined): ChatAttention {
  const failing = (report?.results ?? []).filter((entry) => resultNeedsAttention(entry)).map((entry) => entry.name);
  const names = new Set((signIn ?? []).filter((need) => listedNeed(report, need)).map((need) => need.name));
  for (const name of failing) names.delete(name);
  const where: Record<string, string> = {};
  for (const name of [...failing, ...names]) where[name] = whereLabel(report?.results.find((entry) => entry.name === name)?.scopes ?? []);
  return { failing, signIn: [...names].sort(), where };
}

/** What a Claude config switches off, per folder: the folders whose `disabledMcpServers` names this connector. */
export function claudeOffIn(projects: unknown, name: string): string[] {
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) return [];
  return Object.entries(projects as Record<string, unknown>)
    .filter(([, entry]) => {
      const list = entry && typeof entry === "object" ? (entry as { disabledMcpServers?: unknown }).disabledMcpServers : undefined;
      return Array.isArray(list) && list.includes(name);
    })
    .map(([dir]) => dir);
}

/** A TOML definition switched off everywhere (`enabled = false`, kept verbatim in `extra`). */
export function tomlSwitchedOff(def: { extra?: readonly string[] } | null | undefined): boolean {
  return (def?.extra ?? []).some((line) => /^enabled\s*=\s*false\s*(#.*)?$/.test(line.trim()));
}
