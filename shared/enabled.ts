/**
 * Per-workspace on/off for the servers an agent loads, as Claude Code spells it
 * in `~/.claude.json`. Pure: the server reads and writes the file, the panels
 * render the verdict.
 *
 * Claude Code keeps one entry per project directory under `projects`, keyed by
 * the directory a session starts in, and two families of switch inside it:
 *
 *  - `disabledMcpServers`: an opt-out list of names. It governs servers the
 *    project did not define: user-level (`mcpServers` at the top of the file),
 *    local (`projects[<dir>].mcpServers`), plugin and connector servers. A name
 *    in the list is not loaded by sessions started in that directory, and no
 *    other directory is affected. `/mcp disable <name>` writes the same list.
 *    Its sibling `enabledMcpServers` is the opposite-sense opt-in list for
 *    default-off built-ins and is never written here.
 *  - `enabledMcpjsonServers` / `disabledMcpjsonServers` (note the "json"):
 *    the approval lists for the servers a project's own `.mcp.json` defines. A
 *    name in neither list, without `enableAllProjectMcpServers`, means Claude
 *    asks at launch.
 *
 * Codex has no per-directory switch of its own: `enabled = false` on a
 * `[mcp_servers.*]` block in `config.toml` is global, and Paseo's Codex
 * provider sends its `mcp_servers` as a config override that Codex layers on
 * top of `config.toml`, so a user-level server loads whatever the agent's
 * record says. The one place this plugin does decide what a Codex agent loads
 * is the servers it injects from `.mcp.json`: those are only there because the
 * `agent.create` hook added them, so leaving one out is a real per-workspace
 * switch. That set lives in the plugin's own host file (`injection` lever).
 * Kimi and Grok have no switch either. Where there is none the verdict says
 * so, with the reason, so a panel can explain instead of drawing a toggle that
 * would do nothing.
 */
import type { LoadScope } from "./budget";

export type EnabledState = "enabled" | "disabled" | "undecided";

export type Lever = "disabledMcpServers" | "mcpjsonServers" | "injection" | "none";

export type SwitchVerdict = {
  state: EnabledState;
  /** Whether a toggle here changes what an agent in this directory loads. */
  writable: boolean;
  lever: Lever;
  /** One sentence a panel can show next to the switch (or instead of it). */
  reason: string;
};

// --------------------------------------------------------------- capability

/** Which lever, if any, a provider has for a server loaded at `scope`. */
export function leverFor(provider: string, scope: LoadScope): Lever {
  if (provider === "claude") return scope === "project" ? "mcpjsonServers" : "disabledMcpServers";
  // Any provider the hook injects for can have an injected server left out.
  if (scope === "project" && (provider === "codex" || provider === "claude")) return "injection";
  return "none";
}

export function noSwitchReason(provider: string, scope: LoadScope): string {
  if (provider === "codex") {
    return "Codex reads config.toml on top of what Paseo passes it, so nothing per workspace can turn this off: enabled = false in config.toml turns it off everywhere. Use Servers to remove it, or edit config.toml.";
  }
  return `${provider || "This editor"} has no per-workspace switch for an MCP server${scope === "project" ? " it injects" : ""}.`;
}

// ------------------------------------------------------------------- entry

/** The keys of a `projects[<dir>]` entry this module reads. Every other key passes through untouched. */
export type ClaudeProjectEntry = {
  disabledMcpServers?: string[];
  enableAllProjectMcpServers?: boolean;
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
  [key: string]: unknown;
};

/** The parts of `~/.claude.json` this module reads. Every other key passes through untouched. */
export type ClaudeConfig = {
  projects?: Record<string, ClaudeProjectEntry>;
  [key: string]: unknown;
};

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** State of a user, local, plugin or connector server for a directory: off when opted out, on otherwise. */
export function claudeInheritedState(entry: ClaudeProjectEntry | null | undefined, name: string): EnabledState {
  return names(entry?.disabledMcpServers).includes(name) ? "disabled" : "enabled";
}

