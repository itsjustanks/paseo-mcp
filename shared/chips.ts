/**
 * The Connectors chip on a live agent's composer, as a registry with
 * everything it touches passed in, so it can be tested without an app (0.18.1).
 *
 * 0.19.1, attention only: the user found our plugins add "too many… like
 * composer chips". The chip used to sit on every agent ("12 MCP · ~38k
 * tokens"); now it shows only while a connector that chat loads is failing or
 * needs sign-in ("1 connector failing", "2 connectors need sign-in"), and a
 * calm chat has none. The counts and token cost are in the agent panel. The
 * verdict is shared/attention.ts, from the one health read the chip already
 * made, so the registry now reads less than before: no tool lists, no Paseo
 * tool counts and no context meters.
 *
 * Paseo 0.8.0 stable and later take a chip as a `button` ({ title, icon,
 * label, behavior }) and hand back `{ update, remove }`; the old shape (a
 * React `Component` and `onPress`, from the 0.8.0-beta.1 SDK this plugin
 * builds against) threw there, so the chip never showed on 0.9 or 0.11 apps.
 * Reported, with a first fix, by @hteo1337 in itsjustanks/paseo-mcp#1. On the
 * old shape the component draws the face it gets from `publish`.
 */
import { attentionFace, chatAttention, chatIsLive, hostAttentionNames, hostNeedsAttention, type ChatAttention, type SignInNeed } from "./attention";
import type { McpHealthReport } from "./contracts";
import { backoffMs } from "./schedule";

/** `status` and `lastActivityAt` (0.19.2) decide whether the chat is live enough for a chip; absent on older apps. */
export type ChipAgent = { id: string; workspaceId: string; provider: string; cwd: string; status?: string; lastActivityAt?: string | null };

/**
 * The agent a chip is for, from what the app reports, or null for none: a
 * closed or archived agent, or one with no workspace. Since 0.9 the plugin's
 * own observation lists every agent the daemon has (83 on one host, closed
 * ones and ones whose workspace is gone among them), so this filter matters.
 */
export function chipAgentFrom(
  raw: { id?: string; workspaceId?: string | null; provider?: string | null; status?: string; archivedAt?: string | null; cwd?: string | null; lastActivityAt?: string | null; updatedAt?: string | null } | undefined,
): ChipAgent | null {
  if (!raw?.id || !raw.workspaceId || raw.status === "closed" || raw.archivedAt) return null;
  // Paseo 0.11's agent list sends `updatedAt` (checked on the wire, 2026-10-06); `lastActivityAt` is the SDK's name for it.
  const lastActivityAt = raw.lastActivityAt ?? raw.updatedAt ?? null;
  return {
    id: raw.id,
    workspaceId: raw.workspaceId,
    provider: raw.provider ?? "",
    cwd: raw.cwd ?? "",
    ...(raw.status ? { status: raw.status } : {}),
    ...(lastActivityAt ? { lastActivityAt } : {}),
  };
}
export type ChipFace = { label: string; icon: string };
export type ChipHandle = { update(face: ChipFace): void; remove(): void };

/** What the registry last decided, for the sidebar row's dot and the old chip component. */
export type AttentionState = {
  host: "failing" | "sign-in" | null;
  faces: ReadonlyMap<string, ChipFace>;
  /** 0.19.2: the connectors behind the dot, for its popover. */
  names?: ChatAttention;
};

