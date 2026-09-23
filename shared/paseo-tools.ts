/**
 * Paseo's own MCP tools: the `paseo` server every daemon runs at `/mcp/agents`
 * and, with `daemon.mcp.injectIntoAgents` on, adds to every agent it starts.
 * Pure: the host reads and patches the daemon config, the panels render this.
 *
 * How the daemon decides what an agent gets (Paseo 0.9.1, @getpaseo/server):
 *
 *  - `mcp.enabled` (default on; only `--no-mcp` or `daemon.mcp.enabled` in
 *    config.json turn it off, the config API cannot) and `mcp.injectIntoAgents`
 *    together decide whether any agent gets the server
 *    (server/bootstrap.js: `setPaseoToolsEnabled(mcpEnabled && inject)`).
 *  - `providers.<id>.paseoTools.enabled` turns it off for one provider; absent
 *    means on (agent/paseo-tool-policy.js: `policy?.enabled !== false`).
 *  - `providers.<id>.paseoTools.disabledTools` lists bare tool names
 *    (`list_agents`, not `mcp__paseo__list_agents`) to leave out
 *    (`!policy?.disabledTools?.includes(toolName)`).
 *  - `browserTools.enabled` (default off) decides whether the `browser_*`
 *    tools are registered at all (agent/tools/paseo-tools.js).
 *
 * The policy is copied into an agent when it is created or reloaded
 * (agent/agent-manager.js), so a change applies to agents started after it.
 *
 * The daemon offers no tool list to a plugin: `/mcp/agents` wants a per-run
 * token handed only to agents whenever a daemon password is set. So the list
 * is this catalogue, copied from the daemon's `registerTool` calls, and the UI
 * says which Paseo version it matches.
 */

/** The Paseo release this catalogue was copied from. */
export const PASEO_TOOLS_AS_OF = "0.9.1";

/**
 * Paseo's built-in providers as of 0.9.1 (@getpaseo/protocol provider-config.js
 * `BUILTIN_PROVIDER_IDS`). Each is on unless its config entry says
 * `enabled: false` (server provider-registry.js: `enabledByDefault ?? true`,
 * and no built-in sets it), so each can run agents with no entry at all.
 */
export const PASEO_BUILTIN_PROVIDERS = ["claude", "codex", "copilot", "opencode", "pi", "omp"] as const;

/** The server's name in agent configs and tool prefixes (`mcp__paseo__*`). */
export const PASEO_SERVER_NAME = "paseo";

/** How the load lists it next to the editor-defined servers. */
export const PASEO_TOOLS_LABEL = "Paseo tools (built in)";

export type PaseoToolGroup = "agents" | "terminals" | "schedules" | "workspaces" | "browser";

export const PASEO_TOOL_GROUPS: Array<{ id: PaseoToolGroup; label: string }> = [
  { id: "agents", label: "Agents" },
  { id: "terminals", label: "Terminals" },
  { id: "schedules", label: "Schedules and heartbeats" },
  { id: "workspaces", label: "Workspaces" },
  { id: "browser", label: "Browser" },
];

export type PaseoToolInfo = { name: string; title: string; description: string; group: PaseoToolGroup };

const tool = (group: PaseoToolGroup, name: string, title: string, description: string): PaseoToolInfo => ({ name, title, description, group });

/**
 * Every tool the built-in server registers for an agent, in registration
 * order. `speak` is left out: it only exists for voice sessions and the
 * daemon never lets a policy turn it off.
 */
