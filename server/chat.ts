import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  CHAT_SCAN_LIMIT,
  SIGN_IN_KIND,
  SIGN_IN_VERSION,
  authFailureServer,
  cardedServers,
  countCalls,
  planTurnOffUnused,
  signInCardsFor,
  type TurnOffPlan,
} from "../shared/chat";
import type { AgentChatRead, AgentMeter } from "../shared/contracts";
import { PASEO_COST_NAME, meterFor, usageFrom, type ContextUsage, type ToolsKnown } from "../shared/meter";
import { readAgentServers } from "./agent-record";
import { handleMcpAgentServers, handleMcpSetEnabled } from "./enabled";
import { readHealthSettings } from "./health";
import { clientSeenWithin } from "./presence";
import { withDeadline } from "./run";
import { toolsReportNow } from "./tools";

/**
 * One agent's context meter, what its chat used, and the in-chat sign-in card
 * (0.14.0). Everything the RPC answers comes from a per-agent cache refreshed
 * in the background, so the chip and the panel never wait on the daemon.
 *
 * The timeline is read through the agent handle (`paseo.agents.ref(id)
 * .timeline.refetch`): the newest page, then older pages, 500 items at a time,
 * to CHAT_SCAN_LIMIT items at most. Only tool names, statuses and plugin items
 * are looked at; arguments, output and error text never leave this module.
 */

type Paseo = PluginHandlerContext["paseo"];

const TAG = "[paseo-mcp]";
export const METER_TTL_MS = 60_000;
export const CHAT_TTL_MS = 60_000;
/** A refresh that failed is not tried again from a read for this long. */
const RETRY_MS = 60_000;
const PAGE = 500;
/** Agents remembered at once; the oldest is forgotten past this. */
const MAX_AGENTS = 200;
/** Items of one turn looked at for a failed sign-in. */
const TURN_SCAN_LIMIT = 500;

// ----------------------------------------------------------------- timeline

type TimelinePage = Awaited<ReturnType<ReturnType<Paseo["agents"]["ref"]>["timeline"]["refetch"]>>;

/** `complete`: every page was read, back to the chat's first item; `truncated` is its opposite. */
export type TimelineRead = { items: unknown[]; truncated: boolean; complete: boolean; usage: ContextUsage | null };

/**
 * Newest items first read, oldest kept at the front, never more than `limit`.
 * A page that fails fails the whole read. `usage: false` skips the context use.
 */
export async function readTimeline(paseo: Paseo, agentId: string, limit = CHAT_SCAN_LIMIT, { usage: withUsage = true }: { usage?: boolean } = {}): Promise<TimelineRead> {
  const handle = paseo.agents.ref(agentId);
  const items: unknown[] = [];
  let cursor: TimelinePage["startCursor"] = null;
  let hasOlder = false;
  let snapshot: unknown = null;
  for (let first = true; items.length < limit; first = false) {
    const size = Math.min(PAGE, limit - items.length);
    const page: TimelinePage = await withDeadline(
      handle.timeline.refetch(first ? { direction: "tail", limit: size, projection: "projected" } : { direction: "before", cursor: cursor!, limit: size, projection: "projected" }),
      "the agent's timeline",
    );
    snapshot = page.agent ?? snapshot;
    const entries = page.entries ?? [];
    items.unshift(...entries.map((entry) => entry.item));
    hasOlder = page.hasOlder;
    cursor = page.startCursor;
    if (!hasOlder || !cursor || entries.length === 0) break;
  }
  if (items.length > limit) items.splice(0, items.length - limit);
  // Older items left unread for any reason (the cap, no cursor, an empty page) make the read incomplete.
  const complete = !hasOlder;
  if (!withUsage) return { items, truncated: !complete, complete, usage: null };
  let usage = usageFrom(handle.lastUsage ?? (snapshot as { lastUsage?: unknown } | null)?.lastUsage);
  if (!usage) {
    const refreshed = await withDeadline(handle.refresh(), "the agent").catch(() => null);
    usage = usageFrom(handle.lastUsage ?? refreshed?.agent?.lastUsage);
  }
  return { items, truncated: !complete, complete, usage };
}

// -------------------------------------------------------------------- cache

type MeterInput = { workspaceId: string; providerId: string; agentId: string };

type Entry = {
  meter: AgentMeter | null;
  loaded: string[];
  meterAt: number;
  meterFailedAt: number;
  chat: AgentChatRead | null;
  usage: ContextUsage | null;
  chatAt: number;
  chatFailedAt: number;
  meterFlight: Promise<void> | null;
  chatFlight: Promise<void> | null;
};

