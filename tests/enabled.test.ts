import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_INJECTION_STORE,
  assertUnrelatedKeysKept,
  injectionDisabledFor,
  parseInjectionStore,
  setInjectionEnabled,
  claudeInheritedState,
  claudeProjectState,
  leverFor,
  readClaudeEnabled,
  setClaudeEnabled,
  setClaudeInheritedEnabled,
  setClaudeProjectEnabled,
  switchVerdict,
  type ClaudeConfig,
} from "../shared/enabled";

test("only Claude has a per-workspace lever: disabledMcpServers for inherited servers, the mcpjson lists for project ones", () => {
  assert.equal(leverFor("claude", "user"), "disabledMcpServers");
  assert.equal(leverFor("claude", "local"), "disabledMcpServers");
  assert.equal(leverFor("claude", "project"), "mcpjsonServers");
  for (const [provider, scope] of [["codex", "user"], ["codex", "local"], ["kimi", "user"], ["kimi", "project"], ["grok", "user"], ["", "user"]] as const) {
    assert.equal(leverFor(provider, scope), "none", `${provider}/${scope}`);
    const verdict = switchVerdict(provider, scope, undefined, "jam");
    assert.equal(verdict.writable, false);
    assert.ok(verdict.reason.length > 20, `${provider}/${scope} explains itself`);
  }
  assert.match(switchVerdict("codex", "user", undefined, "jam").reason, /config\.toml on top.*everywhere/);
  // A server the hook injects can be left out, for Codex as for Claude.
  assert.equal(leverFor("codex", "project"), "injection");
  const on = switchVerdict("codex", "project", undefined, "jam", []);
  assert.deepEqual([on.state, on.writable, on.lever], ["enabled", true, "injection"]);
  const off = switchVerdict("codex", "project", undefined, "jam", ["jam"]);
  assert.equal(off.state, "disabled");
  assert.match(off.reason, /this workspace only/);
});

test("the injection store keeps one list per directory and drops emptied keys", () => {
  assert.deepEqual(parseInjectionStore(null), EMPTY_INJECTION_STORE);
  assert.deepEqual(parseInjectionStore({ version: 1, disabled: { "/a": ["jam", 3, null], "/b": [] } }), { version: 1, disabled: { "/a": ["jam"] } });
  const store = setInjectionEnabled(EMPTY_INJECTION_STORE, "/home/demo/p", "jam", false);
  assert.deepEqual(store.disabled, { "/home/demo/p": ["jam"] });
  assert.deepEqual(injectionDisabledFor(store, "/home/demo/p"), ["jam"]);
  assert.deepEqual(injectionDisabledFor(store, "/home/demo/other"), []);
  const twice = setInjectionEnabled(store, "/home/demo/p", "jam", false);
  assert.deepEqual(twice.disabled, { "/home/demo/p": ["jam"] });
  const more = setInjectionEnabled(twice, "/home/demo/p", "supabase", false);
  assert.deepEqual(more.disabled, { "/home/demo/p": ["jam", "supabase"] });
  const back = setInjectionEnabled(setInjectionEnabled(more, "/home/demo/p", "jam", true), "/home/demo/p", "supabase", true);
  assert.deepEqual(back, EMPTY_INJECTION_STORE);
  // The original is untouched.
  assert.deepEqual(store.disabled, { "/home/demo/p": ["jam"] });
});

test("inherited state: off only when the name is in disabledMcpServers", () => {
  assert.equal(claudeInheritedState(undefined, "jam"), "enabled");
  assert.equal(claudeInheritedState({}, "jam"), "enabled");
  assert.equal(claudeInheritedState({ disabledMcpServers: ["jam"] }, "jam"), "disabled");
  assert.equal(claudeInheritedState({ disabledMcpServers: ["linear"] }, "jam"), "enabled");
  // The json-suffixed lists are a different family and must not leak across.
  assert.equal(claudeInheritedState({ disabledMcpjsonServers: ["jam"] }, "jam"), "enabled");
  // Junk in the list is ignored rather than crashing the read.
  assert.equal(claudeInheritedState({ disabledMcpServers: [1, null, "jam"] as unknown as string[] }, "jam"), "disabled");
});

