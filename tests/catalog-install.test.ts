/**
 * Add from catalogue against a sandbox HOME: the read never waits on the
 * network, and installs go through the real writers (user configs, a project's
 * .mcp.json) with backups, read-back, the name-clash rule and the
 * project-scope secret rule.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-catalog-"));
const project = join(home, "code", "demo");
const other = join(home, "code", "other");
mkdirSync(project, { recursive: true });
mkdirSync(other, { recursive: true });
mkdirSync(join(home, ".codex"), { recursive: true });
writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@example.com" }, mcpServers: { docs: { type: "http", url: "https://docs.example.com/mcp" } }, projects: {} }, null, 2));
writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5"\n\n[mcp_servers.docs]\nurl = "https://docs.example.com/mcp"\n');
writeFileSync(join(other, ".mcp.json"), JSON.stringify({ mcpServers: { heroui: { type: "http", url: "https://mcp.heroui.pro/mcp" } } }, null, 2));
process.env.HOME = home;
process.env.PASEO_HOME = join(home, ".paseo");
// 0.13.0: the registry is a library, off by default; these tests search it.
mkdirSync(join(home, ".paseo", "plugin-settings", "paseo-mcp"), { recursive: true });
writeFileSync(
  join(home, ".paseo", "plugin-settings", "paseo-mcp", "catalog.json"),
  JSON.stringify({ version: 2, values: { libraries: [{ id: "mcp-registry", name: "MCP Registry", source: "https://registry.modelcontextprotocol.io", format: "registry" }] } }),
);
delete process.env.AGENT_LINK_HOME;
delete process.env.AGENT_AUTH_HOME;
after(() => rmSync(home, { recursive: true, force: true }));

const catalog = await import("../server/catalog");
const { handleMcpCatalog, handleMcpCatalogEntry, handleMcpCatalogInstall, handleMcpCatalogPlan, setCatalogFetch, catalogSettled, resetCatalogCaches } = catalog;

const paseo = {
  config: { get: async () => ({ config: { providers: {} } }), patch: async () => ({}) },
  projects: { list: async () => [{ name: "demo", path: project }, { name: "other", path: other }] },
} as never;
const context = { paseo } as never;

// Network: every call is recorded and answered by `answer`.
const fetched: string[] = [];
let answer: (url: string, init?: RequestInit) => Promise<Response> = async () => new Response("", { status: 401 });
setCatalogFetch((url, init) => {
  fetched.push(url);
  return answer(url, init);
});

/** What the app does: preview, then install bound to that preview. */
async function planThenInstall(input: Parameters<typeof handleMcpCatalogPlan>[0], ctx: typeof context) {
  const plan = await handleMcpCatalogPlan(input, ctx);
  return handleMcpCatalogInstall({ ...input, planHash: plan.planHash }, ctx);
}

const claude = join(home, ".claude.json");
const codex = join(home, ".codex", "config.toml");
const TOKEN = "hp_live_0123456789abcdefghij";

const smitheryBody = {
  servers: [
    {
      server: {
        name: "ai.smithery/pinion05-supabase-mcp-lite",
        description: "Same functionality, consuming only 1/20 of the context window tokens.",
        version: "1.0.0",
        remotes: [{ type: "streamable-http", url: "https://server.smithery.ai/@pinion05/supabase-mcp-lite/mcp", headers: [{ name: "Authorization", isRequired: true, isSecret: true, value: "Bearer {smithery_api_key}" }] }],
      },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true, publishedAt: "2025-09-17T00:00:00Z" } },
    },
    {
      server: { name: "com.supabase/mcp", version: "0.13.0", remotes: [{ type: "streamable-http", url: "https://mcp.supabase.com/mcp" }] },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
    },
  ],
};

