import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { healthIsSignIn, healthNeedsAttention, type McpHealth, type McpHealthReport, type McpHealthScope } from "../shared/contracts";
import { HEALTH_DEFAULTS, healthSettings, type HealthSettings } from "../shared/settings";
import { mapLimit } from "../shared/tools";
import { backgroundPass } from "./background";
import {
  binaryOnPath,
  buildDestinations,
  destRead,
  discoverProjects,
  findDef,
  jsonMcpRead,
  probeHttp,
  type McpDef,
} from "./handlers";
import { onShutdown, onStart } from "./lifecycle";
import { resolveSearchPath, settledSearchPath } from "./path";
import { definitionKey, loadSavedReports, restoredHealth, saveHealthReport } from "./report-cache";
import { readSettingsDocument } from "./settings";

const TAG = "[paseo-mcp]";
/** HTTP probes in flight at once during a pass: forty servers in batches, not forty sockets. */
const HEALTH_CONCURRENCY = 8;
/** A pass a panel read started that failed is not started again from a read for this long. */
const READ_RETRY_MS = 60_000;

export function readHealthSettings(): HealthSettings {
  return readSettingsDocument(healthSettings, HEALTH_DEFAULTS);
}

// ------------------------------------------------------------------- probing

/**
 * One pass over every server defined in any editor config (user level) or any
 * registered project's `.mcp.json` (project level). A server present at both
 * levels is probed once; its `scopes` list says where it lives, so a panel can
 * tell "fix ~/.claude.json" from "fix this project's .mcp.json".
 */
export async function probeAll(
  paseo: PluginHandlerContext["paseo"] | null,
  options: {
    /** Filled with each server's definition key (server/report-cache.ts). */
    keys?: Map<string, string>;
    /** False for a pass a panel read started: wait for the login PATH if it is being asked for, never ask. */
    startPathLookup?: boolean;
  } = {},
): Promise<McpHealthReport> {
  const destinations = await buildDestinations(paseo);
  const defsByDest = new Map(destinations.map((dest) => [dest.id, destRead(dest)] as const));
  const scopes = new Map<string, McpHealthScope[]>();
  const addScope = (name: string, scope: McpHealthScope) => {
    const list = scopes.get(name) ?? [];
    list.push(scope);
    scopes.set(name, list);
  };
  for (const dest of destinations) {
    for (const name of Object.keys(defsByDest.get(dest.id) ?? {})) {
      addScope(name, { level: "user", label: dest.label, configPath: dest.configPath });
    }
  }
  // Project definitions only fill in when no editor defines the name: the
  // user-level copy is what the editor actually runs.
  const projectDefs = new Map<string, McpDef>();
  for (const project of await discoverProjects(paseo)) {
    const file = join(project.path, ".mcp.json");
    if (!existsSync(file)) continue;
    for (const [name, def] of Object.entries(jsonMcpRead(file))) {
      addScope(name, { level: "project", label: project.name, configPath: file });
      if (!projectDefs.has(name)) projectDefs.set(name, def);
    }
  }

  const names = [...scopes.keys()].sort();
  // Stdio verdicts need the login shell's PATH, asked once per process.
  await (options.startPathLookup === false ? settledSearchPath() : resolveSearchPath());
  const results = await mapLimit(names, HEALTH_CONCURRENCY, async (name): Promise<McpHealth> => {
      const where = scopes.get(name) ?? [];
      const def = findDef(destinations, name, defsByDest) ?? projectDefs.get(name) ?? null;
      options.keys?.set(name, definitionKey(def));
      if (!def) return { name, status: "unknown", note: "no readable definition", scopes: where };
      if (def.command) {
        return binaryOnPath(def.command)
          ? { name, status: "ok", note: `binary '${def.command}' found`, scopes: where }
          : { name, status: "binary-missing", note: `'${def.command}' not on PATH`, scopes: where };
      }
      if (def.url) {
        const probe = await probeHttp(def.url, def.headers);
        return { name, ...probe, scopes: where };
      }
      return { name, status: "unknown", note: "no command or url", scopes: where };
  });
  return { results, checkedAt: new Date().toISOString() };
}

// --------------------------------------------------------------------- cache

