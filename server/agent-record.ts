import { join, win32 } from "node:path";
import { isSafeAgentId, recordServers, type RecordServer } from "../shared/agent-record";
import { listToolsMcp, type FetchLike } from "../shared/tools";
import { readJsonCached } from "./files";
import { paseoHome } from "./settings";

/**
 * The daemon's project directory name for a cwd, exactly as
 * `agent-storage.js` `projectDirNameFromCwd` builds it in @getpaseo/server
 * 0.9.1: `path.win32.parse` finds the root (drive letter, UNC share, or "/"),
 * the root is stripped to letters ("C:\\" → "C"), and every separator run in
 * the rest becomes "-". Server-only, since it needs node:path.
 */
export function agentProjectDir(cwd: string): string {
  const { root } = win32.parse(cwd);
  const withoutRoot = cwd.slice(root.length).replace(/[\\/]+$/, "");
  const sanitizedRoot = root.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "");
  if (!withoutRoot) return sanitizedRoot || "root";
  return (sanitizedRoot ? `${sanitizedRoot}-` : "") + withoutRoot.replace(/[\\/]+/g, "-");
}

/**
 * The servers an agent was actually started with, from the record the daemon
 * writes after every `agent.create` hook ran (see shared/agent-record.ts).
 * Read-only, through the stat-keyed file cache. `cwds` are the directories the
 * agent may have been started in (the workspace's own, then its project
 * root); the record sits under the one the daemon used. Null when no record
 * for this agent is found, so the panel shows nothing rather than a guess.
 */
export function readAgentServers(agentId: string, cwds: readonly string[], home = paseoHome()): RecordServer[] | null {
  if (!isSafeAgentId(agentId)) return null;
  for (const cwd of new Set(cwds.filter(Boolean))) {
    const dir = agentProjectDir(cwd);
    if (dir === "." || dir === "..") continue;
    const servers = recordServers(readJsonCached(join(home, "agents", dir, `${agentId}.json`)), agentId);
    if (servers) return servers;
  }
  return null;
}

// ------------------------------------------------------------ HTTP tool counts

/**
 * Tool counts for plugin-added HTTP servers, from the same `initialize` +
 * `tools/list` probe the Tools view uses (shared/tools.ts `listToolsMcp`).
 * The panel read never waits for it: it gets the last answer, and a probe
 * starts in the background when there is none or it is older than ten
 * minutes, one per URL at a time. A good count is kept when a later ask fails.
 * Headers from the record are sent to that server only and never returned.
 */
export const ADDED_TOOLS_TTL_MS = 10 * 60_000;

export type AddedCount = { tools?: number; note: string };

type Entry = { at: number; count: AddedCount };

const counts = new Map<string, Entry>();
const inFlight = new Map<string, Promise<void>>();
let probeFetch: FetchLike | undefined;

/** For tests: a fake fetch, or null to reset the cache and use the real one. */
export function configureAddedProbe(next: { fetch?: FetchLike } | null): void {
  probeFetch = next?.fetch;
  counts.clear();
  inFlight.clear();
}

/** Resolves once every background probe started so far has settled; for tests. */
export async function addedProbesSettled(): Promise<void> {
  await Promise.all([...inFlight.values()]);
}

async function ask(url: string, headers: Record<string, string> | undefined): Promise<AddedCount> {
  try {
    const outcome = await listToolsMcp(url, headers, probeFetch ? { fetch: probeFetch } : {});
    if (outcome.kind === "listed") return { tools: outcome.tools.length, note: `${outcome.tools.length} ${outcome.tools.length === 1 ? "tool" : "tools"}` };
    if (outcome.kind === "auth-required") return { note: "needs a sign-in before it lists its tools" };
    return { note: `tools not listed: ${outcome.note || "no answer"}` };
  } catch {
    return { note: "tools not listed: no answer" };
  }
}

/** One ask; a failure is recorded too, so it is not retried before the ten minutes are up. */
async function probe(url: string, headers: Record<string, string> | undefined): Promise<void> {
  const count = await ask(url, headers);
  const previous = counts.get(url);
  // Keep the last good count through a failed ask, as the Tools view does.
  if (count.tools === undefined && previous?.count.tools !== undefined) {
    counts.set(url, { at: Date.now(), count: previous.count });
    return;
  }
  counts.set(url, { at: Date.now(), count });
}

/** The last known count for one server; starts a background probe when due. Never waits. */
export function addedToolCount(server: RecordServer, now = Date.now()): AddedCount {
  if (server.transport === "stdio") return { note: "runs on demand" };
  if (server.transport !== "http" || !server.url) return { note: "no command or URL the plugin can read" };
  const url = server.url;
  const hit = counts.get(url);
  if ((!hit || now - hit.at >= ADDED_TOOLS_TTL_MS) && !inFlight.has(url)) {
    const run = probe(url, server.headers).finally(() => inFlight.delete(url));
    inFlight.set(url, run);
  }
  return hit?.count ?? { note: "tools not counted yet" };
}
