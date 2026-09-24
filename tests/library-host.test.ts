/**
 * Libraries (0.13.0) against a sandbox HOME: a private library read from a
 * file on the host, the default library's 404 and the Recommended fallback,
 * the last good copy kept through a failed read, registry pagination, keys
 * sent only to their own library's site, the 0.12.0 settings read through
 * the migration, and an install from a library card through the existing
 * writers.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-library-"));
const project = join(home, "code", "demo");
mkdirSync(project, { recursive: true });
mkdirSync(join(home, ".codex"), { recursive: true });
writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: {} }, null, 2));
process.env.HOME = home;
process.env.PASEO_HOME = join(home, ".paseo");
delete process.env.AGENT_LINK_HOME;
delete process.env.AGENT_AUTH_HOME;
after(() => rmSync(home, { recursive: true, force: true }));

const catalog = await import("../server/catalog");
const { handleMcpCatalog, handleMcpCatalogPlan, handleMcpCatalogInstall, handleMcpCatalogTeamAuth, setCatalogFetch, catalogSettled, resetCatalogCaches } = catalog;
const { mcpCatalog } = await import("../shared/catalog");
const { GALLERY_META } = await import("../shared/library");
const { DEFAULT_LIBRARY_URL } = await import("../shared/library-source");

const context = { paseo: { config: { get: async () => ({ config: { providers: {} } }), patch: async () => ({}) }, projects: { list: async () => [{ name: "demo", path: project }] } } } as never;
const claude = join(home, ".claude.json");
const settingsDir = join(home, ".paseo", "plugin-settings", "paseo-mcp");
mkdirSync(settingsDir, { recursive: true });
const settingsFile = join(settingsDir, "catalog.json");
const setLibraries = (libraries: Array<Record<string, unknown>>) => writeFileSync(settingsFile, JSON.stringify({ version: 2, values: { libraries } }));

const TOKEN = "acme_live_Zx9Qw8Er7Ty6Ui5Op4";
const item = (server: Record<string, unknown>, meta?: Record<string, unknown>) => ({ server: { version: "1.0.0", description: `${server.name} server`, ...server }, ...(meta ? { _meta: { [GALLERY_META]: meta } } : {}) });
const acmeHeaders = [{ name: "Authorization", value: "Bearer {ACME_TOKEN}", isRequired: true, isSecret: true, variables: { ACME_TOKEN: { description: "Acme token", isRequired: true, isSecret: true } } }];
const acmeAt = (url: string) => item({ name: "com.acme/mcp", remotes: [{ type: "streamable-http", url, headers: acmeHeaders }] }, { displayName: "Acme", category: "payments", auth: "token", publisher: "Acme" });
const acme = acmeAt("https://mcp.acme.example/mcp");
const notion = item({ name: "com.notion/mcp", remotes: [{ type: "streamable-http", url: "https://mcp.notion.com/mcp" }] }, { id: "notion", displayName: "Notion", category: "productivity", auth: "oauth", publisher: "Notion" });

// Network: every call is recorded with its Authorization header and answered by `answer`.
const sent: Array<{ url: string; authorization: string | null }> = [];
let answer: (url: string) => Promise<Response> = async () => new Response("", { status: 404 });
setCatalogFetch(async (url, init) => {
  sent.push({ url, authorization: new Headers(init?.headers).get("authorization") });
  return answer(url);
});
after(() => setCatalogFetch(null));

async function read(input: { query?: string; refresh?: "team" | "registry" | "both" | "libraries" | "all"; library?: string } = {}) {
  await handleMcpCatalog(input, context);
  await catalogSettled();
  return handleMcpCatalog({ query: input.query ?? "" }, context);
}

test("the default library: a 404 is said plainly and the Recommended list stands in; once published it merges in", async () => {
  resetCatalogCaches();
  rmSync(settingsFile, { force: true });
  sent.length = 0;
  answer = async () => new Response("Not Found", { status: 404 });
  const missing = await read();
  assert.ok(sent.some((request) => request.url === DEFAULT_LIBRARY_URL), "the default library is read");
  assert.ok(!sent.some((request) => request.url.startsWith("https://registry.modelcontextprotocol.io/")), "the official registry is off by default");
  const gallery = missing.libraries.find((library) => library.id === "mcp-gallery");
  assert.equal(gallery?.state, "error");
  assert.match(gallery?.note ?? "", /HTTP 404: nothing is published at that address \(yet\)\. The recommended servers shipped with the plugin are shown instead\./);
  assert.ok(missing.cards.some((card) => card.key === "recommended:notion"));
  assert.equal(missing.libraries.find((library) => library.id === "mcp-registry")?.state, "off");
  assert.ok(mcpCatalog.output.safeParse(missing).success);

  answer = async (url) => (url === DEFAULT_LIBRARY_URL ? new Response(JSON.stringify({ servers: [notion, acme], metadata: { count: 2 } }), { status: 200 }) : new Response("", { status: 404 }));
  const published = await read({ library: "mcp-gallery" });
  const keys = published.cards.map((card) => card.key);
  assert.ok(keys.includes("recommended:notion"), "the library's exact copy of Notion shows as the recommended card");
  assert.ok(!keys.includes("library:mcp-gallery:com.notion/mcp"));
  assert.equal(published.cards.find((card) => card.key === "recommended:notion")?.trust, "official");
  assert.equal(published.cards.find((card) => card.key === "library:mcp-gallery:com.acme/mcp")?.trust, "library");
  assert.ok(keys.includes("recommended:linear"), "the rest of the recommended list stays");
  assert.equal(published.libraries.find((library) => library.id === "mcp-gallery")?.count, 2);
  assert.ok(mcpCatalog.output.safeParse(published).success);
});

test("a private library from a file on the host: read in the background, installed through the existing writers", async () => {
  resetCatalogCaches();
  const file = join(home, "private", "servers.json");
  mkdirSync(join(home, "private"), { recursive: true });
  writeFileSync(file, JSON.stringify({ servers: [acme], metadata: { count: 1 } }));
  setLibraries([{ id: "acme-private", name: "Acme private", source: "~/private/servers.json" }]);
  sent.length = 0;
  const first = await handleMcpCatalog({ query: "" }, context);
  assert.equal(first.libraries[0]?.state, "loading");
  await catalogSettled();
  const second = await handleMcpCatalog({ query: "" }, context);
  assert.equal(second.libraries[0]?.state, "ready");
  assert.equal(second.libraries[0]?.kind, "file");
  assert.equal(sent.length, 0, "a file library touches no network");
  const card = second.cards.find((entry) => entry.key === "library:acme-private:com.acme/mcp");
  assert.ok(card);
  assert.equal(card.entry.inputs?.[0]?.secret, true);

  // User level: the typed key goes into the editor config, masked in the preview.
  const input = { key: card.key, scope: "user" as const, targets: [claude], projectPath: "", name: "acme", values: { ACME_TOKEN: TOKEN } };
  const plan = await handleMcpCatalogPlan(input, context);
  assert.equal(plan.ok, true, plan.issues.join());
  assert.ok(plan.previews.every((preview) => !preview.text.includes(TOKEN)));
  answer = async () => new Response("", { status: 401 });
  const result = await handleMcpCatalogInstall({ ...input, planHash: plan.planHash }, context);
  assert.equal(result.ok, true, result.message);
  assert.equal(JSON.parse(readFileSync(claude, "utf8")).mcpServers.acme.headers.Authorization, `Bearer ${TOKEN}`);

  // Project level: a ${VAR} the plugin names, never the key.
  const projectPlan = await handleMcpCatalogPlan({ ...input, scope: "project", targets: [], projectPath: project, name: "acme" }, context);
  assert.equal(projectPlan.ok, true, projectPlan.issues.join());
  const installed = await handleMcpCatalogInstall({ ...input, scope: "project", targets: [], projectPath: project, name: "acme", planHash: projectPlan.planHash }, context);
  assert.equal(installed.ok, true, installed.message);
  const written = readFileSync(join(project, ".mcp.json"), "utf8");
  assert.ok(!written.includes(TOKEN));
  assert.match(written, /Bearer \$\{MCP_TEAM__ACME__[0-9A-F]{6}__ACME_TOKEN\}/);

  // A library entry changed after the review is never written unseen.
  writeFileSync(file, JSON.stringify({ servers: [acmeAt("https://mcp.moved.example/mcp")] }));
  const stale = await handleMcpCatalogPlan({ ...input, name: "acme-2" }, context);
  await read({ library: "acme-private" });
  const refused = await handleMcpCatalogInstall({ ...input, name: "acme-2", planHash: stale.planHash }, context);
  assert.equal(refused.ok, false);
  assert.equal(refused.message, catalog.PLAN_CHANGED);
});

test("a failed read keeps the last good copy and says so; a disabled library is not read", async () => {
  resetCatalogCaches();
  const file = join(home, "private", "keep.json");
  writeFileSync(file, JSON.stringify({ servers: [acme] }));
  setLibraries([{ id: "keep", name: "Keep", source: file }]);
  const good = await read();
  assert.equal(good.libraries[0]?.count, 1);
  writeFileSync(file, "{ broken");
  const broken = await read({ library: "keep" });
  assert.equal(broken.libraries[0]?.state, "error");
  assert.match(broken.libraries[0]?.note ?? "", /not valid JSON \(line 1\)\. Showing the last good copy\./);
  assert.ok(broken.cards.some((card) => card.key === "library:keep:com.acme/mcp"), "the last good copy is still shown");

  resetCatalogCaches();
  sent.length = 0;
  setLibraries([{ id: "off", name: "Off", source: "https://off.example/servers.json", enabled: false }]);
  const off = await read();
  assert.equal(off.libraries[0]?.state, "off");
  assert.equal(sent.length, 0);
});

test("a registry library: searched as you type, following the cursor for up to three pages", async () => {
  resetCatalogCaches();
  setLibraries([{ id: "private-registry", name: "Private registry", source: "https://registry.acme.example", format: "registry" }]);
  const page = (index: number, cursor: string) =>
    JSON.stringify({
      servers: [{ server: { name: `com.acme/tool-${index}`, version: "1.0.0", description: "A tool", remotes: [{ type: "streamable-http", url: `https://tool${index}.acme.example/mcp` }] }, _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } } }],
      metadata: cursor ? { nextCursor: cursor, count: 1 } : { count: 1 },
    });
  sent.length = 0;
  answer = async (url) => {
    const cursor = new URL(url).searchParams.get("cursor") ?? "";
    const index = cursor ? Number(cursor.replace("c", "")) : 1;
    return new Response(page(index, index < 5 ? `c${index + 1}` : ""), { status: 200 });
  };
  const idle = await handleMcpCatalog({ query: "" }, context);
  assert.equal(idle.libraries[0]?.state, "idle", "a registry waits for a search");
  assert.equal(sent.length, 0);
  const found = await read({ query: "tool" });
  assert.deepEqual(
    sent.map((request) => request.url),
    [
      "https://registry.acme.example/v0.1/servers?search=tool&version=latest&limit=100",
      "https://registry.acme.example/v0.1/servers?search=tool&version=latest&limit=100&cursor=c2",
      "https://registry.acme.example/v0.1/servers?search=tool&version=latest&limit=100&cursor=c3",
    ],
  );
  assert.deepEqual(found.cards.filter((card) => card.shelf === "registry").map((card) => card.registryName), ["com.acme/tool-1", "com.acme/tool-2", "com.acme/tool-3"]);
  assert.equal(found.registry.state, "ready");
  assert.match(found.libraries[0]?.note ?? "", /narrow the search/);
  assert.ok(found.cards.filter((card) => card.shelf === "registry").every((card) => card.trust === "community" && card.library?.id === "private-registry"));

  // Installable from the search it came from.
  const plan = await handleMcpCatalogPlan({ key: "registry:com.acme/tool-2", scope: "user", targets: [claude], projectPath: "", name: "tool-2", values: {} }, context);
  assert.equal(plan.ok, true, plan.issues.join());
});

test("each library's key goes only to its own site; a 0.12.0 settings file is read through the migration", async () => {
  resetCatalogCaches();
  sent.length = 0;
  answer = async () => new Response(JSON.stringify({ servers: [] }), { status: 200 });
  setLibraries([
    { id: "private-a", name: "A", source: "https://a.example/servers.json", headerName: "Authorization" },
    { id: "private-b", name: "B", source: "https://b.example/servers.json", headerName: "Authorization" },
  ]);
  assert.deepEqual(await handleMcpCatalogTeamAuth({ action: "set", value: "Bearer key-for-a-0123456789", library: "private-a" }), { set: true, origin: "https://a.example" });
  await read({ refresh: "libraries" });
  assert.equal(sent.find((request) => request.url.startsWith("https://a.example/"))?.authorization, "Bearer key-for-a-0123456789");
  assert.equal(sent.find((request) => request.url.startsWith("https://b.example/"))?.authorization, null);
  assert.deepEqual(await handleMcpCatalogTeamAuth({ action: "status", library: "private-b" }), { set: false, origin: "" });

  // B's address moves to A's site: B still has no key, and A's key never goes with it.
  setLibraries([
    { id: "private-a", name: "A", source: "https://a.example/servers.json", headerName: "Authorization" },
    { id: "private-b", name: "B", source: "https://a.example/other.json", headerName: "Authorization" },
  ]);
  sent.length = 0;
  await read({ refresh: "libraries" });
  assert.equal(sent.find((request) => request.url === "https://a.example/other.json")?.authorization, null);
  await handleMcpCatalogTeamAuth({ action: "clear", library: "private-a" });

  // 0.12.0's document: version 1, one team catalogue. The host reads it as the Team library.
  resetCatalogCaches();
  const teamFile = join(home, "team.json");
  writeFileSync(teamFile, JSON.stringify([{ id: "ikit-n8n", name: "n8n", transport: "http", url: "https://n8n.example.com/mcp", headers: { Authorization: "Bearer {N8N}" }, inputs: [{ id: "N8N", label: "Token" }], auth: "header" }]));
  writeFileSync(settingsFile, JSON.stringify({ version: 1, values: { teamSource: teamFile, teamHeaderName: "" } }));
  const migrated = await read();
  assert.deepEqual(migrated.libraries.map((library) => library.id), ["team", "mcp-gallery", "mcp-registry"]);
  assert.equal(migrated.team.state, "ready");
  assert.deepEqual(migrated.cards.filter((card) => card.shelf === "team").map((card) => [card.key, card.trust]), [["team:ikit-n8n", "team"]]);
  assert.equal(JSON.parse(readFileSync(settingsFile, "utf8")).version, 1, "the host never rewrites the document; Paseo does when it migrates");
});
