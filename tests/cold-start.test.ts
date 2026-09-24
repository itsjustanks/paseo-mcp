/**
 * 0.11.3: the first panel read after the plugin starts never waits on a probe,
 * and the last verdicts and tool lists survive a restart without storing
 * anything secret. Runs the real handlers against a sandbox HOME and a local
 * MCP server that takes 1.5 s to answer.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, mock } from "node:test";

const SLOW_MS = 1500;
const TOKEN = "qs-secret-token-0123456789";
const HEADER_SECRET = "hdr-secret-value-9876543210";

const standIn = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    let id: unknown;
    let method = "";
    try {
      ({ id, method = "" } = JSON.parse(body) as { id?: unknown; method?: string });
    } catch {
      // not JSON-RPC
    }
    const result =
      method === "tools/list"
        ? { tools: [{ name: "search", description: "Search", inputSchema: { type: "object", properties: { q: {} } } }] }
        : { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stand-in", version: "1.0.0" } };
    setTimeout(() => {
      if (id === undefined) return void response.writeHead(202).end();
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    }, SLOW_MS);
  });
});
await new Promise<void>((done) => standIn.listen(0, "127.0.0.1", done));
const port = (standIn.address() as { port: number }).port;

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-cold-"));
const project = join(home, "code", "demo");
mkdirSync(project, { recursive: true });
const url = `http://127.0.0.1:${port}/mcp?token=${TOKEN}`;
writeFileSync(
  join(home, ".claude.json"),
  JSON.stringify({
    mcpServers: {
      remote: { type: "http", url, headers: { Authorization: `Bearer ${HEADER_SECRET}` } },
      local: { type: "stdio", command: "node", args: [] },
    },
    projects: {},
  }),
);
process.env.HOME = home;
process.env.PASEO_HOME = join(home, ".paseo");
process.env.SHELL = "/bin/sh";

const { handleMcpHealth, handleMcpHealthCached, healthSettled, resetHealthCache } = await import("../server/health");
const { handleMcpToolsCached, resetToolsCache, toolsSettled } = await import("../server/tools");
const { definitionKey, parseReports, reportCachePath, resetReportCache, restoredTools, serializeReports, RESTORED_REASON } = await import(
  "../server/report-cache"
);
const { markClientSeen, resetPresence } = await import("../server/presence");

const paseo = {
  config: { get: async () => ({ config: { providers: {} } }) },
  workspaces: { list: async () => ({ entries: [] }) },
  projects: { list: async () => ({ entries: [{ name: "demo", path: project }] }) },
} as never;
const context = { paseo } as never;
const settled = () => Promise.all([healthSettled(), toolsSettled()]);

/** A plugin restart: every in-memory cache gone, the file left where it is. */
function restart(): void {
  resetHealthCache();
  resetToolsCache();
  resetReportCache();
}

after(() => {
  standIn.close();
  rmSync(home, { recursive: true, force: true });
});

test("a fresh host answers the first panel read at once and says it is checking", async () => {
  resetPresence();
  const began = Date.now();
  const [health, tools] = await Promise.all([handleMcpHealthCached({}, context), handleMcpToolsCached({}, context)]);
  const ms = Date.now() - began;
  assert.ok(ms < SLOW_MS, `the read took ${ms} ms; it must not wait on the ${SLOW_MS} ms server`);
  assert.equal(health.report, null);
  assert.equal(health.checking, true);
  assert.equal(tools.report, null);
  assert.equal(tools.checking, true);

  await settled();
  const [again, toolsAgain] = await Promise.all([handleMcpHealthCached({}, context), handleMcpToolsCached({}, context)]);
  assert.equal(again.checking, false, "a current verdict starts nothing more");
  assert.deepEqual(again.report?.results.map((entry) => `${entry.name}:${entry.status}`), ["local:ok", "remote:ok"]);
  assert.equal(again.report?.stale, undefined);
  assert.equal(toolsAgain.report?.servers.find((entry) => entry.name === "remote")?.tools.length, 1);
  assert.equal(existsSync(reportCachePath()), false, "nothing is written while no app is connected");
});

