import type { PluginBeforeRequests, PluginServerContext } from "@getpaseo/plugin/server";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { injectionDisabledFor } from "../shared/enabled";
import { INJECTION_DEFAULTS, injectionSettings, injectionTargets, type InjectionSettings } from "../shared/settings";
import { readInjectionStore } from "./enabled";
import { hasInlineCredentials, jsonMcpRead, type McpDef } from "./handlers";
import { readSettingsDocument, settingsPath } from "./settings";

type CreateRequest = PluginBeforeRequests["agent.create"];
type McpServers = NonNullable<CreateRequest["config"]["mcpServers"]>;
type McpServerConfig = McpServers[string];

const TAG = "[paseo-mcp]";

// ----------------------------------------------------------------- settings

/** Reads the persisted injection document; see server/settings.ts for the envelope. */
export function readInjectionSettings(path = settingsPath(injectionSettings.id)): InjectionSettings {
  return readSettingsDocument(injectionSettings, INJECTION_DEFAULTS, path);
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
  disabled: readonly string[] = [],
): { injected: McpServers; skipped: string[] } {
  const injected: McpServers = {};
  const skipped: string[] = [];
  for (const [name, def] of Object.entries(definitions)) {
    if (name in existing) {
      skipped.push(`${name} (already on the agent)`);
      continue;
    }
    // Turned off for this workspace from the MCP panel (shared/enabled.ts).
    if (disabled.includes(name)) {
      skipped.push(`${name} (off for this workspace)`);
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
    const disabled = injectionDisabledFor(readInjectionStore(), cwd);
    const { injected, skipped } = planInjection(jsonMcpRead(configPath), existing, settings, disabled);
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