test("the catalogue read answers at once; the registry search runs in the background and is cached", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  answer = async (url) => {
    if (url.startsWith("https://registry.modelcontextprotocol.io/")) {
      await gate;
      return new Response(JSON.stringify(smitheryBody), { status: 200 });
    }
    return new Response("", { status: 401 });
  };
  const began = Date.now();
  const first = await handleMcpCatalog({ query: "supabase" }, context);
  assert.ok(Date.now() - began < 1000, "the read did not wait for the registry");
  assert.equal(first.registry.state, "searching");
  assert.equal(first.cards.filter((card) => card.shelf === "registry").length, 0);
  assert.ok(first.cards.some((card) => card.key === "recommended:supabase"));
  assert.deepEqual(first.projects.map((entry) => [entry.name, entry.servers]), [["demo", 0], ["other", 1]]);
  assert.match(fetched[0] ?? "", /search=supabase&version=latest&limit=100/);

  release();
  await catalogSettled();
  const second = await handleMcpCatalog({ query: "supabase" }, context);
  assert.equal(second.registry.state, "ready");
  const registry = second.cards.filter((card) => card.shelf === "registry");
  // The official Supabase entry duplicates the recommended card and is folded into it.
  assert.deepEqual(registry.map((card) => [card.registryName, card.trust]), [["ai.smithery/pinion05-supabase-mcp-lite", "community"]]);
  const before = fetched.length;
  await handleMcpCatalog({ query: " Supabase " }, context);
  assert.equal(fetched.length, before, "a cached query is not asked again within a day");
  await handleMcpCatalog({ query: "supabase", refresh: "registry" }, context);
  assert.equal(fetched.length, before + 1, "Refresh asks again");
  await catalogSettled();
});

test("a failed registry search is reported and not retried in a loop", async () => {
  answer = async () => {
    throw new Error("getaddrinfo ENOTFOUND registry.modelcontextprotocol.io");
  };
  await handleMcpCatalog({ query: "jira" }, context);
  await catalogSettled();
  const failed = await handleMcpCatalog({ query: "jira" }, context);
  assert.equal(failed.registry.state, "error");
  assert.match(failed.registry.note, /ENOTFOUND/);
  const count = fetched.filter((url) => url.includes("search=jira")).length;
  await handleMcpCatalog({ query: "jira" }, context);
  assert.equal(fetched.filter((url) => url.includes("search=jira")).length, count);
});

test("user level: written to each chosen editor with backups, read back, then health-checked", async () => {
  answer = async () => new Response("", { status: 401 });
  const input = { key: "recommended:linear", scope: "user" as const, targets: [claude, codex], projectPath: "", name: "linear", values: {} };
  const plan = await handleMcpCatalogPlan(input, context);
  assert.equal(plan.ok, true, plan.issues.join());
  assert.equal(plan.previews.length, 2);
  assert.match(plan.previews[1]?.text ?? "", /\[mcp_servers\.linear\]\nurl = "https:\/\/mcp\.linear\.app\/mcp"/);
  assert.match(plan.budget, /Adds 1 server to every workspace/);
  assert.ok(plan.notes.some((note) => /Connect OAuth/.test(note)));

  const result = await planThenInstall(input, context);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.written.length, 2);
  assert.equal(result.oauth, true);
  assert.equal(result.health?.status, "auth-required");
  const config = JSON.parse(readFileSync(claude, "utf8"));
  assert.deepEqual(config.mcpServers.linear, { type: "http", url: "https://mcp.linear.app/mcp" });
  assert.equal(config.oauthAccount.emailAddress, "me@example.com", "the rest of ~/.claude.json is kept");
  assert.match(readFileSync(codex, "utf8"), /model = "gpt-5"[\s\S]*\[mcp_servers\.linear\]\nurl = "https:\/\/mcp\.linear\.app\/mcp"/);
  assert.ok(readdirSync(home).some((entry) => entry.startsWith(".claude.json.bak-paseo-mcp-")));
});

test("name clash: refused without touching the file, with a free name offered", async () => {
  const beforeText = readFileSync(claude, "utf8");
  const input = { key: "recommended:linear", scope: "user" as const, targets: [claude], projectPath: "", name: "linear", values: {} };
  const plan = await handleMcpCatalogPlan(input, context);
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.clash?.suggestion, "linear-2");
  const result = await planThenInstall(input, context);
  assert.equal(result.ok, false);
  assert.match(result.message, /already in .*Use 'linear-2' instead, or skip it/);
  assert.equal(readFileSync(claude, "utf8"), beforeText);
  const renamed = await planThenInstall({ ...input, name: "linear-2" }, context);
  assert.equal(renamed.ok, true, renamed.message);
});

