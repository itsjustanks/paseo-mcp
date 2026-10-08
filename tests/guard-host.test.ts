/**
 * 0.20.0: compare-before-replace for every settings file another program
 * writes too (~/.claude.json, a project's .mcp.json, Codex's config.toml).
 * Against a sandbox HOME, with a "concurrent writer" simulated between the
 * plugin's temporary write and its rename (replaceHooks), and a corrupted
 * write simulated right after the rename.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, afterEach } from "node:test";

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-guard-"));
const project = join(home, "code", "data-glue");
process.env.HOME = home;
process.env.PASEO_HOME = join(home, ".paseo");
delete process.env.AGENT_LINK_HOME;
delete process.env.AGENT_AUTH_HOME;
after(() => rmSync(home, { recursive: true, force: true }));
mkdirSync(project, { recursive: true });
mkdirSync(join(home, ".codex"), { recursive: true });

const claudePath = join(home, ".claude.json");
const codexPath = join(home, ".codex", "config.toml");
const projectFile = join(project, ".mcp.json");
const CLAUDE = { oauthAccount: { emailAddress: "me@example.com" }, mcpServers: { acme: { type: "http", url: "http://127.0.0.1:9/mcp" } }, projects: { [project]: { disabledMcpServers: [] } }, numStartups: 3 };
const reset = () => {
  writeFileSync(claudePath, JSON.stringify(CLAUDE, null, 2));
  writeFileSync(codexPath, '[mcp_servers.acme]\nurl = "http://127.0.0.1:9/mcp"\n');
  writeFileSync(projectFile, JSON.stringify({ mcpServers: { acme: { type: "http", url: "http://127.0.0.1:9/mcp" } } }, null, 2));
};
reset();

const paseo = {
  config: { get: async () => ({ config: { providers: {} } }), patch: async () => ({}) },
  projects: { list: async () => [{ name: "data-glue", path: project }] },
} as never;
const context = { paseo } as never;
const guard = await import("../server/safe-write");
const { ConcurrentChangeError, readStamped, replaceGuarded, replaceHooks } = guard;
const { backupFile, handleMcpRemove, handleMcpSync, removeFromProjectFile } = await import("../server/handlers");
const { writeClaudeEnabled } = await import("../server/enabled");
const { handleMcpRawGet, handleMcpRawPut } = await import("../server/mcpjson");
afterEach(() => {
  replaceHooks.beforeRename = undefined;
  replaceHooks.afterRename = undefined;
  reset();
});
const tempFilesIn = (dir: string) => readdirSync(dir).filter((name) => name.endsWith(".tmp"));
/** Another program's write: a new file renamed into place, as Claude Code does. */
const otherWriter = (path: string, text: string) => {
  writeFileSync(`${path}.other`, text);
  renameSync(`${path}.other`, path);
};

// ----------------------------------------------------------------- the guard itself

test("the normal path replaces the file, keeps its permissions and leaves no temporary file", () => {
  chmodSync(claudePath, 0o640);
  const { stamp } = readStamped(claudePath);
  replaceGuarded(claudePath, '{"a":1}\n', stamp, { backup: backupFile(claudePath) });
  assert.equal(readFileSync(claudePath, "utf8"), '{"a":1}\n');
  assert.equal(statSync(claudePath).mode & 0o777, 0o640);
  assert.deepEqual(tempFilesIn(home), []);
});

test("a change between read and rename aborts: nothing written, the other program's file byte for byte, a retryable error", () => {
  const { stamp } = readStamped(claudePath);
  const theirs = JSON.stringify({ ...CLAUDE, numStartups: 4 }, null, 2);
  replaceHooks.beforeRename = (path) => otherWriter(path, theirs);
  assert.throws(
    () => replaceGuarded(claudePath, '{"mine":true}\n', stamp, { backup: backupFile(claudePath) }),
    (error: unknown) => error instanceof ConcurrentChangeError && error.retryable && error.message === "Claude Code changed its settings file while saving. Nothing was changed; try again.",
  );
  assert.equal(readFileSync(claudePath, "utf8"), theirs);
  assert.deepEqual(tempFilesIn(home), [], "the temporary file is deleted");
});

test("even a touch with the same content aborts (mtime is part of the stamp), and so does an in-place edit", () => {
  const { stamp } = readStamped(claudePath);
  replaceHooks.beforeRename = (path) => utimesSync(path, new Date(), new Date(Date.now() + 5000));
  assert.throws(() => replaceGuarded(claudePath, "{}", stamp), ConcurrentChangeError);
  const fresh = readStamped(claudePath).stamp;
  replaceHooks.beforeRename = (path) => writeFileSync(path, readFileSync(path, "utf8").replace('"numStartups": 3', '"numStartups": 9'));
  assert.throws(() => replaceGuarded(claudePath, "{}", fresh), ConcurrentChangeError);
});

test("a read-back that doesn't match writes nothing more: no rollback, the backup kept and named", () => {
  const { stamp } = readStamped(claudePath);
  const backup = backupFile(claudePath);
  assert.ok(backup);
  // Changed in place right after the rename (same inode): it could be Claude Code, so it is left as it is.
  replaceHooks.afterRename = (path) => writeFileSync(path, '{"claude":"in place"}');
  assert.throws(
    () => replaceGuarded(claudePath, '{"mine":true}\n', stamp, { backup }),
    (error: unknown) =>
      error instanceof ConcurrentChangeError &&
      /^The file changed right after saving \(probably Claude Code\)\. Your change may not be in it; check and try again\. A backup from before is at ~\/\.claude\.json\.bak-paseo-mcp-/.test((error as Error).message),
  );
  assert.equal(readFileSync(claudePath, "utf8"), '{"claude":"in place"}', "the newer in-place write is not overwritten");
  assert.ok(readdirSync(home).includes(backup.split("/").pop()!), "the backup is kept");
});

