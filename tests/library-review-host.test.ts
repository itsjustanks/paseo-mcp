/**
 * Review fixes for 0.13.0, host side, against a sandbox HOME: a rollback to
 * 0.12.0 keeps working (the version 1 settings are kept as catalog.v1.json
 * before the migration rewrites them, and the Team key is also written in
 * 0.12.0's shape), and a card dropped at the last check is listed on its
 * library's row with the reason.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-review-"));
mkdirSync(join(home, ".codex"), { recursive: true });
writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: {} }));
process.env.HOME = home;
process.env.PASEO_HOME = join(home, ".paseo");
delete process.env.AGENT_LINK_HOME;
delete process.env.AGENT_AUTH_HOME;
after(() => rmSync(home, { recursive: true, force: true }));

const catalog = await import("../server/catalog");
const { handleMcpCatalog, handleMcpCatalogTeamAuth, setCatalogFetch, catalogSettled, resetCatalogCaches, readCatalogSettings } = catalog;
const { curatedCard } = await import("../shared/catalog");
const { CURATED_CATALOG } = await import("../shared/catalog-curated");

const context = { paseo: { config: { get: async () => ({ config: { providers: {} } }), patch: async () => ({}) }, projects: { list: async () => [] } } } as never;
const settingsDir = join(home, ".paseo", "plugin-settings", "paseo-mcp");
mkdirSync(settingsDir, { recursive: true });
const settingsFile = join(settingsDir, "catalog.json");
const v1Copy = join(settingsDir, "catalog.v1.json");
const store = join(settingsDir, "team-auth.json");

const sent: Array<{ url: string; authorization: string | null }> = [];
setCatalogFetch(async (url, init) => {
  sent.push({ url, authorization: new Headers(init?.headers).get("authorization") });
  return new Response("[]", { status: 200 });
});
after(() => setCatalogFetch(null));

/** How 0.12.0 reads the key store (server/team-auth.ts at ac16341): the top-level `teamHeaderValue` and `origin`, nothing else. */
function readAs012(): { value: string; origin: string } | null {
  const raw = JSON.parse(readFileSync(store, "utf8")) as { teamHeaderValue?: unknown; origin?: unknown };
  return typeof raw.teamHeaderValue === "string" ? { value: raw.teamHeaderValue, origin: typeof raw.origin === "string" ? raw.origin : "" } : null;
}

const V1 = JSON.stringify({ version: 1, values: { teamSource: "https://git.acme.example/raw/catalog.json", teamHeaderName: "Authorization" } });