const entries = new Map<string, Entry>();

function agentKey(input: MeterInput): string {
  return `${input.workspaceId}\u0000${input.providerId}\u0000${input.agentId}`;
}

function entryFor(key: string): Entry {
  let entry = entries.get(key);
  if (entry) {
    // Most recently used last, so the oldest is the first one forgotten.
    entries.delete(key);
    entries.set(key, entry);
    return entry;
  }
  entry = { meter: null, loaded: [], meterAt: 0, meterFailedAt: 0, chat: null, usage: null, chatAt: 0, chatFailedAt: 0, meterFlight: null, chatFlight: null };
  entries.set(key, entry);
  while (entries.size > MAX_AGENTS) entries.delete(entries.keys().next().value!);
  return entry;
}

/** Tool lists by server name, as the meter reads them. */
function knownTools(): Map<string, ToolsKnown> {
  const report = toolsReportNow();
  return new Map(
    (report?.servers ?? []).map((entry) => [
      entry.name,
      { listed: entry.kind === "listed", tools: entry.tools.length, ...(entry.definitionTokens !== undefined ? { definitionTokens: entry.definitionTokens } : {}) },
    ]),
  );
}

type AgentServersRead = Awaited<ReturnType<typeof handleMcpAgentServers>>;

/** The names a chat's calls are matched against: editor servers that load, added ones, and Paseo's. */
function loadedNames(data: AgentServersRead): string[] {
  const servers = data.servers.filter((entry) => entry.enabled.state !== "disabled");
  const paseoTools = data.paseoTools?.tools ?? 0;
  return [...new Set([...servers.map((entry) => entry.name), ...(data.pluginServers ?? []).map((entry) => entry.name), ...(paseoTools > 0 ? [PASEO_COST_NAME] : [])])];
}

/** The chip's path: cached counts only, so no `tools/list` and no Codex run (`probe: false`). */
async function computeMeter(input: MeterInput, context: PluginHandlerContext): Promise<{ meter: AgentMeter; loaded: string[] }> {
  const data = await handleMcpAgentServers(input, context, { probe: false });
  // A server switched off for this workspace does not load in a new session.
  const servers = data.servers.filter((entry) => entry.enabled.state !== "disabled");
  const paseoTools = data.paseoTools?.tools ?? 0;
  const meter = meterFor({ servers, added: data.pluginServers, known: knownTools(), paseoTools, toolSearch: data.toolSearch });
  return { meter, loaded: loadedNames(data) };
}

