import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Providers the injection hook knows how to target. */
export const INJECTION_PROVIDERS = ["claude", "codex"] as const;
export type InjectionProvider = (typeof INJECTION_PROVIDERS)[number];

export const InjectionProviderSchema = z.enum(INJECTION_PROVIDERS);

/**
 * Host-scoped settings for adding a workspace's `.mcp.json` servers to every
 * new agent. Stored by Paseo under `$PASEO_HOME/plugin-settings/paseo-mcp/injection.json`.
 */
export const injectionSettings = defineSettings({
  id: "injection",
  scope: "host",
  version: 1,
  schema: z.object({
    injectWorkspaceServers: z
      .boolean()
      .default(false)
      .describe("Add the workspace's .mcp.json servers to every new agent"),
    providers: z.array(InjectionProviderSchema).default(["codex"]).describe("Which providers to inject for"),
    skipInlineCredentialServers: z
      .boolean()
      .default(true)
      .describe("Leave out servers whose definition carries inline credentials"),
  }),
});

export type InjectionSettings = z.infer<typeof injectionSettings.schema>;

/** Schema defaults as a plain object, for callers that cannot reach the store. */
export const INJECTION_DEFAULTS: InjectionSettings = injectionSettings.schema.parse({});

export function injectionTargets(values: InjectionSettings, provider: string): boolean {
  return values.injectWorkspaceServers && (values.providers as readonly string[]).includes(provider);
}

// ---------------------------------------------------------------- health

/** Interval choices offered by the settings screen; any integer in [1, 1440] is stored. */
export const HEALTH_INTERVAL_CHOICES = [5, 10, 15, 30, 60] as const;

/**
 * Host-scoped settings for the background health check. Stored by Paseo under
 * `$PASEO_HOME/plugin-settings/paseo-mcp/health.json`. The server reads the file
 * directly on each heartbeat, so a change applies without a plugin reload.
 */
export const healthSettings = defineSettings({
  id: "health",
  scope: "host",
  version: 1,
  schema: z.object({
    backgroundChecks: z
      .boolean()
      .default(true)
      .describe("Probe every MCP server on a timer, not only when Refresh is pressed"),
    intervalMinutes: z
      .number()
      .int()
      .min(1)
      .max(1440)
      .default(10)
      .describe("Minutes between background checks"),
    showComposerPill: z
      .boolean()
      .default(true)
      .describe("Show a composer pill on each agent while a server needs attention"),
  }),
});

export type HealthSettings = z.infer<typeof healthSettings.schema>;

/** Schema defaults as a plain object, for callers that cannot reach the store. */
export const HEALTH_DEFAULTS: HealthSettings = healthSettings.schema.parse({});
