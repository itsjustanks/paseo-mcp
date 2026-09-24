/**
 * Round 3 of the 0.12.0 review, host side, against a sandbox HOME: the team
 * key is bound to the site it was set for, and a project plan says when a
 * variable it asks for is already set on this host.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-catalog-r3-"));
const project = join(home, "code", "demo");
mkdirSync(project, { recursive: true });
mkdirSync(join(home, ".codex"), { recursive: true });
writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: {} }));
process.env.HOME = home;
process.env.PASEO_HOME = join(home, ".paseo");
delete process.env.AGENT_LINK_HOME;
delete process.env.AGENT_AUTH_HOME;

const catalog = await import("../server/catalog");
const { handleMcpCatalog, handleMcpCatalogPlan, handleMcpCatalogTeamAuth, setCatalogFetch, catalogSettled, resetCatalogCaches } = catalog;
const context = { paseo: { config: { get: async () => ({ config: { providers: {} } }), patch: async () => ({}) }, projects: { list: async () => [{ name: "demo", path: project }] } } } as never;

const settingsDir = join(home, ".paseo", "plugin-settings", "paseo-mcp");
mkdirSync(settingsDir, { recursive: true });
const settingsFile = join(settingsDir, "catalog.json");
const store = join(settingsDir, "team-auth.json");
const setTeam = (values: Record<string, string>) => writeFileSync(settingsFile, JSON.stringify({ version: 1, values }));

const sent: Array<{ url: string; authorization: string | null }> = [];
setCatalogFetch(async (url, init) => {
  sent.push({ url, authorization: new Headers(init?.headers).get("authorization") });
  return new Response("[]", { status: 200 });
});

async function read() {
  await handleMcpCatalog({ query: "" }, context);
  await catalogSettled();
  return handleMcpCatalog({ query: "" }, context);
}

after(() => {
  setCatalogFetch(null);
  delete process.env.MCP_HEROUI_PRO_HEROUI_PERSONAL_TOKEN;
  rmSync(home, { recursive: true, force: true });
});

const KEY = "Bearer ghp_" + "REALTEAMTOKEN0123456789abcdef";

test("5: the team key goes only to the site it was set for; a moved address clears it and says so", async () => {
  resetCatalogCaches();
  sent.length = 0;
  setTeam({ teamSource: "https://raw.githubusercontent.com/acme/private/main/catalog.json", teamHeaderName: "Authorization" });
  await handleMcpCatalogTeamAuth({ action: "set", value: KEY });
  await read();
  assert.equal(sent.at(-1)?.authorization, KEY, "sent to the site it was set for");

  // Any client that can edit the settings points the address at its own site.
  setTeam({ teamSource: "https://attacker.example/c.json", teamHeaderName: "Authorization" });
  const moved = await read();
  const attacker = sent.filter((request) => request.url.startsWith("https://attacker.example/"));
  assert.ok(attacker.length > 0, "the new address is still read");
  assert.ok(attacker.every((request) => request.authorization === null), JSON.stringify(attacker));
  assert.match(moved.team.note, /The key was cleared because the team address moved to another site; set it again/);
  assert.ok(!JSON.stringify(moved).includes("REALTEAMTOKEN"));
  assert.deepEqual(await handleMcpCatalogTeamAuth({ action: "status" }), { set: false, origin: "" });

  // Moving back does not bring it back: whoever moved it may not be whoever set it.
  setTeam({ teamSource: "https://raw.githubusercontent.com/acme/private/main/catalog.json", teamHeaderName: "Authorization" });
  await read();
  assert.equal(sent.at(-1)?.authorization, null);

  // A key can only be set for an https address, and answers with its origin.
  setTeam({ teamSource: "~/team.json", teamHeaderName: "Authorization" });
  await assert.rejects(handleMcpCatalogTeamAuth({ action: "set", value: KEY }), /https team address first/);
  setTeam({ teamSource: "https://raw.githubusercontent.com/acme/private/main/catalog.json", teamHeaderName: "Authorization" });
  assert.deepEqual(await handleMcpCatalogTeamAuth({ action: "set", value: KEY }), { set: true, origin: "https://raw.githubusercontent.com" });
  assert.equal(JSON.parse(readFileSync(store, "utf8")).origin, "https://raw.githubusercontent.com");
  await handleMcpCatalogTeamAuth({ action: "clear" });
});

test("5: a value moved from the old setting is bound to that setting's address; one with no origin is sent nowhere", async () => {
  resetCatalogCaches();
  sent.length = 0;
  rmSync(store, { force: true });
  setTeam({ teamSource: "https://team.example.com/catalogue.json", teamHeaderName: "Authorization", teamHeaderValue: "Bearer legacy_value_0123" });
  await read();
  assert.equal(JSON.parse(readFileSync(store, "utf8")).origin, "https://team.example.com");
  assert.equal(sent.at(-1)?.authorization, "Bearer legacy_value_0123");

  // A store an earlier build wrote, with no origin: never sent.
  resetCatalogCaches();
  writeFileSync(store, JSON.stringify({ teamHeaderValue: "Bearer unbound_value" }), { mode: 0o600 });
  setTeam({ teamSource: "https://team.example.com/catalogue.json", teamHeaderName: "Authorization" });
  await read();
  assert.ok(sent.every((request) => request.authorization !== "Bearer unbound_value"), JSON.stringify(sent));
});

test("2: a project plan says when a variable it asks for is already set on this host, by name only", async () => {
  process.env.MCP_HEROUI_PRO_HEROUI_PERSONAL_TOKEN = "already-there-value-0123";
  const plan = await handleMcpCatalogPlan({ key: "recommended:heroui-pro", scope: "project", targets: [], projectPath: project, name: "heroui-pro", values: {} }, context);
  assert.ok(
    plan.notes.includes("MCP_HEROUI_PRO_HEROUI_PERSONAL_TOKEN is already set on this host: this server would receive that value."),
    plan.notes.join("\n"),
  );
  assert.ok(!JSON.stringify(plan).includes("already-there-value"));
  delete process.env.MCP_HEROUI_PRO_HEROUI_PERSONAL_TOKEN;
  const unset = await handleMcpCatalogPlan({ key: "recommended:heroui-pro", scope: "project", targets: [], projectPath: project, name: "heroui-pro", values: {} }, context);
  assert.ok(!unset.notes.some((note) => /already set/.test(note)));
});
