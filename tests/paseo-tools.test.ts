import assert from "node:assert/strict";
import test from "node:test";
import { costProfile, loadFor, loadsForWorkspace, toolBudgetTier, type PaseoToolsLike, type ProfileScope, type WorkspaceProfile } from "../shared/budget";
import { chipLabel } from "../shared/contracts";
import {
  PASEO_BUILTIN_PROVIDERS,
  PASEO_TOOL_CATALOG,
  buildPaseoToolsPatch,
  isBrowserTool,
  mergeDisabledTools,
  paseoToolCount,
  paseoToolProviders,
  patchMismatch,
  readDaemonToolsConfig,
  resolvePaseoTools,
  toolChange,
  toolOnFor,
  unknownTools,
  type DaemonToolsConfig,
} from "../shared/paseo-tools";
import { configureLive } from "../server/paseo-live";
import { describePatch, handleMcpPaseoTools, handleMcpSetPaseoTools, resetPaseoToolsCache } from "../server/paseo-tools";

// Never reach a real daemon from these tests: the live list always fails here.
configureLive({ fetch: async () => { throw new Error("no network in tests"); } });

const CORE = PASEO_TOOL_CATALOG.filter((entry) => !isBrowserTool(entry.name)).length;
const ALL = PASEO_TOOL_CATALOG.length;

const config = (overrides: Partial<DaemonToolsConfig> = {}): DaemonToolsConfig => ({
  mcpEnabled: true,
  injectIntoAgents: true,
  browserTools: true,
  providers: {},
  ...overrides,
});

// ------------------------------------------------------------------ catalogue

test("the catalogue matches Paseo 0.9.1: 39 core tools and 22 browser tools, bare names, no speak", () => {
  assert.equal(CORE, 39);
  assert.equal(ALL - CORE, 22);
  const names = PASEO_TOOL_CATALOG.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length, "unique names");
  assert.ok(names.every((name) => /^[a-z_]+$/.test(name) && !name.startsWith("mcp__")), "bare names, as disabledTools takes them");
  assert.ok(!names.includes("speak"), "speak is voice-only and cannot be turned off");
  assert.ok(PASEO_TOOL_CATALOG.every((entry) => (entry.group === "browser") === isBrowserTool(entry.name)));
});

test("the catalogue names are the ones Paseo 0.9.1 registers, so a renamed tool fails here", () => {
  const core = [
    "archive_agent", "archive_workspace", "cancel_agent", "capture_terminal", "create_agent", "create_heartbeat",
    "create_schedule", "create_terminal", "create_workspace", "delete_heartbeat", "delete_schedule", "get_agent_activity",
    "get_agent_status", "inspect_provider", "inspect_schedule", "kill_agent", "kill_terminal", "list_agents", "list_models",
    "list_pending_permissions", "list_profiles", "list_providers", "list_schedules", "list_terminals",
    "list_workspace_scripts", "list_workspaces", "pause_schedule", "rename_workspace", "respond_to_permission",
    "resume_schedule", "run_schedule_once", "schedule_logs", "send_agent_prompt", "send_terminal_keys", "set_agent_mode",
    "start_workspace_script", "stop_workspace_script", "update_agent", "update_schedule",
  ];
  const browser = [
    "back", "click", "close_tab", "drag", "evaluate", "fill", "forward", "hover", "keypress", "list_tabs", "logs",
    "navigate", "new_tab", "reload", "resize", "screenshot", "scroll", "select", "snapshot", "type", "upload", "wait",
  ].map((name) => `browser_${name}`);
  const names = (browserGroup: boolean) =>
    PASEO_TOOL_CATALOG.filter((entry) => isBrowserTool(entry.name) === browserGroup).map((entry) => entry.name).sort();
  assert.deepEqual(names(false), core);
  assert.deepEqual(names(true), browser.sort());
});

// ------------------------------------------------------------------ reading

test("readDaemonToolsConfig takes the daemon's defaults and both provider spellings", () => {
  const empty = readDaemonToolsConfig({});
  assert.deepEqual(empty, { mcpEnabled: true, injectIntoAgents: false, browserTools: false, providers: {} }, "missing inject is off, as config.js reads it");
  const flat = readDaemonToolsConfig({
    mcp: { enabled: false, injectIntoAgents: false },
    browserTools: { enabled: true },
    providers: { codex: { enabled: true, paseoTools: { enabled: false, disabledTools: ["list_agents", 3] } }, claude: { env: { A: "b" } } },
  });
  assert.equal(flat.mcpEnabled, false);
  assert.equal(flat.injectIntoAgents, false);
  assert.equal(flat.browserTools, true);
  assert.deepEqual(flat.providers.codex, { enabled: true, paseoTools: { enabled: false, disabledTools: ["list_agents"] } });
  assert.deepEqual(flat.providers.claude, {});
  const nested = readDaemonToolsConfig({ agents: { providers: { pi: { enabled: false } } } });
  assert.deepEqual(nested.providers, { pi: { enabled: false } });
});

