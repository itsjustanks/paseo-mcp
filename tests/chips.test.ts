/**
 * The MCP composer chip (0.18.1): on apps that take chips as buttons (Paseo
 * 0.8.0 stable and later) the registry adds a button and pushes its label; on
 * the 0.8.0-beta.1 shape the old component draws its own label; the setting
 * hides and shows chips; agents that go away lose theirs; reads that fail
 * slow the loop down without stopping it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CHIP_FIRST_FACE, METER_RETRY_MS, chipAgentFrom, chipFace, createChipRegistry, type ChipAgent, type ChipDeps, type ChipFace } from "../shared/chips";
import { canObserveAgents, supportsButtonPills } from "../shared/host-features";
import type { McpHealthReport } from "../shared/contracts";

const report = (statuses: string[]): McpHealthReport =>
  ({ checkedAt: "2026-10-05T00:00:00.000Z", results: statuses.map((status, index) => ({ name: `s${index}`, status, note: "" })) }) as unknown as McpHealthReport;

function harness(options: { labels?: boolean; wanted?: boolean; health?: McpHealthReport | null; failHealth?: boolean; failMeter?: boolean } = {}) {
  let clock = 1_000_000;
  let failMeter = options.failMeter ?? false;
  const faces = new Map<string, ChipFace[]>();
  const removed: string[] = [];
  const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
  let wanted = options.wanted ?? true;
  let failHealth = options.failHealth ?? false;
  let meterCalls = 0;
  const deps: ChipDeps = {
    addChip(agent, face) {
      faces.set(agent.id, [face]);
      return { update: (next) => faces.get(agent.id)!.push(next), remove: () => removed.push(agent.id) };
    },
    readHealth: async () => {
      if (failHealth) throw new Error("host unreachable");
      return { wanted, report: options.health ?? null };
    },
    labels:
      options.labels === false
        ? null
        : {
            tools: async () => ({ checkedAt: "x", servers: [] }) as never,
            paseo: async () => null,
            meter: async () => {
              meterCalls += 1;
              if (failMeter) throw new Error("This Paseo workspace no longer exists.");
              return { servers: 7, tokens: 24_000, deferred: false } as never;
            },
          },
    schedule(run, ms) {
      const entry = { run, ms, cancelled: false };
      timers.push(entry);
      return entry;
    },
    cancel(handle) {
      (handle as { cancelled: boolean }).cancelled = true;
    },
    pollMs: 60_000,
    maxPollMs: 15 * 60_000,
    now: () => clock,
  };
  const registry = createChipRegistry(deps);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const tick = async () => {
    const next = timers.filter((entry) => !entry.cancelled).pop();
    if (next) {
      next.cancelled = true;
      next.run();
    }
    for (let i = 0; i < 5; i += 1) await settle();
  };
  return {
    registry,
    faces,
    removed,
    timers,
    tick,
    settle: async () => {
      for (let i = 0; i < 5; i += 1) await settle();
    },
    setWanted: (next: boolean) => (wanted = next),
    setFailHealth: (next: boolean) => (failHealth = next),
    setFailMeter: (next: boolean) => (failMeter = next),
    advance: (ms: number) => (clock += ms),
    meterCalls: () => meterCalls,
  };
}

const agent = (id: string, provider = "claude", active = true): ChipAgent => ({ id, workspaceId: "ws-1", provider, active });

test("feature checks: buttons from 0.8.0 stable (addHeaderButton); agent observations from 0.9 (observeEvents)", () => {
  assert.equal(supportsButtonPills({ addComposerPill() {}, addHeaderButton() {} }), true);
  assert.equal(supportsButtonPills({ addComposerPill() {} }), false, "the 0.8.0-beta.1 shape");
  assert.equal(supportsButtonPills(null), false);
  assert.equal(canObserveAgents({ observeEvents() {}, agents: {} }), true);
  assert.equal(canObserveAgents({ agents: {} }), false, "a 0.8 app: never send subscribe");
});

test("buttons: a chip appears with a first face, then its label from health, tools and the agent's meter", async () => {
  const h = harness({ health: report(["ok", "down", "ok"]) });
  h.registry.upsert(agent("a1"));
  await h.settle();
  const faces = h.faces.get("a1")!;
  assert.deepEqual(faces[0], CHIP_FIRST_FACE);
  // 3 servers checked, 1 needs attention; the meter says this agent loads 7.
  assert.deepEqual(faces.at(-1), chipFace("7 connectors · 1 issue", "attention"));
  assert.equal(faces.at(-1)!.icon, "TriangleAlert", "the icon carries the tone");
  assert.equal(h.meterCalls(), 1);
});

test("a calm host reads the meter's cost; an agent with no provider gets no meter read", async () => {
  const h = harness({ health: report(["ok", "ok"]) });
  h.registry.upsert(agent("a1"));
  h.registry.upsert({ id: "a2", workspaceId: "ws-1", provider: "", active: true });
  await h.settle();
  assert.deepEqual(h.faces.get("a1")!.at(-1), { label: "7 connectors · ~24k tokens", icon: "Plug" });
  assert.equal(h.meterCalls(), 1, "only the agent with a provider");
  assert.deepEqual(h.faces.get("a2")!.at(-1), { label: "2 connectors · healthy", icon: "Plug" });
});

test("the old component shape: chips are added and removed, and no label is read or pushed", async () => {
  const h = harness({ labels: false, health: report(["down"]) });
  h.registry.upsert(agent("a1"));
  await h.settle();
  assert.deepEqual(h.faces.get("a1"), [CHIP_FIRST_FACE]);
  assert.equal(h.meterCalls(), 0);
});

test("the setting hides every chip and brings them back; an agent that goes away loses its chip", async () => {
  const h = harness();
  h.registry.upsert(agent("a1"));
  h.registry.upsert(agent("a2"));
  await h.settle();
  assert.deepEqual(h.registry.shown().sort(), ["a1", "a2"]);
  h.setWanted(false);
  await h.tick();
  assert.deepEqual(h.registry.shown(), []);
  assert.deepEqual(h.removed.sort(), ["a1", "a2"]);
  h.setWanted(true);
  await h.tick();
  assert.deepEqual(h.registry.shown().sort(), ["a1", "a2"]);
  h.registry.remove("a1");
  assert.deepEqual(h.registry.shown(), ["a2"]);
});

test("a snapshot replaces what was known: missing agents lose their chips, new ones get one", async () => {
  const h = harness();
  h.registry.replaceAll([agent("a1"), agent("a2")]);
  await h.settle();
  h.registry.replaceAll([agent("a2"), agent("a3")]);
  await h.settle();
  assert.deepEqual(h.registry.shown().sort(), ["a2", "a3"]);
  assert.ok(h.removed.includes("a1"));
  assert.ok(h.faces.get("a3")!.length >= 2, "a chip added later still gets its label");
});

test("a host that doesn't answer keeps the chips and reads less often (1, 2, 4 … 15 minutes)", async () => {
  const h = harness({ failHealth: true });
  h.registry.upsert(agent("a1"));
  await h.settle();
  assert.deepEqual(h.registry.shown(), ["a1"], "assumed on until the host says otherwise");
  const before = h.timers.at(-1)!.ms;
  await h.tick();
  const after = h.timers.at(-1)!.ms;
  assert.ok(after > before, `${after} > ${before}`);
  h.setFailHealth(false);
  await h.tick();
  assert.equal(h.timers.at(-1)!.ms, 60_000, "back to once a minute after an answer");
});

test("stop removes every chip and the timer", async () => {
  const h = harness();
  h.registry.upsert(agent("a1"));
  await h.settle();
  h.registry.stop();
  assert.deepEqual(h.removed, ["a1"]);
  assert.ok(h.timers.every((entry) => entry.cancelled));
  h.registry.upsert(agent("a2"));
  assert.deepEqual(h.registry.shown(), [], "nothing after stop");
});

// ---------------------------------------------- 0.18.3: only live agents, and few reads

test("which agents get a chip: not closed or archived ones, nor one without a workspace; only running ones are metered", () => {
  assert.deepEqual(chipAgentFrom({ id: "a", workspaceId: "w", provider: "claude", status: "running" }), { id: "a", workspaceId: "w", provider: "claude", active: true });
  assert.deepEqual(chipAgentFrom({ id: "a", workspaceId: "w", provider: "codex", status: "idle" }), { id: "a", workspaceId: "w", provider: "codex", active: false });
  assert.equal(chipAgentFrom({ id: "a", workspaceId: "w", provider: "claude", status: "closed" }), null);
  assert.equal(chipAgentFrom({ id: "a", workspaceId: "w", provider: "claude", status: "idle", archivedAt: "2026-10-04T00:00:00Z" }), null);
  assert.equal(chipAgentFrom({ id: "a", workspaceId: "", provider: "claude", status: "running" }), null);
  assert.equal(chipAgentFrom(undefined), null);
});

test("an idle agent's chip is labelled without its meter: one read per running agent, not per agent", async () => {
  const h = harness({ health: report(["ok"]) });
  h.registry.replaceAll([agent("run"), agent("idle-1", "claude", false), agent("idle-2", "codex", false)]);
  await h.settle();
  assert.deepEqual(h.registry.shown().sort(), ["idle-1", "idle-2", "run"]);
  assert.equal(h.meterCalls(), 1, "only the running agent");
  assert.deepEqual(h.faces.get("idle-1")!.at(-1), { label: "1 connector · healthy", icon: "Plug" });
});

test("a meter that fails (a workspace that's gone) isn't asked again for 10 minutes", async () => {
  const h = harness({ failMeter: true });
  h.registry.upsert(agent("a1"));
  await h.settle();
  assert.equal(h.meterCalls(), 1);
  await h.tick();
  await h.tick();
  assert.equal(h.meterCalls(), 1, "not every minute");
  h.advance(METER_RETRY_MS + 1);
  h.setFailMeter(false);
  await h.tick();
  assert.equal(h.meterCalls(), 2, "asked again after the wait");
});

test("an agent that closes loses its chip", async () => {
  const h = harness();
  h.registry.replaceAll([agent("a1"), agent("a2")]);
  await h.settle();
  h.registry.remove("a2");
  assert.deepEqual(h.registry.shown(), ["a1"]);
});