export const PASEO_TOOL_CATALOG: readonly PaseoToolInfo[] = [
  tool("workspaces", "create_workspace", "Create workspace", "Create a workspace from an existing checkout or a new Paseo-managed worktree."),
  tool("workspaces", "list_workspaces", "List workspaces", "List active workspaces."),
  tool("workspaces", "archive_workspace", "Archive workspace", "Archive a workspace and everything it owns."),
  tool("agents", "create_agent", "Create agent", "Create an agent, by default a subagent in the caller's workspace."),
  tool("agents", "send_agent_prompt", "Send agent prompt", "Send a task to a running agent."),
  tool("agents", "get_agent_status", "Get agent status", "Latest snapshot for an agent: lifecycle, capabilities, pending permissions."),
  tool("agents", "list_agents", "List agents", "List recent agents as compact metadata."),
  tool("agents", "cancel_agent", "Cancel agent run", "Abort an agent's current run and keep the agent."),
  tool("agents", "archive_agent", "Archive agent", "Archive an agent, interrupting it if running."),
  tool("agents", "kill_agent", "Kill agent", "Terminate an agent session permanently."),
  tool("agents", "update_agent", "Update agent", "Update an agent's name, labels or runtime settings."),
  tool("workspaces", "rename_workspace", "Rename workspace", "Set a workspace's visible title."),
  tool("workspaces", "list_workspace_scripts", "List workspace scripts", "Workspace scripts with lifecycle, port, proxy URL and health."),
  tool("workspaces", "start_workspace_script", "Start workspace script", "Start a configured workspace script."),
  tool("workspaces", "stop_workspace_script", "Stop workspace script", "Stop a running workspace script."),
  tool("terminals", "list_terminals", "List terminals", "List terminals for a directory or everywhere."),
  tool("terminals", "create_terminal", "Create terminal", "Create a terminal session for a directory."),
  tool("terminals", "kill_terminal", "Kill terminal", "Kill a terminal session."),
  tool("terminals", "capture_terminal", "Capture terminal", "Read plain-text output lines from a terminal."),
  tool("terminals", "send_terminal_keys", "Send terminal keys", "Send text or special keys to a terminal."),
  tool("schedules", "create_schedule", "Create schedule", "A recurring schedule that starts a new agent on a cron cadence."),
  tool("schedules", "create_heartbeat", "Create heartbeat", "A recurring heartbeat that prompts the calling agent on a cron cadence."),
  tool("schedules", "delete_heartbeat", "Delete heartbeat", "Delete one of the caller's heartbeats."),
  tool("schedules", "list_schedules", "List schedules", "List every schedule the daemon manages."),
  tool("schedules", "inspect_schedule", "Inspect schedule", "A schedule and its run history."),
  tool("schedules", "pause_schedule", "Pause schedule", "Pause an active schedule."),
  tool("schedules", "resume_schedule", "Resume schedule", "Resume a paused schedule."),
  tool("schedules", "delete_schedule", "Delete schedule", "Delete a schedule permanently."),
  tool("schedules", "update_schedule", "Update schedule", "Change the given fields of a schedule."),
  tool("schedules", "schedule_logs", "Schedule logs", "Run history for a schedule."),
  tool("schedules", "run_schedule_once", "Run schedule once", "Run a schedule now without changing its cadence."),
  tool("agents", "list_providers", "List providers", "Configured agent providers, availability and modes."),
  tool("agents", "list_models", "List models", "Models for an agent provider."),
  tool("agents", "list_profiles", "List agent profiles", "Named provider/model/mode bundles set up for agents."),
  tool("agents", "inspect_provider", "Inspect provider", "A provider's modes and feature settings."),
  tool("agents", "get_agent_activity", "Get agent activity", "Recent timeline entries for an agent, summarised."),
  tool("agents", "set_agent_mode", "Set agent session mode", "Switch an agent's mode (plan, auto, read-only …)."),
  tool("agents", "list_pending_permissions", "List pending permissions", "Pending permission requests across all agents."),
  tool("agents", "respond_to_permission", "Respond to permission", "Approve or deny a pending permission request."),
  tool("browser", "browser_list_tabs", "List browser tabs", "Open Paseo browser tabs for the agent's workspace."),
  tool("browser", "browser_new_tab", "New browser tab", "Open a Paseo browser tab in the background."),
  tool("browser", "browser_snapshot", "Browser snapshot", "A model-readable snapshot of a tab, with element refs."),
  tool("browser", "browser_click", "Click", "Click an element in a tab."),
  tool("browser", "browser_fill", "Fill", "Fill an input-like element."),
  tool("browser", "browser_wait", "Wait", "Wait until a tab shows text or reaches a URL."),
  tool("browser", "browser_type", "Type", "Type text into an element or the focused one."),
  tool("browser", "browser_keypress", "Keypress", "Send a keypress to an element or the focused one."),
  tool("browser", "browser_navigate", "Navigate", "Load a URL in a tab."),
  tool("browser", "browser_back", "Back", "Go back in a tab."),
  tool("browser", "browser_forward", "Forward", "Go forward in a tab."),
  tool("browser", "browser_reload", "Reload", "Reload a tab."),
  tool("browser", "browser_screenshot", "Screenshot", "Capture a PNG of a tab."),
  tool("browser", "browser_upload", "Upload", "Set workspace files on a file input."),
  tool("browser", "browser_hover", "Hover", "Hover an element."),
  tool("browser", "browser_select", "Select", "Set a select element's value."),
  tool("browser", "browser_drag", "Drag", "Drag one element onto another."),
  tool("browser", "browser_logs", "Console and network", "Recent console messages and network entries."),
  tool("browser", "browser_evaluate", "Evaluate", "Run a JavaScript function in a tab."),
  tool("browser", "browser_scroll", "Scroll", "Scroll a tab."),
  tool("browser", "browser_resize", "Resize", "Resize a tab's viewport."),
  tool("browser", "browser_close_tab", "Close tab", "Close a Paseo browser tab."),
];