test("project state reads the allow and deny lists, deny winning", () => {
  assert.equal(claudeProjectState(undefined, "jam"), "undecided");
  assert.equal(claudeProjectState({}, "jam"), "undecided");
  assert.equal(claudeProjectState({ enabledMcpjsonServers: ["jam"] }, "jam"), "enabled");
  assert.equal(claudeProjectState({ disabledMcpjsonServers: ["jam"] }, "jam"), "disabled");
  assert.equal(claudeProjectState({ enabledMcpjsonServers: ["jam"], disabledMcpjsonServers: ["jam"] }, "jam"), "disabled");
  assert.equal(claudeProjectState({ enableAllProjectMcpServers: true }, "jam"), "enabled");
  assert.equal(claudeProjectState({ enableAllProjectMcpServers: true, disabledMcpjsonServers: ["jam"] }, "jam"), "disabled");
  // disabledMcpServers does not govern a project server.
  assert.equal(claudeProjectState({ disabledMcpServers: ["jam"], enabledMcpjsonServers: ["jam"] }, "jam"), "enabled");
});

test("the verdict names the state and explains the lever", () => {
  const off = switchVerdict("claude", "user", { disabledMcpServers: ["jam"] }, "jam");
  assert.deepEqual([off.state, off.writable, off.lever], ["disabled", true, "disabledMcpServers"]);
  assert.match(off.reason, /this workspace only/);
  const on = switchVerdict("claude", "user", {}, "jam");
  assert.equal(on.state, "enabled");
  assert.match(on.reason, /every workspace/);
  const asks = switchVerdict("claude", "project", {}, "jam");
  assert.deepEqual([asks.state, asks.lever], ["undecided", "mcpjsonServers"]);
  assert.match(asks.reason, /asks/);
});

test("turning an inherited server off adds it to disabledMcpServers and keeps every other key", () => {
  const entry = { allowedTools: ["Bash"], hasTrustDialogAccepted: true, mcpServers: { zapier: { url: "x" } }, enabledMcpjsonServers: [], disabledMcpjsonServers: [] };
  const off = setClaudeInheritedEnabled(entry, "jam", false);
  assert.deepEqual(off.disabledMcpServers, ["jam"]);
  assert.equal(off.allowedTools, entry.allowedTools);
  assert.equal(off.mcpServers, entry.mcpServers);
  assert.deepEqual(off.enabledMcpjsonServers, []);
  assert.deepEqual(off.disabledMcpjsonServers, []);
  assert.equal(claudeInheritedState(off, "jam"), "disabled");
  // The original is untouched, and turning it back on empties the list it created.
  assert.equal("disabledMcpServers" in entry, false);
  const on = setClaudeInheritedEnabled(off, "jam", true);
  assert.deepEqual(on.disabledMcpServers, []);
  assert.equal(claudeInheritedState(on, "jam"), "enabled");
});

test("turning an inherited server on in an entry that never opted out changes nothing", () => {
  assert.deepEqual(setClaudeInheritedEnabled(undefined, "jam", true), {});
  assert.deepEqual(setClaudeInheritedEnabled({ hasTrustDialogAccepted: true }, "jam", true), { hasTrustDialogAccepted: true });
  // Turning it off twice does not duplicate the name.
  const twice = setClaudeInheritedEnabled(setClaudeInheritedEnabled({}, "jam", false), "jam", false);
  assert.deepEqual(twice.disabledMcpServers, ["jam"]);
});

