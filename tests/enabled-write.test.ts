import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectKeyFor, readClaudeConfig, writeClaudeEnabled } from "../server/enabled";

/**
 * The write path against a copy of a real-shaped `~/.claude.json` in a temp
 * directory. The live file is never touched: every test builds its own file
 * under a fresh mkdtemp and removes it afterwards.
 */
const FIXTURE = {
  numStartups: 412,
  installMethod: "native",
  oauthAccount: { emailAddress: "demo@example.com", accountUuid: "abc", organizationUuid: "org" },
  mcpServers: {
    jam: { type: "http", url: "https://mcp.jam.dev/mcp" },
    attio: { type: "http", url: "https://mcp.attio.com/mcp?token=eyJhbGciOiJIUzI1NiJ9.secret.sig" },
  },
  projects: {
    "/home/demo": { allowedTools: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [], hasTrustDialogAccepted: true },
    "/home/demo/projects/data-glue": {
      allowedTools: ["Bash(npm test)"],
      mcpServers: { zapier: { type: "http", url: "https://mcp.zapier.com/x" } },
      enabledMcpjsonServers: [],
      disabledMcpjsonServers: [],
      lastCost: 3.5,
      history: [{ display: "fix the thing", pastedContents: {} }],
    },
  },
  tipsHistory: { "new-user-warmup": 1, "shift-enter": 4 },
  cachedGrowthBookFeatures: { flag: { on: true } },
  userID: "u-1",
};

function withConfig<T>(run: (configPath: string, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "paseo-mcp-enabled-"));
  const configPath = join(dir, ".claude.json");
  writeFileSync(configPath, `${JSON.stringify(FIXTURE, null, 2)}\n`);
  try {
    return run(configPath, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PROJECT = "/home/demo/projects/data-glue";

test("turning a user-level server off writes disabledMcpServers for that directory and nothing else changes", () => {
  withConfig((configPath, dir) => {
    const result = writeClaudeEnabled(configPath, PROJECT, "disabledMcpServers", "jam", false);
    assert.deepEqual(result, { state: "disabled", changed: true });
    const after = readClaudeConfig(configPath);
    assert.deepEqual(after.projects?.[PROJECT]?.disabledMcpServers, ["jam"]);
    // Every other key is byte-for-byte what it was.
    const { projects: afterProjects, ...afterRest } = after;
    const { projects: beforeProjects, ...beforeRest } = FIXTURE as typeof after;
    assert.deepEqual(afterRest, beforeRest);
    assert.deepEqual(afterProjects?.["/home/demo"], beforeProjects?.["/home/demo"]);
    const { disabledMcpServers: _added, ...entry } = afterProjects?.[PROJECT] ?? {};
    assert.deepEqual(entry, beforeProjects?.[PROJECT]);
    // The token in the user-level definition is still there, untouched.
    assert.equal((after.mcpServers as Record<string, { url: string }>).attio.url, FIXTURE.mcpServers.attio.url);
    // A backup was taken first and the temp file is gone.
    const files = readdirSync(dir);
    assert.ok(files.some((file) => file.startsWith(".claude.json.bak-paseo-mcp-")), files.join(", "));
    assert.ok(!files.some((file) => file.endsWith(".tmp-paseo-mcp")));
    assert.equal(readFileSync(configPath, "utf8").endsWith("}\n"), true);
  });
});

test("turning it back on empties the list; a no-op write touches nothing and takes no backup", () => {
  withConfig((configPath, dir) => {
    writeClaudeEnabled(configPath, PROJECT, "disabledMcpServers", "jam", false);
    const on = writeClaudeEnabled(configPath, PROJECT, "disabledMcpServers", "jam", true);
    assert.deepEqual(on, { state: "enabled", changed: true });
    assert.deepEqual(readClaudeConfig(configPath).projects?.[PROJECT]?.disabledMcpServers, []);
    const before = readFileSync(configPath, "utf8");
    const backups = readdirSync(dir).filter((file) => file.includes(".bak-")).length;
    const again = writeClaudeEnabled(configPath, PROJECT, "disabledMcpServers", "jam", true);
    assert.deepEqual(again, { state: "enabled", changed: false });
    assert.equal(readFileSync(configPath, "utf8"), before);
    assert.equal(readdirSync(dir).filter((file) => file.includes(".bak-")).length, backups);
  });
});

test("a worktree directory with no project entry gains a minimal one beside its siblings", () => {
  withConfig((configPath) => {
    const worktree = "/home/demo/.paseo/worktrees/data-glue/feature-x";
    writeClaudeEnabled(configPath, worktree, "disabledMcpServers", "attio", false);
    const after = readClaudeConfig(configPath);
    assert.deepEqual(after.projects?.[worktree], { disabledMcpServers: ["attio"] });
    assert.deepEqual(Object.keys(after.projects ?? {}), [...Object.keys(FIXTURE.projects), worktree]);
    assert.deepEqual(after.projects?.[PROJECT], FIXTURE.projects[PROJECT]);
  });
});

test("project-scope servers go through the mcpjson lists, never disabledMcpServers", () => {
  withConfig((configPath) => {
    assert.deepEqual(writeClaudeEnabled(configPath, PROJECT, "mcpjsonServers", "supabase", false), { state: "disabled", changed: true });
    const entry = readClaudeConfig(configPath).projects?.[PROJECT];
    assert.deepEqual(entry?.disabledMcpjsonServers, ["supabase"]);
    assert.equal("disabledMcpServers" in (entry ?? {}), false);
    assert.deepEqual(writeClaudeEnabled(configPath, PROJECT, "mcpjsonServers", "supabase", true), { state: "enabled", changed: true });
    const next = readClaudeConfig(configPath).projects?.[PROJECT];
    assert.deepEqual(next?.enabledMcpjsonServers, ["supabase"]);
    assert.deepEqual(next?.disabledMcpjsonServers, []);
  });
});

test("an unparseable or missing config is refused, not overwritten", () => {
  withConfig((configPath) => {
    writeFileSync(configPath, "{ not json");
    assert.throws(() => writeClaudeEnabled(configPath, PROJECT, "disabledMcpServers", "jam", false), /not valid JSON/);
    assert.equal(readFileSync(configPath, "utf8"), "{ not json");
    writeFileSync(configPath, "[]");
    assert.throws(() => writeClaudeEnabled(configPath, PROJECT, "disabledMcpServers", "jam", false), /not a JSON object/);
    rmSync(configPath);
    assert.throws(() => writeClaudeEnabled(configPath, PROJECT, "disabledMcpServers", "jam", false), /does not exist/);
    assert.equal(existsSync(configPath), false);
  });
});

test("the project key is the workspace directory, so a worktree gets its own entry", () => {
  assert.equal(projectKeyFor({ workspaceDirectory: "/home/demo/.paseo/worktrees/p/wt", projectRootPath: "/home/demo/projects/p" }), "/home/demo/.paseo/worktrees/p/wt");
  assert.equal(projectKeyFor({ projectRootPath: "/home/demo/projects/p" }), "/home/demo/projects/p");
  assert.equal(projectKeyFor({ workspaceDirectory: "", projectRootPath: "/home/demo/projects/p" }), "/home/demo/projects/p");
});
