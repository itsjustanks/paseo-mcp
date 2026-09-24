import type { SettingsDefinition } from "@getpaseo/plugin";
import { chmodSync, constants, copyFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ZodType, output as ZodOutput } from "zod";

/**
 * The SDK has no server-side settings read, so server modules read the document
 * the daemon persists for this plugin: $PASEO_HOME/plugin-settings/<pluginId>/<settingsId>.json,
 * an envelope `{ version, values }` written atomically by the host. An older
 * version goes through the definition's own `migrate` when that is
 * synchronous, as Paseo would on its next read (Paseo then saves the result;
 * this reader never writes). Anything unreadable, from a newer or unmigratable
 * version, or invalid yields the caller's defaults; a server module must
 * never guess.
 */
export function paseoHome(): string {
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
    let values: unknown = envelope.values ?? {};
    if (envelope.version !== definition.version) {
      if (typeof envelope.version !== "number" || envelope.version > definition.version || !definition.migrate) return defaults;
      values = definition.migrate(values, envelope.version);
      if (values instanceof Promise) return defaults;
    }
    const parsed = definition.schema.safeParse(values);
    return parsed.success ? (parsed.data as ZodOutput<Schema>) : defaults;
  } catch {
    return defaults;
  }
}

/** Where keepVersionCopy keeps a document as it was at `version`: `<id>.v<version>.json` beside it. */
export function versionCopyPath(settingsId: string, version: number, pluginId = "paseo-mcp"): string {
  return join(paseoHome(), "plugin-settings", pluginId, `${settingsId}.v${version}.json`);
}

/**
 * Keep a copy of a settings document while it is still at `version`, before a
 * migration rewrites it: Paseo's store replaces the file in place and keeps
 * no backup, and an older plugin cannot read the migrated one. Written once
 * (never over an existing copy), byte for byte, 0600. Best-effort: a copy
 * that cannot be made never blocks a read.
 */
export function keepVersionCopy(settingsId: string, version: number, pluginId = "paseo-mcp"): void {
  const path = settingsPath(settingsId, pluginId);
  const copy = versionCopyPath(settingsId, version, pluginId);
  try {
    if (existsSync(copy) || !existsSync(path)) return;
    const envelope = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    if (envelope?.version !== version) return;
    copyFileSync(path, copy, constants.COPYFILE_EXCL);
    chmodSync(copy, 0o600);
  } catch {
    // Nothing to copy, or it is already there.
  }
}