test("setting project state moves the name between the mcpjson lists and keeps every other key", () => {
  const entry = { allowedTools: ["Bash"], enabledMcpjsonServers: ["jam", "linear"], disabledMcpjsonServers: ["supabase"], lastCost: 1.25 };
  const off = setClaudeProjectEnabled(entry, "jam", false);
  assert.deepEqual(off.enabledMcpjsonServers, ["linear"]);
  assert.deepEqual(off.disabledMcpjsonServers, ["supabase", "jam"]);
  assert.equal(off.allowedTools, entry.allowedTools);
  assert.equal(off.lastCost, 1.25);
  assert.equal(claudeProjectState(off, "jam"), "disabled");
  assert.deepEqual(entry.enabledMcpjsonServers, ["jam", "linear"]);
  const on = setClaudeProjectEnabled(off, "jam", true);
  assert.deepEqual(on.enabledMcpjsonServers, ["linear", "jam"]);
  assert.deepEqual(on.disabledMcpjsonServers, ["supabase"]);
  assert.deepEqual(setClaudeProjectEnabled(undefined, "jam", true), { enabledMcpjsonServers: ["jam"] });
});

const CONFIG: ClaudeConfig = {
  numStartups: 412,
  oauthAccount: { emailAddress: "demo@example.com", accountUuid: "abc" },
  mcpServers: { jam: { type: "http", url: "https://mcp.jam.dev/mcp" }, linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
  projects: {
    "/home/demo": { allowedTools: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [] },
    "/home/demo/projects/data-glue": { allowedTools: ["Bash"], mcpServers: { zapier: { url: "x" } }, enabledMcpjsonServers: [], disabledMcpjsonServers: [], lastCost: 3.5 },
  },
  tipsHistory: { "new-user-warmup": 1 },
  userID: "u-1",
};

test("setClaudeEnabled touches exactly one project entry and creates a missing one minimally", () => {
  const dir = "/home/demo/projects/data-glue";
  const next = setClaudeEnabled(CONFIG, dir, "disabledMcpServers", "jam", false);
  assert.equal(readClaudeEnabled(next, dir, "disabledMcpServers", "jam"), "disabled");
  assert.equal(readClaudeEnabled(next, "/home/demo", "disabledMcpServers", "jam"), "enabled");
  assert.equal(readClaudeEnabled(CONFIG, dir, "disabledMcpServers", "jam"), "enabled");
  assert.doesNotThrow(() => assertUnrelatedKeysKept(CONFIG, next, dir));
  // Same references for everything that did not change.
  assert.equal(next.mcpServers, CONFIG.mcpServers);
  assert.equal(next.projects?.["/home/demo"], CONFIG.projects?.["/home/demo"]);
  assert.deepEqual(Object.keys(next), Object.keys(CONFIG));
  assert.deepEqual(Object.keys(next.projects ?? {}), Object.keys(CONFIG.projects ?? {}));

  // A worktree directory with no entry yet gains one holding only the list.
  const worktree = "/home/demo/.paseo/worktrees/data-glue/feature-x";
  const fresh = setClaudeEnabled(CONFIG, worktree, "disabledMcpServers", "jam", false);
  assert.deepEqual(fresh.projects?.[worktree], { disabledMcpServers: ["jam"] });
  assert.doesNotThrow(() => assertUnrelatedKeysKept(CONFIG, fresh, worktree));
  // And a config with no projects map at all.
  const bare = setClaudeEnabled({ userID: "u" }, worktree, "mcpjsonServers", "supabase", true);
  assert.deepEqual(bare, { userID: "u", projects: { [worktree]: { enabledMcpjsonServers: ["supabase"] } } });
});

test("assertUnrelatedKeysKept refuses a write that changes anything outside the one entry", () => {
  const dir = "/home/demo/projects/data-glue";
  assert.throws(() => assertUnrelatedKeysKept(CONFIG, { ...CONFIG, userID: "other" }, dir), /'userID' would change/);
  const { tipsHistory: _dropped, ...missing } = CONFIG;
  assert.throws(() => assertUnrelatedKeysKept(CONFIG, missing, dir), /top-level keys/);
  const sibling = { ...CONFIG, projects: { ...CONFIG.projects, "/home/demo": { allowedTools: ["Edit"] } } };
  assert.throws(() => assertUnrelatedKeysKept(CONFIG, sibling, dir), /project entry '\/home\/demo' would change/);
  const { mcpServers: _servers, ...lost } = CONFIG;
  assert.throws(() => assertUnrelatedKeysKept(CONFIG, { ...lost, extra: 1 }, dir), /top-level keys/);
});
