import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { McpServerTools, McpToolsReport } from "../shared/contracts";
import { TOOLS_CONCURRENCY, listToolsMcp, mapLimit, stdioOutcome, summarizeTools } from "../shared/tools";
import { buildDestinations, destRead, discoverProjects, findDef, jsonMcpRead, type McpDef } from "./handlers";
import { readHealthSettings } from "./health";
import { onShutdown, onStart } from "./lifecycle";

const TAG = "[paseo-mcp]";

// ------------------------------------------------------------------- listing

/**
 * One pass over every server defined in any editor config or registered
 * project's `.mcp.json`, the same set the health check covers. HTTP servers are
 * asked for their tools a few at a time; stdio servers are reported as such
 * without being run. Nothing here spawns a process.
 */
export async function listAll(paseo: PluginHandlerContext["paseo"] | null): Promise<McpToolsReport> {
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
    if (!def) return { name, transport: "unknown", ...stdioOutcome(undefined), kind: "unavailable", note: "no readable definition" };
    if (def.command) return { name, transport: "stdio", ...stdioOutcome(def.command) };
    if (def.url) return { name, transport: "http", ...(await listToolsMcp(def.url, def.headers)) };
    return { name, transport: "unknown", ...stdioOutcome(undefined), kind: "unavailable", note: "no command or url" };
  });
  return { servers, checkedAt: new Date().toISOString() };
}

// --------------------------------------------------------------------- cache

let cached: McpToolsReport | null = null;
let inFlight: Promise<McpToolsReport> | null = null;
let lastPaseo: PluginHandlerContext["paseo"] | null = null;

/** List now, sharing one pass between concurrent callers, and cache the result. */
export function refreshTools(paseo: PluginHandlerContext["paseo"] | null): Promise<McpToolsReport> {
  if (paseo) lastPaseo = paseo;
  if (inFlight) return inFlight;
  inFlight = listAll(paseo ?? lastPaseo)
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

// Tool lists move far less often than reachability does, so the refresh runs
// on a multiple of the health interval, and only while background checks are on.
const TOOLS_INTERVAL_FACTOR = 6;
const RECHECK_SETTINGS_MS = 60_000;
let timer: ReturnType<typeof setTimeout> | null = null;

function schedule(delayMs: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(beat, delayMs);
}

function beat(): void {
  timer = null;
  const settings = readHealthSettings();
  if (!settings.backgroundChecks) {
    schedule(RECHECK_SETTINGS_MS);
    return;
  }
  void refreshTools(null)
    .then((report) => {
      const totals = summarizeTools(report.servers);
      console.log(`${TAG} tools: ${totals.listed} of ${totals.servers} servers listed, ${totals.tools} tools, ${totals.signIn} need sign-in, ${totals.stdio} stdio`);
    })
    .catch((error) => {
      console.error(`${TAG} tools listing failed:`, error instanceof Error ? error.message : error);
    })
    .finally(() => schedule(settings.intervalMinutes * 60_000 * TOOLS_INTERVAL_FACTOR));
}

function startToolsTimer(): void {
  if (timer) return;
  // Later than the health pass so the two do not hit every server at once on start-up.
  schedule(readHealthSettings().backgroundChecks ? 45_000 : RECHECK_SETTINGS_MS);
}

export function stopToolsTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

onStart(startToolsTimer);
onShutdown(stopToolsTimer);

// ------------------------------------------------------------------ handlers

export async function handleMcpTools(_input: Record<string, never>, { paseo }: PluginHandlerContext) {
  return refreshTools(paseo);
}

export async function handleMcpToolsCached(_input: Record<string, never>, { paseo }: PluginHandlerContext) {
  lastPaseo = paseo;
  return { report: cached, inFlight: inFlight !== null };
}