function startMeter(entry: Entry, input: MeterInput, context: PluginHandlerContext): Promise<void> {
  if (entry.meterFlight) return entry.meterFlight;
  entry.meterFlight = computeMeter(input, context)
    .then(({ meter, loaded }) => {
      entry.meter = meter;
      entry.loaded = loaded;
      entry.meterAt = Date.now();
    })
    .catch((error: unknown) => {
      entry.meterFailedAt = Date.now();
      console.warn(`${TAG} context meter failed: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      entry.meterFlight = null;
    });
  return entry.meterFlight;
}

function startChat(entry: Entry, input: MeterInput, context: PluginHandlerContext): Promise<void> {
  if (entry.chatFlight) return entry.chatFlight;
  const run = async () => {
    if (!entry.meter) await startMeter(entry, input, context);
    // Without the server list every call would count against nobody: no verdict at all.
    if (!entry.meter) throw new Error("the agent's servers could not be read");
    const read = await readTimeline(context.paseo, input.agentId);
    const known = entry.loaded;
    entry.chat = { scanned: read.items.length, truncated: read.truncated, complete: read.complete, calls: countCalls(read.items, known), loaded: known, asOf: new Date().toISOString() };
    entry.usage = read.usage;
    entry.chatAt = Date.now();
    // The fallback detection path: a failure from before an app was connected
    // gets its card when the panel reads the chat. Same dedupe as the hook.
    if (readHealthSettings().chatSignInNotices) {
      const provider = input.providerId;
      await queueNotices(context.paseo, input.agentId, provider, read.items, known, read.items);
    }
  };
  entry.chatFlight = run()
    .catch(() => {
      entry.chatFailedAt = Date.now();
      // No error text: a timeline read can fail on content this module must not log.
      console.warn(`${TAG} chat read failed for one agent; the panel shows the last read`);
    })
    .finally(() => {
      entry.chatFlight = null;
    });
  return entry.chatFlight;
}

/**
 * Never waits. Starts a background refresh when the meter (or, with `chat`,
 * the chat read) is missing or over a minute old, and says `checking` while
 * one runs.
 */
export async function handleMcpAgentChat(
  input: { workspaceId: string; providerId: string; agentId: string; chat?: boolean },
  context: PluginHandlerContext,
) {
  const entry = entryFor(agentKey(input));
  const now = Date.now();
  const target = { workspaceId: input.workspaceId, providerId: input.providerId, agentId: input.agentId };
  if (now - entry.meterAt >= METER_TTL_MS && now - entry.meterFailedAt >= RETRY_MS) void startMeter(entry, target, context);
  if (input.chat && now - entry.chatAt >= CHAT_TTL_MS && now - entry.chatFailedAt >= RETRY_MS) void startChat(entry, target, context);
  // The last read failed after (or without) a good one: what is served is out of date.
  const stale = Boolean(input.chat) && entry.chatFailedAt > entry.chatAt;
  return {
    checking: entry.meterFlight !== null || (Boolean(input.chat) && entry.chatFlight !== null),
    meter: entry.meter,
    usage: input.chat ? entry.usage : null,
    chat: input.chat ? entry.chat : null,
    stale,
    ...(stale ? { failedAt: new Date(entry.chatFailedAt).toISOString() } : {}),
  };
}

// ---------------------------------------------------------- turn off unused

export const TURN_OFF_CHANGED = "The chat changed since you reviewed this list; review again.";
export const TURN_OFF_TOO_LONG = "This chat is too long to be sure which servers it used, so nothing was switched off.";
export const TURN_OFF_UNREADABLE = "Couldn't read this chat's history, so nothing was switched off.";
export const TURN_OFF_NO_SERVERS = "Couldn't read this agent's servers, so nothing was switched off.";

type TurnOffResult = {
  ok: boolean;
  message: string;
  refused?: "changed" | "too-long" | "unreadable" | "no-servers";
  done: string[];
  failed: string[];
  plan?: TurnOffPlan;
};

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

/**
 * "Turn off the unused ones", decided here and never from the panel's copy: a
 * fresh read of the server list and of the whole chat (no cache, every page),
 * the plan rebuilt from them, and a switch flipped only when that plan is
 * exactly the list the user confirmed. Anything short of that switches nothing.
 */
export async function handleMcpTurnOffUnused(
  input: { workspaceId: string; providerId: string; agentId: string; expected: string[] },
  context: PluginHandlerContext,
): Promise<TurnOffResult> {
  const refuse = (refused: NonNullable<TurnOffResult["refused"]>, message: string, plan?: TurnOffPlan): TurnOffResult => ({ ok: false, message, refused, done: [], failed: [], ...(plan ? { plan } : {}) });
  let data: AgentServersRead;
  try {
    data = await handleMcpAgentServers({ workspaceId: input.workspaceId, providerId: input.providerId, agentId: input.agentId }, context, { probe: false });
  } catch {
    return refuse("no-servers", TURN_OFF_NO_SERVERS);
  }
  let read: TimelineRead;
  try {
    read = await readTimelineImpl(context.paseo, input.agentId, CHAT_SCAN_LIMIT, { usage: false });
  } catch {
    return refuse("unreadable", TURN_OFF_UNREADABLE);
  }
  if (!read.complete) return refuse("too-long", TURN_OFF_TOO_LONG);
  const plan = planTurnOffUnused(data.servers, countCalls(read.items, loadedNames(data)));
  if (!sameNames(plan.off, input.expected)) return refuse("changed", TURN_OFF_CHANGED, plan);
  const done: string[] = [];
  const failed: string[] = [];
  for (const name of plan.off) {
    try {
      const result = await handleMcpSetEnabled({ workspaceId: input.workspaceId, providerId: input.providerId, name, enabled: false }, context);
      (result.ok ? done : failed).push(name);
    } catch {
      failed.push(name);
    }
  }
  // The next panel read starts over from the files and the timeline.
  entries.delete(agentKey(input));
  const message = [
    done.length ? `Off for this workspace: ${done.join(", ")}. New sessions start without them.` : plan.off.length ? "" : "Nothing to turn off.",
    failed.length ? `Not changed: ${failed.join(", ")}. Try their switches below.` : "",
  ].filter(Boolean).join(" ");
  return { ok: failed.length === 0, message, done, failed, plan };
}

// ----------------------------------------------------------------- sign-in

/** Per agent, the servers that already have a card in its chat. */
const carded = new Map<string, Set<string>>();
/** Per agent, the notices being worked on, one at a time. */
const queues = new Map<string, Promise<void>>();
let readTimelineImpl = readTimeline;

/**
 * Append at most one card per server per chat. The first time an agent is
 * seen in this run, its timeline is read back for cards an earlier run added;
 * if that read fails, nothing is appended this time, so a restart can never
 * add a second card. A server is marked before its append, and a failed append
 * is not retried: no loop, no duplicate.
 */
function queueNotices(paseo: Paseo, agentId: string, provider: string, items: readonly unknown[], known: readonly string[], history?: readonly unknown[]): Promise<void> {
  const previous = queues.get(agentId) ?? Promise.resolve();
  const next = previous.then(async () => {
    let seen = carded.get(agentId);
    if (!seen) {
      const earlier = history ?? (await readTimelineImpl(paseo, agentId).catch(() => null))?.items;
      if (!earlier) return;
      seen = cardedServers(earlier);
      carded.set(agentId, seen);
      while (carded.size > MAX_AGENTS) carded.delete(carded.keys().next().value!);
    }
    for (const card of signInCardsFor(items, known, seen, provider)) {
      seen.add(card.server);
      try {
        await withDeadline(
          paseo.agents.ref(agentId).timeline.append({
            type: "plugin",
            // Stable per server, so the daemon holds one card per server per chat even if this map were lost.
            id: `${SIGN_IN_KIND}:${card.server}`,
            kind: SIGN_IN_KIND,
            version: SIGN_IN_VERSION,
            data: { server: card.server, provider: card.provider },
          }),
          "the agent's timeline",
        );
        console.log(`${TAG} chat notice: ${card.server} needs sign-in`);
      } catch {
        console.warn(`${TAG} chat notice for ${card.server} was not added`);
      }
    }
  });
  const settled = next.catch(() => undefined);
  queues.set(agentId, settled);
  void settled.finally(() => {
    if (queues.get(agentId) === settled) queues.delete(agentId);
  });
  return settled;
}

/** Server names an agent may call: the tool lists', the ones it was created with, and Paseo's. */
function knownNames(agentId: string, cwd: string): string[] {
  const names = new Set<string>([PASEO_COST_NAME]);
  for (const entry of toolsReportNow()?.servers ?? []) names.add(entry.name);
  for (const entry of readAgentServers(agentId, [cwd]) ?? []) names.add(entry.name);
  return [...names];
}

type TurnEnded = { agent: { id: string; provider: string; cwd: string }; timeline: readonly unknown[] };

/**
 * `agent.turn_ended` carries that turn's timeline, so no subscription is
 * needed. Only while an app is connected (server/presence.ts) and the setting
 * is on; a turn with no auth-shaped MCP failure costs one pass over its items.
 */
export function onTurnEnded(event: TurnEnded, paseo: Paseo): Promise<void> | undefined {
  if (!clientSeenWithin()) return undefined;
  if (!readHealthSettings().chatSignInNotices) return undefined;
  const items = event.timeline.slice(-TURN_SCAN_LIMIT);
  // A card only ever names a server this agent knows, so the known list comes first.
  const known = knownNames(event.agent.id, event.agent.cwd);
  if (!items.some((item) => authFailureServer(item, known) !== null)) return undefined;
  return queueNotices(paseo, event.agent.id, event.agent.provider, items, known);
}

export function registerChatNotices(server: PluginServerContext): () => void {
  return server.on("agent.turn_ended", (event, { paseo }) => {
    void onTurnEnded(event, paseo);
  });
}

// ------------------------------------------------------------------- tests

/** For tests: forget every agent, and optionally read timelines some other way. */
export function resetChat(options: { readTimeline?: typeof readTimeline } = {}): void {
  entries.clear();
  carded.clear();
  queues.clear();
  readTimelineImpl = options.readTimeline ?? readTimeline;
}

/** For tests: wait for every background read and notice. */
export async function chatSettled(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    const flights = [...entries.values()].flatMap((entry) => [entry.meterFlight, entry.chatFlight]).filter(Boolean);
    const all = [...flights, ...queues.values()];
    if (all.length === 0) return;
    await Promise.all(all);
  }
}