test("providers worth a switch: the six built-ins and every enabled config entry; disabled ones left out", () => {
  const cfg = config({ providers: { pi: { enabled: false }, "ai-router": { enabled: true }, codex: { enabled: false }, omp: {} } });
  assert.deepEqual(paseoToolProviders(cfg, ["claude-work", ""]), ["claude", "copilot", "opencode", "omp", "ai-router"]);
  assert.deepEqual(paseoToolProviders(config()), [...PASEO_BUILTIN_PROVIDERS], "a built-in needs no config entry");
  assert.deepEqual(
    paseoToolProviders(config({ providers: { "claude-work": { enabled: true } } }), ["claude-work"]),
    [...PASEO_BUILTIN_PROVIDERS, "claude-work"],
  );
});

test("an editor found on disk that Paseo has no provider for gets no Paseo tools", () => {
  assert.deepEqual(paseoToolProviders(config(), ["kimi", "grok"]), [...PASEO_BUILTIN_PROVIDERS]);
  assert.deepEqual(
    paseoToolProviders(config({ providers: { kimi: { enabled: true } } }), ["kimi", "grok"]),
    [...PASEO_BUILTIN_PROVIDERS, "kimi"],
    "unless the config declares it",
  );
});

// ------------------------------------------------------------------ resolver

test("every combination of mcp.enabled, injectIntoAgents, provider policy and browser tools", () => {
  for (const mcpEnabled of [true, false]) {
    for (const injectIntoAgents of [true, false]) {
      for (const policy of [undefined, { enabled: true }, { enabled: false }, { disabledTools: ["list_agents", "browser_click"] }]) {
        for (const browserTools of [true, false]) {
          const cfg = config({ mcpEnabled, injectIntoAgents, browserTools, providers: policy ? { claude: { paseoTools: policy } } : {} });
          const state = resolvePaseoTools(cfg, ["claude"]);
          const injected = mcpEnabled && injectIntoAgents;
          const providerOn = policy?.enabled !== false;
          const disabled = policy?.disabledTools ?? [];
          const expected = !injected || !providerOn
            ? 0
            : PASEO_TOOL_CATALOG.filter((entry) => (browserTools || !isBrowserTool(entry.name)) && !disabled.includes(entry.name)).length;
          const label = JSON.stringify({ mcpEnabled, injectIntoAgents, policy, browserTools });
          assert.equal(state.injected, injected, label);
          assert.equal(state.blocker, !mcpEnabled ? "mcp-off" : !injectIntoAgents ? "inject-off" : "", label);
          assert.equal(paseoToolCount(state, "claude"), expected, label);
          assert.equal(state.providers[0]!.enabled, providerOn, label);
          assert.equal(state.tools.find((entry) => entry.name === "list_agents")!.onFor.includes("claude"), expected > 0 && !disabled.includes("list_agents"), label);
        }
      }
    }
  }
});

test("known counts: 61 with browser tools, 39 without, 0 for a provider switched off", () => {
  const cfg = config({ providers: { codex: { paseoTools: { enabled: false } } } });
  const state = resolvePaseoTools(cfg, ["claude", "codex"]);
  assert.equal(paseoToolCount(state, "claude"), 61);
  assert.equal(paseoToolCount(state, "codex"), 0);
  assert.equal(paseoToolCount(resolvePaseoTools(config({ browserTools: false }), ["claude"]), "claude"), 39);
  assert.equal(paseoToolCount(state, "not-listed"), 61, "an id not listed gets what a provider with no entry gets");
  assert.equal(state.defaultTools, 61);
  assert.equal(resolvePaseoTools(config({ injectIntoAgents: false }), ["claude"]).defaultTools, 0);
  assert.equal(toolOnFor(config(), "anything", "create_agent"), true, "a provider with no entry gets the tools, like the daemon");
});

// ------------------------------------------------------------------ patch builder

