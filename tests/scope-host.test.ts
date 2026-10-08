/**
 * 0.20.0, against a sandbox HOME: each app's scopes are found where the app
 * keeps them, and the workspace panel's list says which level each connector
 * comes from and which copy wins.
 * - Claude: ~/.claude.json's top level (Everywhere), its entry for this
 *   project (just for you), and the project's .mcp.json (This project).
 * - Codex: ~/.codex/config.toml (Everywhere); the project's .mcp.json only
 *   when the plugin adds it to new agents.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-scope-"));
const project = join(home, "code", "data-glue");
process.env.HOME = home;
process.env.PASEO_HOME = join(home, ".paseo");
delete process.env.AGENT_LINK_HOME;
delete process.env.AGENT_AUTH_HOME;
after(() => rmSync(home, { recursive: true, force: true }));

const DEAD = "http://127.0.0.1:9/mcp";
mkdirSync(project, { recursive: true });
mkdirSync(join(home, ".codex"), { recursive: true });
writeFileSync(
  join(home, ".claude.json"),
  JSON.stringify({
    oauthAccount: { emailAddress: "me@example.com" },
    mcpServers: { acme: { type: "http", url: DEAD }, docs: { type: "http", url: DEAD } },
    projects: { [project]: { mcpServers: { solo: { type: "http", url: DEAD } } } },
  }),
);
writeFileSync(join(home, ".codex", "config.toml"), `[mcp_servers.acme]\nurl = "${DEAD}"\n`);
writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { acme: { type: "http", url: DEAD }, team: { type: "http", url: DEAD } } }));

const paseo = {
  config: { get: async () => ({ config: { providers: {} } }), patch: async () => ({}) },
  workspaces: { list: async () => ({ entries: [{ id: "ws", name: "data-glue", workspaceDirectory: project, projectRootPath: project }] }) },
  projects: { list: async () => ({ entries: [{ name: "data-glue", path: project }] }) },
} as never;
const context = { paseo } as never;

const { handleMcpAgentServers } = await import("../server/enabled");
const { sourceLabel, scopeLabel, shadowLine, homeRelative } = await import("../shared/scope");

test("Claude: everywhere, just for you and this project, each from its own file; the project's copy wins over everywhere", async () => {
  const read = await handleMcpAgentServers({ workspaceId: "ws", providerId: "claude" }, context, { probe: false });
  const byName = Object.fromEntries(read.servers.map((entry) => [entry.name, entry]));
  assert.equal(byName.docs.scope, "user");
  assert.equal(byName.solo.scope, "local");
  assert.equal(byName.team.scope, "project");
  assert.equal(byName.acme.scope, "project", "Claude Code: project beats user");
  assert.deepEqual(byName.acme.shadows, ["user"]);
  assert.equal(scopeLabel(byName.acme.scope, "data-glue"), "This project · data-glue");
  assert.equal(sourceLabel(byName.acme.scope, byName.acme.configPath), "data-glue · .mcp.json");
  assert.equal(sourceLabel(byName.docs.scope, byName.docs.configPath), "Claude Code settings");
  assert.equal(sourceLabel(byName.solo.scope, byName.solo.configPath), "Claude Code · just for you");
  assert.equal(byName.solo.enabled.writable, false, "Claude's just-for-you copy is read only here");
  assert.match(byName.solo.enabled.reason, /claude mcp remove solo -s local/);
  assert.equal(shadowLine(byName.acme.scope, byName.acme.shadows ?? [], "claude"), "Also set up everywhere; this project's copy is used here.");
  assert.equal(read.home, home);
  assert.equal(homeRelative(byName.docs.configPath, read.home ?? ""), "~/.claude.json");
});

test("Codex: only its own settings unless the plugin adds .mcp.json; no shadow claimed then", async () => {
  const read = await handleMcpAgentServers({ workspaceId: "ws", providerId: "codex" }, context, { probe: false });
  assert.deepEqual(read.servers.map((entry) => [entry.name, entry.scope]), [["acme", "user"]]);
  assert.equal(read.servers[0].shadows, undefined);
  assert.equal(sourceLabel("user", read.servers[0].configPath), "Codex settings");
});