test("a completed pass is saved, and nothing secret reaches the file", async () => {
  markClientSeen();
  await handleMcpHealth({}, context);
  await handleMcpToolsCached({}, context);
  await settled();
  const path = reportCachePath();
  assert.equal(path, join(home, ".paseo", "plugin-data", "paseo-mcp", "cache.json"));
  const text = readFileSync(path, "utf8");
  for (const secret of [TOKEN, HEADER_SECRET, `127.0.0.1:${port}`]) assert.ok(!text.includes(secret), `the file carries ${secret}`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const saved = parseReports(text);
  assert.ok(saved?.health && saved.tools);
  assert.equal(saved.health.keys.get("remote"), definitionKey({ url, headers: { Authorization: `Bearer ${HEADER_SECRET}` } }));
});

test("after a restart the first read answers with the saved report, as of its time, and refreshes it", async () => {
  restart();
  const began = Date.now();
  const [health, tools] = await Promise.all([handleMcpHealthCached({}, context), handleMcpToolsCached({}, context)]);
  assert.ok(Date.now() - began < SLOW_MS);
  assert.equal(health.report?.stale?.reason, RESTORED_REASON);
  assert.equal(health.checking, true, "the saved verdict is checked again at once");
  assert.deepEqual(health.report?.results.map((entry) => entry.name), ["local", "remote"]);
  const remote = tools.report?.servers.find((entry) => entry.name === "remote");
  assert.equal(remote?.tools.length, 1, "the saved list counts until the server answers again");
  assert.equal(remote?.stale?.restored, true);
  assert.equal(tools.checking, true);

  await settled();
  const [fresh, freshTools] = await Promise.all([handleMcpHealthCached({}, context), handleMcpToolsCached({}, context)]);
  assert.equal(fresh.report?.stale, undefined, "this run's verdict replaces the saved one");
  assert.equal(fresh.checking, false);
  assert.equal(freshTools.report?.stale, undefined);
  assert.equal(freshTools.report?.servers.find((entry) => entry.name === "remote")?.stale, undefined);
});

test("back from a pause, the read answers with the last verdict and refreshes it in the background", async () => {
  const before = (await handleMcpHealthCached({}, context)).report?.checkedAt;
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 11 * 60_000 });
  try {
    const began = Date.now();
    const read = await handleMcpHealthCached({}, context);
    assert.ok(Date.now() - began < SLOW_MS);
    assert.equal(read.report?.checkedAt, before, "the last verdict, not a wait");
    assert.equal(read.checking, true);
  } finally {
    mock.timers.reset();
  }
  await settled();
});

test("a corrupt or old-version file is ignored", async () => {
  const path = reportCachePath();
  for (const text of ["{not json", JSON.stringify({ version: 99, savedAt: "", health: null, tools: null }), JSON.stringify({ version: 1, savedAt: "x", health: { results: "no" }, tools: null })]) {
    writeFileSync(path, text);
    restart();
    resetPresence();
    const read = await handleMcpHealthCached({}, context);
    assert.equal(read.report, null, `loaded ${text.slice(0, 30)}`);
    assert.equal(read.checking, true);
    await settled();
  }
});

test("definition keys change with the URL or headers and hide both", () => {
  const base = definitionKey({ url, headers: { A: "1", B: "2" } });
  assert.equal(base, definitionKey({ url, headers: { B: "2", A: "1" } }), "header order does not matter");
  assert.notEqual(base, definitionKey({ url, headers: { A: "1", B: "3" } }));
  assert.notEqual(base, definitionKey({ url: `${url}&x=1`, headers: { A: "1", B: "2" } }));
  assert.notEqual(definitionKey({ command: "node" }), definitionKey({ command: "npx" }));
  assert.match(base, /^[0-9a-f]{32}$/);
  assert.equal(definitionKey(null), "");
});

test("saved lists round-trip with their keys, and restored lists are marked", () => {
  const report = {
    checkedAt: "2026-09-24T02:00:00.000Z",
    servers: [
      { name: "a", transport: "http" as const, kind: "listed" as const, note: "1 tools", tools: [], serverInfo: null, protocolVersion: "" },
      { name: "b", transport: "stdio" as const, kind: "stdio" as const, note: "runs on demand", tools: [], serverInfo: null, protocolVersion: "" },
    ],
  };
  const keys = new Map([["a", "k1"], ["b", "k2"]]);
  const parsed = parseReports(serializeReports({ health: null, tools: { report, keys } }));
  assert.deepEqual(parsed?.tools?.report, report);
  assert.deepEqual([...(parsed?.tools?.keys ?? [])], [["a", "k1"], ["b", "k2"]]);
  const shown = restoredTools(report);
  assert.deepEqual(shown.servers[0]?.stale, { reason: RESTORED_REASON, asOf: report.checkedAt, restored: true });
  assert.equal(shown.servers[1]?.stale, undefined, "only real lists are marked");
  assert.equal(shown.stale?.asOf, report.checkedAt);
});
