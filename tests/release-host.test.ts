/**
 * 0.20.0 release review, against a sandbox HOME:
 * - a stale reveal never overwrites a rotated key (Fields and JSON);
 * - only fields changed since Reveal are written;
 * - temporary files are owner-only, written in full, and removed on failure
 *   (a full disk included);
 * - a settings file that isn't valid UTF-8 is refused, byte for byte intact;
 * - the gallery's precedence line follows Claude Code's order.
 */
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-release-"));
process.env.HOME = home;
process.env.PASEO_HOME = join(home, ".paseo");
delete process.env.AGENT_LINK_HOME;
delete process.env.AGENT_AUTH_HOME;
after(() => rmSync(home, { recursive: true, force: true }));
mkdirSync(join(home, ".codex"), { recursive: true });

const claudePath = join(home, ".claude.json");
const OLD = "Bearer old-token-1111";
const NEW = "Bearer rotated-token-2222";
const write = (headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
  writeFileSync(claudePath, JSON.stringify({ oauthAccount: { emailAddress: "me@example.com" }, mcpServers: { web: { type: "http", url: "https://example.com/mcp", headers } }, ...extra }, null, 2));
const read = () => JSON.parse(readFileSync(claudePath, "utf8"));

const paseo = { config: { get: async () => ({ config: { providers: {} } }), patch: async () => ({}) }, projects: { list: async () => [] } } as never;
const context = { paseo } as never;
const { handleMcpDefAll, handleMcpEditOne, handleMcpRemove } = await import("../server/handlers");
const { handleMcpRawGet, handleMcpRawPut } = await import("../server/mcpjson");
const { readStamped, replaceGuarded } = await import("../server/safe-write");
const { alsoInProjects } = await import("../shared/servers");

const revealedFields = async () => (await handleMcpDefAll({ name: "web", reveal: true }, context)).rows.find((row) => row.found)!;

test("Fields: a key rotated after Reveal is never written back; the save is refused and says why", async () => {
  write({ Authorization: OLD });
  const row = await revealedFields();
  assert.ok(row.version);
  write({ Authorization: NEW }); // rotated by another program
  const result = await handleMcpEditOne(
    { name: "web", destId: claudePath, kind: "http", url: "https://example.com/v2/mcp", kvLines: row.kvLines, version: row.version, changed: { kind: false, command: false, url: true, kvLines: false } },
    context,
  );
  assert.equal(result.ok, false);
  assert.equal(result.message, "This connector changed since you revealed it; reveal again.");
  assert.equal(read().mcpServers.web.headers.Authorization, NEW, "the rotated key stays");
  assert.equal(read().mcpServers.web.url, "https://example.com/mcp", "nothing written");
});

test("Fields: only fields changed since Reveal are written; Claude Code changing other keys doesn't block the save", async () => {
  write({ Authorization: OLD, "X-Team": "a  b" });
  const row = await revealedFields();
  write({ Authorization: OLD, "X-Team": "a  b" }, { numStartups: 9 }); // Claude Code touched something else
  const result = await handleMcpEditOne(
    // The headers text differs (spacing), but the form says it wasn't changed: the stored values are kept as they were.
    { name: "web", destId: claudePath, kind: "http", url: "https://example.com/v2/mcp", kvLines: "Authorization=Bearer old-token-1111\nX-Team=a b", version: row.version, changed: { kind: false, command: false, url: true, kvLines: false } },
    context,
  );
  assert.equal(result.ok, true, result.message);
  assert.equal(read().mcpServers.web.url, "https://example.com/v2/mcp");
  assert.deepEqual(read().mcpServers.web.headers, { Authorization: OLD, "X-Team": "a  b" }, "byte for byte, not re-parsed from the form");
  assert.equal(read().numStartups, 9, "Claude Code's change is kept");
});

test("JSON tab: a key rotated after Reveal is never written back", async () => {
  write({ Authorization: OLD });
  const revealed = (await handleMcpRawGet({ name: "web", reveal: true }, context)).rows.find((row) => row.found)!;
  assert.ok(revealed.version);
  write({ Authorization: NEW });
  const result = await handleMcpRawPut({ name: "web", destId: claudePath, json: revealed.json.replace("/mcp", "/v2/mcp"), dryRun: false, version: revealed.version }, context);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.message === "This connector changed since you revealed it; reveal again."), JSON.stringify(result.issues));
  assert.equal(read().mcpServers.web.headers.Authorization, NEW);
  const fresh = (await handleMcpRawGet({ name: "web", reveal: true }, context)).rows.find((row) => row.found)!;
  const ok = await handleMcpRawPut({ name: "web", destId: claudePath, json: fresh.json.replace("/mcp", "/v2/mcp"), dryRun: false, version: fresh.version }, context);
  assert.equal(ok.ok, true, ok.message);
  assert.equal(read().mcpServers.web.headers.Authorization, NEW, "revealed again, the rotated key is what's saved");
});