test("5: v1 → v2 → rollback: the version 1 settings are kept as catalog.v1.json and 0.12.0 still reads the Team key", async () => {
  resetCatalogCaches();
  rmSync(v1Copy, { force: true });
  writeFileSync(settingsFile, V1);
  writeFileSync(store, JSON.stringify({ teamHeaderValue: "Bearer OLDKEY", origin: "https://git.acme.example" }), { mode: 0o600 });

  // The host's own read keeps the copy before anything migrates.
  assert.ok(readCatalogSettings().libraries.some((library) => library.id === "team"));
  assert.ok(existsSync(v1Copy), "catalog.v1.json is kept");
  assert.equal(readFileSync(v1Copy, "utf8"), V1, "the version 1 document, byte for byte");
  assert.equal(statSync(v1Copy).mode & 0o777, 0o600);

  // Paseo's migration (the definition the host registers) keeps it too, before it rewrites the file.
  rmSync(v1Copy, { force: true });
  const migrated = catalog.hostCatalogSettings.migrate?.(JSON.parse(V1).values, 1) as { libraries: Array<{ id: string }> };
  assert.deepEqual(migrated.libraries.map((library) => library.id), ["team", "mcp-gallery", "mcp-registry"]);
  assert.equal(readFileSync(v1Copy, "utf8"), V1);
  writeFileSync(settingsFile, JSON.stringify({ version: 2, values: migrated }));
  catalog.hostCatalogSettings.migrate?.(migrated, 2);
  assert.equal(readFileSync(v1Copy, "utf8"), V1, "never overwritten by a later document");

  // 0.13.0 sets a new Team key; 0.12.0's reader still finds it, bound to its origin.
  assert.deepEqual(await handleMcpCatalogTeamAuth({ action: "set", value: "Bearer NEWKEY" }), { set: true, origin: "https://git.acme.example" });
  assert.deepEqual(readAs012(), { value: "Bearer NEWKEY", origin: "https://git.acme.example" });
  assert.deepEqual(JSON.parse(readFileSync(store, "utf8")).keys.team, { value: "Bearer NEWKEY", origin: "https://git.acme.example" });

  // Another library's key never lands in 0.12.0's slot.
  writeFileSync(settingsFile, JSON.stringify({ version: 2, values: { libraries: [...migrated.libraries, { id: "acme", name: "Acme", source: "https://acme.example/servers.json", headerName: "Authorization" }] } }));
  await handleMcpCatalogTeamAuth({ action: "set", value: "Bearer ACMEKEY", library: "acme" });
  assert.deepEqual(readAs012(), { value: "Bearer NEWKEY", origin: "https://git.acme.example" });

  // Rolled back: 0.12.0 reads the restored version 1 document and sends its key to its own site.
  writeFileSync(settingsFile, readFileSync(v1Copy, "utf8"));
  const restored = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.equal(restored.version, 1);
  assert.equal(new URL(restored.values.teamSource).origin, readAs012()?.origin);

  // Clearing the Team key clears 0.12.0's copy too.
  await handleMcpCatalogTeamAuth({ action: "clear" });
  assert.equal(readAs012(), null);
  assert.ok(existsSync(store), "the other library's key is kept");
});

test("7: a card dropped at the last check is listed on its library's row with the reason", () => {
  const good = curatedCard(CURATED_CATALOG[0]!);
  const library = { id: "acme", name: "Acme" };
  const longAddress = { ...good, key: "library:acme:com.acme/long", shelf: "library" as const, trust: "library" as const, library, registryName: "com.acme/long", entry: { ...good.entry, url: `https://acme.example/${"p".repeat(3000)}` } };
  const manyArgs = { ...good, key: "library:acme:com.acme/args", shelf: "library" as const, trust: "library" as const, library, registryName: "com.acme/args", entry: { ...good.entry, transport: "stdio" as const, url: undefined, command: "npx", args: Array.from({ length: 70 }, () => "x") } };
  const { shown, dropped, byLibrary } = catalog.cardsThatParse([good, longAddress, manyArgs]);
  assert.deepEqual(shown.map((card) => card.key), [good.key]);
  assert.equal(dropped.library, 2);
  assert.deepEqual(byLibrary.get("acme"), [
    { id: "com.acme/long", reason: "address too long" },
    { id: "com.acme/args", reason: "too many arguments" },
  ]);
});

test("7: the library's row lists each server that could not be shown, with the reason", async () => {
  resetCatalogCaches();
  const file = join(home, "acme.json");
  const remote = (name: string, url: string) => ({ server: { name, remotes: [{ type: "streamable-http", url }] } });
  writeFileSync(file, JSON.stringify({ servers: [remote("com.acme/ok", "https://mcp.acme.example/mcp"), remote("com.acme/long", `https://mcp.acme.example/${"p".repeat(3000)}`)] }));
  writeFileSync(settingsFile, JSON.stringify({ version: 2, values: { libraries: [{ id: "acme", name: "Acme", source: file }] } }));
  await handleMcpCatalog({ query: "" }, context);
  await catalogSettled();
  const out = await handleMcpCatalog({ query: "" }, context);
  const row = out.libraries.find((library) => library.id === "acme");
  assert.equal(row?.count, 1);
  assert.deepEqual(row?.refused, [{ id: "com.acme/long", reason: "address too long" }]);
});
