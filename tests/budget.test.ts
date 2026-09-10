import assert from "node:assert/strict";
import test from "node:test";
import {
  BUDGET_ATTENTION,
  BUDGET_PROBLEM,
  budgetTier,
  costProfile,
  loadFor,
  loadsForWorkspace,
  scopeForProvider,
  userLevelNames,
  workspaceServerNames,
  type ProfileScope,
  type WorkspaceProfile,
} from "../shared/budget";

const http = (name: string) => ({ name, transport: "http" as const });
const stdio = (name: string) => ({ name, transport: "stdio" as const });

const claude: ProfileScope = {
  id: "/home/demo/.claude.json",
  label: "Claude · demo@example.com (primary)",
  provider: "claude",
  providerId: "claude",
  configPath: "/home/demo/.claude.json",
  servers: [http("jam"), http("linear"), stdio("digitalocean")],
  local: [http("zapier")],
};
const codex: ProfileScope = {
  id: "/home/demo/.codex/config.toml",
  label: "Codex · demo@example.com (primary)",
  provider: "codex",
  providerId: "codex",
  configPath: "/home/demo/.codex/config.toml",
  servers: [http("jam"), http("posthog")],
  local: [],
};
const slot: ProfileScope = { ...claude, id: "/home/demo/.agent-link/claude/work/.claude.json", label: "Claude · work (slot)", providerId: "", configPath: "/home/demo/.agent-link/claude/work/.claude.json" };

const profile: WorkspaceProfile = {
  project: [stdio("supabase"), http("jam")],
  projectConfigPath: "/home/demo/projects/data-glue/.mcp.json",
  scopes: [claude, codex, slot],
};

const off = { injectWorkspaceServers: false, providers: ["codex"] };
const on = { injectWorkspaceServers: true, providers: ["codex"] };

test("budget tiers follow the documented thresholds", () => {
  assert.equal(budgetTier(0), "ok");
  assert.equal(budgetTier(BUDGET_ATTENTION - 1), "ok");
  assert.equal(budgetTier(BUDGET_ATTENTION), "attention");
  assert.equal(budgetTier(BUDGET_PROBLEM - 1), "attention");
  assert.equal(budgetTier(BUDGET_PROBLEM), "problem");
  assert.equal(budgetTier(25), "problem");
});

test("a Claude agent loads local, project and user servers once each, local winning", () => {
  const load = loadFor(profile, claude, off);
  assert.deepEqual(
    load.servers.map((entry) => `${entry.name}:${entry.scope}`),
    ["zapier:local", "supabase:project", "jam:project", "linear:user", "digitalocean:user"],
  );
  assert.equal(load.projectIncluded, true);
  const cost = costProfile(load);
  assert.deepEqual({ ...cost }, { total: 5, stdio: 2, http: 3, unknown: 0, project: 2, local: 1, user: 2, tier: "ok" });
});

test("a Codex agent skips .mcp.json unless injection targets it", () => {
  const without = loadFor(profile, codex, off);
  assert.equal(without.projectIncluded, false);
  assert.match(without.projectNote, /turn on injection/);
  assert.deepEqual(without.servers.map((entry) => entry.name), ["jam", "posthog"]);

  const withInjection = loadFor(profile, codex, on);
  assert.equal(withInjection.projectIncluded, true);
  assert.deepEqual(withInjection.servers.map((entry) => `${entry.name}:${entry.scope}`), ["supabase:project", "jam:project", "posthog:user"]);

  const wrongProvider = loadFor(profile, codex, { injectWorkspaceServers: true, providers: ["claude"] });
  assert.equal(wrongProvider.projectIncluded, false);
  assert.match(wrongProvider.projectNote, /not for codex/);
});

test("user-level names are the servers that could be scoped per project", () => {
  assert.deepEqual(userLevelNames(loadFor(profile, claude, off)), ["linear", "digitalocean"]);
});

test("workspace loads cover only wired editors, heaviest first", () => {
  const loads = loadsForWorkspace(profile, off);
  assert.deepEqual(loads.map((load) => load.providerId), ["claude", "codex"]);
  assert.ok(loads[0].servers.length >= loads[1].servers.length);
});

test("no wired editor still counts the project servers", () => {
  const loads = loadsForWorkspace({ ...profile, scopes: [slot] }, off);
  assert.equal(loads.length, 1);
  assert.equal(loads[0].providerId, "");
  assert.deepEqual(loads[0].servers.map((entry) => entry.name), ["supabase", "jam"]);
});

test("a custom provider id matches its own config, a base id its primary", () => {
  const custom: ProfileScope = { ...claude, id: "/home/demo/.agent-link/claude/work/.claude.json", providerId: "claude-work", configPath: "/home/demo/.agent-link/claude/work/.claude.json" };
  const scoped = { ...profile, scopes: [claude, custom, codex] };
  assert.equal(scopeForProvider(scoped, "claude-work")?.id, custom.id);
  assert.equal(scopeForProvider(scoped, "claude")?.id, claude.id);
  assert.equal(scopeForProvider(scoped, "grok"), null);
});

test("workspace server names union every wired load plus the project file", () => {
  const names = [...workspaceServerNames(profile, off)].sort();
  assert.deepEqual(names, ["digitalocean", "jam", "linear", "posthog", "supabase", "zapier"]);
});

test("the reported configuration lands over budget", () => {
  // 25 user-level servers, one project server: what the bug report described.
  const many: ProfileScope = { ...claude, servers: Array.from({ length: 25 }, (_, index) => http(`s${index}`)), local: [] };
  const cost = costProfile(loadFor({ ...profile, scopes: [many] }, many, off));
  assert.equal(cost.total, 27);
  assert.equal(cost.user, 25);
  assert.equal(cost.tier, "problem");
});
