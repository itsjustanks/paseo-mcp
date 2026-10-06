/**
 * Does this chat need the user? (0.19.1, the user: our plugins add "too many…
 * like composer chips".) The composer chip used to be always on ("12 MCP ·
 * ~38k tokens"). Now it shows only when a connector this chat loads is
 * failing or needs sign-in; a calm chat gets no chip, and the counts and
 * token cost live in the agent panel. Pure, so the chip, the sidebar row's
 * dot and the tests all read the same verdict.
 *
 * Which connectors a chat loads, from what the chip already knows (no extra
 * reads): a user-level config counts when its Paseo provider id is the
 * agent's provider; a project `.mcp.json` counts when the agent works in that
 * project or below it. A report from a host older than 0.19.1 has no provider
 * id on its scopes, so every user-level config counts there.
 */
import { healthNeedsAttention, scopedToDirectory, type McpHealthReport, type McpHealthScope } from "./contracts";

/** The agent a chat runs: its Paseo provider id and its working directory ("" when unknown). */
export type AttentionAgent = { provider: string; cwd: string };

/** A connector some account still has to sign in to, and the Paseo provider ids whose agents use that account. */
export type SignInNeed = { name: string; providerIds: string[] };

export type ChatAttention = { failing: string[]; signIn: string[] };

function scopeIsThisChats(scope: McpHealthScope, agent: AttentionAgent): boolean {
  if (scope.level === "project") return scopedToDirectory(scope, agent.cwd);
  return scope.providerId === undefined || scope.providerId === agent.provider;
}

/** The connectors this chat loads that are failing or need sign-in. Both empty: the chat is calm. */
export function chatAttention(report: McpHealthReport | null | undefined, signIn: readonly SignInNeed[] | null | undefined, agent: AttentionAgent): ChatAttention {
  const failing = (report?.results ?? [])
    .filter((entry) => healthNeedsAttention(entry.status) && entry.scopes.some((scope) => scopeIsThisChats(scope, agent)))
    .map((entry) => entry.name);
  const names = new Set((signIn ?? []).filter((need) => need.providerIds.includes(agent.provider)).map((need) => need.name));
  // A connector that is failing says so once, as failing.
  for (const name of failing) names.delete(name);
  return { failing, signIn: [...names].sort() };
}

const connectors = (count: number) => `${count} ${count === 1 ? "connector" : "connectors"}`;

/** The chip's words, or null for no chip. Failing comes first; sign-in is added when there is room for both. */
export function attentionLabel(attention: ChatAttention): string | null {
  const failing = attention.failing.length;
  const signIn = attention.signIn.length;
  if (failing > 0 && signIn > 0) return `${connectors(failing)} failing, ${signIn} need${signIn === 1 ? "s" : ""} sign-in`;
  if (failing > 0) return `${connectors(failing)} failing`;
  if (signIn > 0) return `${connectors(signIn)} need${signIn === 1 ? "s" : ""} sign-in`;
  return null;
}

/** The chip's face for a chat, or null for no chip. The icon carries the kind, so colour is never the only channel. */
export function attentionFace(attention: ChatAttention): { label: string; icon: string } | null {
  const label = attentionLabel(attention);
  if (!label) return null;
  return { label, icon: attention.failing.length > 0 ? "TriangleAlert" : "KeyRound" };
}

/** For the sidebar row's dot: anything on this computer that needs the user, whichever chat it belongs to. */
export function hostNeedsAttention(report: McpHealthReport | null | undefined, signIn: readonly SignInNeed[] | null | undefined): "failing" | "sign-in" | null {
  if ((report?.results ?? []).some((entry) => healthNeedsAttention(entry.status))) return "failing";
  if ((signIn ?? []).some((need) => need.providerIds.length > 0)) return "sign-in";
  return null;
}
