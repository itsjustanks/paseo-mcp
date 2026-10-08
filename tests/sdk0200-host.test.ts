/**
 * 0.20.0, against a sandbox HOME:
 * - the hand editor's "What this destination will hold" preview showed the
 *   real keys, because masks are restored before the write is planned. The
 *   preview now stays masked; the file still gets the key;
 * - TOML lines kept as written (an `[mcp_servers.x.oauth]` table with a
 *   `client_secret`) reached the preview unmasked through a dry run;
 * - a failed `mcp logout` returned the CLI's output, token and all.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-sdk0200-"));
process.env.HOME = home;
process.env.PASEO_HOME = join(home, ".paseo");
delete process.env.AGENT_LINK_HOME;
delete process.env.AGENT_AUTH_HOME;
after(() => rmSync(home, { recursive: true, force: true }));

const claudePath = join(home, ".claude.json");
const TOKEN = "test-token-0123456789abcdef";
const ARG_SECRET = "short-lived-credential";
writeFileSync(
  claudePath,
  JSON.stringify({
    oauthAccount: { emailAddress: "me@example.com" },
    mcpServers: {
      acme: { type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: `Bearer ${TOKEN}` } },
      // The review's probe: a flag and its value as two items of `args`.
      local: { type: "stdio", command: "npx", args: ["-y", "local-mcp", "--api-key", ARG_SECRET, "--port", "3000"], env: { MODE: "dev" } },
    },
  }),
);

// Codex keeps an OAuth client secret in a subtable this plugin carries as written.
const codexPath = join(home, ".codex", "config.toml");
const CLIENT_SECRET = "oauth-client-secret-9f8e7d6c5b4a";
mkdirSync(join(home, ".codex"), { recursive: true });
writeFileSync(
  codexPath,
  ["[mcp_servers.acme]", 'url = "http://127.0.0.1:9/mcp"', "", "[mcp_servers.acme.oauth]", 'client_id = "acme-client"', `client_secret = "${CLIENT_SECRET}"`, ""].join("\n"),
);

// A fake `claude` first on the PATH: its logout fails and prints a token, as a real CLI might.
const bin = join(home, "bin");
const LOGOUT_TOKEN = "sk-live-0123456789abcdefLOGOUT";
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "refreshing with Bearer ${LOGOUT_TOKEN}" >&2\necho "error: refresh_token=${LOGOUT_TOKEN} was rejected" >&2\nexit 3\n`);
chmodSync(join(bin, "claude"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;

const { cliPath, handleMcpLogout, handleMcpRawGet, handleMcpRawPut } = await import("../server/mcpjson");
const context = { paseo: { config: { get: async () => ({ config: { providers: {} } }), patch: async () => ({}) }, projects: { list: async () => [] } } } as never;

test("the editor's preview keeps keys masked, and saving still writes the real key", async () => {
  const read = await handleMcpRawGet({ name: "acme", reveal: false }, context);
  const row = read.rows.find((entry) => entry.found);
  assert.ok(row, "the Claude config has acme");
  assert.ok(!row.json.includes(TOKEN), "the editor starts masked");

  const dry = await handleMcpRawPut({ name: "acme", destId: row.destId, json: row.json.replace("127.0.0.1:9", "127.0.0.1:10"), dryRun: true }, context);
  assert.equal(dry.ok, true, dry.message);
  assert.ok(dry.preview.includes("127.0.0.1:10"), "the preview shows the change");
  assert.ok(!dry.preview.includes(TOKEN), "no key in the preview");

  const saved = await handleMcpRawPut({ name: "acme", destId: row.destId, json: row.json.replace("127.0.0.1:9", "127.0.0.1:10"), dryRun: false }, context);
  assert.equal(saved.ok, true, saved.message);
  assert.ok(!saved.preview.includes(TOKEN), "no key in the saved preview either");
  const file = JSON.parse(readFileSync(claudePath, "utf8")) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> };
  assert.equal(file.mcpServers.acme.url, "http://127.0.0.1:10/mcp");
  assert.equal(file.mcpServers.acme.headers.Authorization, `Bearer ${TOKEN}`, "the real key is kept in the file");
});

test("an OAuth client_secret kept as written in a TOML subtable stays masked through a dry run, and the file keeps it", async () => {
  const read = await handleMcpRawGet({ name: "acme", reveal: false }, context);
  const row = read.rows.find((entry) => entry.found && entry.dialect === "codex-toml");
  assert.ok(row, "the Codex config has acme");
  assert.ok(!row.nativePreview.includes(CLIENT_SECRET), "not in the saved config as shown");

  const edited = row.json.replace("127.0.0.1:9", "127.0.0.1:11");
  const dry = await handleMcpRawPut({ name: "acme", destId: row.destId, json: edited, dryRun: true }, context);
  assert.equal(dry.ok, true, dry.message);
  assert.ok(dry.preview.includes("127.0.0.1:11"), "the preview shows the change");
  assert.match(dry.preview, /\[mcp_servers\.acme\.oauth\]/, "the kept table is in the preview");
  assert.ok(!dry.preview.includes(CLIENT_SECRET), `no client secret in the dry run's preview:\n${dry.preview}`);

  const saved = await handleMcpRawPut({ name: "acme", destId: row.destId, json: edited, dryRun: false }, context);
  assert.equal(saved.ok, true, saved.message);
  assert.ok(!saved.preview.includes(CLIENT_SECRET));
  const file = readFileSync(codexPath, "utf8");
  assert.ok(file.includes(`client_secret = "${CLIENT_SECRET}"`), "the write keeps the real secret");
  assert.ok(file.includes("127.0.0.1:11"));
});

test("a failed sign-out says so in a fixed sentence; the CLI's token never comes back", async () => {
  assert.equal(cliPath("claude"), join(bin, "claude"), "the fake CLI, never a real one");
  const result = await handleMcpLogout({ provider: "claude", accountDir: "", server: "acme" }, context);
  assert.equal(result.ok, false);
  assert.equal(result.message, "Couldn't sign out of 'acme' (claude mcp logout stopped with code 3). Run it in a terminal to see why.", "a fixed sentence, nothing the CLI printed");
  assert.ok(!result.message.includes(LOGOUT_TOKEN));
});

test("a secret flag's value in args stays out of the hidden-keys view and the copyable preview", async () => {
  const read = await handleMcpRawGet({ name: "local", reveal: false }, context);
  const row = read.rows.find((entry) => entry.found);
  assert.ok(row, "the Claude config has local");
  assert.ok(!row.json.includes(ARG_SECRET), `not in the read-only JSON:\n${row.json}`);
  assert.ok(!row.nativePreview.includes(ARG_SECRET), "not in the saved config as shown");
  assert.match(row.json, /"--api-key",\s*"•••"/);
  assert.match(row.json, /"--port",\s*"3000"/, "other arguments stay readable");

  const revealed = await handleMcpRawGet({ name: "local", reveal: true }, context);
  const raw = revealed.rows.find((entry) => entry.destId === row.destId)?.json ?? "";
  const dry = await handleMcpRawPut({ name: "local", destId: row.destId, json: raw.replace('"3000"', '"3001"'), dryRun: true }, context);
  assert.equal(dry.ok, true, dry.message);
  assert.ok(dry.preview.includes("3001"));
  assert.ok(!dry.preview.includes(ARG_SECRET), `not in the dry run's preview either:\n${dry.preview}`);
});

test("Reveal to edit, then Save, writes the real values: the editor's revealed text, never the masked one", async () => {
  const masked = (await handleMcpRawGet({ name: "local", reveal: false }, context)).rows.find((entry) => entry.found);
  const revealed = (await handleMcpRawGet({ name: "local", reveal: true }, context)).rows.find((entry) => entry.found);
  assert.ok(masked && revealed);
  assert.ok(revealed.json.includes(ARG_SECRET), "Reveal loads the real definition");
  const saved = await handleMcpRawPut({ name: "local", destId: revealed.destId, json: revealed.json.replace('"3000"', '"3002"'), dryRun: false }, context);
  assert.equal(saved.ok, true, saved.message);
  const file = JSON.parse(readFileSync(claudePath, "utf8")) as { mcpServers: Record<string, { args: string[] }> };
  assert.deepEqual(file.mcpServers.local.args, ["-y", "local-mcp", "--api-key", ARG_SECRET, "--port", "3002"], "the real key, and the edit");
});
