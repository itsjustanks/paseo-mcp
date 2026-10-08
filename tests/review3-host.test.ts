/**
 * 0.20.0, final review, against a sandbox HOME:
 * - Fields Save refuses masked text anywhere (a whole field, or "Bearer •••");
 * - a field the user didn't change is written back from what is stored, byte
 *   for byte: ["--token", "two words"] stays two items through an env edit;
 * - Claude's "just for you" copies are read only: listed (local-only names
 *   too), never removed, and the plugin never writes their entries.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-final-"));
const project = join(home, "code", "data-glue");
process.env.HOME = home;
process.env.PASEO_HOME = join(home, ".paseo");
delete process.env.AGENT_LINK_HOME;
delete process.env.AGENT_AUTH_HOME;
after(() => rmSync(home, { recursive: true, force: true }));
mkdirSync(project, { recursive: true });

const claudePath = join(home, ".claude.json");
const SECRET = "fixture-secret";
const config = {
  oauthAccount: { emailAddress: "me@example.com" },
  mcpServers: {
    local: { type: "stdio", command: "node", args: ["server", "--token", "two words"], env: { MODE: "dev" } },
    web: { type: "http", url: "https://example.com/mcp", headers: { Authorization: `Bearer ${SECRET}`, "X-Team": "a  b" } },
    acme: { type: "http", url: "http://127.0.0.1:9/mcp" },
  },
  projects: { [project]: { mcpServers: { acme: { type: "http", url: "http://127.0.0.1:9/mcp" }, solo: { type: "http", url: "http://127.0.0.1:9/solo" } }, allowedTools: ["x"] } },
};
writeFileSync(claudePath, JSON.stringify(config, null, 2));

const paseo = {
  config: { get: async () => ({ config: { providers: {} } }), patch: async () => ({}) },
  projects: { list: async () => [{ name: "data-glue", path: project }] },
} as never;
const context = { paseo } as never;
const { backupFile, handleMcpDefAll, handleMcpEditOne, handleMcpMatrix, handleMcpRemove, jsonLike } = await import("../server/handlers");
const read = () => JSON.parse(readFileSync(claudePath, "utf8"));
const revealedRow = async (name: string) => (await handleMcpDefAll({ name, reveal: true }, context)).rows.find((row) => row.found)!;

test("Save refuses masked text anywhere, and writes nothing", async () => {
  const before = readFileSync(claudePath, "utf8");
  for (const input of [
    { kind: "stdio" as const, command: "node server --token •••", kvLines: "MODE=dev" },
    { kind: "http" as const, url: "https://example.com/mcp", kvLines: "Authorization=Bearer •••" },
    { kind: "http" as const, url: "https://•••@example.com/mcp", kvLines: "" },
  ]) {
    const result = await handleMcpEditOne({ name: input.kind === "stdio" ? "local" : "web", destId: claudePath, ...input }, context);
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.match(result.message, /still hidden \(•••\).*nothing was written/);
  }
  assert.equal(readFileSync(claudePath, "utf8"), before);
});

test("an unchanged command is written back from what is stored: [\"--token\", \"two words\"] stays two items", async () => {
  const row = await revealedRow("local");
  assert.equal(row.command, "node server --token two words");
  const saved = await handleMcpEditOne({ name: "local", destId: claudePath, kind: "stdio", command: row.command, kvLines: "MODE=prod" }, context);
  assert.equal(saved.ok, true, saved.message);
  assert.deepEqual(read().mcpServers.local.args, ["server", "--token", "two words"], "not re-split");
  assert.deepEqual(read().mcpServers.local.env, { MODE: "prod" }, "only the edited field changed");
});

test("unchanged headers keep their exact values; an edited command is taken as typed", async () => {
  const web = await revealedRow("web");
  const kept = await handleMcpEditOne({ name: "web", destId: claudePath, kind: "http", url: "https://example.com/v2/mcp", kvLines: web.kvLines }, context);
  assert.equal(kept.ok, true, kept.message);
  assert.deepEqual(read().mcpServers.web.headers, { Authorization: `Bearer ${SECRET}`, "X-Team": "a  b" });
  assert.equal(read().mcpServers.web.url, "https://example.com/v2/mcp");
  const local = await revealedRow("local");
  const edited = await handleMcpEditOne({ name: "local", destId: claudePath, kind: "stdio", command: `${local.command} --verbose`, kvLines: local.kvLines }, context);
  assert.equal(edited.ok, true, edited.message);
  assert.deepEqual(read().mcpServers.local.args, ["server", "--token", "two", "words", "--verbose"], "an edited command line is split, as before");
});

test("Claude's just-for-you copies are listed (local-only too) and never written by Remove", async () => {
  const matrix = await handleMcpMatrix({} as never, context);
  const acme = matrix.servers.find((entry) => entry.name === "acme");
  const solo = matrix.servers.find((entry) => entry.name === "solo");
  assert.deepEqual(acme?.localIn, [{ destId: claudePath, project }]);
  assert.ok(solo, "a local-only name is in the list");
  assert.deepEqual(solo?.presentIn, []);
  assert.deepEqual(solo?.localIn, [{ destId: claudePath, project }]);
  assert.equal(solo?.transport, "http");

  const result = await handleMcpRemove({ name: "acme", targets: [claudePath], projectFiles: [], localEntries: [{ destId: claudePath, project }] } as never, context);
  assert.equal(result.ok, true, result.message);
  const after = read();
  assert.equal(after.mcpServers.acme, undefined, "the everywhere copy is removed");
  assert.deepEqual(after.projects, config.projects, "the per-project entries are exactly as they were");
});

test("JSON writes keep the file's layout; a new file gets two spaces and a newline", () => {
  assert.equal(jsonLike(null, { a: 1 }), '{\n  "a": 1\n}\n');
  assert.equal(jsonLike('{\n\t"a": 1\n}\n', { a: 2 }), '{\n\t"a": 2\n}\n');
  assert.equal(jsonLike('{"a":1}', { a: 2 }), '{"a":2}');
  assert.equal(jsonLike('{\n    "a": 1\n}', { a: 2 }), '{\n    "a": 2\n}');
});

test("a backup is readable by its owner only, even of a file anyone can read", () => {
  const path = join(home, "open.json");
  writeFileSync(path, '{"mcpServers":{}}');
  chmodSync(path, 0o644);
  const backup = backupFile(path);
  assert.ok(backup);
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  assert.ok(readdirSync(home).some((name) => name.startsWith("open.json.bak-paseo-mcp-")));
});
