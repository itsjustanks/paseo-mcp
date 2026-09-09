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
