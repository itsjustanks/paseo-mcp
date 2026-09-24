import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { BUDGET_ATTENTION, BUDGET_PROBLEM, costProfile, loadFor, loadsForWorkspace, type ProfileScope, type WorkspaceProfile } from "../shared/budget";
import {
  AI_ROUTER_REASON,
  MANAGED_OVERRIDE_MIN_VERSION,
  TOOL_SEARCH_ON_LINE,
  aiRouterRoutesAgents,
  baseCli,
  inheritedEnv,
  isFirstPartyBaseUrl,
  readProviderLaunch,
  toolSearch,
  toolSearchLine,
  type ToolSearchVerdict,
} from "../shared/tool-search";
import { forgetAllFiles } from "../server/files";
import { resetPaseoToolsCache } from "../server/paseo-tools";
import { aiRouterSettingsPath, managedSettingsDir, managedSettingsEnv, toolSearchVerdicts } from "../server/tool-search";

const claude = (inputs: Omit<Parameters<typeof toolSearch>[1], "base"> = {}, id = "claude") => toolSearch(id, { base: "claude", ...inputs });

// ------------------------------------------------------------------ resolver

test("a Claude provider with nothing set has tool search on (Claude Code's default)", () => {
  assert.deepEqual(claude(), { state: "on", reason: "Claude Code's default", cli: "claude" });
  assert.equal(claude({ daemonEnv: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } }).state, "on", "the first-party host is not custom");
});

test("a custom ANTHROPIC_BASE_URL turns it off, named by where it was set", () => {
  const provider = claude({ providerEnv: { ANTHROPIC_BASE_URL: "https://gateway.example.com/anthropic" } }, "claude-work");
  assert.equal(provider.state, "off");
  assert.equal(provider.reason, "The claude-work provider sets a custom ANTHROPIC_BASE_URL (gateway.example.com)");
  const daemon = claude({ daemonEnv: { ANTHROPIC_BASE_URL: "http://127.0.0.1:20128" } });
  assert.equal(daemon.state, "off");
  assert.match(daemon.reason, /^The daemon's environment sets a custom ANTHROPIC_BASE_URL \(127\.0\.0\.1:20128\)/);
  assert.equal(claude({ daemonEnv: { ANTHROPIC_BASE_URL: "not a url" } }).state, "off", "unparsable counts as not first-party");
});

test("the provider entry's env wins over the daemon's", () => {
  const verdict = claude({ daemonEnv: { ANTHROPIC_BASE_URL: "https://proxy.example.com" }, providerEnv: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } });
  assert.equal(verdict.state, "on");
  const blank = claude({ daemonEnv: { ANTHROPIC_BASE_URL: "https://proxy.example.com" }, providerEnv: { ANTHROPIC_BASE_URL: "  " } });
  assert.equal(blank.state, "off", "a blank value is not set, so the daemon's stands");
});

test("ENABLE_TOOL_SEARCH: false turns it off; true, auto and auto:N override a custom base URL", () => {
  assert.equal(claude({ providerEnv: { ENABLE_TOOL_SEARCH: "false" } }).state, "off");
  assert.match(claude({ providerEnv: { ENABLE_TOOL_SEARCH: "false" } }).reason, /sets ENABLE_TOOL_SEARCH=false/);
  for (const value of ["true", "auto", "auto:5", "TRUE"]) {
    const verdict = claude({ daemonEnv: { ANTHROPIC_BASE_URL: "https://proxy.example.com" }, providerEnv: { ENABLE_TOOL_SEARCH: value } });
    assert.equal(verdict.state, "on", value);
  }
  assert.equal(claude({ daemonEnv: { ANTHROPIC_BASE_URL: "https://proxy.example.com", ENABLE_TOOL_SEARCH: "maybe" } }).state, "off", "an undocumented value is ignored");
});