test("the patch carries only what changes, and nothing when nothing does", () => {
  const cfg = config({ browserTools: false, providers: { codex: { enabled: true, paseoTools: { disabledTools: ["kill_agent"] } } } });
  assert.equal(buildPaseoToolsPatch(cfg, {}), null);
  assert.equal(buildPaseoToolsPatch(cfg, { injectIntoAgents: true, browserTools: false }), null);
  assert.equal(buildPaseoToolsPatch(cfg, { providers: [{ id: "codex", enabled: true, tools: { kill_agent: false, list_agents: true } }] }), null);
  assert.deepEqual(buildPaseoToolsPatch(cfg, { injectIntoAgents: false }), { mcp: { injectIntoAgents: false } });
  assert.deepEqual(buildPaseoToolsPatch(cfg, { browserTools: true }), { browserTools: { enabled: true } });
  assert.deepEqual(buildPaseoToolsPatch(cfg, { providers: [{ id: "codex", enabled: false }] }), { providers: { codex: { paseoTools: { enabled: false } } } });
});

test("disabledTools is merged with the current list, order and unknown names kept", () => {
  const cfg = config({ providers: { claude: { paseoTools: { disabledTools: ["future_tool", "kill_agent", "list_agents"] } } } });
  const patch = buildPaseoToolsPatch(cfg, { providers: [{ id: "claude", tools: { list_agents: true, browser_click: false } }] });
  assert.deepEqual(patch, { providers: { claude: { paseoTools: { disabledTools: ["future_tool", "kill_agent", "browser_click"] } } } });
  assert.deepEqual(mergeDisabledTools([], { a: false, b: false }), ["a", "b"]);
  assert.deepEqual(mergeDisabledTools(["a"], { a: false }), ["a"], "no duplicates");
});

test("an opencode agent with no config entry is counted, and All providers writes all six built-ins", () => {
  const cfg = config();
  const state = resolvePaseoTools(cfg, paseoToolProviders(cfg));
  assert.equal(paseoToolCount(state, "opencode"), 61);
  assert.equal(state.providers.length, 6);
  const patch = buildPaseoToolsPatch(cfg, toolChange(paseoToolProviders(cfg), "browser_evaluate", false));
  assert.deepEqual(Object.keys(patch?.providers ?? {}), [...PASEO_BUILTIN_PROVIDERS]);
});

test("a write to several providers patches each one separately", () => {
  const patch = buildPaseoToolsPatch(config(), { providers: [{ id: "claude", tools: { kill_agent: false } }, { id: "codex", tools: { kill_agent: false } }] });
  assert.deepEqual(patch, { providers: { claude: { paseoTools: { disabledTools: ["kill_agent"] } }, codex: { paseoTools: { disabledTools: ["kill_agent"] } } } });
});

test("unknown tool names are caught before anything is written", () => {
  assert.deepEqual(unknownTools({ providers: [{ id: "claude", tools: { list_agent: false, list_agents: false } }] }), ["list_agent"]);
  assert.deepEqual(unknownTools({ injectIntoAgents: true }), []);
});

test("patchMismatch names the first field the read-back does not hold", () => {
  const after = config({ providers: { claude: { paseoTools: { disabledTools: ["kill_agent"] } } } });
  assert.equal(patchMismatch(after, { providers: [{ id: "claude", tools: { kill_agent: false } }] }), "");
  assert.match(patchMismatch(after, { providers: [{ id: "claude", tools: { kill_agent: true } }] }), /kill_agent for claude reads back as off/);
  assert.match(patchMismatch(config({ injectIntoAgents: true }), { injectIntoAgents: false }), /reads back as on/);
});

// ------------------------------------------------------------------ host handlers

/** The daemon's merge, reduced: records merge deeply, arrays and scalars replace (daemon-config-store.js deepMerge). */
function deepMerge(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const before = next[key];
    next[key] = before && typeof before === "object" && !Array.isArray(before) && value && typeof value === "object" && !Array.isArray(value)
      ? deepMerge(before as Record<string, unknown>, value as Record<string, unknown>)
      : value;
  }
  return next;
}

type FakeOptions = {
  refuse?: boolean;
  /** Save something other than the patch, the way a launch flag or a racing client would. */
  saveInstead?: (current: Record<string, unknown>, patch: Record<string, unknown>) => Record<string, unknown>;
  /** Every read after the first patch fails. */
  unreadableAfterPatch?: boolean;
};

function fakeDaemon(initial: Record<string, unknown>, options: FakeOptions = {}) {
  let current = structuredClone(initial);
  const patches: unknown[] = [];
  const paseo = {
    config: {
      get: async () => {
        if (options.unreadableAfterPatch && patches.length > 0) throw new Error("socket hang up");
        return { requestId: "r", config: structuredClone(current) };
      },
      patch: async (patch: Record<string, unknown>) => {
        patches.push(patch);
        if (options.refuse) throw new Error("Relay is controlled by a daemon launch override.");
        current = options.saveInstead ? options.saveInstead(current, patch) : deepMerge(current, patch);
        return { requestId: "r", config: structuredClone(current) };
      },
    },
  };
  return { context: { paseo } as never, patches, current: () => current };
}

