/**
 * No spawn loop: the panel RPCs read files, and Codex runs only in the
 * background, once per account, until something changes. Runs the real
 * handlers against a sandbox HOME with a fake `codex` that logs each run.
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-nospawn-"));
const project = join(home, "code", "demo");
const codexLog = join(home, "codex-runs.log");
mkdirSync(project, { recursive: true });
mkdirSync(join(home, ".local", "bin"), { recursive: true });
mkdirSync(join(home, ".codex"), { recursive: true });
writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@example.com" }, mcpServers: { docs: { type: "http", url: "http://localhost:9/mcp" } }, projects: {} }));
writeFileSync(join(home, ".codex", "config.toml"), '[mcp_servers.docs]\nurl = "http://localhost:9/mcp"\n');
const idToken = `x.${Buffer.from(JSON.stringify({ email: "me@example.com" })).toString("base64url")}.y`;
writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { id_token: idToken } }));
for (const email of ["one@example.com", "two@example.com"]) {
  const dir = join(home, ".agent-link", "accounts", "codex", email);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), '[mcp_servers.docs]\nurl = "http://localhost:9/mcp"\n');
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { id_token: idToken } }));
}
writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { tool: { command: "node", args: [] } } }));
writeFileSync(
  join(home, ".local", "bin", "codex"),
  `#!/bin/sh\necho "$CODEX_HOME" >> "${codexLog}"\necho "WARNING: failed to clean up stale arg0 temp dirs: Permission denied (os error 13)" >&2\necho '[{"name":"docs","auth_status":"not_logged_in"}]'\n`,
);
chmodSync(join(home, ".local", "bin", "codex"), 0o755);
process.env.HOME = home;
process.env.PASEO_HOME = join(home, ".paseo");
// The live Paseo tool list asks the daemon's own endpoint; point it at a closed port.
process.env.PASEO_LISTEN = "127.0.0.1:9";
process.env.PATH = "/usr/bin:/bin";
delete process.env.AGENT_LINK_HOME;
delete process.env.AGENT_AUTH_HOME;

// Count every process the handlers start.
const spawned: string[] = [];
const mutable = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>;
for (const method of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"]) {
  const original = mutable[method]!;
  mutable[method] = (...args: unknown[]) => {
    spawned.push(basename(String(args[0])));
    return original.apply(childProcess, args);
  };
}
syncBuiltinESMExports();

const { handleMcpAuth, handleMcpMatrix } = await import("../server/handlers");
const { handleMcpWorkspace } = await import("../server/workspace");
const { handleMcpAgentServers } = await import("../server/enabled");
const { handleMcpHealthCached } = await import("../server/health");
const { handleMcpToolsCached } = await import("../server/tools");
const { handleMcpSiblings } = await import("../server/siblings");
const { handleMcpPaseoTools, handleMcpSetPaseoTools } = await import("../server/paseo-tools");
const { codexChecksSettled } = await import("../server/codex-auth");
const { injectWorkspaceServers } = await import("../server/hooks");

let daemonConfig: Record<string, unknown> = { mcp: { injectIntoAgents: true }, browserTools: { enabled: true }, providers: {} };
const paseo = {
  config: {
    get: async () => ({ config: structuredClone(daemonConfig) }),
    // Enough of the daemon's merge for the one patch shape the plugin sends.
    patch: async (patch: Record<string, unknown>) => {
      daemonConfig = { ...daemonConfig, ...patch };
      return { config: structuredClone(daemonConfig) };
    },
  },
  workspaces: { list: async () => ({ entries: [{ id: "ws", name: "demo", workspaceDirectory: project, projectRootPath: project }] }) },
  projects: { list: async () => ({ entries: [{ name: "demo", path: project }] }) },
} as never;
const context = { paseo };

const codexRuns = () => (existsSync(codexLog) ? readFileSync(codexLog, "utf8").split("\n").filter(Boolean).length : 0);

after(() => rmSync(home, { recursive: true, force: true }));

test("panel reads start no process at all", async () => {
  spawned.length = 0;
  for (let round = 0; round < 10; round += 1) {
    await handleMcpWorkspace({ workspaceId: "ws" }, context);
    await handleMcpAgentServers({ workspaceId: "ws", providerId: "claude" }, context);
    await handleMcpMatrix({} as never, context);
    await handleMcpHealthCached({} as never, context);
    await handleMcpToolsCached({} as never, context);
    handleMcpSiblings();
    await handleMcpPaseoTools({}, context);
  }
  await codexChecksSettled();
  assert.equal(codexRuns(), 0, "no codex from the workspace panel, the Claude agent panel, the matrix, the cached reads or the AI Router card");
  assert.deepEqual(spawned.filter((name) => name !== "ps" && name !== "lsof"), [], `unexpected processes: ${spawned.join(", ")}`);
  // The process scan is shared: ten workspace reads in a row read the table once.
  assert.ok(spawned.filter((name) => name === "ps").length <= 1, `ps ran ${spawned.filter((name) => name === "ps").length} times`);
});

test("the sign-in read asks Codex once per account in the background, then never again until something changes", async () => {
  spawned.length = 0;
  const first = await handleMcpAuth({}, context);
  assert.equal(first.checking, true, "the answer came back before Codex finished");
  await codexChecksSettled();
  assert.equal(codexRuns(), 3, "primary + two slots, once each");
  for (let round = 0; round < 20; round += 1) {
    await handleMcpAuth({}, context);
    await handleMcpAgentServers({ workspaceId: "ws", providerId: "codex" }, context);
  }
  await codexChecksSettled();
  assert.equal(codexRuns(), 3, "forty more reads, no new Codex run");
  const settled = await handleMcpAuth({}, context);
  const primary = settled.accounts.find((account) => account.provider === "codex" && account.isPrimary);
  assert.equal(primary?.authStatus.docs, "not-connected");
  assert.equal(settled.checking, false);
});

test("Refresh asks Codex again, once per account", async () => {
  const before = codexRuns();
  await handleMcpAuth({ refresh: true }, context);
  await handleMcpAuth({ refresh: true }, context);
  await codexChecksSettled();
  assert.equal(codexRuns() - before, 3, "a second press while the first check runs does not queue another");
});

test("Paseo tools read and write start no process", async () => {
  spawned.length = 0;
  for (let round = 0; round < 5; round += 1) {
    await handleMcpPaseoTools({ refresh: true }, context);
    const off = await handleMcpSetPaseoTools({ browserTools: false }, context);
    assert.equal(off.ok, true, off.message);
    const on = await handleMcpSetPaseoTools({ browserTools: true }, context);
    assert.equal(on.ok, true, on.message);
  }
  const workspace = await handleMcpWorkspace({ workspaceId: "ws" }, context);
  assert.equal(workspace.paseoTools?.tools.claude, 61, "the workspace load counts Paseo tools");
  assert.deepEqual(spawned.filter((name) => name !== "ps" && name !== "lsof"), [], `unexpected processes: ${spawned.join(", ")}`);
});

test("creating an agent reads .mcp.json without starting git", async () => {
  mkdirSync(join(process.env.PASEO_HOME!, "plugin-settings", "paseo-mcp"), { recursive: true });
  writeFileSync(
    join(process.env.PASEO_HOME!, "plugin-settings", "paseo-mcp", "injection.json"),
    JSON.stringify({ version: 1, values: { injectWorkspaceServers: true, providers: ["codex"], skipInlineCredentialServers: true } }),
  );
  spawned.length = 0;
  const request = { config: { provider: "codex", cwd: project, mcpServers: {} } } as never;
  const result = injectWorkspaceServers(request) as { config: { mcpServers: Record<string, unknown> } };
  assert.deepEqual(Object.keys(result.config.mcpServers), ["tool"]);
  assert.deepEqual(spawned, []);
});
