import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { PASEO_TOOLS_AS_OF, PASEO_TOOL_CATALOG, catalogueDriftLine, guessGroup, isBrowserTool, liveCatalog, toolListOrigin } from "../shared/paseo-tools";
import { forgetAllFiles } from "../server/files";
import { LIVE_TTL_MS, configureLive, liveEndpoint, liveSnapshot, refreshLive } from "../server/paseo-live";
import { handleMcpPaseoTools, handleMcpSetPaseoTools, resetPaseoToolsCache } from "../server/paseo-tools";
import { findServerVersion, setRunningPaseoVersion } from "../server/paseo-version";

// ------------------------------------------------------------------ version drift

test("the version drift line shows only for a catalogue that differs from the host", () => {
  assert.equal(catalogueDriftLine({ asOf: "0.9.1" }), "", "host version unknown: say nothing");
  assert.equal(catalogueDriftLine({ asOf: "0.9.1", hostVersion: "0.9.1" }), "");
  assert.equal(
    catalogueDriftLine({ asOf: "0.9.1", hostVersion: "0.10.2", source: "catalogue" }),
    "This list is from Paseo 0.9.1; this host runs 0.10.2, so new tools may be missing and removed ones may still show.",
  );
  assert.equal(catalogueDriftLine({ asOf: "0.9.1", hostVersion: "0.10.2", source: "live" }), "", "a live list cannot drift");
  assert.equal(toolListOrigin({ asOf: "0.9.1", source: "live" }), "Tool list live from this host.");
  assert.equal(toolListOrigin({ asOf: "0.9.1" }), "Tool list as of Paseo 0.9.1.");
});

test("the running server version is found by walking up from the plugin process path", () => {
  const files: Record<string, unknown> = {
    "/app/node_modules/@getpaseo/server/package.json": { name: "@getpaseo/server", version: "0.9.1" },
    "/app/package.json": { name: "paseo-desktop", version: "9.9.9" },
  };
  const read = (path: string) => files[path] ?? null;
  assert.equal(findServerVersion("/app/node_modules/@getpaseo/server/dist/server/server/plugins/plugin-process.js", read), "0.9.1");
  assert.equal(findServerVersion("/elsewhere/bin/node-script.js", read), null, "no server package above: unknown");
  assert.equal(findServerVersion("/app/index.js", read), null, "another package.json is not the server's");
});

// ------------------------------------------------------------------ endpoint

test("live endpoint: a password, from env or config.json, means the catalogue; never a token", () => {
  assert.equal(liveEndpoint({ PASEO_PASSWORD: "hunter2" }, {}).url, null);
  assert.match(liveEndpoint({}, { daemon: { auth: { password: "$argon2id$..." } } }).reason, /password/);
  assert.equal(liveEndpoint({ PASEO_PASSWORD: "   " }, {}).url, "http://127.0.0.1:6767/mcp/agents", "a blank env password is none");
});

test("live endpoint: listen from PASEO_LISTEN, then daemon.listen, then PORT, the daemon's own order", () => {
  assert.equal(liveEndpoint({}, {}).url, "http://127.0.0.1:6767/mcp/agents");
  assert.equal(liveEndpoint({ PORT: "7000" }, {}).url, "http://127.0.0.1:7000/mcp/agents");
  assert.equal(liveEndpoint({}, { daemon: { listen: "0.0.0.0:6800" } }).url, "http://127.0.0.1:6800/mcp/agents", "a wildcard is asked on loopback");
  assert.equal(liveEndpoint({ PASEO_LISTEN: "[::]:6801" }, { daemon: { listen: "0.0.0.0:6800" } }).url, "http://[::1]:6801/mcp/agents");
  assert.equal(liveEndpoint({ PASEO_LISTEN: "6802" }, {}).url, "http://127.0.0.1:6802/mcp/agents");
  assert.equal(liveEndpoint({ PASEO_LISTEN: "/run/paseo.sock" }, {}).url, null);
  assert.equal(liveEndpoint({ PASEO_LISTEN: "unix:///run/paseo.sock" }, {}).url, null);
  assert.equal(liveEndpoint({ PASEO_LISTEN: "nope" }, {}).url, null);
});

test("live endpoint: the address in paseo.pid, the one the daemon bound, wins; without one the old order stands", () => {
  const lock = { pid: 71662, startedAt: "2026-09-23T04:52:06.685Z", hostname: "h", uid: 501, listen: "127.0.0.1:6900", heartbeat: true };
  assert.equal(liveEndpoint({ PASEO_LISTEN: "127.0.0.1:6767" }, { daemon: { listen: "0.0.0.0:6800" } }, lock).url, "http://127.0.0.1:6900/mcp/agents");
  assert.equal(liveEndpoint({}, {}, { ...lock, listen: "[::]:6901" }).url, "http://[::1]:6901/mcp/agents");
  assert.equal(liveEndpoint({}, {}, { ...lock, listen: "/home/u/.paseo/paseo.sock" }).url, null, "a bound socket");
  assert.equal(liveEndpoint({ PASEO_LISTEN: "127.0.0.1:6767" }, {}, { ...lock, listen: null }).url, "http://127.0.0.1:6767/mcp/agents", "no worker running: fall back");
  for (const garbage of [null, "junk", [], { listen: 42 }]) assert.equal(liveEndpoint({ PORT: "7000" }, {}, garbage).url, "http://127.0.0.1:7000/mcp/agents");
  assert.equal(liveEndpoint({ PASEO_PASSWORD: "x" }, {}, lock).url, null, "a password still means no ask");
});