let cached: McpHealthReport | null = null;
let inFlight: Promise<McpHealthReport> | null = null;
// The most recent paseo handle seen by any RPC. The timer uses it so a
// background pass honours provider overrides and the live project catalog.
let lastPaseo: PluginHandlerContext["paseo"] | null = null;
let restored = false;
let readPassFailedAt = 0;

/** The verdict the last run saved, "as of" its time, until this run has its own. */
function restoreSaved(): void {
  if (restored) return;
  restored = true;
  const saved = loadSavedReports().health;
  if (saved && !cached) cached = restoredHealth(saved.report);
}

/** Probe now, sharing one pass between concurrent callers, cache the verdict and save it for the next run. */
export function refreshHealth(
  paseo: PluginHandlerContext["paseo"] | null,
  options: { startPathLookup?: boolean } = {},
): Promise<McpHealthReport> {
  if (paseo) lastPaseo = paseo;
  restoreSaved();
  if (inFlight) return inFlight;
  const keys = new Map<string, string>();
  inFlight = probeAll(paseo ?? lastPaseo, { keys, startPathLookup: options.startPathLookup })
    .then((report) => {
      cached = report;
      saveHealthReport(report, keys);
      return report;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Start a pass for a panel read without waiting for it. A pass started this
 * way that failed is not retried from a read for a minute, so a read every few
 * seconds cannot turn into a probe every few seconds.
 */
function refreshForRead(paseo: PluginHandlerContext["paseo"] | null): void {
  if (inFlight || Date.now() - readPassFailedAt < READ_RETRY_MS) return;
  void refreshHealth(paseo, { startPathLookup: false }).catch((error: unknown) => {
    readPassFailedAt = Date.now();
    console.warn(`${TAG} health check failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/** For tests: forget this run's verdict and what was restored. */
export function resetHealthCache(): void {
  cached = null;
  restored = false;
  readPassFailedAt = 0;
}

/** For tests: wait for the pass in flight, if any. */
export async function healthSettled(): Promise<void> {
  await inFlight?.catch(() => undefined);
}

// --------------------------------------------------------------------- timer

// First pass shortly after start-up so the chip has a verdict before the user
// opens anything; later passes follow the configured interval (server/background.ts).
const pass = backgroundPass({
  name: "health check",
  firstDelayMs: 15_000,
  intervalMs: () => {
    const settings = readHealthSettings();
    return settings.backgroundChecks ? settings.intervalMinutes * 60_000 : null;
  },
  run: async () => {
    const report = await refreshHealth(null);
    const issues = report.results.filter((entry) => healthNeedsAttention(entry.status)).length;
    const signIn = report.results.filter((entry) => healthIsSignIn(entry.status)).length;
    console.log(`${TAG} health check: ${report.results.length} servers, ${issues} need attention, ${signIn} OAuth`);
  },
});

export function stopHealthTimer(): void {
  pass.stop();
}

onStart(() => {
  restoreSaved();
  pass.start();
});
onShutdown(stopHealthTimer);

// ------------------------------------------------------------------ handlers

export async function handleMcpHealth(_input: Record<string, never>, { paseo }: PluginHandlerContext) {
  return refreshHealth(paseo);
}

/**
 * Never waits on a probe. With a verdict, it answers with it; with none yet (a
 * fresh host), one saved by the last run, or one older than the interval (back
 * from a pause), it also starts a pass in the background and says `checking`.
 * The app reads again every few seconds while it is checking.
 */
export async function handleMcpHealthCached(_input: Record<string, never>, { paseo }: PluginHandlerContext) {
  lastPaseo = paseo;
  restoreSaved();
  const settings = readHealthSettings();
  const age = cached ? Date.now() - Date.parse(cached.checkedAt) : 0;
  const pausedTooLong = settings.backgroundChecks && age > settings.intervalMinutes * 60_000;
  if (!cached || cached.stale || pausedTooLong) refreshForRead(paseo);
  return {
    report: cached,
    backgroundChecks: settings.backgroundChecks,
    intervalMinutes: settings.intervalMinutes,
    showComposerPill: settings.showComposerPill,
    nextCheckAt: settings.backgroundChecks ? pass.nextRunAt() : null,
    checking: inFlight !== null,
  };
}
