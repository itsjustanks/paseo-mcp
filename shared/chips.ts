/**
 * The MCP chip on each live agent's composer, as a registry with everything
 * it touches passed in, so it can be tested without an app (0.18.1).
 *
 * Paseo 0.8.0 stable and later take a chip as a `button` ({ title, icon,
 * label, behavior }) and hand back `{ update, remove }`; the old shape (a
 * React `Component` and `onPress`, from the 0.8.0-beta.1 SDK this plugin
 * builds against) throws there, so the chip never showed on 0.9 or 0.11 apps.
 * Reported, with a first fix, by @hteo1337 in itsjustanks/paseo-mcp#1.
 *
 * With buttons the label is a string the plugin pushes, so this registry
 * works it out the way the old chip component did (`chipLabel`): the cached
 * health report, the cached tool lists, Paseo's own tools for the agent's
 * provider, and the agent's context meter. On an app that still takes the old
 * component, `labels` is null and the component draws its own label.
 */
import { chipLabel, type AgentMeter, type McpHealthReport, type McpToolsReport, type PaseoToolsStateReport } from "./contracts";
import { paseoToolCount } from "./paseo-tools";
import { backoffMs } from "./schedule";

/** `active`: running or starting, so its context meter is worth reading. */
export type ChipAgent = { id: string; workspaceId: string; provider: string; active: boolean };

/** A meter read that failed (a workspace that's gone, say) is not asked again for this long (0.18.3). */
export const METER_RETRY_MS = 10 * 60_000;

/**
 * The agent a chip is for, from what the app reports, or null for none: a
 * closed or archived agent, or one with no workspace. Since 0.9 the plugin's
 * own observation lists every agent the daemon has (83 on one host, closed
 * ones and ones whose workspace is gone among them), so this filter matters.
 */
export function chipAgentFrom(raw: { id?: string; workspaceId?: string | null; provider?: string | null; status?: string; archivedAt?: string | null } | undefined): ChipAgent | null {
  if (!raw?.id || !raw.workspaceId || raw.status === "closed" || raw.archivedAt) return null;
  return { id: raw.id, workspaceId: raw.workspaceId, provider: raw.provider ?? "", active: raw.status === "running" || raw.status === "initializing" };
}
export type ChipFace = { label: string; icon: string };
export type ChipHandle = { update(face: ChipFace): void; remove(): void };