test("auto:N is on up to the default 10%, unknown above it or outside 0-100", () => {
  const proxy = { ANTHROPIC_BASE_URL: "https://proxy.example.com" };
  for (const value of ["auto:5", "auto:10", "auto:0"]) assert.equal(claude({ daemonEnv: proxy, providerEnv: { ENABLE_TOOL_SEARCH: value } }).state, "on", value);
  for (const value of ["auto:50", "auto:100"]) {
    const verdict = claude({ providerEnv: { ENABLE_TOOL_SEARCH: value } });
    assert.equal(verdict.state, "unknown", value);
    assert.equal(verdict.reason, `The claude provider sets ENABLE_TOOL_SEARCH=${value}, which defers tools only once they fill ${value.slice(5)}% of the context window`);
  }
  for (const value of ["auto:999", "auto:x", "auto:", "auto:-1", "auto:5.5"]) {
    const verdict = claude({ daemonEnv: proxy, providerEnv: { ENABLE_TOOL_SEARCH: value } });
    assert.equal(verdict.state, "unknown", value);
    assert.match(verdict.reason, /not a threshold Claude Code documents/);
  }
  assert.equal(claude({ daemonEnv: { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1", ENABLE_TOOL_SEARCH: "auto:50" } }).state, "off", "the betas flag still wins");
});

test("a derived provider inherits its base entry's env; its own wins", () => {
  const launch = readProviderLaunch({ providers: { claude: { env: { ANTHROPIC_BASE_URL: "https://gw.example.com" } }, work: { extends: "claude" }, cursor: { extends: "acp" } } });
  assert.deepEqual(inheritedEnv("work", launch), { ANTHROPIC_BASE_URL: "https://gw.example.com" });
  assert.equal(inheritedEnv("cursor", launch), undefined, "acp has no entry to inherit");
  assert.equal(inheritedEnv("claude", launch), undefined);
  const work = toolSearch("work", { base: "claude", baseEnv: inheritedEnv("work", launch), providerEnv: launch.work?.env });
  assert.equal(work.state, "off");
  assert.equal(work.reason, "The claude provider sets a custom ANTHROPIC_BASE_URL (gw.example.com)");
  const own = toolSearch("work", { base: "claude", baseEnv: inheritedEnv("work", launch), providerEnv: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } });
  assert.equal(own.state, "on");
});

test("settings files layer over the launch env: user, then project, then local; an empty value cancels", () => {
  const user = { label: "~/.claude/settings.json", env: { ANTHROPIC_BASE_URL: "https://proxy.example.com" } };
  const project = { label: "The project's .claude/settings.json", env: { ENABLE_TOOL_SEARCH: "false" } };
  const local = { label: "The project's .claude/settings.local.json", env: { ENABLE_TOOL_SEARCH: "true" } };
  assert.equal(claude({ settingsEnv: [user] }).reason, "~/.claude/settings.json sets a custom ANTHROPIC_BASE_URL (proxy.example.com)");
  assert.equal(claude({ providerEnv: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, settingsEnv: [user] }).state, "off", "a settings file beats the launch env");
  assert.equal(claude({ settingsEnv: [user, project] }).reason, "The project's .claude/settings.json sets ENABLE_TOOL_SEARCH=false");
  assert.equal(claude({ settingsEnv: [user, project, local] }).state, "on", "local beats project");
  assert.equal(claude({ daemonEnv: { ANTHROPIC_BASE_URL: "https://proxy.example.com" }, settingsEnv: [{ label: "x", env: { ANTHROPIC_BASE_URL: "" } }] }).state, "on");
});

test("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS keeps it off even with ENABLE_TOOL_SEARCH=true", () => {
  const verdict = claude({ daemonEnv: { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1", ENABLE_TOOL_SEARCH: "true" } });
  assert.deepEqual(verdict, { state: "off", reason: "The daemon's environment sets CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", cli: "claude" });
  assert.equal(claude({ daemonEnv: { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "0" } }).state, "on", "0 is not set");
});

test("AI Router's routeAgents turns it off for the built-in claude provider only", () => {
  const routed = claude({ aiRouterRoutes: true });
  assert.deepEqual(routed, { state: "off", reason: AI_ROUTER_REASON, cli: "claude" });
  assert.equal(claude({ aiRouterRoutes: true, providerEnv: { ENABLE_TOOL_SEARCH: "true" } }).state, "off", "the betas flag it adds cannot be overridden");
  assert.equal(claude({ aiRouterRoutes: true }, "claude-work").state, "on", "AI Router does not reroute a custom claude provider");
  assert.equal(claude({ aiRouterRoutes: false }).state, "on");
});

test("AI Router's own provider, whose entry carries ANTHROPIC_BASE_URL, is off and named as AI Router", () => {
  const verdict = claude({ providerEnv: { ANTHROPIC_BASE_URL: "http://omniroute:20128" } }, "ai-router");
  assert.equal(verdict.state, "off");
  assert.equal(verdict.reason, AI_ROUTER_REASON);
});

test("Vertex and Foundry are unknown: the plugin cannot see the model or deployment", () => {
  assert.equal(claude({ daemonEnv: { CLAUDE_CODE_USE_VERTEX: "1" } }).state, "unknown");
  assert.equal(claude({ daemonEnv: { CLAUDE_CODE_USE_FOUNDRY: "true" } }).state, "unknown");
});

test("Codex is unknown, other CLIs off, an unknown CLI unknown", () => {
  assert.equal(toolSearch("codex", { base: "codex" }).state, "unknown");
  assert.match(toolSearch("codex", { base: "codex" }).reason, /model supports tool search/);
  assert.deepEqual(toolSearch("copilot", { base: "copilot", daemonEnv: { ENABLE_TOOL_SEARCH: "true" } }), { state: "off", reason: "Copilot has no documented tool search", cli: "copilot" });
  assert.equal(toolSearch("mystery", { base: "" }).state, "unknown");
});

// ------------------------------------------------------------------ managed settings (0.11.2)

const MANAGED = "Managed settings (/etc/claude-code/managed-settings.json)";
const managedOn = { label: MANAGED, env: { ENABLE_TOOL_SEARCH: "true" } };

test("managed ENABLE_TOOL_SEARCH keeps it on under the betas flag, naming the file and the minimum version", () => {
  const verdict = claude({ daemonEnv: { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1", ENABLE_TOOL_SEARCH: "false" }, managedEnv: [managedOn] });
  assert.equal(verdict.state, "on");
  assert.equal(verdict.managed, true);
  assert.equal(
    verdict.reason,
    `${MANAGED} keep tool search on, even with CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS set (this needs Claude Code v${MANAGED_OVERRIDE_MIN_VERSION} or later)`,
  );
  assert.equal(MANAGED_OVERRIDE_MIN_VERSION, "2.1.227");
  const plain = claude({ managedEnv: [{ label: MANAGED, env: { ENABLE_TOOL_SEARCH: "auto" } }] });
  assert.equal(plain.reason, `${MANAGED} keep tool search on`, "no version clause without the betas flag");
  const proxy = claude({ daemonEnv: { ANTHROPIC_BASE_URL: "https://proxy.example.com" }, managedEnv: [managedOn] });
  assert.equal(proxy.state, "on", "overrides a custom base URL too");
});

test("managed ENABLE_TOOL_SEARCH=false turns it off, over a user or project value", () => {
  const verdict = claude({ settingsEnv: [{ label: "The project's .claude/settings.local.json", env: { ENABLE_TOOL_SEARCH: "true" } }], managedEnv: [{ label: MANAGED, env: { ENABLE_TOOL_SEARCH: "false" } }] });
  assert.deepEqual(verdict, { state: "off", reason: `${MANAGED} set ENABLE_TOOL_SEARCH=false`, cli: "claude", managed: true });
  const high = claude({ managedEnv: [{ label: MANAGED, env: { ENABLE_TOOL_SEARCH: "auto:50" } }] });
  assert.equal(high.state, "unknown");
  assert.match(high.reason, /set ENABLE_TOOL_SEARCH=auto:50, which defers tools only once they fill 50%/);
});

test("managed settings on plus a routed AI Router session: on", () => {
  for (const [id, routes] of [["claude", true], ["ai-router", false]] as const) {
    const verdict = claude({ aiRouterRoutes: routes, managedEnv: [managedOn] }, id);
    assert.equal(verdict.state, "on", id);
    assert.match(verdict.reason, /even with CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS set \(this needs Claude Code v2\.1\.227 or later\)$/);
  }
  assert.equal(claude({ aiRouterRoutes: true }).state, "off", "without managed settings routing still turns it off");
});

test("under the betas flag a cloud provider ignores the managed override, so tool search stays off", () => {
  for (const flag of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) {
    const verdict = claude({ daemonEnv: { [flag]: "1", CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, managedEnv: [managedOn] });
    assert.equal(verdict.state, "off", flag);
    assert.notEqual(verdict.managed, true, `${flag}: the managed file did not decide it`);
  }
  // Without the betas flag, Bedrock with managed on is Claude Code's normal deferral.
  assert.equal(claude({ daemonEnv: { CLAUDE_CODE_USE_BEDROCK: "1" }, managedEnv: [managedOn] }).state, "on");
});

test("managed settings: no layer, an undocumented value, a cloud provider, other CLIs", () => {
  assert.equal(claude({ daemonEnv: { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, managedEnv: [] }).state, "off", "missing: no layer");
  assert.equal(claude({ daemonEnv: { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, managedEnv: [{ label: MANAGED, env: { ENABLE_TOOL_SEARCH: "maybe" } }] }).state, "off", "an undocumented value is ignored");
  const vertex = claude({ daemonEnv: { CLAUDE_CODE_USE_VERTEX: "1" }, managedEnv: [managedOn] });
  assert.equal(vertex.state, "unknown", "the override has no effect on a cloud provider");
  assert.equal(toolSearch("codex", { base: "codex", managedEnv: [managedOn] }).state, "unknown", "Claude-based providers only");
  const emptied = claude({ daemonEnv: { ENABLE_TOOL_SEARCH: "false" }, managedEnv: [{ label: MANAGED, env: { ENABLE_TOOL_SEARCH: "" } }] });
  assert.equal(emptied.state, "on", "an empty managed value cancels one set lower down");
});

test("the on line names managed settings", () => {
  const verdict = claude({ managedEnv: [managedOn] });
  assert.equal(toolSearchLine(verdict, 76), `${MANAGED} keep tool search on. ${TOOL_SEARCH_ON_LINE}`);
});

test("first-party host means api.anthropic.com only", () => {
  assert.equal(isFirstPartyBaseUrl("https://api.anthropic.com/"), true);
  assert.equal(isFirstPartyBaseUrl("https://api.anthropic.com.evil.example"), false);
  assert.equal(isFirstPartyBaseUrl("https://console.anthropic.com"), false);
});

test("base CLI: an entry's extends, a built-in id, then the editor list's guess", () => {
  const launch = readProviderLaunch({ providers: { "claude-work": { extends: "claude", env: { CLAUDE_CONFIG_DIR: "/x", N: 3 } }, cursor: { extends: "acp" } } });
  assert.deepEqual(launch["claude-work"], { extends: "claude", env: { CLAUDE_CONFIG_DIR: "/x" } }, "non-string env values dropped");
  assert.equal(baseCli("claude-work", launch), "claude");
  assert.equal(baseCli("codex", launch), "codex");
  assert.equal(baseCli("slot-x", launch, "codex"), "codex");
  assert.equal(baseCli("slot-y", launch), "");
  assert.deepEqual(readProviderLaunch({ agents: { providers: { pi: {} } } }), { pi: { env: {} } }, "the nested spelling too");
});

test("AI Router settings: routeAgents true only when the envelope says so, at version 1", () => {
  assert.equal(aiRouterRoutesAgents({ version: 1, values: { routeAgents: true } }), true);
  assert.equal(aiRouterRoutesAgents({ version: 2, values: { routeAgents: true } }), false, "another version reads as AI Router's defaults");
  assert.equal(aiRouterRoutesAgents({ values: { routeAgents: true } }), false, "no version: defaults");
  assert.equal(aiRouterRoutesAgents({ version: 1, values: { routeAgents: "yes" } }), false);
  assert.equal(aiRouterRoutesAgents(null), false);
  assert.equal(aiRouterRoutesAgents("junk"), false);
});

// ------------------------------------------------------------------ host

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-tool-search-"));
after(() => rmSync(home, { recursive: true, force: true }));

function fakePaseo(providers: Record<string, unknown>) {
  return { config: { get: async () => ({ requestId: "r", config: { providers } }) } } as never;
}

const userHome = join(home, "user");
const workspace = join(home, "workspace");

async function verdicts(providers: Record<string, unknown>, env: Record<string, string> = {}, directory?: string) {
  resetPaseoToolsCache();
  forgetAllFiles();
  const ids = [{ id: "claude", base: "claude" }, { id: "claude-work", base: "claude" }, { id: "codex", base: "codex" }];
  return toolSearchVerdicts(fakePaseo(providers), ids, { daemonEnv: env, home, userHome, directory, managedDir });
}

const managedDir = join(home, "managed");

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

test("host: AI Router settings file absent, present, broken", async () => {
  const path = aiRouterSettingsPath(home);
  assert.equal((await verdicts({}))?.claude?.state, "on", "absent: not routed");
  mkdirSync(join(home, "plugin-settings", "ai-router"), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, values: { routeAgents: true } }));
  const routed = await verdicts({});
  assert.equal(routed?.claude?.state, "off");
  assert.match(routed!.claude!.reason, /AI Router/);
  assert.equal(routed?.["claude-work"]?.state, "on");
  writeFileSync(path, "{not json");
  assert.equal((await verdicts({}))?.claude?.state, "on", "broken: not routed");
  rmSync(path);
});

test("host: provider env from the daemon config and the daemon's own env both count", async () => {
  const fromEntry = await verdicts({ "claude-work": { extends: "claude", env: { ANTHROPIC_BASE_URL: "https://gw.example.com" } } });
  assert.equal(fromEntry?.["claude-work"]?.state, "off");
  assert.equal(fromEntry?.claude?.state, "on");
  const fromDaemon = await verdicts({}, { ANTHROPIC_BASE_URL: "https://gw.example.com" });
  assert.equal(fromDaemon?.claude?.state, "off");
  assert.equal(fromDaemon?.codex?.state, "unknown");
});

test("host: an unreadable daemon config gives no verdicts rather than a guess", async () => {
  resetPaseoToolsCache();
  const broken = { config: { get: async () => { throw new Error("daemon gone"); } } } as never;
  assert.equal(await toolSearchVerdicts(broken, [{ id: "claude", base: "claude" }], { daemonEnv: {}, home, userHome }), undefined);
});

test("host: a derived provider with no env of its own gets its base entry's", async () => {
  const result = await verdicts({ claude: { env: { ANTHROPIC_BASE_URL: "https://gw.example.com" } }, "claude-work": { extends: "claude" } });
  assert.equal(result?.["claude-work"]?.state, "off");
  assert.equal(result?.claude?.state, "off");
});

test("host: Claude Code's user settings env, from ~/.claude or the provider's CLAUDE_CONFIG_DIR", async () => {
  const user = join(userHome, ".claude", "settings.json");
  writeJson(user, { env: { ANTHROPIC_BASE_URL: "https://proxy.example.com" } });
  const fromUser = await verdicts({});
  assert.equal(fromUser?.claude?.reason, "~/.claude/settings.json sets a custom ANTHROPIC_BASE_URL (proxy.example.com)");
  assert.equal(fromUser?.codex?.state, "unknown", "not read for Codex");

  const work = join(userHome, ".agent-link", "claude", "work", "settings.json");
  writeJson(work, { env: { ENABLE_TOOL_SEARCH: "false" } });
  const derived = await verdicts({ "claude-work": { extends: "claude", env: { CLAUDE_CONFIG_DIR: "~/.agent-link/claude/work" } } });
  assert.equal(derived?.["claude-work"]?.reason, "~/.agent-link/claude/work/settings.json sets ENABLE_TOOL_SEARCH=false", "its own config dir, not ~/.claude");
  assert.match(derived!.claude!.reason, /^~\/\.claude\/settings\.json/);
  const inherited = await verdicts({ claude: { env: { CLAUDE_CONFIG_DIR: join(userHome, ".agent-link", "claude", "work") } }, "claude-work": { extends: "claude" } });
  assert.match(inherited!["claude-work"]!.reason, /agent-link\/claude\/work\/settings\.json sets ENABLE_TOOL_SEARCH=false/, "inherited from the base entry");

  writeJson(user, "{not json");
  assert.equal((await verdicts({}))?.claude?.state, "on", "a broken file is no layer");
  rmSync(join(userHome), { recursive: true, force: true });
});

test("host: project and local settings count only where the workspace is known", async () => {
  writeJson(join(workspace, ".claude", "settings.json"), { env: { ANTHROPIC_BASE_URL: "https://team-proxy.example.com" } });
  assert.equal((await verdicts({}))?.claude?.state, "on", "no directory: not read");
  const project = await verdicts({}, {}, workspace);
  assert.equal(project?.claude?.reason, "The project's .claude/settings.json sets a custom ANTHROPIC_BASE_URL (team-proxy.example.com)");
  writeJson(join(workspace, ".claude", "settings.local.json"), { env: { ENABLE_TOOL_SEARCH: "true" } });
  assert.equal((await verdicts({}, {}, workspace))?.claude?.state, "on", "local beats project");
  writeJson(join(workspace, ".claude", "settings.local.json"), "][");
  assert.equal((await verdicts({}, {}, workspace))?.claude?.state, "off", "a broken local file is no layer");
  rmSync(workspace, { recursive: true, force: true });
});

test("host: managed settings file and drop-ins, above everything, missing or broken is no layer", async () => {
  const betas = { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" };
  assert.equal((await verdicts({}, betas))?.claude?.state, "off", "missing: no layer");
  const file = join(managedDir, "managed-settings.json");
  writeJson(file, { env: { ENABLE_TOOL_SEARCH: "true" } });
  const on = await verdicts({}, betas);
  assert.equal(on?.claude?.state, "on");
  assert.match(on!.claude!.reason, new RegExp(`^Managed settings \\(${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\) keep tool search on, even with`));
  assert.equal(on?.codex?.state, "unknown", "not read for Codex");

  writeJson(join(managedDir, "managed-settings.d", "10-a.json"), { env: { ENABLE_TOOL_SEARCH: "auto" } });
  writeJson(join(managedDir, "managed-settings.d", "20-b.json"), { env: { ENABLE_TOOL_SEARCH: "false" } });
  writeJson(join(managedDir, "managed-settings.d", ".30-hidden.json"), { env: { ENABLE_TOOL_SEARCH: "true" } });
  writeJson(join(managedDir, "managed-settings.d", "40-notes.txt"), { env: { ENABLE_TOOL_SEARCH: "true" } });
  const dropIns = await verdicts({}, betas);
  assert.equal(dropIns?.claude?.state, "off", "drop-ins merge after the file, alphabetically; hidden and non-.json files skipped");
  assert.match(dropIns!.claude!.reason, /managed-settings\.d\/20-b\.json\) set ENABLE_TOOL_SEARCH=false$/);
  rmSync(join(managedDir, "managed-settings.d"), { recursive: true, force: true });

  writeJson(file, "{broken");
  assert.equal((await verdicts({}, betas))?.claude?.state, "off", "broken: no layer");
  rmSync(managedDir, { recursive: true, force: true });
});

test("host: managed settings with AI Router routing the built-in claude provider", async () => {
  const path = aiRouterSettingsPath(home);
  writeJson(path, { version: 1, values: { routeAgents: true } });
  writeJson(join(managedDir, "managed-settings.json"), { env: { ENABLE_TOOL_SEARCH: "true" } });
  const result = await verdicts({});
  assert.equal(result?.claude?.state, "on");
  assert.equal(result?.claude?.managed, true);
  rmSync(path);
  rmSync(managedDir, { recursive: true, force: true });
});

test("host: the managed settings directory per platform", () => {
  assert.equal(managedSettingsDir("darwin"), "/Library/Application Support/ClaudeCode");
  assert.equal(managedSettingsDir("linux"), "/etc/claude-code");
  assert.equal(managedSettingsDir("win32"), "C:\\Program Files\\ClaudeCode");
  // The macOS path as a real layout: a directory with a space in its name.
  const mac = join(home, "Library", "Application Support", "ClaudeCode");
  writeJson(join(mac, "managed-settings.json"), { env: { ENABLE_TOOL_SEARCH: "true" } });
  forgetAllFiles();
  assert.deepEqual(managedSettingsEnv(mac), [{ label: `Managed settings (${join(mac, "managed-settings.json")})`, env: { ENABLE_TOOL_SEARCH: "true" } }]);
  rmSync(join(home, "Library"), { recursive: true, force: true });
});

// ------------------------------------------------------------------ budget

const http = (name: string) => ({ name, transport: "http" as const });
const scope = (count: number, providerId = "claude"): ProfileScope => ({
  id: "/c.json", label: "Claude", provider: "claude", providerId, configPath: "/c.json",
  servers: Array.from({ length: count }, (_, index) => http(`s${index}`)), local: [],
});
const profileOf = (s: ProfileScope): WorkspaceProfile => ({ project: [], projectConfigPath: "", scopes: [s] });
const ON: ToolSearchVerdict = { state: "on", reason: "Claude Code's default", cli: "claude" };
const OFF: ToolSearchVerdict = { state: "off", reason: AI_ROUTER_REASON, cli: "claude" };
const UNKNOWN: ToolSearchVerdict = { state: "unknown", reason: "Codex defers MCP tools only when its model supports tool search, and the plugin cannot see the model", cli: "codex" };

test("tool search on: 61 Paseo tools no longer raise the tier; the server count still does", () => {
  const s = scope(3);
  const paseo = { tools: { claude: 61 } };
  assert.equal(costProfile(loadFor(profileOf(s), s, null, paseo)).tier, "attention", "today: 15 + 61 = 76 tools");
  const on = costProfile(loadFor(profileOf(s), s, null, paseo, { claude: ON }));
  assert.equal(on.tier, "ok");
  assert.equal(on.deferred, true);
  assert.equal(on.tools, 76, "the estimate is still reported");
  for (const [count, tier] of [[BUDGET_ATTENTION, "attention"], [BUDGET_PROBLEM, "problem"]] as const) {
    const big = scope(count);
    assert.equal(costProfile(loadFor(profileOf(big), big, null, paseo, { claude: ON })).tier, tier, `${count} servers`);
  }
});

test("tool search off or unknown: exactly today's tiers and numbers, plus deferred: false", () => {
  const s = scope(3);
  const paseo = { tools: { claude: 61 } };
  const today = costProfile(loadFor(profileOf(s), s, null, paseo));
  for (const verdict of [OFF, UNKNOWN]) {
    const cost = costProfile(loadFor(profileOf(s), s, null, paseo, { claude: verdict }));
    assert.deepEqual(cost, { ...today, deferred: false });
  }
});

test("unchanged numbers: without Paseo tools and without verdicts the profile is 0.10.0's, key for key", () => {
  for (const count of [0, 3, BUDGET_ATTENTION, BUDGET_PROBLEM, 25]) {
    const s = scope(count);
    const cost = costProfile(loadFor(profileOf(s), s, null));
    assert.deepEqual(Object.keys(cost), ["total", "builtIn", "paseoTools", "tools", "stdio", "http", "unknown", "project", "local", "user", "tier"]);
    assert.equal(cost.tools, count * 5);
    assert.equal(cost.total, count);
    assert.equal(cost.tier, count >= BUDGET_PROBLEM ? "problem" : count >= BUDGET_ATTENTION ? "attention" : "ok");
    assert.deepEqual(costProfile(loadsForWorkspace(profileOf(s), null)[0]!), cost, "the workspace path agrees");
  }
});

test("a verdict for another provider does not touch this load", () => {
  const s = scope(3);
  const load = loadFor(profileOf(s), s, null, null, { codex: ON });
  assert.equal(load.toolSearch, undefined);
  assert.equal("deferred" in costProfile(load), false);
});

test("the panel lines", () => {
  assert.equal(toolSearchLine(ON, 76), TOOL_SEARCH_ON_LINE);
  assert.equal(TOOL_SEARCH_ON_LINE, "Claude Code's tool search is on: tool definitions load up front only while they fit in 10% of the context window, and on demand past that.");
  assert.equal(
    toolSearchLine(OFF, 76),
    "AI Router re-routes this provider through OmniRoute (custom ANTHROPIC_BASE_URL) whenever its endpoint is up, so Claude Code's tool search is off and all 76 tool definitions load with the first prompt.",
  );
  assert.equal(toolSearchLine({ state: "off", reason: "Copilot has no documented tool search", cli: "copilot" }, 10), "Copilot has no documented tool search, so all 10 tool definitions load with the first prompt.");
  assert.match(toolSearchLine(UNKNOWN, 20), /, so this counts as if all 20 tool definitions load with the first prompt\.$/);
});
