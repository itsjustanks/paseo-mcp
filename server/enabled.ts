import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadFor, scopeForProvider, type LoadedServer } from "../shared/budget";
import type { AgentServer, McpAuthAccount } from "../shared/contracts";
import {
  EMPTY_INJECTION_STORE,
  SWITCH_EFFECT_NOTE,
  assertUnrelatedKeysKept,
  injectionDisabledFor,
  leverFor,
  parseInjectionStore,
  readClaudeEnabled,
  setClaudeEnabled,
  setInjectionEnabled,
  switchVerdict,
  type ClaudeConfig,
  type ClaudeProjectEntry,
  type InjectionDisabledStore,
} from "../shared/enabled";
import {
  backupFile,
  buildDestinations,
  destRead,
  handleMcpAuth,
  hasInlineCredentials,
  jsonMcpRead,
  readJson,
  redactDetail,
  writeJsonAtomic,
  type McpDef,
} from "./handlers";
import { settingsPath } from "./settings";
import { buildProfile, claudeLocalServers, readInjection } from "./workspace";

/**
 * The per-workspace switches behind the workspace and agent panels. Reading
 * always goes back to the editor's config file, never to a cached copy, so a
 * toggle made in a terminal (`/mcp disable`) is what the panel shows next.
 *
 * Writing `~/.claude.json` is the riskiest thing this plugin does: it is the
 * user's live Claude Code state with dozens of unrelated keys. So a write is
 * refused unless the file parses, the new document differs from the old one
 * only inside `projects[<directory>]`, and the file read back after the atomic
 * rename parses and holds the state just written.
 */

type WorkspaceEntry = { id: string; name: string; workspaceDirectory?: string; projectRootPath: string };

async function findWorkspace(paseo: PluginHandlerContext["paseo"], workspaceId: string): Promise<WorkspaceEntry> {
  const result = await paseo.workspaces.list();
  const workspace = (result as { entries: WorkspaceEntry[] }).entries.find((entry) => entry.id === workspaceId);
  if (!workspace) throw new Error("This Paseo workspace no longer exists.");
  return workspace;
}

/**
 * The directory Claude Code keys its project entry by: the directory a
 * session starts in. Paseo launches an agent in the workspace directory, so a
 * worktree workspace gets its own entry, separate from the project root's.
 */
export function projectKeyFor(workspace: Pick<WorkspaceEntry, "workspaceDirectory" | "projectRootPath">): string {
  return workspace.workspaceDirectory || workspace.projectRootPath;
}

// ----------------------------------------------------------- injection store

/** The plugin's own file of injected servers to leave out, per directory. Never a file another program writes. */
export function injectionStorePath(): string {
  return settingsPath("workspace-disabled");
}

export function readInjectionStore(path = injectionStorePath()): InjectionDisabledStore {
  if (!existsSync(path)) return EMPTY_INJECTION_STORE;
  return parseInjectionStore(readJson(path));
}

/** Set one injected server's per-directory state; returns what the file reads back. */
export function writeInjectionEnabled(path: string, directory: string, name: string, enabled: boolean): { state: "enabled" | "disabled"; changed: boolean } {
  const before = readInjectionStore(path);
  const next = setInjectionEnabled(before, directory, name, enabled);
  const changed = JSON.stringify(before) !== JSON.stringify(next);
  if (changed) {
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomic(path, next);
  }
  const after = readInjectionStore(path);
  const state = injectionDisabledFor(after, directory).includes(name) ? "disabled" : "enabled";
  if (state !== (enabled ? "enabled" : "disabled")) throw new Error(`${path} was written but reads back as '${state}'`);
  return { state, changed };
}

// -------------------------------------------------------------------- reading

export function readClaudeConfig(path: string): ClaudeConfig {
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}); refusing to touch it`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object; refusing to touch it`);
  return parsed as ClaudeConfig;
}

function projectEntry(configPath: string, directory: string): ClaudeProjectEntry | undefined {
  try {
    return readClaudeConfig(configPath).projects?.[directory];
  } catch {
    return undefined;
  }
}