const CATALOG_NAMES = new Set(PASEO_TOOL_CATALOG.map((entry) => entry.name));

export function isBrowserTool(name: string): boolean {
  return name.startsWith("browser_");
}

// ------------------------------------------------------------------ reading

export type ProviderToolsPolicy = { enabled?: boolean; disabledTools?: string[] };

/** The daemon settings this module reads, pulled out of `paseo.config.get()`. */
export type DaemonToolsConfig = {
  mcpEnabled: boolean;
  injectIntoAgents: boolean;
  browserTools: boolean;
  /** Every provider entry in the config, whether or not it sets `paseoTools`. */
  providers: Record<string, { enabled?: boolean; paseoTools?: ProviderToolsPolicy }>;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
}

/**
 * The fields that matter, from the config as `paseo.config.get()` returns it
 * (flattened `providers`; the nested `agents.providers` spelling is read too).
 * Missing fields take the daemon's own defaults: MCP on (config.js `?? true`),
 * injection off (config.js:340 `?? false`), browser tools off.
 */
export function readDaemonToolsConfig(config: unknown): DaemonToolsConfig {
  const root = record(config);
  const mcp = record(root.mcp);
  const browser = record(root.browserTools);
  const rawProviders = record(root.providers ?? record(root.agents).providers);
  const providers: DaemonToolsConfig["providers"] = {};
  for (const [id, raw] of Object.entries(rawProviders)) {
    const entry = record(raw);
    const policy = record(entry.paseoTools);
    const disabledTools = stringList(policy.disabledTools);
    providers[id] = {
      ...(typeof entry.enabled === "boolean" ? { enabled: entry.enabled } : {}),
      ...(entry.paseoTools !== undefined
        ? {
            paseoTools: {
              ...(typeof policy.enabled === "boolean" ? { enabled: policy.enabled } : {}),
              ...(disabledTools ? { disabledTools } : {}),
            },
          }
        : {}),
    };
  }
  return {
    mcpEnabled: mcp.enabled !== false,
    injectIntoAgents: mcp.injectIntoAgents === true,
    browserTools: browser.enabled === true,
    providers,
  };
}

// ------------------------------------------------------------------ state

export type PaseoToolsBlocker = "" | "mcp-off" | "inject-off";

export type PaseoProviderState = {
  id: string;
  /** Whether the daemon config has an entry for it; a built-in runs without one. */
  configured: boolean;
  /** `paseoTools.enabled` as the daemon reads it: absent is on. */
  enabled: boolean;
  /** Bare names from `paseoTools.disabledTools`, in the config's order, unknown ones kept. */
  disabledTools: string[];
  /** How many tools a new agent of this provider gets; 0 when it gets none. */
  tools: number;
};

export type PaseoToolState = PaseoToolInfo & {
  /** Provider ids whose new agents get this tool. */
  onFor: string[];
};

export type PaseoToolsState = {
  /** The daemon adds the server to agents at all (`mcp.enabled` and `mcp.injectIntoAgents`). */
  injected: boolean;
  mcpEnabled: boolean;
  injectIntoAgents: boolean;
  blocker: PaseoToolsBlocker;
  browserTools: boolean;
  providers: PaseoProviderState[];
  tools: PaseoToolState[];
  /** Tools a provider with no `paseoTools` entry gets: the count for any provider id not listed. */
  defaultTools: number;
  asOf: string;
};

export function isBuiltinProvider(id: string): boolean {
  return (PASEO_BUILTIN_PROVIDERS as readonly string[]).includes(id);
}

/**
 * Providers that can run an agent here, so worth a switch: the six built-ins
 * and every config entry, less any turned off. `known` ids (the editor list's
 * wired provider ids) count only when they are one of those: an editor found
 * on disk (`~/.kimi-code`, `~/.grok`) that Paseo has no provider for gets no
 * Paseo tools. Built-ins first in Paseo's order, then the rest by name.
 */
