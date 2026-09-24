/**
 * Review findings on the host side, against a sandbox HOME: capped reads from
 * the network and from files, and the team source that must not leak (its
 * parse errors, its address, its header value).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-catalog-sec-"));
mkdirSync(join(home, ".codex"), { recursive: true });
writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: {} }));
process.env.HOME = home;
process.env.PASEO_HOME = join(home, ".paseo");
delete process.env.AGENT_LINK_HOME;
delete process.env.AGENT_AUTH_HOME;

const catalog = await import("../server/catalog");
const { handleMcpCatalog, setCatalogFetch, catalogSettled, resetCatalogCaches } = catalog;
const context = { paseo: { config: { get: async () => ({ config: { providers: {} } }), patch: async () => ({}) }, projects: { list: async () => [] } } } as never;

const settingsDir = join(home, ".paseo", "plugin-settings", "paseo-mcp");
mkdirSync(settingsDir, { recursive: true });
const settingsFile = join(settingsDir, "catalog.json");
const setTeam = (values: Record<string, string>) => writeFileSync(settingsFile, JSON.stringify({ version: 1, values }));

async function readTeam(values: Record<string, string>) {
  resetCatalogCaches();
  setTeam(values);
  await handleMcpCatalog({ query: "" }, context);
  await catalogSettled();
  return handleMcpCatalog({ query: "" }, context);
}

// A local server that never stops answering, or declares a body it never sends.
const endless = http.createServer((req, res) => {
  if (req.url?.startsWith("/declared")) {
    res.writeHead(200, { "content-type": "application/json", "content-length": String(50 * 1024 * 1024) });
    res.write("[");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  const chunk = Buffer.alloc(128 * 1024, 0x20);
  const timer = setInterval(() => res.write(chunk), 5);
  res.on("close", () => clearInterval(timer));
});
await new Promise<void>((resolve) => endless.listen(0, "127.0.0.1", resolve));
const port = (endless.address() as { port: number }).port;

after(() => {
  setCatalogFetch(null);
  endless.closeAllConnections();
  endless.close();
  rmSync(home, { recursive: true, force: true });
});

// 6 --------------------------------------------------------------- unbounded reads

test("6: an endless answer is cut off at the cap, not read until the timeout", { timeout: 6000 }, async () => {
  setCatalogFetch((_url, init) => globalThis.fetch(`http://127.0.0.1:${port}/`, init));
  const began = Date.now();
  const team = await readTeam({ teamSource: "https://team.example.com/catalogue.json" });
  assert.match(team.team.note, /more than 1 MB/);
  // 0.13.0: the registry is a library, off by default.
  writeFileSync(settingsFile, JSON.stringify({ version: 2, values: { libraries: [{ id: "mcp-registry", name: "MCP Registry", source: "https://registry.modelcontextprotocol.io", format: "registry" }] } }));
  const registry = await handleMcpCatalog({ query: "endless" }, context);
  assert.equal(registry.registry.state, "searching");
  await catalogSettled();
  const answered = await handleMcpCatalog({ query: "endless" }, context);
  assert.match(answered.registry.note, /more than 8 MB/);
  assert.ok(Date.now() - began < 4000, `took ${Date.now() - began} ms`);
});

test("6: a declared length over the cap is refused unread", { timeout: 6000 }, async () => {
  setCatalogFetch((_url, init) => globalThis.fetch(`http://127.0.0.1:${port}/declared`, init));
  const began = Date.now();
  const team = await readTeam({ teamSource: "https://team.example.com/catalogue.json" });
  assert.match(team.team.note, /more than 1 MB/);
  assert.ok(Date.now() - began < 2000, `took ${Date.now() - began} ms`);
});

test("6: only a regular file under 1 MB is read (no directory, FIFO, /dev/zero)", { timeout: 6000 }, async () => {
  const dir = join(home, "a-directory");
  mkdirSync(dir);
  assert.match((await readTeam({ teamSource: dir })).team.note, /not a regular file/);
  const fifo = join(home, "a-fifo");
  execFileSync("mkfifo", [fifo]);
  assert.match((await readTeam({ teamSource: fifo })).team.note, /not a regular file/);
  assert.match((await readTeam({ teamSource: "/dev/zero" })).team.note, /not a regular file/);
  const big = join(home, "big.json");
  writeFileSync(big, `[${" ".repeat(1024 * 1024)}]`);
  assert.match((await readTeam({ teamSource: big })).team.note, /1 MB/);
  const good = join(home, "good.json");
  writeFileSync(good, "[]");
  assert.equal((await readTeam({ teamSource: good })).team.state, "ready");
});

// 7 ------------------------------------------------------------ team source leaks

test("7a: a file that is not JSON is reported by line, with none of its text, in the note and the log", async () => {
  const envFile = join(home, ".env");
  writeFileSync(envFile, "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz\n");
  const logged: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  try {
    const result = await readTeam({ teamSource: envFile });
    assert.equal(result.team.state, "error");
    assert.match(result.team.note, /not valid JSON \(line 1\)/);
    assert.ok(!/OPENAI|sk-proj/.test(result.team.note), result.team.note);
    assert.ok(logged.length > 0);
    assert.ok(!logged.some((line) => /OPENAI|sk-proj/.test(line)), logged.join("\n"));
  } finally {
    console.warn = warn;
  }
});

test("7b: the team address comes back without its query or user name", async () => {
  setCatalogFetch(async () => new Response("[]", { status: 200 }));
  const withToken = await readTeam({ teamSource: "https://team.example.com/catalogue.json?token=SECRET123&x=1#frag" });
  assert.equal(withToken.team.source, "https://team.example.com/catalogue.json?…");
  assert.ok(!JSON.stringify(withToken).includes("SECRET123"));
  const withUser = await readTeam({ teamSource: "https://someone:pw123@team.example.com/catalogue.json" });
  assert.ok(!/someone|pw123/.test(JSON.stringify(withUser)), withUser.team.source);
});

test("7c: the header value is write-only: moved out of settings, kept 0600, answered only as { set }", async () => {
  const seen: Array<string | null> = [];
  setCatalogFetch(async (url, init) => {
    if (url.startsWith("https://team.example.com/")) seen.push(new Headers(init?.headers).get("authorization"));
    return new Response("[]", { status: 200 });
  });
  const VALUE = "Bearer github_pat_fixture_0123456789";
  const result = await readTeam({ teamSource: "https://team.example.com/catalogue.json", teamHeaderName: "Authorization", teamHeaderValue: VALUE });
  assert.equal(result.team.state, "ready");
  assert.equal(seen.at(-1), VALUE, "the migrated value is still sent to the team address");
  assert.ok(!JSON.stringify(result).includes("github_pat"));

  // Cleared from the settings document, which keeps its version and other values.
  const document = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.equal(document.version, 1);
  assert.deepEqual(document.values, { teamSource: "https://team.example.com/catalogue.json", teamHeaderName: "Authorization" });
  // Kept in the plugin's own file, 0600.
  const store = join(settingsDir, "team-auth.json");
  assert.equal(statSync(store).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(store, "utf8")).keys.team.value, VALUE);
  // The settings schema no longer carries it, so Paseo never sends it to a client.
  const { catalogSettings } = await import("../shared/catalog");
  assert.ok(!("teamHeaderValue" in catalogSettings.schema.parse({ teamHeaderValue: "x" })));

  // The RPC answers { set } and nothing else.
  const rpc = catalog.handleMcpCatalogTeamAuth;
  assert.equal(typeof rpc, "function");
  assert.deepEqual(await rpc({ action: "status" }), { set: true, origin: "https://team.example.com" });
  assert.deepEqual(await rpc({ action: "set", value: "Bearer replaced_value" }), { set: true, origin: "https://team.example.com" });
  await handleMcpCatalog({ query: "" }, context);
  await catalogSettled();
  assert.equal(seen.at(-1), "Bearer replaced_value");
  await assert.rejects(rpc({ action: "set", value: "Bearer a\r\nX-Evil: 1" }), /one line/);
  assert.deepEqual(await rpc({ action: "clear" }), { set: false, origin: "" });
  assert.equal(existsSync(store), false);
  assert.deepEqual(await rpc({ action: "status" }), { set: false, origin: "" });
});

test("a team address with a key in its query string is refused; the key belongs in the write-only field", async () => {
  const { teamLocation } = await import("../server/catalog");
  for (const address of [
    "https://raw.example.com/team.json?token=abc123",
    "https://store.example.blob.core.windows.net/c/team.json?sv=2024&sig=abc",
    "https://fn.example.net/api/team?code=Zx9ab12",
    "https://bucket.s3.amazonaws.com/team.json?X-Amz-Signature=abc",
    "https://example.com/team.json?api_key=abc",
  ]) {
    const where = teamLocation(address);
    assert.equal(where.kind, "invalid", address);
    assert.match((where as { reason: string }).reason, /key field/, address);
  }
  assert.equal(teamLocation("https://gist.githubusercontent.com/me/abc/raw/team.json?raw=true").kind, "url", "a harmless query is fine");
  assert.equal(teamLocation("https://raw.example.com/team.json").kind, "url");
});
