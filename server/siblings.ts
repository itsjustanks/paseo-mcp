import { join } from "node:path";
import { AI_ROUTER } from "../shared/siblings";
import { readJsonCached } from "./files";
import { paseoHome } from "./settings";

/**
 * Whether another plugin is installed on this daemon, for the Overview's
 * cross-promo card. Paseo keeps two records, and one install shows up in
 * only one of them:
 *   - `$PASEO_HOME/plugins/sources.json`: git and npm installs, an object keyed
 *     by plugin id (`{"ai-router":{"kind":"git",…}}`);
 *   - `$PASEO_HOME/config.json` → `plugins`: every install, including a
 *     directory install, which sources.json does not list (seen on a Mac with
 *     AI Router installed from a folder: sources.json was `{}`).
 * An installed but disabled plugin still counts: copying its install source
 * again would be no help.
 *
 * Both files go through the stat-keyed cache in server/files.ts, so a call is
 * two `stat`s and the files are parsed again only after they change.
 */
export function siblingRecordPaths(home = paseoHome()): { sources: string; config: string } {
  return { sources: join(home, "plugins", "sources.json"), config: join(home, "config.json") };
}

function hasKey(value: unknown, key: string): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, key);
}

/** True when either record names the plugin. Anything unreadable or oddly shaped counts as "not installed". */
export function pluginListed(id: string, sources: unknown, config: unknown): boolean {
  const plugins = hasKey(config, "plugins") ? (config as { plugins: unknown }).plugins : undefined;
  return hasKey(sources, id) || hasKey(plugins, id);
}

export function pluginInstalled(id: string, home = paseoHome()): boolean {
  const paths = siblingRecordPaths(home);
  return pluginListed(id, readJsonCached(paths.sources), readJsonCached(paths.config));
}

export function handleMcpSiblings(): { aiRouter: { installed: boolean } } {
  return { aiRouter: { installed: pluginInstalled(AI_ROUTER.id) } };
}
