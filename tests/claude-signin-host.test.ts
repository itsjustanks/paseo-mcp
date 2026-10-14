/**
 * 0.20.1, the paseo-ankit case: Claude runs through a router, so ~/.claude.json
 * has no Anthropic account, and Supercut is signed in on Codex only. Claude
 * must still be listed for connector sign-in, with Supercut as "needs sign-in",
 * and a Claude sign-in it started but never finished counts as not signed in.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-claude-signin-"));
mkdirSync(join(home, ".claude"), { recursive: true });
mkdirSync(join(home, ".codex"), { recursive: true });
const SUPERCUT = "https://mcp.supercut.ai/mcp";
writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { supercut: { type: "http", url: SUPERCUT }, slashy: { type: "http", url: "https://slashy.example/mcp" }, notion: { type: "http", url: "https://mcp.notion.com/mcp" }, keyed: { type: "http", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer x" } } } }));
writeFileSync(
  join(home, ".claude", ".credentials.json"),
  JSON.stringify({ claudeAiOauth: { accessToken: "", expiresAt: 0 }, mcpOAuth: { "slashy|0001": { serverName: "slashy", serverUrl: "https://slashy.example/mcp", accessToken: "" }, "notion|0002": { serverName: "notion", serverUrl: "https://mcp.notion.com/mcp", accessToken: "GOOD" } } }),
);
writeFileSync(join(home, ".claude", "mcp-needs-auth-cache.json"), JSON.stringify({ sentry: { timestamp: 1 }, notion: { timestamp: 1 } }));
writeFileSync(join(home, ".codex", "config.toml"), `[mcp_servers.supercut]\nurl = "${SUPERCUT}"\n`);
const idToken = `x.${Buffer.from(JSON.stringify({ email: "me@example.com" })).toString("base64url")}.y`;
writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { id_token: idToken } }));
writeFileSync(
  join(home, ".codex", ".credentials.json"),
  JSON.stringify({ "supercut|12db": { server_name: "supercut", server_url: SUPERCUT, client_id: "c", access_token: "T", expires_at: Date.now() + 3_600_000 } }),
);
process.env.HOME = home;
// This test is the "no CLAUDE_CONFIG_DIR" layout: never inherit one from the shell running it.
delete process.env.CLAUDE_CONFIG_DIR;
process.env.PASEO_HOME = join(home, ".paseo");
process.env.PATH = "/usr/bin:/bin";
delete process.env.AGENT_LINK_HOME;
delete process.env.AGENT_AUTH_HOME;

const { collectAccounts } = await import("../server/handlers");

test("Claude with no Anthropic account is still listed, and Supercut (signed in on Codex) needs a Claude sign-in", () => {
  const accounts = collectAccounts({ askCodex: false });
  const claude = accounts.find((account) => account.provider === "claude");
  const codex = accounts.find((account) => account.provider === "codex");
  assert.ok(claude, "a Claude row exists without an email");
  assert.equal(claude!.email, "");
  assert.equal(claude!.isPrimary, true);
  assert.equal(codex?.authStatus.supercut, "connected");
  assert.equal(claude!.authStatus.supercut, "not-connected");
  assert.equal(claude!.authStatus.slashy, "not-connected", "a Claude sign-in that never finished");
  assert.equal(claude!.authStatus.sentry, "not-connected", "Claude's own needs-sign-in list");
  assert.equal(claude!.authStatus.keyed, undefined, "a static key has no sign-in");
  assert.equal(claude!.authStatus.notion, "connected", "signed in since Claude listed it");
  assert.ok(!claude!.needsAuth.includes("notion"), "review fix: a finished sign-in leaves the needs-sign-in list, so cards and the chip stop warning");
  assert.ok(claude!.needsAuth.includes("sentry"));
  assert.equal(claude!.configDirEnv, undefined, "no CLAUDE_CONFIG_DIR here");
  assert.doesNotMatch(JSON.stringify(accounts), /"T"|GOOD|accessToken/);
});

test("the agent panel's one-account read still counts Codex's sign-ins for Claude", () => {
  const only = collectAccounts({ askCodex: false, only: { provider: "claude", email: "" } });
  assert.equal(only.length, 1);
  assert.equal(only[0]!.provider, "claude");
  assert.equal(only[0]!.authStatus.supercut, "not-connected");
});