/** State of a `.mcp.json` server for a directory: deny wins, then allow (or allow-all), else Claude asks at launch. */
export function claudeProjectState(entry: ClaudeProjectEntry | null | undefined, name: string): EnabledState {
  if (!entry) return "undecided";
  if (names(entry.disabledMcpjsonServers).includes(name)) return "disabled";
  if (entry.enableAllProjectMcpServers === true || names(entry.enabledMcpjsonServers).includes(name)) return "enabled";
  return "undecided";
}

/**
 * The verdict a panel shows for one server an agent of `provider` loads at
 * `scope` in the directory `entry` belongs to. `injectionDisabled` is the
 * plugin's own per-directory set of injected servers to leave out.
 */
export function switchVerdict(
  provider: string,
  scope: LoadScope,
  entry: ClaudeProjectEntry | null | undefined,
  name: string,
  injectionDisabled: readonly string[] = [],
): SwitchVerdict {
  const lever = leverFor(provider, scope);
  if (lever === "none") return { state: "enabled", writable: false, lever, reason: noSwitchReason(provider, scope) };
  if (lever === "injection") {
    const state: EnabledState = injectionDisabled.includes(name) ? "disabled" : "enabled";
    return {
      state,
      writable: true,
      lever,
      reason:
        state === "disabled"
          ? "Left out of injection for this workspace only. The .mcp.json entry is untouched; other workspaces are not affected."
          : "Added from this workspace's .mcp.json by injection when an agent starts. Turn it off to leave it out here only.",
    };
  }
  if (lever === "mcpjsonServers") {
    const state = claudeProjectState(entry, name);
    return {
      state,
      writable: true,
      lever,
      reason:
        state === "undecided"
          ? "Not yet approved or denied for this directory; Claude Code asks when a session starts."
          : "Governed by this directory's .mcp.json approval list in ~/.claude.json.",
    };
  }
  const state = claudeInheritedState(entry, name);
  return {
    state,
    writable: true,
    lever,
    reason:
      scope === "user"
        ? state === "disabled"
          ? "Off for this workspace only. The user-level definition is untouched and other workspaces still load it."
          : "User-level server, loaded in every workspace. Turn it off here to skip it for this workspace only."
        : "Claude Code's per-directory (local) server for this workspace.",
  };
}

// ------------------------------------------------------------------- writes

/** A copy of `entry` with `name` added to or removed from `disabledMcpServers`; every other key is kept as it was. */
export function setClaudeInheritedEnabled(entry: ClaudeProjectEntry | null | undefined, name: string, enabled: boolean): ClaudeProjectEntry {
  const next: ClaudeProjectEntry = { ...(entry ?? {}) };
  const off = names(next.disabledMcpServers).filter((entry) => entry !== name);
  if (!enabled) off.push(name);
  // Only keep a list that exists or is now needed, so an entry that never had
  // `disabledMcpServers` does not gain an empty one when a server is turned on.
  if (off.length > 0 || next.disabledMcpServers !== undefined) next.disabledMcpServers = off;
  return next;
}

/** A copy of `entry` with `name` moved to the right `.mcp.json` approval list; every other key is kept as it was. */
export function setClaudeProjectEnabled(entry: ClaudeProjectEntry | null | undefined, name: string, enabled: boolean): ClaudeProjectEntry {
  const next: ClaudeProjectEntry = { ...(entry ?? {}) };
  const on = names(next.enabledMcpjsonServers).filter((entry) => entry !== name);
  const off = names(next.disabledMcpjsonServers).filter((entry) => entry !== name);
  if (enabled) on.push(name);
  else off.push(name);
  if (on.length > 0 || next.enabledMcpjsonServers !== undefined) next.enabledMcpjsonServers = on;
  if (off.length > 0 || next.disabledMcpjsonServers !== undefined) next.disabledMcpjsonServers = off;
  return next;
}

/**
 * The whole config with one project entry updated. Only `projects[<dir>]` is a
 * new object; every other top-level key and every other project entry is the
 * same reference as before, which is what `assertUnrelatedKeysKept` checks
 * before anything is written.
 */