export async function handleMcpAgentServers(
  { workspaceId, providerId }: { workspaceId: string; providerId: string },
  { paseo }: PluginHandlerContext,
) {
  const workspace = await findWorkspace(paseo, workspaceId);
  const directory = projectKeyFor(workspace);
  const candidates = [...new Set([directory, workspace.projectRootPath].filter(Boolean))];
  const projectConfigPath = candidates.map((candidate) => join(candidate, ".mcp.json")).find(existsSync) ?? "";
  const projectDefs = projectConfigPath ? jsonMcpRead(projectConfigPath) : {};
  const destinations = await buildDestinations(paseo);
  const { profile } = buildProfile(destinations, projectDefs, projectConfigPath, candidates);
  const scope = scopeForProvider(profile, providerId);
  const load = loadFor(profile, scope, readInjection());
  const dest = scope ? destinations.find((entry) => entry.id === scope.id) : undefined;
  const entry = scope?.provider === "claude" ? projectEntry(scope.configPath, directory) : undefined;
  const injectionDisabled = injectionDisabledFor(readInjectionStore(), directory);

  // Definitions by name, for the redacted detail line: local beats project
  // beats user, the order Claude resolves them in.
  const defs: Record<string, McpDef> = { ...projectDefs };
  if (dest) {
    const local = dest.provider === "claude" ? claudeLocalServers(dest.configPath, candidates) : {};
    Object.assign(defs, destRead(dest), projectDefs, local);
  }

  const servers: AgentServer[] = load.servers.map((server: LoadedServer) => {
    const def = defs[server.name] ?? null;
    return {
      name: server.name,
      transport: server.transport,
      detail: redactDetail(def).slice(0, 80),
      scope: server.scope,
      configPath: server.configPath,
      inlineCredentials: hasInlineCredentials(def),
      enabled: switchVerdict(scope?.provider ?? "", server.scope, entry, server.name, injectionDisabled),
    };
  });

  let account: McpAuthAccount | null = null;
  if (dest && (dest.provider === "claude" || dest.provider === "codex")) {
    const { accounts } = await handleMcpAuth({}, { paseo } as PluginHandlerContext);
    account = accounts.find((candidate) => candidate.provider === dest.provider && candidate.email === dest.account) ?? null;
  }

  return {
    directory,
    scope: scope ? { id: scope.id, label: scope.label, provider: scope.provider, providerId: scope.providerId, configPath: scope.configPath } : null,
    projectIncluded: load.projectIncluded,
    projectNote: load.projectNote,
    servers,
    account,
  };
}

// -------------------------------------------------------------------- writing

/**
 * Set one server's per-directory state in a `.claude.json`. Backs the file up,
 * refuses any change outside `projects[<directory>]`, writes through a temp
 * file and rename, then reads the result back and checks it. Exported with the
 * path as a parameter so a test can run it against a copy in a temp directory.
 */
export function writeClaudeEnabled(
  configPath: string,
  directory: string,
  lever: "disabledMcpServers" | "mcpjsonServers",
  name: string,
  enabled: boolean,
): { state: ReturnType<typeof readClaudeEnabled>; changed: boolean } {
  const before = readClaudeConfig(configPath);
  const next = setClaudeEnabled(before, directory, lever, name, enabled);
  assertUnrelatedKeysKept(before, next, directory);
  const changed = JSON.stringify(before.projects?.[directory] ?? null) !== JSON.stringify(next.projects?.[directory] ?? null);
  if (!changed) return { state: readClaudeEnabled(before, directory, lever, name), changed };
  backupFile(configPath);
  writeJsonAtomic(configPath, next);
  const after = readClaudeConfig(configPath);
  assertUnrelatedKeysKept(before, after, directory);
  const state = readClaudeEnabled(after, directory, lever, name);
  const wanted = enabled ? "enabled" : "disabled";
  if (state !== wanted) throw new Error(`${configPath} was written but reads back as '${state}', not '${wanted}'`);
  return { state, changed };
}

export async function handleMcpSetEnabled(
  { workspaceId, providerId, name, enabled }: { workspaceId: string; providerId: string; name: string; enabled: boolean },
  context: PluginHandlerContext,
) {
  const current = await handleMcpAgentServers({ workspaceId, providerId }, context);
  const server = current.servers.find((entry) => entry.name === name);
  if (!server) return { ok: false, message: `'${name}' is not a server this agent loads` };
  if (!current.scope) return { ok: false, message: "No editor config is wired to this provider" };
  const lever = leverFor(current.scope.provider, server.scope);
  if (lever === "none") return { ok: false, message: server.enabled.reason };
  try {
    if (lever === "injection") {
      const { state, changed } = writeInjectionEnabled(injectionStorePath(), current.directory, name, enabled);
      return {
        ok: true,
        state,
        message: changed
          ? `${name} ${enabled ? "injected again" : "left out of injection"} for this workspace only. ${SWITCH_EFFECT_NOTE}`
          : `${name} was already ${enabled ? "on" : "off"} here.`,
      };
    }
    const { state, changed } = writeClaudeEnabled(current.scope.configPath, current.directory, lever, name, enabled);
    const where = server.scope === "user" ? "for this workspace only" : "for this workspace";
    return {
      ok: true,
      state,
      message: changed
        ? `${name} ${enabled ? "on" : "off"} ${where} (backup saved). ${SWITCH_EFFECT_NOTE}`
        : `${name} was already ${enabled ? "on" : "off"} here.`,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
