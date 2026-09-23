/** Paseo's built-in tools per provider, as the workspace RPC reports them (shared/contracts.ts `PaseoToolsLoad`). */
export type PaseoToolsLike = { tools: Record<string, number> };

/** The two injection fields the count depends on; accepts the RPC's string-typed copy as well as the settings document. */
export type InjectionLike = { injectWorkspaceServers: boolean; providers: readonly string[] };

/** Mirrors `injectionTargets` in shared/settings.ts, without pinning the provider union. */
function injects(values: InjectionLike, providerId: string): boolean {
  return values.injectWorkspaceServers && values.providers.includes(providerId);
}

/**
 * What an agent started in a workspace actually loads, counted from the
 * configs rather than guessed. Every MCP server's tool definitions land in the
 * agent's context before it reads a line of code, so the count is a budget.
 *
 * Pure so it can be unit-tested; the server resolves the files, the client
 * renders the verdict.
 */

export type Transport = "stdio" | "http" | "unknown";

export type ProfileServer = { name: string; transport: Transport };

/** One editor config on the host, with what it defines for every workspace and for this one. */
export type ProfileScope = {
  id: string;
  label: string;
  /** Base CLI: claude | codex | kimi | grok. */
  provider: string;
  /** Paseo provider id an agent can run as; "" for a slot no provider is wired to. */
  providerId: string;
  configPath: string;
  /** User-level definitions: loaded in every workspace. */
  servers: ProfileServer[];
  /** Claude's per-directory ("local") definitions for this workspace only. */
  local: ProfileServer[];
};

export type WorkspaceProfile = {
  /** This workspace's `.mcp.json` servers. */
  project: ProfileServer[];
  projectConfigPath: string;
  scopes: ProfileScope[];
};

export type LoadScope = "project" | "local" | "user";

export type LoadedServer = ProfileServer & { scope: LoadScope; configPath: string };

export type WorkspaceLoad = {
  /** Paseo provider id the count is for, or "" when no editor is wired. */
  providerId: string;
  provider: string;
  label: string;
  servers: LoadedServer[];
  /** Whether the project `.mcp.json` counts for this provider, and why not if it does not. */
  projectIncluded: boolean;
  projectNote: string;
  /**
   * Tools this provider's agents get from Paseo's own server, "Paseo tools
   * (built in)": one more server in the count, with a known tool count. 0 when
   * the daemon does not add it for this provider, or the host did not say.
   */
  paseoTools: number;
};

// ------------------------------------------------------------------ thresholds

/**
 * Server counts at which the panel speaks up. Evidence, not vibes:
 *
 *  - Cursor caps an agent at 40 MCP tools and warns that "some models may not
 *    respect more than 40 tools". At a conservative five tools per server that
 *    is eight servers, so eight is where the panel starts counting out loud.
 *  - Anthropic measured roughly 77K tokens of tool definitions for 50+ tools
 *    (~1.5K per tool) when it shipped MCP tool search in Claude Code 2.1.7,
 *    which defers definitions once they pass 10% of the context window.
 *    Sixteen servers at five tools each is 80 tools, about 120K tokens, more
 *    than half of a 200K window spent before any work. The report that
 *    prompted this (25 user-level servers, Paseo agents dying with "Prompt is
 *    too long" before their first tool call) sits well above that line.
 */
export const BUDGET_ATTENTION = 8;
export const BUDGET_PROBLEM = 16;

export type BudgetTier = "ok" | "attention" | "problem";

export function budgetTier(count: number): BudgetTier {
  if (count >= BUDGET_PROBLEM) return "problem";
  if (count >= BUDGET_ATTENTION) return "attention";
  return "ok";
}

/**
 * The same two lines in tools, for when a real tool count is known. The server
 * thresholds assume five tools per server; Paseo's built-in server alone hands
 * an agent 39 tools, 61 with browser tools, so counting it as "one server"
 * would hide most of its cost. 40 is Cursor's cap and 80 the line sixteen
 * servers stand for above. For a load without Paseo tools the estimate is five
 * per server, so this tier always equals the server tier and nothing changes.
 */
export const TOOLS_PER_SERVER_GUESS = 5;
export const BUDGET_TOOLS_ATTENTION = BUDGET_ATTENTION * TOOLS_PER_SERVER_GUESS;
export const BUDGET_TOOLS_PROBLEM = BUDGET_PROBLEM * TOOLS_PER_SERVER_GUESS;

export function toolBudgetTier(tools: number): BudgetTier {
  if (tools >= BUDGET_TOOLS_PROBLEM) return "problem";
  if (tools >= BUDGET_TOOLS_ATTENTION) return "attention";
  return "ok";
}

const TIER_RANK: Record<BudgetTier, number> = { ok: 0, attention: 1, problem: 2 };

function worseTier(a: BudgetTier, b: BudgetTier): BudgetTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

// ------------------------------------------------------------------ resolution

/** Whether the base CLI reads the project's `.mcp.json` on its own. Codex, Kimi and Grok do not. */
function readsProjectConfig(provider: string): boolean {
  return provider === "claude";
}