// ------------------------------------------------------------------ live catalogue

test("a live list keeps catalogue text for known names, adds new ones, keeps browser tools when the daemon lists none", () => {
  const core = PASEO_TOOL_CATALOG.filter((entry) => !isBrowserTool(entry.name));
  const live = [
    ...core.filter((entry) => entry.name !== "kill_agent").map((entry) => ({ name: entry.name, title: "Long daemon title", description: "Long daemon text" })),
    { name: "pause_heartbeat", title: "Pause heartbeat", description: "Pause one." },
    { name: "speak", title: "Speak", description: "Voice only." },
  ];
  const list = liveCatalog(live);
  const names = list.map((entry) => entry.name);
  assert.ok(!names.includes("kill_agent"), "a removed tool is gone");
  assert.ok(!names.includes("speak"));
  assert.equal(list.find((entry) => entry.name === "pause_heartbeat")?.group, "schedules");
  assert.equal(list.find((entry) => entry.name === "list_agents")?.title, "List agents", "catalogue text for a known name");
  assert.equal(list.filter((entry) => isBrowserTool(entry.name)).length, 22, "browser off on the daemon: the catalogue's browser group stays");
  const withBrowser = liveCatalog([{ name: "list_agents" }, { name: "browser_click" }]);
  assert.deepEqual(withBrowser.map((entry) => entry.name), ["list_agents", "browser_click"]);
  assert.equal(guessGroup("create_terminal_pool"), "terminals");
  assert.equal(guessGroup("do_thing"), "agents");
});

// ------------------------------------------------------------------ fetch + fallback

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-live-"));
after(() => {
  rmSync(home, { recursive: true, force: true });
  configureLive({ fetch: async () => { throw new Error("no network in tests"); } });
  setRunningPaseoVersion(undefined);
});

type Call = { url: string; body: { method: string }; headers: Record<string, string> };

function fakeDaemon(tools: Array<{ name: string; title?: string; description?: string }> | "down" | 401) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string };
    calls.push({ url, body, headers: init.headers as Record<string, string> });
    if (tools === "down") throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED" } });
    if (tools === 401) return new Response("", { status: 401 });
    const result = body.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "agent-mcp", version: "2.0.0" } }
      : { tools };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

const paseo = (config: Record<string, unknown> = { mcp: { injectIntoAgents: true } }) =>
  ({ config: { get: async () => ({ requestId: "r", config }), patch: async () => ({ requestId: "r", config }) } }) as never;

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  resetPaseoToolsCache();
  forgetAllFiles();
});

test("no password and an answer: the live list is used and labelled live, no Authorization header sent", async () => {
  const daemon = fakeDaemon([{ name: "list_agents" }, { name: "create_agent" }, { name: "brand_new_tool", title: "Brand new", description: "New in a later Paseo." }]);
  configureLive({ fetch: daemon.fetch, env: { PASEO_LISTEN: "127.0.0.1:6767" }, home });
  setRunningPaseoVersion("0.10.0");
  const state = await handleMcpPaseoTools({ refresh: true }, { paseo: paseo() });
  assert.equal(state.source, "live");
  assert.equal(state.hostVersion, "0.10.0");
  assert.equal(catalogueDriftLine(state), "", "live: no drift line even though versions differ");
  assert.ok(state.tools.some((entry) => entry.name === "brand_new_tool"));
  assert.ok(!state.tools.some((entry) => entry.name === "kill_agent"));
  assert.equal(daemon.calls[0]!.url, "http://127.0.0.1:6767/mcp/agents");
  assert.ok(daemon.calls.every((call) => !Object.keys(call.headers).some((key) => key.toLowerCase() === "authorization")));
  // A live-only name can be switched; a typo still cannot.
  const typo = await handleMcpSetPaseoTools({ providers: [{ id: "claude", tools: { brand_new_tol: false } }] }, { paseo: paseo() });
  assert.match(typo.message, /^Not a Paseo tool on this host: brand_new_tol/);
});

