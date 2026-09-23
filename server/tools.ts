import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { McpServerTools, McpToolsReport } from "../shared/contracts";
import { TOOLS_CONCURRENCY, keepLastGoodTools, listToolsMcp, mapLimit, stdioOutcome, summarizeTools } from "../shared/tools";
import { backgroundPass } from "./background";
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
export async function listAll(
  paseo: PluginHandlerContext["paseo"] | null,
  urls: Map<string, string> = new Map(),
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
    if (!def) return { name, transport: "unknown", ...stdioOutcome(undefined), kind: "unavailable", note: "no readable definition" };
    if (def.command) return { name, transport: "stdio", ...stdioOutcome(def.command) };
    if (def.url) {
      urls.set(name, def.url);
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
// Each HTTP server's URL at the last pass: a stale list is only kept for a
// definition that has not changed since it was read.
let lastUrls = new Map<string, string>();

/** List now, sharing one pass between concurrent callers, and cache the result. */
export function refreshTools(paseo: PluginHandlerContext["paseo"] | null): Promise<McpToolsReport> {
  if (paseo) lastPaseo = paseo;
  if (inFlight) return inFlight;
  const urls = new Map<string, string>();
  inFlight = listAll(paseo ?? lastPaseo, urls)
    .then((report) => {
      const previousUrls = lastUrls;
      cached = keepLastGoodTools(cached, report, (name) => previousUrls.get(name) === urls.get(name));
      lastUrls = urls;
      return cached;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

// --------------------------------------------------------------------- timer

// Tool lists move far less often than reachability does, so the refresh runs
// on a multiple of the health interval, and only while background checks are
// on. The first pass comes later than the health pass so the two do not hit
// every server at once on start-up.
const TOOLS_INTERVAL_FACTOR = 6;

const pass = backgroundPass({
  name: "tools listing",
  firstDelayMs: 45_000,
  intervalMs: () => {
    const settings = readHealthSettings();
    return settings.backgroundChecks ? settings.intervalMinutes * 60_000 * TOOLS_INTERVAL_FACTOR : null;
  },
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

onStart(() => pass.start());
onShutdown(stopToolsTimer);

// ------------------------------------------------------------------ handlers

export async function handleMcpTools(_input: Record<string, never>, { paseo }: PluginHandlerContext) {
  return refreshTools(paseo);
}

export async function handleMcpToolsCached(_input: Record<string, never>, { paseo }: PluginHandlerContext) {
  lastPaseo = paseo;
  return { report: cached, inFlight: inFlight !== null };
}