export type ChipDeps = {
  /** Put one chip on an agent's composer; returns how to change and remove it. */
  addChip(agent: ChipAgent, face: ChipFace): ChipHandle;
  /** The setting (show the chip or not), the cached health report and the sign-in needs, in one read. */
  readHealth(): Promise<{ wanted: boolean; report: McpHealthReport | null; signIn?: SignInNeed[] }>;
  /** Told after every change, with what needs attention. */
  publish?(state: AttentionState): void;
  schedule(run: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  /** One read a minute while there is an agent; slower after failures, up to `maxPollMs`. */
  pollMs: number;
  maxPollMs: number;
  /** The clock, for which chats are live (0.19.2); `Date.now` when absent. */
  now?(): number;
};

export function createChipRegistry(deps: ChipDeps) {
  const agents = new Map<string, ChipAgent>();
  const chips = new Map<string, { handle: ChipHandle; face: ChipFace }>();
  // Nothing is shown before the first read: no chip is better than one that blinks away.
  let read: { wanted: boolean; report: McpHealthReport | null; signIn: SignInNeed[] } | null = null;
  let failures = 0;
  let timer: unknown = null;
  let stopped = false;
  // A read in flight: another snapshot arriving meanwhile waits for its answer instead of reading again.
  let reading = false;

  const faceFor = (agent: ChipAgent): ChipFace | null => {
    if (!read?.wanted) return null;
    // 0.19.2: an old finished chat gets no chip; it gets one again when it runs.
    if (!chatIsLive(agent, (deps.now ?? Date.now)())) return null;
    return attentionFace(chatAttention(read.report, read.signIn, agent));
  };

  const drop = (id: string) => {
    try {
      chips.get(id)?.handle.remove();
    } catch {
      // Already gone on the app's side.
    }
    chips.delete(id);
  };

  const reconcile = () => {
    if (stopped) return;
    for (const agent of agents.values()) {
      const face = faceFor(agent);
      const chip = chips.get(agent.id);
      if (!face) {
        if (chip) drop(agent.id);
      } else if (!chip) {
        try {
          chips.set(agent.id, { handle: deps.addChip(agent, face), face });
        } catch {
          // An app that refuses this chip (a workspace it doesn't know yet) gets another try on the next read.
        }
      } else if (chip.face.label !== face.label || chip.face.icon !== face.icon) {
        try {
          chip.handle.update(face);
          chip.face = face;
        } catch {
          drop(agent.id);
        }
      }
    }
    for (const id of [...chips.keys()]) if (!agents.has(id)) drop(id);
    deps.publish?.({
      host: read ? hostNeedsAttention(read.report, read.signIn) : null,
      names: read ? hostAttentionNames(read.report, read.signIn) : { failing: [], signIn: [] },
      faces: new Map([...chips.entries()].map(([id, chip]) => [id, chip.face])),
    });
  };

  const schedule = () => {
    if (stopped) return;
    timer = deps.schedule(() => void poll(), backoffMs(failures, deps.pollMs, deps.maxPollMs));
  };

  const poll = async (): Promise<void> => {
    timer = null;
    if (agents.size > 0) {
      reading = true;
      try {
        const next = await deps.readHealth();
        read = { wanted: next.wanted, report: next.report, signIn: next.signIn ?? [] };
        failures = 0;
      } catch {
        // Host unreachable: keep whatever the last read decided.
        failures += 1;
      } finally {
        reading = false;
      }
      reconcile();
    }
    schedule();
  };

  /** Read now instead of at the next beat (the first agent). */
  const pollNow = () => {
    if (reading) return;
    if (timer !== null) deps.cancel(timer);
    timer = null;
    void poll();
  };

  return {
    /** An agent appeared or changed (its workspace, provider or folder). Decided from the last read; no new read. */
    upsert(agent: ChipAgent) {
      if (stopped || !agent.id || !agent.workspaceId) return;
      const first = agents.size === 0;
      agents.set(agent.id, agent);
      if (first && read === null) pollNow();
      else reconcile();
    },
    remove(agentId: string) {
      agents.delete(agentId);
      reconcile();
    },
    /** A full list from the app (a snapshot after connecting or reconnecting): it replaces what was known. */
    replaceAll(list: ChipAgent[]) {
      if (stopped) return;
      agents.clear();
      for (const agent of list) if (agent.id && agent.workspaceId) agents.set(agent.id, agent);
      if (read === null && agents.size > 0) pollNow();
      else reconcile();
    },
    start() {
      void poll();
    },
    stop() {
      stopped = true;
      if (timer !== null) deps.cancel(timer);
      timer = null;
      for (const id of [...chips.keys()]) drop(id);
      agents.clear();
    },
    /** For tests: which agents have a chip. */
    shown(): string[] {
      return [...chips.keys()];
    },
  };
}
