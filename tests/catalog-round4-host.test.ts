/**
 * Round 4 of the 0.12.0 review, host side, against a sandbox HOME: the whole
 * catalogue answer, fed the registry's real recorded answers, parses the way
 * the app parses it; a stdio plan shows its command line; an install is bound
 * to the preview it follows; user-level installs into Codex, Kimi and Grok
 * hold the typed value, never a ${VAR} they would not expand.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const home = mkdtempSync(join(tmpdir(), "paseo-mcp-catalog-r4-"));
const project = join(home, "code", "demo");
mkdirSync(project, { recursive: true });
for (const dir of [".codex", ".kimi-code", ".grok"]) mkdirSync(join(home, dir), { recursive: true });
writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: {} }));
process.env.HOME = home;
process.env.PASEO_HOME = join(home, ".paseo");
delete process.env.AGENT_LINK_HOME;
delete process.env.AGENT_AUTH_HOME;

const catalog = await import("../server/catalog");
const { handleMcpCatalog, handleMcpCatalogPlan, handleMcpCatalogInstall, setCatalogFetch, catalogSettled, resetCatalogCaches } = catalog;
const { mcpCatalog, CatalogCardSchema, curatedCard } = await import("../shared/catalog");
const { CURATED_CATALOG } = await import("../shared/catalog-curated");
const context = { paseo: { config: { get: async () => ({ config: { providers: {} } }), patch: async () => ({}) }, projects: { list: async () => [{ name: "demo", path: project }] } } } as never;

const claude = join(home, ".claude.json");
const codex = join(home, ".codex", "config.toml");
const kimi = join(home, ".kimi-code", "mcp.json");
const grok = join(home, ".grok", "config.toml");
const teamFile = join(home, "team.json");
const settingsDir = join(home, ".paseo", "plugin-settings", "paseo-mcp");
mkdirSync(settingsDir, { recursive: true });
writeFileSync(join(settingsDir, "catalog.json"), JSON.stringify({ version: 1, values: { teamSource: teamFile, teamHeaderName: "" } }));

const TOKEN = "acme_live_Zx9Qw8Er7Ty6Ui5Op4";
const teamEntry = (url: string) => ({
  id: "acme",
  name: "Acme",
  publisher: "Acme",
  transport: "http",
  url,
  headers: { Authorization: "Bearer {ACME_TOKEN}" },
  inputs: [{ id: "ACME_TOKEN", label: "Acme token" }],
  auth: "header",
});
writeFileSync(teamFile, JSON.stringify([teamEntry("https://mcp.acme.example/mcp"), { id: "acme-cli", name: "Acme CLI", transport: "stdio", command: "npx", args: ["-y", "acme-mcp@1.0.0", "--api-key", "{ACME_TOKEN}"], inputs: [{ id: "ACME_TOKEN", label: "Acme token" }], auth: "none" }]));

let registryBody = "{}";
setCatalogFetch(async (url) => (url.startsWith("https://registry.modelcontextprotocol.io/") ? new Response(registryBody, { status: 200 }) : new Response("", { status: 401 })));

after(() => {
  setCatalogFetch(null);
  rmSync(home, { recursive: true, force: true });
});

async function read(query = "", refresh?: "team" | "registry" | "both") {
  await handleMcpCatalog({ query, refresh }, context);
  await catalogSettled();
  return handleMcpCatalog({ query }, context);
}

async function planThenInstall(input: Parameters<typeof handleMcpCatalogPlan>[0]) {
  const plan = await handleMcpCatalogPlan(input, context);
  return { plan, result: await handleMcpCatalogInstall({ ...input, planHash: plan.planHash }, context) };
}

// 1 ------------------------------------------------ the whole answer parses

test("1: the full catalogue answer, fed the registry's recorded answers, parses as the app parses it", async () => {
  for (const name of ["reg-api.json", "reg-data.json", "reg-mcp.json", "reg-server.json"]) {
    resetCatalogCaches();
    registryBody = readFileSync(join(here, "fixtures", "registry", name), "utf8");
    const query = name.replace(/^reg-|\.json$/g, "");
    const out = await read(query);
    const registry = out.cards.filter((card) => card.shelf === "registry");
    assert.ok(registry.length > 0, `${name}: registry cards shown`);
    const parsed = mcpCatalog.output.safeParse(out);
    assert.ok(parsed.success, `${name}: ${parsed.success ? "" : `${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`}`);
    assert.ok(registry.filter((card) => card.entry.transport === "stdio").every((card) => !card.installable), name);
  }
});

test("1: a card that fails the schema is left out and counted, never the whole answer", () => {
  const good = curatedCard(CURATED_CATALOG[0]!);
  const bad = { ...good, key: "registry:x", shelf: "registry" as const, entry: { ...good.entry, name: "A".repeat(81) } };
  const { shown, dropped } = catalog.cardsThatParse([good, bad, { ...bad, key: "registry:y" }]);
  assert.deepEqual(shown.map((card) => card.key), [good.key]);
  assert.equal(dropped.registry, 2);
  assert.ok(shown.every((card) => CatalogCardSchema.safeParse(card).success));
});

// 2 -------------------------------------------------------- the command line

test("2: a command server's plan shows the exact command line, typed secrets masked", async () => {
  await read("", "team");
  const playwright = await handleMcpCatalogPlan({ key: "recommended:playwright", scope: "user", targets: [claude], projectPath: "", name: "playwright", values: {} }, context);
  assert.equal(playwright.commandLine, "npx @playwright/mcp@latest");
  const team = await handleMcpCatalogPlan({ key: "team:acme-cli", scope: "user", targets: [claude], projectPath: "", name: "acme-cli", values: { ACME_TOKEN: TOKEN } }, context);
  assert.equal(team.ok, true, team.issues.join());
  assert.match(team.commandLine, /^npx -y acme-mcp@1\.0\.0 --api-key '•••/);
  assert.ok(!team.commandLine.includes(TOKEN));
  const remote = await handleMcpCatalogPlan({ key: "recommended:linear", scope: "user", targets: [claude], projectPath: "", name: "linear", values: {} }, context);
  assert.equal(remote.commandLine, "");
});

// 6b ---------------------------------------------- install bound to its preview

test("6b: an install is refused when the entry or the plan changed after the preview", async () => {
  await read("", "team");
  const input = { key: "team:acme", scope: "user" as const, targets: [claude], projectPath: "", name: "acme", values: { ACME_TOKEN: TOKEN } };
  const plan = await handleMcpCatalogPlan(input, context);
  assert.equal(plan.ok, true, plan.issues.join());
  assert.match(plan.planHash, /^[0-9a-f]{64}$/);
  const before = readFileSync(claude, "utf8");

  // No hash, or the hash of another preview: refused.
  assert.equal((await handleMcpCatalogInstall(input, context)).message, catalog.PLAN_CHANGED);
  assert.equal((await handleMcpCatalogInstall({ ...input, targets: [claude, codex], planHash: plan.planHash }, context)).message, catalog.PLAN_CHANGED);
  assert.equal((await handleMcpCatalogInstall({ ...input, name: "acme-2", planHash: plan.planHash }, context)).message, catalog.PLAN_CHANGED);

  // The team file moves the address after the user reviewed it.
  writeFileSync(teamFile, JSON.stringify([teamEntry("https://mcp.elsewhere.example/mcp")]));
  await read("", "team");
  const stale = await handleMcpCatalogInstall({ ...input, planHash: plan.planHash }, context);
  assert.equal(stale.ok, false);
  assert.equal(stale.message, "The server's details changed since you reviewed them; review again.");
  assert.equal(readFileSync(claude, "utf8"), before, "nothing was written");

  // Reviewed again: written, at the address the user saw.
  const { result } = await planThenInstall(input);
  assert.equal(result.ok, true, result.message);
  assert.equal(JSON.parse(readFileSync(claude, "utf8")).mcpServers.acme.url, "https://mcp.elsewhere.example/mcp");
});

// 6c ------------------------------------------- user scope never writes ${VAR}

test("6c: user-level installs into Codex, Kimi and Grok hold the typed value, never a ${VAR}", async () => {
  await read("", "team");
  const targets = [codex, kimi, grok];
  const header = await planThenInstall({ key: "team:acme", scope: "user", targets, projectPath: "", name: "acme-user", values: { ACME_TOKEN: TOKEN } });
  assert.equal(header.result.ok, true, header.result.message);
  assert.equal(header.result.written.length, 3, header.result.skipped.join());
  const DO_TOKEN = "dop_v1_0123456789abcdef0123456789abcdef";
  const env = await planThenInstall({ key: "recommended:digitalocean", scope: "user", targets, projectPath: "", name: "do-user", values: { DIGITALOCEAN_API_TOKEN: DO_TOKEN } });
  assert.equal(env.result.ok, true, env.result.message);
  for (const file of targets) {
    const body = readFileSync(file, "utf8");
    assert.ok(!body.includes("${"), `${file}: ${body}`);
    assert.ok(body.includes(`Bearer ${TOKEN}`), file);
    assert.ok(body.includes(DO_TOKEN), file);
  }
  assert.deepEqual(env.result.envToSet, []);
});
