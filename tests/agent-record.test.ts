import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, afterEach } from "node:test";
import { isSafeAgentId, recordServers, unexplainedServers } from "../shared/agent-record";
import { BUDGET_ATTENTION, costProfile, loadFor, withAdded, type ProfileScope, type WorkspaceProfile } from "../shared/budget";
import { ADDED_TOOLS_TTL_MS, addedProbesSettled, addedToolCount, agentProjectDir, configureAddedProbe, readAgentServers } from "../server/agent-record";
import { forgetAllFiles } from "../server/files";

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-agent-record-"));
after(() => rmSync(home, { recursive: true, force: true }));
afterEach(() => configureAddedProbe(null));

const AGENT = "504c9fa6-b3f0-44fe-b020-8b9d6b925b7c";

// ------------------------------------------------------------------ record

test("the daemon's project directory name for a cwd (agent-storage.js projectDirNameFromCwd)", () => {
  assert.equal(agentProjectDir("/Users/ankit/Development/Sandbox"), "Users-ankit-Development-Sandbox");
  assert.equal(agentProjectDir("/Users/ankit/Development/Sandbox/"), "Users-ankit-Development-Sandbox");
  assert.equal(agentProjectDir("/"), "root");
  assert.equal(agentProjectDir("C:\\Users\\me\\code"), "C-Users-me-code");
  assert.equal(agentProjectDir("\\\\server\\share\\repo"), "server-share-repo");
  // Two leading slashes: path.win32.parse reads a UNC-style root, exactly as the daemon does.
  assert.equal(agentProjectDir("//a//b"), "a-b");
});

test("agent ids that could leave the agents directory are refused", () => {
  assert.equal(isSafeAgentId(AGENT), true);
  for (const bad of ["", "../x", "a/b", "a.json", "..", "a\\b"]) assert.equal(isSafeAgentId(bad), false, bad);
});

test("the stored config's servers: internal Paseo server skipped, transports read, headers kept host-side", () => {
  const record = {
    id: AGENT,
    config: {
      mcpServers: {
        "shared-browser": { type: "stdio", command: "node", args: ["server.js"] },
        remote: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer secret", n: 1 } },
        events: { type: "sse", url: "https://sse.example.com/sse" },
        paseo: { type: "http", url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=x" },
        odd: { type: "carrier-pigeon" },
      },
    },
  };
  assert.deepEqual(recordServers(record, AGENT), [
    { name: "events", transport: "http", url: "https://sse.example.com/sse" },
    { name: "odd", transport: "unknown" },
    { name: "remote", transport: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer secret" } },
    { name: "shared-browser", transport: "stdio" },
  ]);
  assert.equal(recordServers(record, "someone-else"), null, "another agent's record is not this one's");
  assert.deepEqual(recordServers({ id: AGENT, config: null }, AGENT), [], "no config: started with none");
  assert.equal(recordServers("junk", AGENT), null);
});

test("only servers no editor config explains count as added", () => {
  const servers = [{ name: "tool", transport: "stdio" as const }, { name: "shared-browser", transport: "stdio" as const }];
  assert.deepEqual(unexplainedServers(servers, new Set(["tool"])).map((entry) => entry.name), ["shared-browser"]);
});

test("host: the record is read from $PASEO_HOME/agents/<project dir>/<id>.json; missing, broken or unsafe is null", () => {
  const worktree = "/work/trees/feature";
  const root = "/work/repo";
  forgetAllFiles();
  assert.equal(readAgentServers(AGENT, [worktree, root], home), null, "missing");
  const path = join(home, "agents", agentProjectDir(root), `${AGENT}.json`);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ id: AGENT, config: { mcpServers: { "shared-browser": { type: "stdio", command: "node" } } } }));
  assert.deepEqual(readAgentServers(AGENT, [worktree, root], home), [{ name: "shared-browser", transport: "stdio" }], "falls back to the project root");
  assert.equal(readAgentServers("../agents", [root], home), null, "unsafe id");
  writeFileSync(path, "{not json");
  forgetAllFiles();
  assert.equal(readAgentServers(AGENT, [root], home), null, "broken");
});

// ------------------------------------------------------------------ tool counts