test("user level with a key: previews are masked, the config holds the key", async () => {
  const input = { key: "recommended:heroui-pro", scope: "user" as const, targets: [claude, codex], projectPath: "", name: "heroui-pro", values: { HEROUI_PERSONAL_TOKEN: TOKEN } };
  const plan = await handleMcpCatalogPlan(input, context);
  assert.equal(plan.ok, true, plan.issues.join());
  for (const preview of plan.previews) {
    assert.ok(!preview.text.includes(TOKEN), preview.label);
    assert.match(preview.text, /•••ghij/);
  }
  assert.match(plan.previews[1]?.text ?? "", /\[mcp_servers\.heroui-pro\.http_headers\]/);
  const result = await planThenInstall(input, context);
  assert.equal(result.ok, true, result.message);
  assert.equal(JSON.parse(readFileSync(claude, "utf8")).mcpServers["heroui-pro"].headers["x-heroui-personal-token"], TOKEN);

  // Copy as catalogue entry gives it back without the key.
  const copied = await handleMcpCatalogEntry({ name: "heroui-pro" }, context);
  assert.equal(copied.ok, true);
  assert.ok(!copied.json.includes(TOKEN));
  assert.match(copied.json, /"x-heroui-personal-token": "\{X_HEROUI_PERSONAL_TOKEN\}"/);
});

test("project: a secret goes in as ${VAR}, the file is created readable, the user is told what to set", async () => {
  const input = { key: "recommended:heroui-pro", scope: "project" as const, targets: [], projectPath: project, name: "heroui-pro", values: { HEROUI_PERSONAL_TOKEN: TOKEN } };
  const plan = await handleMcpCatalogPlan(input, context);
  assert.equal(plan.ok, true, plan.issues.join());
  assert.deepEqual(plan.envToSet, [{ name: "MCP_HEROUI_PRO_HEROUI_PERSONAL_TOKEN", label: "Personal token" }]);
  assert.ok(plan.notes.some((note) => /usually in git/.test(note)));
  assert.ok(plan.notes.some((note) => /\$\{MCP_HEROUI_PRO_HEROUI_PERSONAL_TOKEN\}/.test(note)));
  const result = await planThenInstall(input, context);
  assert.equal(result.ok, true, result.message);
  const file = join(project, ".mcp.json");
  const text = readFileSync(file, "utf8");
  assert.ok(!text.includes(TOKEN), "the key never reaches the project file");
  assert.deepEqual(JSON.parse(text).mcpServers["heroui-pro"], { type: "http", url: "https://mcp.heroui.pro/mcp", headers: { "x-heroui-personal-token": "${MCP_HEROUI_PRO_HEROUI_PERSONAL_TOKEN}" } });
  assert.equal(statSync(file).mode & 0o777, 0o644);
  // The probe went without the header: nothing unexpanded is sent anywhere.
  assert.equal(result.health?.status, "auth-required");
});

test("project: a clash with the project's own entry is refused; a broken file is never overwritten", async () => {
  const clash = await planThenInstall({ key: "recommended:heroui-pro", scope: "project", targets: [], projectPath: other, name: "heroui", values: {} }, context);
  assert.equal(clash.ok, false);
  assert.match(clash.message, /heroui-2/);
  writeFileSync(join(other, ".mcp.json"), "{ broken");
  const broken = await planThenInstall({ key: "recommended:linear", scope: "project", targets: [], projectPath: other, name: "linear", values: {} }, context);
  assert.equal(broken.ok, false);
  assert.match(broken.message, /not valid JSON/);
  assert.equal(readFileSync(join(other, ".mcp.json"), "utf8"), "{ broken");
  const unknown = await planThenInstall({ key: "recommended:linear", scope: "project", targets: [], projectPath: "/etc", name: "linear", values: {} }, context);
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /registered projects/);
});

