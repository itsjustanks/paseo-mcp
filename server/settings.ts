import type { SettingsDefinition } from "@getpaseo/plugin";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ZodType, output as ZodOutput } from "zod";

/**
 * The SDK has no server-side settings read, so server modules read the document
 * the daemon persists for this plugin: $PASEO_HOME/plugin-settings/<pluginId>/<settingsId>.json,
 * an envelope `{ version, values }` written atomically by the host. Anything
 * unreadable, from another schema version, or invalid yields the caller's
 * defaults; a server module must never guess.
 */
function paseoHome(): string {
  const raw = process.env.PASEO_HOME?.trim();
  if (!raw) return join(homedir(), ".paseo");
  return resolve(raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw);
}

export function settingsPath(settingsId: string, pluginId = "paseo-mcp"): string {
  return join(paseoHome(), "plugin-settings", pluginId, `${settingsId}.json`);
}

export function readSettingsDocument<Schema extends ZodType>(
  definition: SettingsDefinition<Schema>,
  defaults: ZodOutput<Schema>,
  path = settingsPath(definition.id),
): ZodOutput<Schema> {
  try {
    if (!existsSync(path)) return defaults;
    const envelope = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; values?: unknown };
    if (envelope.version !== definition.version) return defaults;
    const parsed = definition.schema.safeParse(envelope.values ?? {});
    return parsed.success ? (parsed.data as ZodOutput<Schema>) : defaults;
  } catch {
    return defaults;
  }
}