export type ChipDeps = {
  /** Put one chip on an agent's composer; returns how to change and remove it. */
  addChip(agent: ChipAgent, face: ChipFace): ChipHandle;
  /** The setting (show the chip or not) and the cached health report, in one read. */
  readHealth(): Promise<{ wanted: boolean; report: McpHealthReport | null }>;
  /** What else the label needs; null when the app draws the label itself (the old component). */
  labels: null | {
    tools(): Promise<McpToolsReport | null>;
    paseo(): Promise<PaseoToolsStateReport | null>;
    meter(agent: ChipAgent): Promise<AgentMeter | null>;
  };
  schedule(run: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  /** One read a minute while there is an agent; slower after failures, up to `maxPollMs`. */
  pollMs: number;
  maxPollMs: number;
  /** The clock, for tests. */
  now?: () => number;
};

/** A chip before its first label arrives. */
export const CHIP_FIRST_FACE: ChipFace = { label: "Connectors", icon: "Plug" };

/** The chip's face for a label and tone: the icon carries the tone, so colour is never the only channel. */
export function chipFace(label: string, tone: "calm" | "attention"): ChipFace {
  return { label, icon: tone === "attention" ? "TriangleAlert" : "Plug" };
}

const quietly = <T>(read: () => Promise<T>): Promise<T | null> => read().catch(() => null);

export function createChipRegistry(deps: ChipDeps) {
  const agents = new Map<string, ChipAgent>();
  const chips = new Map<string, ChipHandle>();
  // Assume on until the host says otherwise: the setting defaults to on, and a
  // chip that appears a minute late reads worse than one that blinks off.
  let wanted = true;
  let report: McpHealthReport | null = null;
  let failures = 0;
  let timer: unknown = null;
  let stopped = false;
  const now = deps.now ?? (() => Date.now());
  // Agents whose meter read failed, and when to try again.
  const meterQuietUntil = new Map<string, number>();

  /** This agent's meter, when it is running and its last read didn't just fail; else null (the label goes without it). */
  const readMeter = async (agent: ChipAgent): Promise<AgentMeter | null> => {
    const labels = deps.labels;
    if (!labels || !agent.active || !agent.provider) return null;
    if ((meterQuietUntil.get(agent.id) ?? 0) > now()) return null;
    try {
      const meter = await labels.meter(agent);
      meterQuietUntil.delete(agent.id);
      return meter;
    } catch {
      meterQuietUntil.set(agent.id, now() + METER_RETRY_MS);
      return null;
    }
  };

  const reconcile = (): ChipAgent[] => {
    const added: ChipAgent[] = [];
    if (stopped) return added;
    for (const agent of agents.values()) {
      if (wanted && !chips.has(agent.id)) {
        try {
          chips.set(agent.id, deps.addChip(agent, CHIP_FIRST_FACE));
          added.push(agent);
        } catch {
          // An app that refuses this chip (a workspace it doesn't know yet) gets another try on the next read.
        }
      } else if (!wanted && chips.has(agent.id)) {
        chips.get(agent.id)?.remove();
        chips.delete(agent.id);
      }
    }
    for (const id of [...chips.keys()]) {
      if (agents.has(id)) continue;
      chips.get(id)?.remove();
      chips.delete(id);
    }
    return added;
  };

  /** Work out and push the label of each chip in `only` (all when omitted). Every read may fail on its own. */
  const refreshLabels = async (only?: ChipAgent[]): Promise<void> => {
    const labels = deps.labels;
    if (!labels || stopped || !wanted) return;
    const targets = (only ?? [...agents.values()]).filter((agent) => chips.has(agent.id));
    if (targets.length === 0) return;
    const [tools, paseo] = await Promise.all([quietly(labels.tools), quietly(labels.paseo)]);
    await Promise.all(
      targets.map(async (agent) => {
        const meter = await readMeter(agent);
        const chip = chips.get(agent.id);
        if (!chip || stopped) return;
        const { label, tone } = chipLabel(report, tools, paseoToolCount(paseo ?? undefined, agent.provider), meter);
        try {
          chip.update(chipFace(label, tone));
        } catch {
          // Removed between the read and the update: nothing to change.
        }
      }),
    );
  };

  const schedule = () => {
    if (stopped) return;
    timer = deps.schedule(() => void poll(), backoffMs(failures, deps.pollMs, deps.maxPollMs));
  };

  const poll = async (): Promise<void> => {
    timer = null;
    if (agents.size > 0) {
      try {
        const read = await deps.readHealth();
        wanted = read.wanted;
        report = read.report;
        failures = 0;
      } catch {
        // Host unreachable: keep whatever the last read decided.
        failures += 1;
      }
      reconcile();
      await refreshLabels();
    }
    schedule();
  };

  /** Read now instead of at the next beat (the first agent, or a cleared timer). */
  const pollNow = () => {
    if (timer !== null) deps.cancel(timer);
    timer = null;
    void poll();
  };

  return {
    /** An agent appeared or changed (its workspace or provider). */
    upsert(agent: ChipAgent) {
      if (stopped || !agent.id || !agent.workspaceId) return;
      const first = agents.size === 0;
      agents.set(agent.id, agent);
      const added = reconcile();
      if (first) pollNow();
      else if (added.length > 0) void refreshLabels(added);
    },
    remove(agentId: string) {
      agents.delete(agentId);
      meterQuietUntil.delete(agentId);
      reconcile();
    },
    /** A full list from the app (a snapshot after connecting or reconnecting): it replaces what was known. */
    replaceAll(list: ChipAgent[]) {
      if (stopped) return;
      const first = agents.size === 0;
      agents.clear();
      for (const agent of list) if (agent.id && agent.workspaceId) agents.set(agent.id, agent);
      const added = reconcile();
      if (first && agents.size > 0) pollNow();
      else if (added.length > 0) void refreshLabels(added);
    },
    start() {
      void poll();
    },
    stop() {
      stopped = true;
      if (timer !== null) deps.cancel(timer);
      timer = null;
      for (const chip of chips.values()) chip.remove();
      chips.clear();
      agents.clear();
    },
    /** For tests: what is on screen. */
    shown(): string[] {
      return [...chips.keys()];
    },
  };
}