function fakeServer(tools: number | "down" | 401) {
  let calls = 0;
  const fetch = async (_url: string, init: RequestInit) => {
    calls += 1;
    const body = JSON.parse(String(init.body)) as { id: number; method: string };
    if (tools === "down") throw new Error("fetch failed");
    if (tools === 401) return new Response("", { status: 401 });
    const result = body.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "x", version: "1" } }
      : { tools: Array.from({ length: tools }, (_, index) => ({ name: `t${index}`, inputSchema: { type: "object" } })) };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls: () => calls };
}

const HTTP = { name: "remote", transport: "http" as const, url: "https://mcp.example.com/mcp" };

test("stdio servers run on demand and are never asked", () => {
  assert.deepEqual(addedToolCount({ name: "shared-browser", transport: "stdio" }), { note: "runs on demand" });
});

test("an HTTP server's count comes from the tools probe, in the background, then from memory", async () => {
  const server = fakeServer(7);
  configureAddedProbe({ fetch: server.fetch });
  assert.deepEqual(addedToolCount(HTTP), { note: "tools not counted yet" }, "the read never waits");
  await addedProbesSettled();
  assert.deepEqual(addedToolCount(HTTP), { tools: 7, note: "7 tools" });
  const asked = server.calls();
  for (let round = 0; round < 5; round += 1) addedToolCount(HTTP);
  await addedProbesSettled();
  assert.equal(server.calls(), asked, "not asked again within ten minutes");
});

test("a failed ask keeps the last good count and is not retried in a loop; sign-in is named", async () => {
  const good = fakeServer(3);
  configureAddedProbe({ fetch: good.fetch });
  addedToolCount(HTTP);
  await addedProbesSettled();
  const down = fakeServer("down");
  configureAddedProbe({ fetch: down.fetch });
  addedToolCount(HTTP);
  await addedProbesSettled();
  assert.match(addedToolCount(HTTP).note, /^tools not listed/);
  const asked = down.calls();
  addedToolCount(HTTP);
  await addedProbesSettled();
  assert.equal(down.calls(), asked, "the failure is remembered");

  const auth = fakeServer(401);
  configureAddedProbe({ fetch: auth.fetch });
  addedToolCount(HTTP);
  await addedProbesSettled();
  assert.deepEqual(addedToolCount(HTTP), { note: "needs a sign-in before it lists its tools" });
});

test("a good count survives a later failure after the ten minutes", async () => {
  let mode: "up" | "down" = "up";
  const up = fakeServer(4);
  const down = fakeServer("down");
  configureAddedProbe({ fetch: (url, init) => (mode === "up" ? up.fetch(url, init) : down.fetch(url, init)) });
  addedToolCount(HTTP);
  await addedProbesSettled();
  mode = "down";
  addedToolCount(HTTP, Date.now() + ADDED_TOOLS_TTL_MS);
  await addedProbesSettled();
  assert.deepEqual(addedToolCount(HTTP), { tools: 4, note: "4 tools" });
});

// ------------------------------------------------------------------ budget

const scope = (count: number): ProfileScope => ({
  id: "/c.json", label: "Claude", provider: "claude", providerId: "claude", configPath: "/c.json",
  servers: Array.from({ length: count }, (_, index) => ({ name: `s${index}`, transport: "http" as const })), local: [],
});
const profileOf = (s: ProfileScope): WorkspaceProfile => ({ project: [], projectConfigPath: "", scopes: [s] });

test("the agent's budget counts servers other plugins added", () => {
  const s = scope(BUDGET_ATTENTION - 1);
  const base = costProfile(loadFor(profileOf(s), s, null));
  assert.equal(base.tier, "ok");
  assert.equal("added" in base, false, "no added servers: the profile is unchanged");
  const load = withAdded(loadFor(profileOf(s), s, null), [{ name: "shared-browser", transport: "stdio" }, { name: "remote", transport: "http", tools: 12 }, { name: "s0", transport: "http" }]);
  const cost = costProfile(load);
  assert.equal(cost.added, 2, "a name the editor config already loads is not counted twice");
  assert.equal(cost.total, BUDGET_ATTENTION + 1);
  assert.equal(cost.tier, "attention");
  assert.equal(cost.tools, (BUDGET_ATTENTION - 1) * 5 + 5 + 12, "a probed count where there is one, five otherwise");
  assert.equal(cost.stdio, 1);
  assert.equal(cost.http, BUDGET_ATTENTION);
});
