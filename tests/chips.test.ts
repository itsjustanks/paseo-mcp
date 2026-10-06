/**
 * The Connectors composer chip. 0.18.1: on apps that take chips as buttons
 * (Paseo 0.8.0 stable and later) the registry adds a button and pushes its
 * label; on the 0.8.0-beta.1 shape the old component draws the face it is
 * given. 0.19.1: attention only. A chat gets a chip only while a connector it
 * loads is failing or needs sign-in; a calm chat has none; and the registry
 * makes one read a minute, whatever the number of agents.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { SignInNeed } from "../shared/attention";
import { chipAgentFrom, createChipRegistry, type AttentionState, type ChipAgent, type ChipDeps, type ChipFace } from "../shared/chips";
import type { McpHealthReport } from "../shared/contracts";
import { canObserveAgents, supportsButtonPills } from "../shared/host-features";

const HOME = "/home/demo";
const claudeScope = { level: "user", label: "Claude · demo (primary)", configPath: `${HOME}/.claude.json`, providerId: "claude" };
const codexScope = { level: "user", label: "Codex · demo (primary)", configPath: `${HOME}/.codex/config.toml`, providerId: "codex" };
const projectScope = { level: "project", label: "data-glue", configPath: `${HOME}/projects/data-glue/.mcp.json` };

type Entry = { name: string; status: string; scopes?: object[] };
const report = (entries: Entry[]): McpHealthReport =>
  ({ checkedAt: "2026-10-06T00:00:00.000Z", results: entries.map((entry) => ({ note: "", scopes: [claudeScope], ...entry })) }) as unknown as McpHealthReport;

function harness(options: { wanted?: boolean; health?: McpHealthReport | null; signIn?: SignInNeed[]; failHealth?: boolean } = {}) {
  const faces = new Map<string, ChipFace[]>();
  const removed: string[] = [];
  const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
  const published: AttentionState[] = [];
  let wanted = options.wanted ?? true;
  let health = options.health ?? null;
  let signIn = options.signIn ?? [];
  let failHealth = options.failHealth ?? false;
  let reads = 0;
  const deps: ChipDeps = {
    addChip(agent, face) {
      faces.set(agent.id, [face]);
      return { update: (next) => faces.get(agent.id)!.push(next), remove: () => removed.push(agent.id) };
    },
    readHealth: async () => {
      reads += 1;
      if (failHealth) throw new Error("host unreachable");
      return { wanted, report: health, signIn };
    },
    publish: (state) => published.push(state),
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
  };
  const registry = createChipRegistry(deps);
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const tick = async () => {
    const next = timers.filter((entry) => !entry.cancelled).pop();
    if (next) {
      next.cancelled = true;
      next.run();
    }
    await settle();
  };
  return {
    registry,
    faces,
    removed,
    timers,
    published,
    tick,
    settle,
    reads: () => reads,
    setWanted: (next: boolean) => (wanted = next),
    setHealth: (next: McpHealthReport | null) => (health = next),
    setSignIn: (next: SignInNeed[]) => (signIn = next),
    setFailHealth: (next: boolean) => (failHealth = next),
  };
}

const agent = (id: string, provider = "claude", cwd = `${HOME}/projects/other`): ChipAgent => ({ id, workspaceId: "ws-1", provider, cwd });
const last = (h: ReturnType<typeof harness>, id: string) => h.faces.get(id)?.at(-1);

test("feature checks: buttons from 0.8.0 stable (addHeaderButton); agent observations from 0.9 (observeEvents)", () => {
  assert.equal(supportsButtonPills({ addComposerPill() {}, addHeaderButton() {} }), true);
  assert.equal(supportsButtonPills({ addComposerPill() {} }), false, "the 0.8.0-beta.1 shape");
  assert.equal(supportsButtonPills(null), false);
  assert.equal(canObserveAgents({ observeEvents() {}, agents: {} }), true);
  assert.equal(canObserveAgents({ agents: {} }), false, "a 0.8 app: never send subscribe");
});

// ---------------------------------------------------------------- 0.19.1 states

test("a calm chat gets no chip: every connector answers and none needs sign-in", async () => {
  const h = harness({ health: report([{ name: "linear", status: "ok" }, { name: "notion", status: "unknown" }]) });
  h.registry.upsert(agent("a1"));
  await h.settle();
  assert.deepEqual(h.registry.shown(), []);
  assert.equal(h.faces.size, 0, "no chip was ever added");
  assert.equal(h.published.at(-1)!.host, null, "and no sidebar dot");
});

test("an OAuth connector's 401 alone is not a problem: no chip", async () => {
  const h = harness({ health: report([{ name: "jam", status: "auth-required" }]) });
  h.registry.upsert(agent("a1"));
  await h.settle();
  assert.deepEqual(h.registry.shown(), []);
});

test("one failing connector: '1 connector failing' with the warning icon", async () => {
  const h = harness({ health: report([{ name: "supabase", status: "down" }, { name: "linear", status: "ok" }]) });
  h.registry.upsert(agent("a1"));
  await h.settle();
  assert.deepEqual(last(h, "a1"), { label: "1 connector failing", icon: "TriangleAlert" });
  assert.equal(h.published.at(-1)!.host, "failing");
});

test("sign-in: '2 connectors need sign-in' with the key icon, only for the chat whose account needs it", async () => {
  const h = harness({ health: report([{ name: "linear", status: "ok" }]), signIn: [{ name: "jam", providerIds: ["claude"] }, { name: "posthog", providerIds: ["claude", "claude-work"] }] });
  h.registry.replaceAll([agent("claude-chat"), agent("codex-chat", "codex")]);
  await h.settle();
  assert.deepEqual(last(h, "claude-chat"), { label: "2 connectors need sign-in", icon: "KeyRound" });
  assert.deepEqual(h.registry.shown(), ["claude-chat"], "Codex's account needs nothing: no chip there");
  assert.equal(h.published.at(-1)!.host, "sign-in");
});

test("failing and sign-in together: both counted, failing first; a failing one isn't counted twice", async () => {
  const h = harness({ health: report([{ name: "supabase", status: "binary-missing" }]), signIn: [{ name: "jam", providerIds: ["claude"] }, { name: "supabase", providerIds: ["claude"] }] });
  h.registry.upsert(agent("a1"));
  await h.settle();
  assert.deepEqual(last(h, "a1"), { label: "1 connector failing, 1 needs sign-in", icon: "TriangleAlert" });
});

test("a failing connector belongs to the chats that load it: its provider's config, or the project the agent works in", async () => {
  const h = harness({
    health: report([
      { name: "codex-only", status: "down", scopes: [codexScope] },
      { name: "project-db", status: "warn", scopes: [projectScope] },
    ]),
  });
  h.registry.replaceAll([agent("claude-elsewhere"), agent("codex-elsewhere", "codex"), agent("claude-in-project", "claude", `${HOME}/projects/data-glue/src`)]);
  await h.settle();
  assert.deepEqual(h.registry.shown().sort(), ["claude-in-project", "codex-elsewhere"]);
  assert.deepEqual(last(h, "codex-elsewhere"), { label: "1 connector failing", icon: "TriangleAlert" });
  assert.deepEqual(last(h, "claude-in-project"), { label: "1 connector failing", icon: "TriangleAlert" });
  assert.equal(h.published.at(-1)!.host, "failing", "the dot shows for anything on this computer");
});

test("a report from an older host (no provider id on its scopes) counts every user-level config", async () => {
  const old = { level: "user", label: "Claude", configPath: `${HOME}/.claude.json` };
  const h = harness({ health: report([{ name: "a", status: "down", scopes: [old] }]) });
  h.registry.replaceAll([agent("c1"), agent("x1", "codex")]);
  await h.settle();
  assert.deepEqual(h.registry.shown().sort(), ["c1", "x1"]);
});

test("the chip goes away when the problem is fixed, and changes its words when the problem changes", async () => {
  const h = harness({ health: report([{ name: "a", status: "down" }, { name: "b", status: "down" }]) });
  h.registry.upsert(agent("a1"));
  await h.settle();
  assert.deepEqual(last(h, "a1"), { label: "2 connectors failing", icon: "TriangleAlert" });
  h.setHealth(report([{ name: "a", status: "down" }, { name: "b", status: "ok" }]));
  await h.tick();
  assert.deepEqual(last(h, "a1"), { label: "1 connector failing", icon: "TriangleAlert" });
  const updates = h.faces.get("a1")!.length;
  await h.tick();
  assert.equal(h.faces.get("a1")!.length, updates, "the same words are not pushed again");
  h.setHealth(report([{ name: "a", status: "ok" }, { name: "b", status: "ok" }]));
  await h.tick();
  assert.deepEqual(h.registry.shown(), []);
  assert.deepEqual(h.removed, ["a1"]);
  assert.equal(h.published.at(-1)!.host, null);
  assert.equal(h.published.at(-1)!.faces.size, 0);
});

test("nothing shows before the first read, and one read serves every agent (no tool, Paseo or meter reads)", async () => {
  const h = harness({ health: report([{ name: "a", status: "down" }]) });
  h.registry.replaceAll([agent("a1"), agent("a2"), agent("a3", "codex")]);
  assert.deepEqual(h.registry.shown(), [], "no chip until the host has answered");
  await h.settle();
  assert.equal(h.reads(), 1, "one read for three agents");
  h.registry.upsert(agent("a4"));
  await h.settle();
  assert.equal(h.reads(), 1, "a new agent is decided from the last read");
  assert.deepEqual(h.registry.shown().sort(), ["a1", "a2", "a4"]);
});

test("snapshots that arrive before the first answer share one read", async () => {
  const h = harness({ health: report([{ name: "a", status: "down" }]) });
  h.registry.replaceAll([agent("a1")]);
  h.registry.replaceAll([agent("a1"), agent("a2")]);
  h.registry.upsert(agent("a3"));
  await h.settle();
  assert.equal(h.reads(), 1);
  assert.deepEqual(h.registry.shown().sort(), ["a1", "a2", "a3"]);
});

test("the setting hides every chip and brings them back; an agent that goes away loses its chip", async () => {
  const h = harness({ health: report([{ name: "a", status: "down" }]) });
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
  const h = harness({ health: report([{ name: "a", status: "down" }]) });
  h.registry.replaceAll([agent("a1"), agent("a2")]);
  await h.settle();
  h.registry.replaceAll([agent("a2"), agent("a3")]);
  await h.settle();
  assert.deepEqual(h.registry.shown().sort(), ["a2", "a3"]);
  assert.ok(h.removed.includes("a1"));
  assert.deepEqual(last(h, "a3"), { label: "1 connector failing", icon: "TriangleAlert" });
});

test("a host that doesn't answer shows nothing new and reads less often (1, 2, 4 … 15 minutes)", async () => {
  const h = harness({ failHealth: true });
  h.registry.upsert(agent("a1"));
  await h.settle();
  assert.deepEqual(h.registry.shown(), [], "no verdict, no chip");
  const before = h.timers.at(-1)!.ms;
  await h.tick();
  const after = h.timers.at(-1)!.ms;
  assert.ok(after > before, `${after} > ${before}`);
  h.setFailHealth(false);
  await h.tick();
  assert.equal(h.timers.at(-1)!.ms, 60_000, "back to once a minute after an answer");
});

test("a failed read keeps the chips the last read decided", async () => {
  const h = harness({ health: report([{ name: "a", status: "down" }]) });
  h.registry.upsert(agent("a1"));
  await h.settle();
  h.setFailHealth(true);
  await h.tick();
  assert.deepEqual(h.registry.shown(), ["a1"]);
});

test("stop removes every chip and the timer", async () => {
  const h = harness({ health: report([{ name: "a", status: "down" }]) });
  h.registry.upsert(agent("a1"));
  await h.settle();
  h.registry.stop();
  assert.deepEqual(h.removed, ["a1"]);
  assert.ok(h.timers.every((entry) => entry.cancelled));
  h.registry.upsert(agent("a2"));
  assert.deepEqual(h.registry.shown(), [], "nothing after stop");
});

test("which agents can get a chip: not closed or archived ones, nor one without a workspace; the folder comes along", () => {
  assert.deepEqual(chipAgentFrom({ id: "a", workspaceId: "w", provider: "claude", status: "running", cwd: "/p" }), { id: "a", workspaceId: "w", provider: "claude", cwd: "/p" });
  assert.deepEqual(chipAgentFrom({ id: "a", workspaceId: "w", provider: "codex", status: "idle" }), { id: "a", workspaceId: "w", provider: "codex", cwd: "" });
  assert.equal(chipAgentFrom({ id: "a", workspaceId: "w", provider: "claude", status: "closed" }), null);
  assert.equal(chipAgentFrom({ id: "a", workspaceId: "w", provider: "claude", status: "idle", archivedAt: "2026-10-04T00:00:00Z" }), null);
  assert.equal(chipAgentFrom({ id: "a", workspaceId: "", provider: "claude", status: "running" }), null);
  assert.equal(chipAgentFrom(undefined), null);
});