test("a password: nothing is fetched, the catalogue stands and the drift line shows", async () => {
  const daemon = fakeDaemon([{ name: "list_agents" }]);
  configureLive({ fetch: daemon.fetch, env: { PASEO_PASSWORD: "secret" }, home });
  setRunningPaseoVersion("0.10.0");
  const state = await handleMcpPaseoTools({ refresh: true }, { paseo: paseo() });
  assert.equal(daemon.calls.length, 0, "never a guessed token, never a request");
  assert.equal(state.source, "catalogue");
  assert.equal(state.tools.length, PASEO_TOOL_CATALOG.length);
  assert.match(state.liveNote ?? "", /password/);
  assert.equal(catalogueDriftLine(state), `This list is from Paseo ${PASEO_TOOLS_AS_OF}; this host runs 0.10.0, so new tools may be missing and removed ones may still show.`);
});

test("a password in $PASEO_HOME/config.json is honoured the same way", async () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ daemon: { auth: { password: "hash" } } }));
  const daemon = fakeDaemon([{ name: "list_agents" }]);
  configureLive({ fetch: daemon.fetch, env: {}, home });
  const state = await handleMcpPaseoTools({ refresh: true }, { paseo: paseo() });
  assert.equal(daemon.calls.length, 0);
  assert.equal(state.source, "catalogue");
  rmSync(join(home, "config.json"));
});

test("a daemon that is down or wants a token: the catalogue, one ask, no retry loop", async () => {
  for (const answer of ["down", 401] as const) {
    const daemon = fakeDaemon(answer);
    configureLive({ fetch: daemon.fetch, env: {}, home });
    const first = await handleMcpPaseoTools({}, { paseo: paseo() });
    assert.equal(first.source, "catalogue", "the first read never waits on the ask");
    await settle();
    const asked = daemon.calls.length;
    assert.ok(asked >= 1 && asked <= 2, "one initialize, at most");
    for (let i = 0; i < 5; i += 1) await handleMcpPaseoTools({}, { paseo: paseo() });
    await settle();
    assert.equal(daemon.calls.length, asked, `no second ask within ${LIVE_TTL_MS / 60_000} minutes`);
    assert.equal((await handleMcpPaseoTools({}, { paseo: paseo() })).source, "catalogue");
    assert.match(liveSnapshot().note, answer === 401 ? /asked for a token/ : /did not list its tools/);
  }
});

test("a good live list is kept when a later ask fails, with the reason noted", async () => {
  let up = true;
  const good = fakeDaemon([{ name: "list_agents" }]);
  const down = fakeDaemon("down");
  configureLive({ fetch: (url, init) => (up ? good.fetch(url, init) : down.fetch(url, init)), env: {}, home });
  await refreshLive(true, true);
  const first = liveSnapshot();
  assert.equal(first.tools?.length, 1);
  up = false;
  await refreshLive(true, true);
  assert.equal(liveSnapshot().tools?.length, 1, "the earlier list stays");
  assert.equal(liveSnapshot().checkedAt, first.checkedAt, "dated to when it was read");
  assert.match(liveSnapshot().note, /did not list its tools/);
  assert.equal((await handleMcpPaseoTools({}, { paseo: paseo() })).source, "live");
});

test("the MCP server off: nothing is asked", async () => {
  const daemon = fakeDaemon([{ name: "list_agents" }]);
  configureLive({ fetch: daemon.fetch, env: {}, home });
  const state = await handleMcpPaseoTools({ refresh: true }, { paseo: paseo({ mcp: { enabled: false } }) });
  assert.equal(daemon.calls.length, 0);
  assert.equal(state.source, "catalogue");
});

test("the ask goes to the address in $PASEO_HOME/paseo.pid; missing or garbage falls back", async () => {
  const pid = join(home, "paseo.pid");
  const cases: Array<[string | null, string]> = [
    [JSON.stringify({ pid: 1, startedAt: "t", hostname: "h", uid: 501, listen: "127.0.0.1:6950" }), "http://127.0.0.1:6950/mcp/agents"],
    [null, "http://127.0.0.1:6767/mcp/agents"],
    ["\u0000garbage{", "http://127.0.0.1:6767/mcp/agents"],
  ];
  for (const [content, url] of cases) {
    forgetAllFiles();
    if (content === null) rmSync(pid, { force: true });
    else writeFileSync(pid, content);
    const daemon = fakeDaemon([{ name: "list_agents" }]);
    configureLive({ fetch: daemon.fetch, env: { PASEO_LISTEN: "127.0.0.1:6767" }, home });
    await refreshLive(true, true);
    assert.equal(daemon.calls[0]?.url, url, content ?? "missing");
  }
  rmSync(pid, { force: true });
});

test("concurrent refreshes share one ask", async () => {
  const daemon = fakeDaemon([{ name: "list_agents" }]);
  configureLive({ fetch: daemon.fetch, env: {}, home });
  await Promise.all([refreshLive(true, true), refreshLive(true, true), refreshLive(true)]);
  assert.equal(daemon.calls.length, 2, "initialize and tools/list, once");
});
