import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { McpHealth, McpHealthReport, McpHealthScope } from "../shared/contracts";
import { HEALTH_DEFAULTS, healthSettings, type HealthSettings } from "../shared/settings";
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
import { readSettingsDocument } from "./settings";

const TAG = "[paseo-mcp]";

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
export async function probeAll(paseo: PluginHandlerContext["paseo"] | null): Promise<McpHealthReport> {
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
  const results = await Promise.all(
    names.map(async (name): Promise<McpHealth> => {
      const where = scopes.get(name) ?? [];
      const def = findDef(destinations, name, defsByDest) ?? projectDefs.get(name) ?? null;
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
    }),
  );
  return { results, checkedAt: new Date().toISOString() };
}

// --------------------------------------------------------------------- cache

let cached: McpHealthReport | null = null;
let inFlight: Promise<McpHealthReport> | null = null;
// The most recent paseo handle seen by any RPC. The timer uses it so a
// background pass honours provider overrides and the live project catalog.
let lastPaseo: PluginHandlerContext["paseo"] | null = null;

/** Probe now, sharing one pass between concurrent callers, and cache the verdict. */
export function refreshHealth(paseo: PluginHandlerContext["paseo"] | null): Promise<McpHealthReport> {
  if (paseo) lastPaseo = paseo;
  if (inFlight) return inFlight;
  inFlight = probeAll(paseo ?? lastPaseo)
    .then((report) => {
      cached = report;
      return report;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

// --------------------------------------------------------------------- timer

let timer: ReturnType<typeof setTimeout> | null = null;
let nextCheckAt: string | null = null;
// Settings can change between beats, so the delay is recomputed every time
// rather than fixed once with setInterval. A disabled check still wakes up
// once a minute to notice when it is turned back on.
const RECHECK_SETTINGS_MS = 60_000;

function schedule(delayMs: number, probe: boolean): void {
  if (timer) clearTimeout(timer);
  nextCheckAt = probe ? new Date(Date.now() + delayMs).toISOString() : null;
  timer = setTimeout(beat, delayMs);
}

function beat(): void {
  timer = null;
  const settings = readHealthSettings();
  if (!settings.backgroundChecks) {
    schedule(RECHECK_SETTINGS_MS, false);
    return;
  }
  void refreshHealth(null)
    .then((report) => {
      const issues = report.results.filter((entry) => entry.status !== "ok" && entry.status !== "unknown").length;
      console.log(`${TAG} health check: ${report.results.length} servers, ${issues} need attention`);
    })
    .catch((error) => {
      console.error(`${TAG} health check failed:`, error instanceof Error ? error.message : error);
    })
    .finally(() => schedule(settings.intervalMinutes * 60_000, true));
}

function startHealthTimer(): void {
  if (timer) return;
  // First pass shortly after start-up so the pill has a verdict before the
  // user opens anything; later passes follow the configured interval.
  schedule(readHealthSettings().backgroundChecks ? 15_000 : RECHECK_SETTINGS_MS, readHealthSettings().backgroundChecks);
}

export function stopHealthTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  nextCheckAt = null;
}

onStart(startHealthTimer);
onShutdown(stopHealthTimer);

// ------------------------------------------------------------------ handlers

export async function handleMcpHealth(_input: Record<string, never>, { paseo }: PluginHandlerContext) {
  return refreshHealth(paseo);
}

export async function handleMcpHealthCached(_input: Record<string, never>, { paseo }: PluginHandlerContext) {
  lastPaseo = paseo;
  const settings = readHealthSettings();
  return {
    report: cached,
    backgroundChecks: settings.backgroundChecks,
    intervalMinutes: settings.intervalMinutes,
    nextCheckAt: settings.backgroundChecks ? nextCheckAt : null,
  };
}