// ----------------------------------------------------------------------- temp files

const temps = () => readdirSync(home).filter((name) => name.endsWith(".tmp"));

test("temporary files are created owner-only (0600) and written in full even when a write is short", () => {
  write({ Authorization: OLD });
  const realOpen = fs.openSync;
  const realWrite = fs.writeSync;
  const modes: number[] = [];
  fs.openSync = ((path: fs.PathLike, flags: number, mode?: number) => {
    if (String(path).endsWith(".tmp")) modes.push(mode ?? -1);
    return realOpen(path, flags, mode);
  }) as typeof fs.openSync;
  // At most 3 bytes per call, as a slow or interrupted write can return.
  fs.writeSync = ((fd: number, buffer: Buffer, offset?: number, length?: number) => {
    const start = offset ?? 0;
    return realWrite(fd, buffer, start, Math.min(3, length ?? buffer.length - start));
  }) as typeof fs.writeSync;
  syncBuiltinESMExports();
  try {
    const { stamp } = readStamped(claudePath);
    const text = JSON.stringify({ written: "in full", padding: "x".repeat(200) });
    replaceGuarded(claudePath, text, stamp);
    assert.equal(readFileSync(claudePath, "utf8"), text);
  } finally {
    fs.openSync = realOpen;
    fs.writeSync = realWrite;
    syncBuiltinESMExports();
  }
  assert.deepEqual(modes, [0o600]);
  assert.deepEqual(temps(), []);
});

test("a full disk (ENOSPC) writes nothing: the file is byte-identical and no temporary file is left", () => {
  write({ Authorization: OLD });
  const before = readFileSync(claudePath);
  const realWrite = fs.writeSync;
  fs.writeSync = (() => {
    throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  }) as typeof fs.writeSync;
  syncBuiltinESMExports();
  try {
    const { stamp } = readStamped(claudePath);
    assert.throws(() => replaceGuarded(claudePath, '{"never":true}', stamp), /ENOSPC/);
  } finally {
    fs.writeSync = realWrite;
    syncBuiltinESMExports();
  }
  assert.ok(readFileSync(claudePath).equals(before));
  assert.deepEqual(temps(), []);
});

// ----------------------------------------------------------------------- bytes

test("a settings file that isn't valid UTF-8 is refused and left byte for byte", async () => {
  const bytes = Buffer.concat([Buffer.from('{"mcpServers":{"web":{"type":"http","url":"https://example.com/mcp","note":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}}}')]);
  writeFileSync(claudePath, bytes);
  assert.throws(() => readStamped(claudePath), /isn't valid UTF-8 text, so it wasn't changed/);
  const result = await handleMcpRemove({ name: "web", targets: [claudePath], projectFiles: [] }, context);
  assert.equal(result.ok, false);
  assert.match(result.skipped.join(), /isn't valid UTF-8 text/);
  assert.ok(readFileSync(claudePath).equals(bytes), "never round-tripped through U+FFFD");
});

test("the stamp hashes the file's bytes, so a byte-level change is seen", () => {
  writeFileSync(claudePath, '{"a":"\u00e9"}');
  const a = readStamped(claudePath).stamp;
  writeFileSync(claudePath, '{"a":"e\u0301"}'); // e + combining accent: looks the same, different bytes
  const b = readStamped(claudePath).stamp;
  assert.notEqual(a.hash, b.hash);
});

// ----------------------------------------------------------------------- wording

test("the gallery's precedence line follows Claude Code's order: just for you, then the project, then everywhere", () => {
  assert.equal(alsoInProjects(["data-glue"]), "Also in data-glue · .mcp.json; Claude Code uses that project's own copy there.");
  assert.equal(alsoInProjects(["data-glue"], ["data-glue"]), 'Also in data-glue · .mcp.json; there Claude Code uses your own "just for you" copy first, then the project\'s.');
  assert.equal(alsoInProjects(["a", "b"], ["b"]), 'Also in 2 projects\' .mcp.json; in each, Claude Code uses your own "just for you" copy if you have one there, then the project\'s.');
  assert.equal(alsoInProjects(["data-glue"], ["elsewhere"]), "Also in data-glue · .mcp.json; Claude Code uses that project's own copy there.");
});