export function paseoToolProviders(config: DaemonToolsConfig, known: readonly string[] = []): string[] {
  const runnable = (id: string) => Boolean(id) && (isBuiltinProvider(id) || id in config.providers) && config.providers[id]?.enabled !== false;
  const ids = new Set<string>();
  for (const id of [...PASEO_BUILTIN_PROVIDERS, ...Object.keys(config.providers), ...known]) if (runnable(id)) ids.add(id);
  const order = (id: string) => {
    const index = (PASEO_BUILTIN_PROVIDERS as readonly string[]).indexOf(id);
    return index === -1 ? PASEO_BUILTIN_PROVIDERS.length : index;
  };
  return [...ids].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
}

/** Whether a new agent of `providerId` gets `name`, the way agent/paseo-tool-policy.js decides it. */
export function toolOnFor(config: DaemonToolsConfig, providerId: string, name: string): boolean {
  if (!config.mcpEnabled || !config.injectIntoAgents) return false;
  if (isBrowserTool(name) && !config.browserTools) return false;
  const policy = config.providers[providerId]?.paseoTools;
  if (policy?.enabled === false) return false;
  return !(policy?.disabledTools ?? []).includes(name);
}

export function resolvePaseoTools(config: DaemonToolsConfig, providerIds: readonly string[]): PaseoToolsState {
  const injected = config.mcpEnabled && config.injectIntoAgents;
  const tools = PASEO_TOOL_CATALOG.map((entry) => ({
    ...entry,
    onFor: providerIds.filter((id) => toolOnFor(config, id, entry.name)),
  }));
  const providers = providerIds.map((id) => {
    const policy = config.providers[id]?.paseoTools;
    return {
      id,
      configured: id in config.providers,
      enabled: policy?.enabled !== false,
      disabledTools: [...(policy?.disabledTools ?? [])],
      tools: tools.filter((entry) => entry.onFor.includes(id)).length,
    };
  });
  return {
    injected,
    mcpEnabled: config.mcpEnabled,
    injectIntoAgents: config.injectIntoAgents,
    blocker: !config.mcpEnabled ? "mcp-off" : !config.injectIntoAgents ? "inject-off" : "",
    browserTools: config.browserTools,
    providers,
    tools,
    // An id with no entry: what `toolOnFor` gives a provider the config does not name.
    defaultTools: PASEO_TOOL_CATALOG.filter((entry) => toolOnFor({ ...config, providers: {} }, "", entry.name)).length,
    asOf: PASEO_TOOLS_AS_OF,
  };
}

/**
 * Tools a new agent of `providerId` gets. A listed provider has its own count;
 * any other id gets what a provider with no entry gets (`defaultTools`), as the
 * daemon would give it, so the chip, the agent panel and the card agree.
 */
export function paseoToolCount(
  state: (Pick<PaseoToolsState, "providers"> & { defaultTools?: number }) | null | undefined,
  providerId: string | null | undefined,
): number {
  if (!state || !providerId) return 0;
  return state.providers.find((entry) => entry.id === providerId)?.tools ?? state.defaultTools ?? 0;
}

export function blockerText(blocker: PaseoToolsBlocker): string {
  if (blocker === "mcp-off") {
    return "Paseo's MCP server is off on this host (daemon.mcp.enabled is false, or the daemon runs with --no-mcp), so no agent gets Paseo tools. That setting is only in config.json and the launch flags; this switch cannot change it.";
  }
  if (blocker === "inject-off") return "Not added to agents: \"Enable Paseo tools\" is off for this host.";
  return "";
}

// ------------------------------------------------------------------ writing

export type PaseoToolsChange = {
  injectIntoAgents?: boolean;
  browserTools?: boolean;
  providers?: Array<{ id: string; enabled?: boolean; tools?: Record<string, boolean> }>;
};

/** The subset of `MutableDaemonConfigPatch` this module writes. */
export type PaseoToolsPatch = {
  mcp?: { injectIntoAgents: boolean };
  browserTools?: { enabled: boolean };
  providers?: Record<string, { paseoTools: ProviderToolsPolicy }>;
};