const START = {
  mcp: { enabled: true, injectIntoAgents: true },
  browserTools: { enabled: true },
  providers: {
    claude: { enabled: true },
    "claude-work": { extends: "claude", label: "Work", env: { CLAUDE_CONFIG_DIR: "/home/demo/.agent-link/claude/work" }, paseoTools: { disabledTools: ["future_tool"] } },
    pi: { enabled: false },
  },
  relay: { enabled: true },
};

test("the write patches through the config API, merges, keeps every other field, and reports the read-back", async () => {
  resetPaseoToolsCache();
  const daemon = fakeDaemon(START);
  const result = await handleMcpSetPaseoTools({ providers: [{ id: "claude-work", tools: { browser_click: false } }] }, daemon.context);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(daemon.patches, [{ providers: { "claude-work": { paseoTools: { disabledTools: ["future_tool", "browser_click"] } } } }]);
  const saved = (daemon.current().providers as Record<string, Record<string, unknown>>)["claude-work"]!;
  assert.equal(saved.extends, "claude");
  assert.equal(saved.label, "Work");
  assert.deepEqual(saved.env, { CLAUDE_CONFIG_DIR: "/home/demo/.agent-link/claude/work" });
  assert.deepEqual(daemon.current().relay, { enabled: true });
  assert.equal(result.state?.providers.find((entry) => entry.id === "claude-work")?.tools, 60);
  assert.match(result.message, /browser_click off for claude-work\. Agents started from now on/);
});

test("a no-op writes nothing; an unknown tool is refused; a refused patch says so", async () => {
  resetPaseoToolsCache();
  const daemon = fakeDaemon(START);
  const same = await handleMcpSetPaseoTools({ injectIntoAgents: true, browserTools: true }, daemon.context);
  assert.equal(same.ok, true);
  assert.equal(daemon.patches.length, 0);
  const typo = await handleMcpSetPaseoTools({ providers: [{ id: "claude", tools: { list_agent: false } }] }, daemon.context);
  assert.equal(typo.ok, false);
  assert.match(typo.message, /Not a Paseo tool as of Paseo 0\.9\.1: list_agent/);
  assert.equal(daemon.patches.length, 0);
  resetPaseoToolsCache();
  const refused = fakeDaemon(START, { refuse: true });
  const result = await handleMcpSetPaseoTools({ injectIntoAgents: false }, refused.context);
  assert.equal(result.ok, false);
  assert.match(result.message, /did not accept the change/);
});

test("a change the read-back does not hold is reported, not claimed", async () => {
  resetPaseoToolsCache();
  const held = fakeDaemon(START, { saveInstead: (current) => current });
  const result = await handleMcpSetPaseoTools({ injectIntoAgents: false }, held.context);
  assert.equal(result.ok, false);
  assert.match(result.message, /Paseo took the change but "Enable Paseo tools" reads back as on/);
  assert.equal(result.state?.injected, true, "the card shows what is saved");
});

test("a change that cannot be read back is not confirmed", async () => {
  resetPaseoToolsCache();
  const daemon = fakeDaemon(START, { unreadableAfterPatch: true });
  const result = await handleMcpSetPaseoTools({ browserTools: false }, daemon.context);
  assert.equal(daemon.patches.length, 1);
  assert.equal(result.ok, false);
  assert.match(result.message, /was sent but could not be read back, so it is not confirmed/);
});

test("another client changing the same tool list at the same moment is said, not hidden", async () => {
  resetPaseoToolsCache();
  const racing = fakeDaemon(START, {
    saveInstead: (current, patch) => {
      const merged = deepMerge(current, patch) as typeof START;
      const work = merged.providers["claude-work"] as { paseoTools: { disabledTools: string[] } };
      work.paseoTools.disabledTools = [...work.paseoTools.disabledTools, "kill_agent"];
      return merged;
    },
  });
  const result = await handleMcpSetPaseoTools({ providers: [{ id: "claude-work", tools: { browser_click: false } }] }, racing.context);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /Another client changed the tool list for claude-work at the same time/);
  assert.deepEqual(result.state?.providers.find((entry) => entry.id === "claude-work")?.disabledTools, ["future_tool", "browser_click", "kill_agent"]);
});