test("a program that replaces the file right after the rename keeps its version (never clobbered by a restore)", () => {
  const { stamp } = readStamped(claudePath);
  const theirs = '{"claude":"newer"}';
  replaceHooks.afterRename = (path) => otherWriter(path, theirs);
  assert.throws(() => replaceGuarded(claudePath, '{"mine":true}\n', stamp, { backup: backupFile(claudePath) }), (error: unknown) => error instanceof ConcurrentChangeError && /right after saving/.test((error as Error).message));
  assert.equal(readFileSync(claudePath, "utf8"), theirs);
});

// ------------------------------------------------------------ every writer of these files

const theirsClaude = JSON.stringify({ ...CLAUDE, numStartups: 42 }, null, 2);

test("~/.claude.json via Remove (jsonMcpWriteMany): aborted and byte-identical; the normal path still removes", async () => {
  replaceHooks.beforeRename = (path) => path === claudePath && otherWriter(path, theirsClaude);
  const raced = await handleMcpRemove({ name: "acme", targets: [claudePath], projectFiles: [] }, context);
  assert.equal(raced.ok, false);
  assert.match(raced.skipped.join(), /Claude Code changed its settings file while saving\. Nothing was changed; try again\./);
  assert.equal(readFileSync(claudePath, "utf8"), theirsClaude);
  replaceHooks.beforeRename = undefined;
  const fine = await handleMcpRemove({ name: "acme", targets: [claudePath], projectFiles: [] }, context);
  assert.equal(fine.ok, true, fine.message);
  assert.equal(JSON.parse(readFileSync(claudePath, "utf8")).mcpServers.acme, undefined);
});

test("~/.claude.json via a per-project switch (writeClaudeEnabled): aborted and byte-identical", () => {
  replaceHooks.beforeRename = (path) => otherWriter(path, theirsClaude);
  assert.throws(() => writeClaudeEnabled(claudePath, project, "disabledMcpServers", "acme", false), ConcurrentChangeError);
  assert.equal(readFileSync(claudePath, "utf8"), theirsClaude);
  replaceHooks.beforeRename = undefined;
  reset();
  assert.equal(writeClaudeEnabled(claudePath, project, "disabledMcpServers", "acme", false).state, "disabled", "the normal path still works");
});

test("~/.claude.json via the hand editor (planWrites): a change after the plan aborts the save", async () => {
  const revealed = (await handleMcpRawGet({ name: "acme", reveal: true }, context)).rows.find((row) => row.destId === claudePath);
  assert.ok(revealed?.found);
  replaceHooks.beforeRename = (path) => path === claudePath && otherWriter(path, theirsClaude);
  const raced = await handleMcpRawPut({ name: "acme", destId: claudePath, json: revealed.json.replace("127.0.0.1:9", "127.0.0.1:10"), dryRun: false }, context);
  assert.equal(raced.ok, false);
  assert.match(raced.message, /Claude Code changed its settings file while saving/);
  assert.equal(readFileSync(claudePath, "utf8"), theirsClaude);
});

test("Claude account copies via Sync (handleMcpSync): a raced slot is skipped and left byte-identical", async () => {
  const slotDir = join(home, ".claude-accounts", "work@example.com");
  mkdirSync(slotDir, { recursive: true });
  const slotPath = join(slotDir, ".claude.json");
  const slot = JSON.stringify({ oauthAccount: { emailAddress: "work@example.com" }, mcpServers: {} }, null, 2);
  writeFileSync(slotPath, slot);
  const theirsSlot = JSON.stringify({ oauthAccount: { emailAddress: "work@example.com" }, mcpServers: {}, numStartups: 7 }, null, 2);
  replaceHooks.beforeRename = (path) => path === slotPath && otherWriter(path, theirsSlot);
  const result = await handleMcpSync();
  assert.match(result.log, /work@example\.com: SKIPPED — Claude Code changed its settings file while saving\. Nothing was changed; try again\./);
  assert.equal(readFileSync(slotPath, "utf8"), theirsSlot);
});

test("a project's .mcp.json (editProjectFile): aborted and byte-identical", () => {
  const theirs = JSON.stringify({ mcpServers: { acme: { type: "http", url: "http://127.0.0.1:9/mcp" }, team: { command: "x" } } }, null, 2);
  replaceHooks.beforeRename = (path) => otherWriter(path, theirs);
  assert.throws(() => removeFromProjectFile(projectFile, "acme"), /\.mcp\.json was changed while saving\. Nothing was changed; try again\./);
  assert.equal(readFileSync(projectFile, "utf8"), theirs);
  replaceHooks.beforeRename = undefined;
  assert.equal(removeFromProjectFile(projectFile, "acme"), "removed", "the normal path still works");
});

test("Codex's config.toml (writeTomlChecked): aborted and byte-identical", async () => {
  const theirs = '[mcp_servers.acme]\nurl = "http://127.0.0.1:9/mcp"\n\n[mcp_servers.other]\nurl = "http://127.0.0.1:9/b"\n';
  replaceHooks.beforeRename = (path) => path === codexPath && otherWriter(path, theirs);
  const raced = await handleMcpRemove({ name: "acme", targets: [codexPath], projectFiles: [] }, context);
  assert.equal(raced.ok, false);
  assert.match(raced.skipped.join(), /Codex changed its settings file while saving\. Nothing was changed; try again\./);
  assert.equal(readFileSync(codexPath, "utf8"), theirs);
});
