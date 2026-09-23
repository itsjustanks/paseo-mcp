import { dirname, join } from "node:path";
import { readJsonCached } from "./files";

/**
 * The Paseo version of the daemon running this plugin. The daemon starts each
 * plugin as a child process of its own `@getpaseo/server` package
 * (server/plugins/runtime.js: `fork(plugin-process.js)`), so `process.argv[1]`
 * sits inside the server package that is actually running, in a Docker image
 * or inside the desktop app's `app.asar`. Its `package.json` is found by
 * walking up, through the stat-keyed file cache. `@getpaseo/client` has no
 * version call, and the Agent MCP endpoint's `serverInfo` is `agent-mcp 2.0.0`
 * whatever the release, so this is the one honest source.
 */
export function findServerVersion(start: string, read: (path: string) => unknown = readJsonCached, maxDepth = 8): string | null {
  let dir = dirname(start);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const pkg = read(join(dir, "package.json")) as { name?: unknown; version?: unknown } | null;
    if (pkg && pkg.name === "@getpaseo/server" && typeof pkg.version === "string") return pkg.version;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

let memo: string | null | undefined;

/** Found once per process: the daemon that started this process does not change under it. */
export function runningPaseoVersion(): string | null {
  if (memo === undefined) memo = process.argv[1] ? findServerVersion(process.argv[1]) : null;
  return memo;
}

/** For tests. */
export function setRunningPaseoVersion(version: string | null | undefined): void {
  memo = version;
}