export function setClaudeEnabled(config: ClaudeConfig, dir: string, lever: Exclude<Lever, "none">, name: string, enabled: boolean): ClaudeConfig {
  const projects = config.projects ?? {};
  const entry = projects[dir];
  const nextEntry = lever === "mcpjsonServers" ? setClaudeProjectEnabled(entry, name, enabled) : setClaudeInheritedEnabled(entry, name, enabled);
  return { ...config, projects: { ...projects, [dir]: nextEntry } };
}

/** The state a config reads back for one server, through the given lever. */
export function readClaudeEnabled(config: ClaudeConfig, dir: string, lever: Exclude<Lever, "none">, name: string): EnabledState {
  const entry = config.projects?.[dir];
  return lever === "mcpjsonServers" ? claudeProjectState(entry, name) : claudeInheritedState(entry, name);
}

/**
 * Throws when `after` differs from `before` anywhere other than `projects[dir]`.
 * Compares serialised values, so two configs with the same content pass even
 * when their objects differ. Run before a write, never after.
 */
export function assertUnrelatedKeysKept(before: ClaudeConfig, after: ClaudeConfig, dir: string): void {
  const beforeKeys = Object.keys(before);
  const afterKeys = Object.keys(after);
  if (beforeKeys.length !== afterKeys.length || beforeKeys.some((key, index) => key !== afterKeys[index])) {
    throw new Error("refusing to write ~/.claude.json: the set of top-level keys would change");
  }
  for (const key of beforeKeys) {
    if (key === "projects") continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      throw new Error(`refusing to write ~/.claude.json: '${key}' would change`);
    }
  }
  const beforeProjects = before.projects ?? {};
  const afterProjects = after.projects ?? {};
  for (const key of new Set([...Object.keys(beforeProjects), ...Object.keys(afterProjects)])) {
    if (key === dir) continue;
    if (JSON.stringify(beforeProjects[key]) !== JSON.stringify(afterProjects[key])) {
      throw new Error(`refusing to write ~/.claude.json: project entry '${key}' would change`);
    }
  }
}

// -------------------------------------------------------- injection store

/**
 * The plugin's own record of injected servers to leave out, keyed by the
 * directory an agent starts in. Stored beside the other plugin settings as
 * `$PASEO_HOME/plugin-settings/paseo-mcp/workspace-disabled.json`, written
 * only by this plugin, read by the `agent.create` hook.
 */
export type InjectionDisabledStore = { version: 1; disabled: Record<string, string[]> };

export const EMPTY_INJECTION_STORE: InjectionDisabledStore = { version: 1, disabled: {} };

export function parseInjectionStore(raw: unknown): InjectionDisabledStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_INJECTION_STORE;
  const disabled = (raw as { disabled?: unknown }).disabled;
  if (!disabled || typeof disabled !== "object" || Array.isArray(disabled)) return EMPTY_INJECTION_STORE;
  const clean: Record<string, string[]> = {};
  for (const [dir, list] of Object.entries(disabled as Record<string, unknown>)) {
    const entries = names(list);
    if (entries.length > 0) clean[dir] = entries;
  }
  return { version: 1, disabled: clean };
}

export function injectionDisabledFor(store: InjectionDisabledStore, dir: string): string[] {
  return store.disabled[dir] ?? [];
}

/** A copy of the store with `name` left out of (or restored to) injection for `dir`; an emptied directory key is dropped. */
export function setInjectionEnabled(store: InjectionDisabledStore, dir: string, name: string, enabled: boolean): InjectionDisabledStore {
  const list = injectionDisabledFor(store, dir).filter((entry) => entry !== name);
  if (!enabled) list.push(name);
  const disabled = { ...store.disabled };
  if (list.length > 0) disabled[dir] = list;
  else delete disabled[dir];
  return { version: 1, disabled };
}

/** Copy for the panel: what a toggle does and when it takes effect. */
export const SWITCH_EFFECT_NOTE = "Takes effect when a new agent session starts; a running agent keeps the servers it started with.";