test("registry card install: a community relay at user level", async () => {
  const input = { key: "registry:ai.smithery/pinion05-supabase-mcp-lite", scope: "user" as const, targets: [claude], projectPath: "", name: "supabase-lite", values: { smithery_api_key: "smk_0123456789abcdef" } };
  const plan = await handleMcpCatalogPlan(input, context);
  assert.equal(plan.ok, true, plan.issues.join());
  assert.ok(plan.notes.some((note) => /third party relays/.test(note)));
  const result = await planThenInstall(input, context);
  assert.equal(result.ok, true, result.message);
  assert.equal(JSON.parse(readFileSync(claude, "utf8")).mcpServers["supabase-lite"].headers.Authorization, "Bearer smk_0123456789abcdef");
  const gone = await handleMcpCatalogPlan({ ...input, key: "registry:nobody/here" }, context);
  assert.match(gone.issues.join(), /no longer listed/);
});

test("cards say where their endpoint is already added, whatever it is called there", async () => {
  writeFileSync(join(other, ".mcp.json"), JSON.stringify({ mcpServers: { heroui: { type: "http", url: "https://mcp.heroui.pro/mcp/" } } }));
  const read = await handleMcpCatalog({ query: "" }, context);
  const card = (key: string) => read.cards.find((entry) => entry.key === key);
  // linear went into Claude and Codex above (as linear and linear-2 in Claude).
  assert.equal(card("recommended:linear")?.added?.label, "in 2 of 2 editors");
  assert.deepEqual(card("recommended:linear")?.added?.editors.sort(), [claude, codex].sort());
  // heroui-pro is in both editors and in demo; "other" has it too, under the name heroui.
  assert.equal(card("recommended:heroui-pro")?.added?.label, "in 2 of 2 editors, demo and other");
  assert.equal(card("recommended:supabase")?.added, undefined);
});

test("team catalogue: read from a file in the background, literal secrets refused", async () => {
  resetCatalogCaches();
  const teamFile = join(home, "team-catalogue.json");
  writeFileSync(
    teamFile,
    JSON.stringify([
      { id: "ikit-metabase", name: "Metabase", publisher: "InvestorKit", transport: "http", url: "https://data.example.app/mcp", headers: { "x-api-key": "{METABASE_KEY}" }, inputs: [{ id: "METABASE_KEY", label: "Metabase key" }], auth: "header" },
      { id: "leaky", name: "Leaky", transport: "http", url: "https://n8n.example.com/mcp", headers: { Authorization: "Bearer sk_" + "live_51Habcdefghijklmnop" }, auth: "header" },
    ]),
  );
  mkdirSync(join(home, ".paseo", "plugin-settings", "paseo-mcp"), { recursive: true });
  writeFileSync(join(home, ".paseo", "plugin-settings", "paseo-mcp", "catalog.json"), JSON.stringify({ version: 1, values: { teamSource: "~/team-catalogue.json" } }));
  const first = await handleMcpCatalog({ query: "" }, context);
  assert.equal(first.team.state, "loading");
  await catalogSettled();
  const second = await handleMcpCatalog({ query: "" }, context);
  assert.equal(second.team.state, "ready");
  assert.deepEqual(second.cards.filter((card) => card.shelf === "team").map((card) => [card.entry.id, card.trust]), [["ikit-metabase", "team"]]);
  assert.equal(second.team.refused[0]?.id, "leaky");
  assert.ok(!JSON.stringify(second).includes("sk_live_51H"));
  // Installs from the team shelf like any other.
  const plan = await handleMcpCatalogPlan({ key: "team:ikit-metabase", scope: "project", targets: [], projectPath: project, name: "metabase", values: {} }, context);
  assert.equal(plan.ok, true, plan.issues.join());
  assert.match(plan.envToSet[0]?.name ?? "", /^MCP_TEAM__IKIT_METABASE__[0-9A-F]{6}__METABASE_KEY$/);
  assert.equal(plan.envToSet.length, 1);

  // A plain-http team URL is refused before anything is sent.
  writeFileSync(join(home, ".paseo", "plugin-settings", "paseo-mcp", "catalog.json"), JSON.stringify({ version: 1, values: { teamSource: "http://example.com/team.json", teamHeaderName: "Authorization", teamHeaderValue: "Bearer x" } }));
  const sent = fetched.length;
  await handleMcpCatalog({ query: "" }, context);
  await catalogSettled();
  const refused = await handleMcpCatalog({ query: "" }, context);
  assert.equal(refused.team.state, "error");
  assert.match(refused.team.note, /only https/);
  assert.equal(fetched.length, sent);
  assert.ok(existsSync(teamFile));
});