/**
 * The smallest daemon patch that makes `change` true, or null when it already
 * is. Only changed fields are sent. `disabledTools` is sent whole because the
 * daemon replaces the array; it starts from the current list, so names the
 * change does not mention (including ones this catalogue does not know) stay
 * where they are. A provider patch carries only `paseoTools`: the daemon merges
 * it into the provider entry and its `paseoTools` object, so every other
 * provider field is left alone (daemon-config-store.js,
 * `applyMutableProviderConfigToOverrides`).
 */
export function buildPaseoToolsPatch(config: DaemonToolsConfig, change: PaseoToolsChange): PaseoToolsPatch | null {
  const patch: PaseoToolsPatch = {};
  if (change.injectIntoAgents !== undefined && change.injectIntoAgents !== config.injectIntoAgents) {
    patch.mcp = { injectIntoAgents: change.injectIntoAgents };
  }
  if (change.browserTools !== undefined && change.browserTools !== config.browserTools) {
    patch.browserTools = { enabled: change.browserTools };
  }
  for (const entry of change.providers ?? []) {
    const current = config.providers[entry.id]?.paseoTools;
    const policy: ProviderToolsPolicy = {};
    if (entry.enabled !== undefined && entry.enabled !== (current?.enabled !== false)) policy.enabled = entry.enabled;
    if (entry.tools && Object.keys(entry.tools).length > 0) {
      const before = current?.disabledTools ?? [];
      const next = mergeDisabledTools(before, entry.tools);
      if (next.length !== before.length || next.some((name, index) => name !== before[index])) policy.disabledTools = next;
    }
    if (Object.keys(policy).length === 0) continue;
    patch.providers = { ...patch.providers, [entry.id]: { paseoTools: policy } };
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** One tool on or off for each of `providerIds`: "All providers" passes every listed id, built-ins with no entry included. */
export function toolChange(providerIds: readonly string[], name: string, on: boolean): PaseoToolsChange {
  return { providers: providerIds.map((id) => ({ id, tools: { [name]: on } })) };
}

/**
 * Providers whose saved `disabledTools` is not the list this write sent:
 * another client wrote the same list at the same moment. Our own names are
 * checked by `patchMismatch`; this only says the rest of the list moved.
 */
export function concurrentListChanges(after: DaemonToolsConfig, patch: PaseoToolsPatch): string[] {
  return Object.entries(patch.providers ?? {})
    .filter(([id, { paseoTools }]) => {
      if (!paseoTools.disabledTools) return false;
      const saved = after.providers[id]?.paseoTools?.disabledTools ?? [];
      return saved.length !== paseoTools.disabledTools.length || saved.some((name, index) => name !== paseoTools.disabledTools![index]);
    })
    .map(([id]) => id);
}

/** `current` with the names set false added (at the end) and the names set true removed. */
export function mergeDisabledTools(current: readonly string[], set: Record<string, boolean>): string[] {
  const next = current.filter((name) => set[name] !== true);
  for (const [name, on] of Object.entries(set)) if (!on && !next.includes(name)) next.push(name);
  return next;
}

/** Names the catalogue does not know; a write refuses them so a typo never lands in the config. */
export function unknownTools(change: PaseoToolsChange): string[] {
  const names = (change.providers ?? []).flatMap((entry) => Object.keys(entry.tools ?? {}));
  return [...new Set(names.filter((name) => !CATALOG_NAMES.has(name)))];
}

/** What the read-back must show for the write to count; the first mismatch, or "". */
export function patchMismatch(after: DaemonToolsConfig, change: PaseoToolsChange): string {
  if (change.injectIntoAgents !== undefined && after.injectIntoAgents !== change.injectIntoAgents) {
    return `"Enable Paseo tools" reads back as ${after.injectIntoAgents ? "on" : "off"}`;
  }
  if (change.browserTools !== undefined && after.browserTools !== change.browserTools) {
    return `browser tools read back as ${after.browserTools ? "on" : "off"}`;
  }
  for (const entry of change.providers ?? []) {
    const policy = after.providers[entry.id]?.paseoTools;
    if (entry.enabled !== undefined && (policy?.enabled !== false) !== entry.enabled) {
      return `Paseo tools for ${entry.id} read back as ${entry.enabled ? "off" : "on"}`;
    }
    for (const [name, on] of Object.entries(entry.tools ?? {})) {
      const off = (policy?.disabledTools ?? []).includes(name);
      if (off === on) return `${name} for ${entry.id} reads back as ${off ? "off" : "on"}`;
    }
  }
  return "";
}
