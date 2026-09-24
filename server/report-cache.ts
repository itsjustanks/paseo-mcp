import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  McpHealthSchema,
  McpServerToolsSchema,
  type McpHealthReport,
  type McpServerTools,
  type McpToolsReport,
} from "../shared/contracts";
import { youngEnough } from "../shared/tools";
import { clientSeenWithin } from "./presence";
import { paseoHome } from "./settings";

/**
 * The last health verdicts and tool lists, kept on disk so a plugin restart
 * (a reload, an update, a daemon restart) does not leave the first panel open
 * waiting on a pass over every server.
 *
 * `$PASEO_HOME/plugin-data/paseo-mcp/cache.json`: the plugin SDK has no data
 * directory API, and Shared Browser keeps its state in
 * `$PASEO_HOME/plugin-data/shared-browser`, so this follows that convention.
 *
 * Nothing secret is stored. Each server is keyed by its name and a hash of its
 * URL, headers and command, never the raw URL (a query string can carry a
 * token). Notes are already redacted; tool descriptions are server text,
 * already capped. A file that is unreadable, from another version or the wrong
 * shape is ignored. It is written atomically, once per completed pass, and only
 * while an app is connected.
 */

export const REPORT_CACHE_VERSION = 1;
/** Anything bigger is not a file this plugin wrote. */
const MAX_BYTES = 8 * 1024 * 1024;
export const RESTORED_REASON = "saved before the plugin restarted";

export function reportCachePath(): string {
  return join(paseoHome(), "plugin-data", "paseo-mcp", "cache.json");
}

/** A server's definition as a hash: the same definition gives the same key, and the URL cannot be read back from it. */
export function definitionKey(def: { url?: string; headers?: Record<string, string>; command?: string } | null): string {
  if (!def) return "";
  const headers = Object.entries(def.headers ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256")
    .update(JSON.stringify([def.url ?? "", headers, def.command ?? ""]))
    .digest("hex")
    .slice(0, 32);
}

const Key = z.object({ key: z.string() });
const CacheFileSchema = z.object({
  version: z.literal(REPORT_CACHE_VERSION),
  savedAt: z.string(),
  health: z.object({ checkedAt: z.string(), results: z.array(McpHealthSchema.extend(Key.shape)) }).nullable(),
  tools: z.object({ checkedAt: z.string(), servers: z.array(McpServerToolsSchema.extend(Key.shape)) }).nullable(),
});

export type Saved<Report> = { report: Report; keys: Map<string, string> };
export type SavedReports = { health: Saved<McpHealthReport> | null; tools: Saved<McpToolsReport> | null };

function withKeys<Entry extends { name: string }>(entries: Entry[], keys: Map<string, string>) {
  return entries.map((entry) => ({ key: keys.get(entry.name) ?? "", ...entry }));
}

function splitKeys<Entry extends { name: string; key: string }>(entries: Entry[]) {
  const keys = new Map(entries.map((entry) => [entry.name, entry.key] as const));
  const rest = entries.map(({ key: _key, ...entry }) => entry);
  return { keys, rest };
}

/** The file's text for these reports. Pure. */
export function serializeReports(saved: SavedReports, now = new Date()): string {
  const file: z.input<typeof CacheFileSchema> = {
    version: REPORT_CACHE_VERSION,
    savedAt: now.toISOString(),
    health: saved.health
      ? { checkedAt: saved.health.report.checkedAt, results: withKeys(saved.health.report.results, saved.health.keys) }
      : null,
    tools: saved.tools
      ? { checkedAt: saved.tools.report.checkedAt, servers: withKeys(saved.tools.report.servers, saved.tools.keys) }
      : null,
  };
  return `${JSON.stringify(file)}\n`;
}

/** The reports in a file's text, or null for anything this version did not write. Pure. */
export function parseReports(text: string): SavedReports | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = CacheFileSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { health, tools } = parsed.data;
  const healthParts = health ? splitKeys(health.results) : null;
  const toolsParts = tools ? splitKeys(tools.servers) : null;
  return {
    health: health && healthParts ? { report: { checkedAt: health.checkedAt, results: healthParts.rest }, keys: healthParts.keys } : null,
    tools: tools && toolsParts ? { report: { checkedAt: tools.checkedAt, servers: toolsParts.rest }, keys: toolsParts.keys } : null,
  };
}

/** A saved health report as this run shows it: "as of" when it was checked. */
export function restoredHealth(report: McpHealthReport): McpHealthReport {
  return { ...report, stale: { reason: RESTORED_REASON, asOf: report.checkedAt } };
}

/** Saved tool lists as this run shows them: each list "as of" when it was last read. */
export function restoredTools(report: McpToolsReport, now: number = Date.now()): McpToolsReport {
  const mark = (entry: McpServerTools): McpServerTools =>
    entry.kind === "listed"
      ? { ...entry, stale: { reason: RESTORED_REASON, asOf: entry.stale?.asOf ?? report.checkedAt, restored: true } }
      : entry;
  // A list last read more than LAST_GOOD_MAX_AGE_MS ago is not brought back: the next pass lists it afresh or says why not.
  const young = (entry: McpServerTools) => entry.kind !== "listed" || youngEnough(entry.stale?.asOf ?? report.checkedAt, now);
  return { ...report, servers: report.servers.filter(young).map(mark), stale: { reason: RESTORED_REASON, asOf: report.checkedAt } };
}

// ----------------------------------------------------------------- the file

let current: SavedReports = { health: null, tools: null };
let loaded = false;
let warned = false;

/** What the last run saved, read once per process. */
export function loadSavedReports(path = reportCachePath()): SavedReports {
  if (loaded) return current;
  loaded = true;
  try {
    if (statSync(path).size <= MAX_BYTES) current = parseReports(readFileSync(path, "utf8")) ?? current;
  } catch {
    // No file yet, or unreadable: start empty.
  }
  return current;
}

function write(path: string): boolean {
  if (!clientSeenWithin()) return false;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, serializeReports(current), { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch (error) {
    if (!warned) console.warn(`[paseo-mcp] could not save the health and tools cache to ${path}: ${error instanceof Error ? error.message : String(error)}`);
    warned = true;
    return false;
  }
}

/** Keep a completed health pass for the next run. False when nothing was written. */
export function saveHealthReport(report: McpHealthReport, keys: Map<string, string>, path = reportCachePath()): boolean {
  loadSavedReports(path);
  current = { ...current, health: { report, keys } };
  return write(path);
}

/** Keep a completed tools pass for the next run. False when nothing was written. */
export function saveToolsReport(report: McpToolsReport, keys: Map<string, string>, path = reportCachePath()): boolean {
  loadSavedReports(path);
  current = { ...current, tools: { report, keys } };
  return write(path);
}

/** For tests: forget what was loaded, so the next load reads the file again. */
export function resetReportCache(): void {
  current = { health: null, tools: null };
  loaded = false;
  warned = false;
}