/**
 * The servers one agent loads: the workspace's `.mcp.json` (when its CLI
 * reads it, or the injection hook adds it), the editor's per-directory
 * definitions, and the editor's user-level definitions. A name defined at two
 * levels loads once; Claude resolves local over project over user, so that is
 * the order kept here.
 */
export function loadFor(
  profile: WorkspaceProfile,
  scope: ProfileScope | null,
  injection: InjectionLike | null,
  paseo: PaseoToolsLike | null = null,
): WorkspaceLoad {
  const provider = scope?.provider ?? "";
  const providerId = scope?.providerId ?? "";
  const native = readsProjectConfig(provider);
  const injected = Boolean(injection && providerId && injects(injection, providerId));
  const projectIncluded = !scope || native || injected;
  const projectNote = projectIncluded
    ? ""
    : injection?.injectWorkspaceServers
      ? `Injection is on but not for ${providerId}; its agents do not read .mcp.json`
      : `${provider} agents do not read .mcp.json; turn on injection to add it`;

  const servers: LoadedServer[] = [];
  const seen = new Set<string>();
  const add = (list: ProfileServer[], scopeName: LoadScope, configPath: string) => {
    for (const entry of list) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      servers.push({ ...entry, scope: scopeName, configPath });
    }
  };
  if (scope) add(scope.local, "local", scope.configPath);
  if (projectIncluded) add(profile.project, "project", profile.projectConfigPath);
  if (scope) add(scope.servers, "user", scope.configPath);
  const paseoTools = providerId ? paseo?.tools[providerId] ?? 0 : 0;
  return { providerId, provider, label: scope?.label ?? "", servers, projectIncluded, projectNote, paseoTools };
}

/** Scopes an agent can actually run as: a destination wired to a Paseo provider id. */
export function wiredScopes(profile: WorkspaceProfile): ProfileScope[] {
  return profile.scopes.filter((scope) => scope.providerId !== "");
}

/**
 * The scope an agent of `providerId` reads. A custom provider id that extends
 * claude or codex is matched exactly; the bare base id falls back to that
 * CLI's primary config, which is what Paseo launches when nothing overrides it.
 */
export function scopeForProvider(profile: WorkspaceProfile, providerId: string): ProfileScope | null {
  return (
    profile.scopes.find((scope) => scope.providerId === providerId) ??
    profile.scopes.find((scope) => scope.providerId === scope.provider && scope.provider === providerId) ??
    null
  );
}

/** One load per wired editor, heaviest first, so a workspace panel can lead with the worst case. */
export function loadsForWorkspace(
  profile: WorkspaceProfile,
  injection: InjectionLike | null,
  paseo: PaseoToolsLike | null = null,
): WorkspaceLoad[] {
  const scopes = wiredScopes(profile);
  if (scopes.length === 0) return [loadFor(profile, null, injection, paseo)];
  const weight = (load: WorkspaceLoad) => load.servers.length + (load.paseoTools > 0 ? 1 : 0);
  return scopes.map((scope) => loadFor(profile, scope, injection, paseo)).sort((a, b) => weight(b) - weight(a));
}

// ------------------------------------------------------------------ cost profile

export type CostProfile = {
  /** Every server the agent loads, Paseo's built-in one included. */
  total: number;
  /** 1 when Paseo tools are part of the load. */
  builtIn: number;
  /** Tools from Paseo's built-in server, a real count. */
  paseoTools: number;
  /** Tool estimate the tier reads: five per MCP server plus the real Paseo count. */
  tools: number;
  stdio: number;
  http: number;
  unknown: number;
  project: number;
  local: number;
  user: number;
  tier: BudgetTier;
};

/** Counts by transport and by where the definition lives. */
export function costProfile(load: WorkspaceLoad): CostProfile {
  const count = (predicate: (entry: LoadedServer) => boolean) => load.servers.filter(predicate).length;
  const builtIn = load.paseoTools > 0 ? 1 : 0;
  const tools = load.servers.length * TOOLS_PER_SERVER_GUESS + load.paseoTools;
  return {
    total: load.servers.length + builtIn,
    builtIn,
    paseoTools: load.paseoTools,
    tools,
    stdio: count((entry) => entry.transport === "stdio"),
    http: count((entry) => entry.transport === "http"),
    unknown: count((entry) => entry.transport === "unknown"),
    project: count((entry) => entry.scope === "project"),
    local: count((entry) => entry.scope === "local"),
    user: count((entry) => entry.scope === "user"),
    tier: worseTier(budgetTier(load.servers.length), toolBudgetTier(tools)),
  };
}

/** User-level servers an agent here loads: the ones that could be scoped to a project instead. */
export function userLevelNames(load: WorkspaceLoad): string[] {
  return load.servers.filter((entry) => entry.scope === "user").map((entry) => entry.name);
}

/** Every server name any agent in this workspace could load, across all wired editors. */
export function workspaceServerNames(profile: WorkspaceProfile, injection: InjectionLike | null): Set<string> {
  const names = new Set<string>();
  for (const load of loadsForWorkspace(profile, injection)) for (const entry of load.servers) names.add(entry.name);
  // Project servers count for the workspace even when no editor reads them yet.
  for (const entry of profile.project) names.add(entry.name);
  return names;
}
