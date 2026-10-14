/**
 * 0.20.1, the dev-stack layout behind "Claude never got my connectors": the
 * daemon runs with CLAUDE_CONFIG_DIR=~/.claude, so Claude Code reads
 * ~/.claude/.claude.json and never ~/.claude.json. The primary Claude
 * destination, its sign-in account, a "bring your own app" write and a sign-in
 * started from the page must all use the file Claude reads.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-claude-config-dir-"));
const claudeDir = join(home, ".claude");
mkdirSync(claudeDir, { recursive: true });
// What an older plugin wrote, where this Claude never looks:
writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { stray: { type: "http", url: "https://stray.example/mcp" } } }));
// What Claude actually reads:
writeFileSync(join(claudeDir, ".claude.json"), JSON.stringify({ numStartups: 3, mcpServers: { real: { type: "http", url: "https://real.example/mcp" } } }));
writeFileSync(join(claudeDir, "mcp-needs-auth-cache.json"), JSON.stringify({ real: { timestamp: 1 } }));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.PASEO_HOME = join(home, ".paseo");
process.env.PATH = "/usr/bin:/bin";
delete process.env.AGENT_LINK_HOME;
delete process.env.AGENT_AUTH_HOME;

const { buildDestinations, claudePrimaryConfig, claudePrimaryDir, collectAccounts, destRead } = await import("../server/handlers");
const { accountEnvironment } = await import("../server/mcpjson");
const { loginCommand } = await import("../shared/accounts");
const { claudeAccountDir } = await import("../server/byo-oauth");

test("the primary Claude destination is the file Claude reads, not ~/.claude.json", async () => {
  assert.equal(claudePrimaryDir(), claudeDir);
  assert.equal(claudePrimaryConfig(), join(claudeDir, ".claude.json"));
  const claude = (await buildDestinations(null)).find((dest) => dest.provider === "claude");
  assert.ok(claude);
  assert.equal(claude!.configPath, join(claudeDir, ".claude.json"));
  assert.deepEqual(Object.keys(destRead(claude!)), ["real"], "the stray file is not what Claude loads");
  assert.equal(claude!.label, "Claude", "no account email: no '· primary (primary)'");
});

test("its sign-in account reads that folder, and a sign-in or a 'bring your own app' write keeps CLAUDE_CONFIG_DIR", () => {
  const account = collectAccounts({ askCodex: false }).find((entry) => entry.provider === "claude");
  assert.equal(account?.dir, claudeDir);
  assert.equal(account?.configDirEnv, claudeDir);
  assert.equal(loginCommand(account!, "real"), `CLAUDE_CONFIG_DIR='${claudeDir}' claude mcp login 'real'`, "the terminal fallback signs into the file Claude reads");
  assert.equal(account?.authStatus.real, "not-connected");
  assert.equal(accountEnvironment("claude", "").env.CLAUDE_CONFIG_DIR, claudeDir);
  assert.equal(accountEnvironment("claude", claudeDir).env.CLAUDE_CONFIG_DIR, claudeDir);
  const other = join(home, ".claude-accounts", "work");
  assert.equal(accountEnvironment("claude", other).env.CLAUDE_CONFIG_DIR, other, "an extra account still gets its own");
  assert.equal(claudeAccountDir({ configPath: join(claudeDir, ".claude.json") }), claudeDir);
});

test("with CLAUDE_CONFIG_DIR unset, everything is ~/.claude.json as before", () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    assert.equal(claudePrimaryConfig(), join(home, ".claude.json"));
    assert.equal(claudePrimaryDir(), join(home, ".claude"));
    assert.equal(claudeAccountDir({ configPath: join(home, ".claude.json") }), "");
    assert.equal(accountEnvironment("claude", "").env.CLAUDE_CONFIG_DIR, undefined);
  } finally {
    process.env.CLAUDE_CONFIG_DIR = saved;
  }
});
