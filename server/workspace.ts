import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Destination, ProcessObservation } from "../shared/contracts";
import type { ProfileScope, ProfileServer, WorkspaceProfile } from "../shared/budget";
import { INJECTION_DEFAULTS, injectionSettings, type InjectionSettings } from "../shared/settings";
import { readJsonCached } from "./files";
import {
  buildDestinations,
  collectAccounts,
  destRead,
  hasInlineCredentials,
  jsonMcpRead,
  redactDetail,
  type McpDef,
} from "./handlers";
import { paseoToolsLoad } from "./paseo-tools";
import { toolSearchVerdicts } from "./tool-search";
import { observeWorkspaceProcesses } from "./processes";
import { withDeadline } from "./run";
import { readSettingsDocument } from "./settings";

/**
 * The workspace panel's one RPC. Everything here is read-only and shaped for
 * the question "what does an agent started in this directory load, and what
 * is it costing": the project `.mcp.json`, each editor's user-level and
 * per-directory definitions, and the MCP processes running for it right now.
 */

function transportOf(def: McpDef): ProfileServer["transport"] {
  return def.command ? "stdio" : def.url ? "http" : "unknown";
}

function profileServers(defs: Record<string, McpDef>): ProfileServer[] {
  return Object.entries(defs)
    .map(([name, def]) => ({ name, transport: transportOf(def) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Claude Code's "local" scope: `projects[<dir>].mcpServers` inside a
 * `.claude.json`, read for the workspace directory and its project root. Only
 * names and transports leave; the entries often carry tokens.
 */
export function claudeLocalServers(configPath: string, directories: string[]): Record<string, McpDef> {
  const config = readJsonCached(configPath) as { projects?: Record<string, { mcpServers?: Record<string, McpDef> }> } | null;
  const projects = config?.projects ?? {};
  const defs: Record<string, McpDef> = {};
  for (const dir of directories) {
    for (const [name, def] of Object.entries(projects[dir]?.mcpServers ?? {})) {
      // A copy: the parse behind it is shared (server/files.ts).
      if (!(name in defs)) defs[name] = structuredClone(def);
    }
  }
  return defs;
}

export function buildProfile(
  destinations: Destination[],
  project: Record<string, McpDef>,
  projectConfigPath: string,
  directories: string[],
): { profile: WorkspaceProfile; defs: Record<string, McpDef> } {
  // Every definition any agent here could run, for process matching. User
  // copies win over project ones, as in health: the editor runs its own copy.
  const defs: Record<string, McpDef> = {};
  const scopes: ProfileScope[] = destinations.map((dest) => {
    const user = destRead(dest);
    const local = dest.provider === "claude" ? claudeLocalServers(dest.configPath, directories) : {};
    for (const [name, def] of Object.entries({ ...user, ...local })) if (!(name in defs)) defs[name] = def;
    return {
      id: dest.id,
      label: dest.label,
      provider: dest.provider,
      providerId: dest.providerId,
      configPath: dest.configPath,
      servers: profileServers(user),
      local: profileServers(local),
    };
  });
  for (const [name, def] of Object.entries(project)) if (!(name in defs)) defs[name] = def;
  return { profile: { project: profileServers(project), projectConfigPath, scopes }, defs };
}

export function readInjection(): InjectionSettings {
  return readSettingsDocument(injectionSettings, INJECTION_DEFAULTS);
}

/** Resolve project MCP state from Paseo's live workspace registry, never a client path. */
export async function handleMcpWorkspace(
  { workspaceId }: { workspaceId: string },
  { paseo }: PluginHandlerContext,
) {
  const result = await withDeadline(paseo.workspaces.list(), "its workspace list");
  const entries = (result as {
    entries: Array<{
      id: string;
      name: string;
      workspaceDirectory?: string;
      projectRootPath: string;
    }>;
  }).entries;
  const workspace = entries.find((entry) => entry.id === workspaceId);
  if (!workspace) throw new Error("This Paseo workspace no longer exists.");

  const directory = workspace.workspaceDirectory || workspace.projectRootPath;
  const candidates = [...new Set([directory, workspace.projectRootPath].filter(Boolean))];
  const configPath = candidates.map((candidate) => join(candidate, ".mcp.json")).find(existsSync) ?? "";
  const definitions = configPath ? jsonMcpRead(configPath) : {};
  const servers = Object.entries(definitions)
    .map(([name, def]) => {
      const hasInline = hasInlineCredentials(def);
      return {
        name,
        transport: transportOf(def),
        detail: redactDetail(def).slice(0, 80),
        authStyle: hasInline ? ("inline-credentials" as const) : ("oauth-or-none" as const),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  // The panel shows Claude sign-in rows only, so no Codex check is started from here.
  const accounts = collectAccounts({ askCodex: false });
  const destinations = await buildDestinations(paseo);
  const { profile, defs } = buildProfile(destinations, definitions, configPath, candidates);
  const paseoTools = await paseoToolsLoad(paseo, destinations.map((dest) => dest.providerId));
  const toolSearch = await toolSearchVerdicts(paseo, destinations.map((dest) => ({ id: dest.providerId, base: dest.provider })), { directory });
  let processes: ProcessObservation;
  try {
    processes = await observeWorkspaceProcesses(directory, defs);
  } catch (error) {
    // A process-table hiccup must never take the panel down with it.
    processes = { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      directory,
      projectRootPath: workspace.projectRootPath,
    },
    configPath,
    servers,
    accounts,
    profile,
    injection: readInjection(),
    processes,
    ...(paseoTools ? { paseoTools } : {}),
    ...(toolSearch ? { toolSearch } : {}),
  };
}
