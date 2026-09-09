import type { PluginBeforeRequests, PluginServerContext } from "@getpaseo/plugin/server";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { INJECTION_DEFAULTS, injectionSettings, injectionTargets, type InjectionSettings } from "../shared/settings";
import { hasInlineCredentials, jsonMcpRead, type McpDef } from "./handlers";

type CreateRequest = PluginBeforeRequests["agent.create"];
type McpServers = NonNullable<CreateRequest["config"]["mcpServers"]>;
type McpServerConfig = McpServers[string];

const TAG = "[paseo-mcp]";

// ----------------------------------------------------------------- settings

/**
 * The SDK has no server-side settings read, so the hook reads the document the
 * daemon persists for this plugin: $PASEO_HOME/plugin-settings/<pluginId>/<settingsId>.json,
 * an envelope `{ version, values }` written atomically by the host. Anything
 * unreadable or invalid means injection stays off; a hook must never guess.
 */
function paseoHome(): string {
  const raw = process.env.PASEO_HOME?.trim();
  if (!raw) return join(homedir(), ".paseo");
  return resolve(raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw);
}

export function settingsPath(pluginId = "paseo-mcp"): string {
  return join(paseoHome(), "plugin-settings", pluginId, `${injectionSettings.id}.json`);
}

export function readInjectionSettings(path = settingsPath()): InjectionSettings {
  try {
    if (!existsSync(path)) return INJECTION_DEFAULTS;
    const envelope = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; values?: unknown };
    if (envelope.version !== injectionSettings.version) return INJECTION_DEFAULTS;
    const parsed = injectionSettings.schema.safeParse(envelope.values ?? {});
    return parsed.success ? parsed.data : INJECTION_DEFAULTS;
  } catch {
    return INJECTION_DEFAULTS;
  }
}

// ------------------------------------------------------------------ .mcp.json

function gitRoot(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Same resolution as handleMcpWorkspace: the directory itself first, then its root. */
export function workspaceMcpJson(cwd: string): string {
  const candidates = [cwd, gitRoot(cwd)].filter((entry): entry is string => Boolean(entry));
  return [...new Set(candidates)].map((dir) => join(dir, ".mcp.json")).find(existsSync) ?? "";
}

/**
 * `.mcp.json` entries into the SDK's `McpServerConfig` union
 * (@getpaseo/protocol agent-types: stdio {type,command,args,env} |
 * http/sse {type,url,headers}). Anything without a command or URL is skipped.
 */
export function toMcpServerConfig(def: McpDef): McpServerConfig | null {
  if (def.command) {
    const config: McpServerConfig = { type: "stdio", command: def.command };
    if (def.args?.length) config.args = [...def.args];
    if (def.env && Object.keys(def.env).length) config.env = { ...def.env };
    return config;
  }
  if (def.url) {
    const headers = def.headers && Object.keys(def.headers).length ? { ...def.headers } : undefined;
    return def.type === "sse"
      ? { type: "sse", url: def.url, ...(headers ? { headers } : {}) }
      : { type: "http", url: def.url, ...(headers ? { headers } : {}) };
  }
  return null;
}

export function planInjection(
  definitions: Record<string, McpDef>,
  existing: McpServers,
  settings: InjectionSettings,
): { injected: McpServers; skipped: string[] } {
  const injected: McpServers = {};
  const skipped: string[] = [];
  for (const [name, def] of Object.entries(definitions)) {
    if (name in existing) {
      skipped.push(`${name} (already on the agent)`);
      continue;
    }
    if (settings.skipInlineCredentialServers && hasInlineCredentials(def)) {
      skipped.push(`${name} (inline credentials)`);
      continue;
    }
    const config = toMcpServerConfig(def);
    if (!config) {
      skipped.push(`${name} (no command or url)`);
      continue;
    }
    injected[name] = config;
  }
  return { injected, skipped };
}

// ---------------------------------------------------------------------- hook

export function injectWorkspaceServers(request: CreateRequest): CreateRequest {
  try {
    const settings = readInjectionSettings();
    const provider = request.config.provider;
    if (!injectionTargets(settings, provider)) return request;
    const cwd = request.config.cwd;
    if (!cwd) return request;
    const configPath = workspaceMcpJson(cwd);
    if (!configPath) return request;
    const existing = request.config.mcpServers ?? {};
    const { injected, skipped } = planInjection(jsonMcpRead(configPath), existing, settings);
    const count = Object.keys(injected).length;
    console.log(
      `${TAG} injected ${count} servers into ${provider} agent` +
        (count ? ` (${Object.keys(injected).join(", ")})` : "") +
        (skipped.length ? ` — skipped ${skipped.join(", ")}` : "") +
        ` from ${configPath}`,
    );
    if (count === 0) return request;
    return { ...request, config: { ...request.config, mcpServers: { ...existing, ...injected } } };
  } catch (error) {
    // A throwing before-hook blocks agent creation for the user. Never.
    console.error(`${TAG} injection skipped:`, error instanceof Error ? error.message : error);
    return request;
  }
}

export function registerHooks(server: PluginServerContext): () => void {
  return server.before("agent.create", ({ request }) => injectWorkspaceServers(request));
}
