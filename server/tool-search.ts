import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  aiRouterRoutesAgents,
  baseCli,
  inheritedEnv,
  launchValue,
  toolSearch,
  type SettingsEnv,
  type ToolSearchVerdict,
} from "../shared/tool-search";
import { listDirCached, readJsonCached } from "./files";
import { readDaemon } from "./paseo-tools";
import { paseoHome } from "./settings";

/**
 * AI Router's routing settings, read-only: the daemon keeps each plugin's
 * settings document at `$PASEO_HOME/plugin-settings/<pluginId>/<settingsId>.json`
 * (AI Router's server/store.ts: plugin id `ai-router`, settings id `routing`).
 */
export function aiRouterSettingsPath(home = paseoHome()): string {
  return join(home, "plugin-settings", "ai-router", "routing.json");
}

/** A settings file's `env` (string values only), or null when the file is missing, not JSON or has none. */
function settingsFileEnv(path: string): Record<string, string> | null {
  const parsed = readJsonCached(path);
  const env = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { env?: unknown }).env : undefined;
  if (!env || typeof env !== "object" || Array.isArray(env)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) if (typeof value === "string") out[key] = value;
  return out;
}

function expandHome(path: string, userHome: string): string {
  if (path === "~") return userHome;
  return path.startsWith("~/") ? join(userHome, path.slice(2)) : path;
}

function tilde(path: string, userHome: string): string {
  return path.startsWith(`${userHome}/`) ? `~${path.slice(userHome.length)}` : path;
}

/**
 * Claude Code's settings files that carry an `env`, lowest precedence first:
 * `<configDir>/settings.json` (user), then, with a workspace directory,
 * `.claude/settings.json` (project) and `.claude/settings.local.json` (local).
 * All through the stat-keyed cache.
 */
export function claudeSettingsEnv(configDir: string, directory: string | undefined, userHome: string): SettingsEnv[] {
  const files = [{ path: join(configDir, "settings.json"), label: tilde(join(configDir, "settings.json"), userHome) }];
  if (directory) {
    files.push(
      { path: join(directory, ".claude", "settings.json"), label: "The project's .claude/settings.json" },
      { path: join(directory, ".claude", "settings.local.json"), label: "The project's .claude/settings.local.json" },
    );
  }
  return files.flatMap(({ path, label }) => {
    const env = settingsFileEnv(path);
    return env ? [{ label, env }] : [];
  });
}

/**
 * Claude Code's system directory for file-based managed settings
 * (https://code.claude.com/docs/en/managed-settings, "Where each mechanism
 * stores the policy"): `/Library/Application Support/ClaudeCode/` on macOS,
 * `/etc/claude-code/` on Linux and WSL, `C:\Program Files\ClaudeCode\` on Windows.
 */
export function managedSettingsDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return "/etc/claude-code";
}

/**
 * The managed settings files' `env`, in the order Claude Code merges them:
 * `managed-settings.json` first, then every `*.json` in `managed-settings.d/`
 * alphabetically, hidden files skipped; `env` merges key by key, the later
 * file winning (managed-settings#split-a-file-based-policy-across-teams). Each
 * file is its own layer so a reason names the one that set the value. A
 * missing or broken file is no layer. The macOS profile, the Windows registry
 * and server-managed settings are not files here and are not read.
 */
export function managedSettingsEnv(dir: string): SettingsEnv[] {
  const dropIns = join(dir, "managed-settings.d");
  const paths = [
    join(dir, "managed-settings.json"),
    ...listDirCached(dropIns)
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .map((name) => join(dropIns, name)),
  ];
  return paths.flatMap((path) => {
    const env = settingsFileEnv(path);
    return env ? [{ label: `Managed settings (${path})`, env }] : [];
  });
}

export type ToolSearchWhere = {
  /** The workspace directory the agent runs in, when known; adds the project settings files. */
  directory?: string;
  /** The daemon's own environment (the plugin process inherits it). */
  daemonEnv?: Record<string, string | undefined>;
  home?: string;
  userHome?: string;
  /** Where managed settings live; the platform's system directory by default. */
  managedDir?: string;
};

/**
 * Per provider id, whether its CLI defers MCP tool definitions. Inputs: each
 * provider entry's `extends` and `env` (and a derived entry's base `env`) from
 * the shared daemon config read, AI Router's `routeAgents` and Claude Code's
 * settings files through the stat-keyed file cache, and this process's
 * environment, which the daemon passes to every plugin it starts (a `fork`
 * without `env` inherits it) and to every agent. The user settings file sits
 * in the provider's `CLAUDE_CONFIG_DIR`, else `~/.claude`. `base` is what the
 * caller knows about an id's CLI from the editor list. Managed settings sit
 * above all of it, read for Claude-based providers only. Undefined when the
 * daemon config cannot be read, so the panels count as before.
 */
export async function toolSearchVerdicts(
  paseo: PluginHandlerContext["paseo"],
  providers: ReadonlyArray<{ id: string; base: string }>,
  { directory, daemonEnv = process.env, home = paseoHome(), userHome = homedir(), managedDir = managedSettingsDir() }: ToolSearchWhere = {},
): Promise<Record<string, ToolSearchVerdict> | undefined> {
  let launch;
  try {
    ({ launch } = await readDaemon(paseo));
  } catch (error) {
    console.warn(`[paseo-mcp] tool search not judged: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  const aiRouterRoutes = aiRouterRoutesAgents(readJsonCached(aiRouterSettingsPath(home)));
  const out: Record<string, ToolSearchVerdict> = {};
  for (const { id, base } of providers) {
    if (!id || out[id]) continue;
    const cli = baseCli(id, launch, base);
    const env = { daemonEnv, baseEnv: inheritedEnv(id, launch), providerEnv: launch[id]?.env };
    const configDir = expandHome(launchValue("CLAUDE_CONFIG_DIR", env) ?? join(userHome, ".claude"), userHome);
    const settingsEnv = cli === "claude" ? claudeSettingsEnv(configDir, directory, userHome) : undefined;
    const managedEnv = cli === "claude" ? managedSettingsEnv(managedDir) : undefined;
    out[id] = toolSearch(id, { base: cli, ...env, settingsEnv, managedEnv, aiRouterRoutes });
  }
  return out;
}