test("turning Paseo tools off daemon-wide reads back as not injected", async () => {
  resetPaseoToolsCache();
  const daemon = fakeDaemon(START);
  const result = await handleMcpSetPaseoTools({ injectIntoAgents: false }, daemon.context);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(daemon.patches, [{ mcp: { injectIntoAgents: false } }]);
  assert.equal(result.state?.injected, false);
  assert.equal(result.state?.blocker, "inject-off");
  const read = await handleMcpPaseoTools({}, daemon.context);
  assert.equal(read.injected, false, "the cache holds the read-back, not the state before the write");
});

test("describePatch says what was written in plain words", () => {
  const before = config();
  assert.equal(describePatch({ browserTools: { enabled: false } }, before), "Browser tools off.");
  assert.equal(describePatch({ providers: { codex: { paseoTools: { enabled: false } } } }, before), "Paseo tools off for codex.");
});

// ------------------------------------------------------------------ budget and chip

const http = (name: string) => ({ name, transport: "http" as const });
const claude: ProfileScope = { id: "c", label: "Claude · me (primary)", provider: "claude", providerId: "claude", configPath: "c", servers: [http("a"), http("b"), http("c")], local: [] };
const codex: ProfileScope = { id: "x", label: "Codex · me (primary)", provider: "codex", providerId: "codex", configPath: "x", servers: [http("a"), http("b"), http("c"), http("d")], local: [] };
const profile: WorkspaceProfile = { project: [], projectConfigPath: "", scopes: [claude, codex] };

test("without injection the budget numbers are what they were", () => {
  const none: Array<PaseoToolsLike | null> = [null, { tools: {} }, { tools: { claude: 0 } }];
  for (const paseo of none) {
    const cost = costProfile(loadFor(profile, claude, null, paseo));
    assert.equal(cost.total, 3);
    assert.equal(cost.builtIn, 0);
    assert.equal(cost.tools, 15);
    assert.equal(cost.tier, "ok");
  }
  // The tool tier equals the server tier for every server count when no Paseo tools load.
  for (let servers = 0; servers < 30; servers += 1) {
    const scope = { ...claude, servers: Array.from({ length: servers }, (_, index) => http(`s${index}`)) };
    const cost = costProfile(loadFor({ ...profile, scopes: [scope] }, scope, null));
    assert.equal(toolBudgetTier(cost.tools), cost.tier, `${servers} servers`);
  }
});

test("with injection Paseo tools are one more server with their real tool count", () => {
  const paseo = { tools: { claude: 61, codex: 0 } };
  const load = loadFor(profile, claude, null, paseo);
  const cost = costProfile(load);
  assert.equal(load.paseoTools, 61);
  assert.equal(load.servers.length, 3, "not an editor definition, so not in the switch list");
  assert.equal(cost.total, 4);
  assert.equal(cost.tools, 3 * 5 + 61);
  assert.equal(cost.tier, "attention", "76 tools: past Cursor's 40, under 80");
  assert.equal(costProfile(loadFor(profile, claude, null, { tools: { claude: 39 } })).tier, "attention", "15 + 39 = 54");
  assert.equal(costProfile(loadFor(profile, codex, null, { tools: { codex: 61 } })).tier, "problem", "4 servers at five plus 61 is 81");
  assert.equal(costProfile(loadFor(profile, codex, null, paseo)).total, 4, "codex has it off: no entry");
  // The heaviest load leads, the built-in server included.
  assert.equal(loadsForWorkspace(profile, null, null)[0]!.providerId, "codex", "4 servers against 3");
  assert.equal(loadsForWorkspace(profile, null, { tools: { claude: 61 } })[0]!.paseoTools, 61, "3 + Paseo ties 4; the scope order decides, as before");
  assert.equal(loadsForWorkspace({ ...profile, scopes: [codex, claude] }, null, { tools: { claude: 61 } })[0]!.providerId, "codex");
});

test("the chip counts Paseo tools only when this agent gets them", () => {
  const health = { results: [{ name: "a", status: "ok" as const, note: "", scopes: [] }], checkedAt: "" };
  const tools = { servers: [{ name: "a", transport: "http" as const, kind: "listed" as const, note: "", tools: [{ name: "t", title: "", description: "", takesArguments: false, arguments: [], required: [] }], serverInfo: null, protocolVersion: "" }], checkedAt: "" };
  assert.equal(chipLabel(health, tools).label, "1 MCP · 1 tools");
  assert.equal(chipLabel(health, tools, 0).label, "1 MCP · 1 tools");
  assert.equal(chipLabel(health, tools, 61).label, "2 MCP · 62 tools");
  assert.equal(chipLabel(null, null, 61).label, "1 MCP");
  assert.equal(chipLabel(null, null).label, "MCP");
});
