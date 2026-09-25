/**
 * Review fixes for 0.14.0 "turn off the unused ones", against the real host
 * modules with a fake daemon: the host decides on a fresh, complete read of the
 * whole chat; the panel is told when a read is incomplete or out of date; no
 * verdict without the server list; and the chip never probes anything.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-chat-host-"));
const project = join(home, "code", "demo");
mkdirSync(project, { recursive: true });
process.env.HOME = home;
process.env.PASEO_HOME = join(home, ".paseo");
process.env.PASEO_LISTEN = "127.0.0.1:9";
mkdirSync(process.env.PASEO_HOME, { recursive: true });
after(() => rmSync(home, { recursive: true, force: true }));

const claudeJson = join(home, ".claude.json");
const pristine = JSON.stringify({ oauthAccount: { emailAddress: "me@example.com" }, mcpServers: {}, projects: {} });
writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { "ikit.attio": { command: "node" }, linear: { command: "node" }, supabase: { command: "node" } } }));

const { handleMcpAgentChat, handleMcpTurnOffUnused, chatSettled, resetChat, TURN_OFF_CHANGED, TURN_OFF_TOO_LONG, TURN_OFF_UNREADABLE } = await import("../server/chat");
const { configureAddedProbe, addedProbesSettled } = await import("../server/agent-record");
const { configureLive } = await import("../server/paseo-live");
const { resetPaseoToolsCache } = await import("../server/paseo-tools");
const { CHAT_SCAN_LIMIT } = await import("../shared/chat");

const call = (name: string) => ({ item: { type: "tool_call", callId: name, name, status: "completed", error: null, detail: { type: "unknown", input: null, output: null } } });

function fakePaseo(options: { timeline: () => Array<{ item: unknown }>; failTimeline?: () => boolean; failWorkspaces?: () => boolean }) {
  let reads = 0;
  const paseo = {
    config: { get: async () => ({ config: { mcp: { injectIntoAgents: true }, providers: {} } }), patch: async (patch: unknown) => ({ config: patch }) },
    workspaces: {
      list: async () => {
        if (options.failWorkspaces?.()) throw new Error("daemon timeout");
        return { entries: [{ id: "ws", name: "demo", workspaceDirectory: project, projectRootPath: project }] };
      },
    },
    projects: { list: async () => ({ entries: [{ name: "demo", path: project }] }) },
    agents: {
      ref: (id: string) => ({
        id,
        lastUsage: null,
        refresh: async () => null,
        timeline: {
          append: async () => ({ seq: 1, epoch: "e" }),
          refetch: async (page: { direction: string; cursor?: { seq: number }; limit: number }) => {
            reads += 1;
            if (options.failTimeline?.()) throw new Error("timeline read failed");
            const all = options.timeline();
            const end = page.direction === "tail" ? all.length : page.cursor!.seq;
            const start = Math.max(0, end - page.limit);
            return { entries: all.slice(start, end), hasOlder: start > 0, startCursor: { epoch: "e", seq: start }, agent: null };
          },
        },
      }),
    },
  } as never;
  return { context: { paseo } as never, reads: () => reads };
}

const disabledHere = () => (JSON.parse(readFileSync(claudeJson, "utf8")).projects?.[project]?.disabledMcpjsonServers ?? []) as string[];
const chatInput = (agentId: string) => ({ workspaceId: "ws", providerId: "claude", agentId, chat: true });
const turnOffInput = (agentId: string, expected: string[]) => ({ workspaceId: "ws", providerId: "claude", agentId, expected });

beforeEach(() => {
  writeFileSync(claudeJson, pristine);
  rmSync(join(home, ".paseo", "agents"), { recursive: true, force: true });
  resetChat();
  resetPaseoToolsCache();
  configureAddedProbe(null);
  configureLive(null);
});

test("P1: a chat longer than the cap, with linear used only in the older part, switches nothing off", async () => {
  const timeline = [...Array.from({ length: 300 }, () => call("mcp__linear__list_issues")), ...Array.from({ length: CHAT_SCAN_LIMIT + 300 }, () => call("mcp__supabase__execute_sql"))];
  const fake = fakePaseo({ timeline: () => timeline });
  await handleMcpAgentChat(chatInput("p1"), fake.context);
  await chatSettled();
  const read = await handleMcpAgentChat(chatInput("p1"), fake.context);
  assert.equal(read.chat?.complete, false, "the panel is told the read stopped at the cap");
  assert.equal(read.chat?.truncated, true);
  // Even a client that sends the list it would have shown gets a refusal.
  const result = await handleMcpTurnOffUnused(turnOffInput("p1", ["ikit.attio", "linear"]), fake.context);
  assert.equal(result.ok, false);
  assert.equal(result.refused, "too-long");
  assert.equal(result.message, TURN_OFF_TOO_LONG);
  assert.deepEqual(result.done, []);
  assert.deepEqual(disabledHere(), [], "nothing switched off");
});

test("P2: a failed read after a good one is served as stale, and turning off switches nothing", async () => {
  let timeline = [call("mcp__supabase__execute_sql")];
  let fail = false;
  const fake = fakePaseo({ timeline: () => timeline, failTimeline: () => fail });
  await handleMcpAgentChat(chatInput("p2"), fake.context);
  await chatSettled();
  const good = await handleMcpAgentChat(chatInput("p2"), fake.context);
  assert.equal(good.stale, false);
  assert.equal(good.chat?.complete, true);
  timeline = [...timeline, call("mcp__linear__create_issue")];
  fail = true;
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try {
    await handleMcpAgentChat(chatInput("p2"), fake.context);
    await chatSettled();
    const served = await handleMcpAgentChat(chatInput("p2"), fake.context);
    assert.equal(served.stale, true, "the previous read is marked stale");
    assert.ok(served.failedAt && !Number.isNaN(Date.parse(served.failedAt)), "with when the read failed");
    assert.deepEqual(served.chat?.calls.map((entry) => entry.server), ["supabase"], "the old read, as before");
  } finally {
    Date.now = realNow;
  }
  const result = await handleMcpTurnOffUnused(turnOffInput("p2", ["ikit.attio", "linear"]), fake.context);
  assert.equal(result.refused, "unreadable");
  assert.equal(result.message, TURN_OFF_UNREADABLE);
  assert.deepEqual(disabledHere(), []);
});

test("a plan that changed between review and confirm is refused, with the new plan", async () => {
  let timeline = [call("mcp__supabase__execute_sql")];
  const fake = fakePaseo({ timeline: () => timeline });
  // Reviewed: ikit.attio and linear unused. Then the chat calls linear.
  timeline = [...timeline, call("mcp__linear__create_issue")];
  const result = await handleMcpTurnOffUnused(turnOffInput("changed", ["ikit.attio", "linear"]), fake.context);
  assert.equal(result.ok, false);
  assert.equal(result.refused, "changed");
  assert.equal(result.message, TURN_OFF_CHANGED);
  assert.deepEqual(result.plan?.off, ["ikit.attio"]);
  assert.deepEqual(disabledHere(), [], "not even the server both lists agree on");
});

test("a plan that still matches is carried out through the per-workspace switch, from a fresh read", async () => {
  const fake = fakePaseo({ timeline: () => [call("mcp__supabase__execute_sql"), call("mcp__ikit_attio__search_records")] });
  const before = fake.reads();
  const result = await handleMcpTurnOffUnused(turnOffInput("same", ["linear"]), fake.context);
  assert.ok(fake.reads() > before, "the timeline was read for this decision");
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.done, ["linear"]);
  assert.deepEqual(disabledHere(), ["linear"]);
});

test("P3: with the server list failed, the chat read fails too and no verdict is given", async () => {
  let first = true;
  const fake = fakePaseo({
    timeline: () => [call("mcp__ikit_attio__search_records"), call("mcp__supabase__execute_sql")],
    failWorkspaces: () => {
      const fail = first;
      first = false;
      return fail;
    },
  });
  await handleMcpAgentChat(chatInput("p3"), fake.context);
  await chatSettled();
  const read = await handleMcpAgentChat(chatInput("p3"), fake.context);
  assert.equal(read.chat, null, "no calls counted against an empty server list");
  assert.equal(read.stale, true);
  assert.ok(read.failedAt);
});

test("P5: twenty chips send no HTTP request, to added servers or to Paseo's own endpoint", async () => {
  const fetched: string[] = [];
  const counting = (async (url: string) => {
    fetched.push(String(url));
    return new Response("{}", { status: 500 });
  }) as never;
  configureAddedProbe({ fetch: counting });
  configureLive({ fetch: counting, env: { PASEO_LISTEN: "127.0.0.1:9" }, home: process.env.PASEO_HOME! });
  const dir = join(process.env.PASEO_HOME!, "agents", project.replace(/^\//, "").replace(/\//g, "-"));
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 20; i += 1) {
    writeFileSync(join(dir, `chip-${i}.json`), JSON.stringify({ id: `chip-${i}`, config: { mcpServers: { [`added${i}`]: { type: "http", url: `http://127.0.0.1:9/mcp${i}`, headers: { Authorization: "Bearer T" } } } } }));
  }
  const fake = fakePaseo({ timeline: () => [] });
  for (let i = 0; i < 20; i += 1) await handleMcpAgentChat({ workspaceId: "ws", providerId: "claude", agentId: `chip-${i}` }, fake.context);
  await chatSettled();
  await addedProbesSettled();
  const settled = await handleMcpAgentChat({ workspaceId: "ws", providerId: "claude", agentId: "chip-0" }, fake.context);
  assert.ok(settled.meter, "the meter still comes out, from cached counts");
  assert.deepEqual(fetched, [], `HTTP requests from the chip: ${fetched.join(", ")}`);
});
