import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { McpServerTools, McpToolsReport } from "../shared/contracts";
import { TOOLS_CONCURRENCY, keepLastGoodTools, listToolsMcp, mapLimit, stdioOutcome, summarizeTools } from "../shared/tools";
import { backgroundPass } from "./background";
import { buildDestinations, destRead, discoverProjects, findDef, jsonMcpRead, type McpDef } from "./handlers";
import { readHealthSettings } from "./health";
import { onShutdown, onStart } from "./lifecycle";
import { definitionKey, loadSavedReports, restoredTools, saveToolsReport } from "./report-cache";

const TAG = "[paseo-mcp]";
/** A listing a panel read started that failed is not started again from a read for this long. */
const READ_RETRY_MS = 60_000;

// ------------------------------------------------------------------- listing

/**
 * One pass over every server defined in any editor config or registered
 * project's `.mcp.json`, the same set the health check covers. HTTP servers are
 * asked for their tools a few at a time; stdio servers are reported as such
 * without being run. Nothing here spawns a process. `keys` is filled with each
 * server's definition key (server/report-cache.ts).
 */
export async function listAll(
  paseo: PluginHandlerContext["paseo"] | null,
  keys: Map<string, string> = new Map(),
): Promise<McpToolsReport> {
  const destinations = await buildDestinations(paseo);
  const defsByDest = new Map(destinations.map((dest) => [dest.id, destRead(dest)] as const));
  const names = new Set<string>();
  for (const defs of defsByDest.values()) for (const name of Object.keys(defs)) names.add(name);
  const projectDefs = new Map<string, McpDef>();
  for (const project of await discoverProjects(paseo)) {
    const file = join(project.path, ".mcp.json");
    if (!existsSync(file)) continue;
    for (const [name, def] of Object.entries(jsonMcpRead(file))) {
      names.add(name);
      if (!projectDefs.has(name)) projectDefs.set(name, def);
    }
  }
  const servers = await mapLimit([...names].sort(), TOOLS_CONCURRENCY, async (name): Promise<McpServerTools> => {
    const def = findDef(destinations, name, defsByDest) ?? projectDefs.get(name) ?? null;
    keys.set(name, definitionKey(def));
    if (!def) return { name, transport: "unknown", ...stdioOutcome(undefined), kind: "unavailable", note: "no readable definition" };
    if (def.command) return { name, transport: "stdio", ...stdioOutcome(def.command) };
    if (def.url) {
      return { name, transport: "http", ...(await listToolsMcp(def.url, def.headers)) };
    }
    return { name, transport: "unknown", ...stdioOutcome(undefined), kind: "unavailable", note: "no command or url" };
  });
  return { servers, checkedAt: new Date().toISOString() };
}

// --------------------------------------------------------------------- cache

let cached: McpToolsReport | null = null;
let inFlight: Promise<McpToolsReport> | null = null;
let lastPaseo: PluginHandlerContext["paseo"] | null = null;
// Each server's definition key (URL, headers, command, hashed) at the last
// pass: a stale list is only kept for a definition that has not changed since
// it was read. Restored with the lists after a restart.
let lastKeys = new Map<string, string>();
let restored = false;
let readPassFailedAt = 0;

/** The lists the last run saved, each "as of" its time, until this run asks again. */
function restoreSaved(): void {
  if (restored) return;
  restored = true;
  const saved = loadSavedReports().tools;
  if (!saved || cached) return;
  cached = restoredTools(saved.report);
  lastKeys = saved.keys;
}

/** List now, sharing one pass between concurrent callers, cache the result and save it for the next run. */
export function refreshTools(paseo: PluginHandlerContext["paseo"] | null): Promise<McpToolsReport> {
  if (paseo) lastPaseo = paseo;
  restoreSaved();
  if (inFlight) return inFlight;
  const keys = new Map<string, string>();
  inFlight = listAll(paseo ?? lastPaseo, keys)
    .then((report) => {
      const previousKeys = lastKeys;
      const next = keepLastGoodTools(cached, report, (name) => previousKeys.get(name) === keys.get(name));
      cached = next;
      lastKeys = keys;
      saveToolsReport(next, keys);
      return next;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Start a listing for a panel read without waiting for it; a failed one is not retried from a read for a minute. */
function refreshForRead(paseo: PluginHandlerContext["paseo"] | null): void {
  if (inFlight || Date.now() - readPassFailedAt < READ_RETRY_MS) return;
  void refreshTools(paseo).catch((error: unknown) => {
    readPassFailedAt = Date.now();
    console.warn(`${TAG} tools listing failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/** For tests: forget this run's lists and what was restored. */
export function resetToolsCache(): void {
  cached = null;
  lastKeys = new Map();
  restored = false;
  readPassFailedAt = 0;
}

/** For tests: wait for the listing in flight, if any. */
export async function toolsSettled(): Promise<void> {
  await inFlight?.catch(() => undefined);
}

// --------------------------------------------------------------------- timer

// Tool lists move far less often than reachability does, so the refresh runs
// on a multiple of the health interval, and only while background checks are
// on. The first pass comes later than the health pass so the two do not hit
// every server at once on start-up.
const TOOLS_INTERVAL_FACTOR = 6;

function toolsIntervalMs(): number | null {
  const settings = readHealthSettings();
  return settings.backgroundChecks ? settings.intervalMinutes * 60_000 * TOOLS_INTERVAL_FACTOR : null;
}

const pass = backgroundPass({
  name: "tools listing",
  firstDelayMs: 45_000,
  intervalMs: toolsIntervalMs,
  run: async () => {
    const report = await refreshTools(null);
    const totals = summarizeTools(report.servers);
    const stale = report.servers.filter((entry) => entry.stale).length;
    console.log(
      `${TAG} tools: ${totals.listed} of ${totals.servers} servers listed, ${totals.tools} tools, ${totals.signIn} need sign-in, ${totals.stdio} stdio` +
        (stale ? `, ${stale} kept from an earlier pass` : ""),
    );
  },
});

export function stopToolsTimer(): void {
  pass.stop();
}

onStart(() => {
  restoreSaved();
  pass.start();
});
onShutdown(stopToolsTimer);

// ------------------------------------------------------------------ handlers

export async function handleMcpTools(_input: Record<string, never>, { paseo }: PluginHandlerContext) {
  return refreshTools(paseo);
}

/**
 * Never waits on a listing. With lists, it answers with them; with none yet,
 * ones saved by the last run, or ones older than the listing interval (back
 * from a pause), it also starts a listing in the background and says
 * `checking`, as the health read does.
 */
export async function handleMcpToolsCached(_input: Record<string, never>, { paseo }: PluginHandlerContext) {
  lastPaseo = paseo;
  restoreSaved();
  const interval = toolsIntervalMs();
  const age = cached ? Date.now() - Date.parse(cached.checkedAt) : 0;
  if (!cached || cached.stale || (interval !== null && age > interval)) refreshForRead(paseo);
  return { report: cached, inFlight: inFlight !== null, checking: inFlight !== null };
}
