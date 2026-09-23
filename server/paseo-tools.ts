import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { PaseoToolsLoad } from "../shared/contracts";
import { plainError } from "../shared/errors";
import {
  PASEO_TOOLS_AS_OF,
  buildPaseoToolsPatch,
  concurrentListChanges,
  paseoToolProviders,
  patchMismatch,
  readDaemonToolsConfig,
  resolvePaseoTools,
  unknownTools,
  type DaemonToolsConfig,
  type PaseoToolsChange,
  type PaseoToolsPatch,
  type PaseoToolsState,
} from "../shared/paseo-tools";
import { withDeadline } from "./run";

/**
 * Paseo's built-in MCP tools, read from and written to the daemon config
 * through the plugin's config API only; `config.json` is never touched here.
 * Reads share one answer for a few seconds, so the workspace panel, the agent
 * panel and every composer chip opening together ask the daemon once.
 *
 * Every write bumps `generation`. A read is cached, and shared with later
 * callers, only while no write has started since it began, so an answer read
 * before a write can never be served after it.
 */

type Paseo = PluginHandlerContext["paseo"];

const CACHE_MS = 5_000;

let generation = 0;
let cached: { at: number; config: DaemonToolsConfig } | null = null;
let inFlight: { generation: number; read: Promise<DaemonToolsConfig> } | null = null;

/** Keep a read only if no write started after it did. */
function remember(config: DaemonToolsConfig, startedAt: number): DaemonToolsConfig {
  if (startedAt === generation) cached = { at: Date.now(), config };
  return config;
}

async function readFresh(paseo: Paseo): Promise<DaemonToolsConfig> {
  const startedAt = generation;
  const { config } = await withDeadline(paseo.config.get(), "its daemon settings");
  return remember(readDaemonToolsConfig(config), startedAt);
}

/** The daemon's Paseo-tools settings, from the last few seconds' read when there is one. */
export function readToolsConfig(paseo: Paseo, fresh = false): Promise<DaemonToolsConfig> {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.config);
  if (inFlight?.generation === generation) return inFlight.read;
  const entry = { generation, read: readFresh(paseo) };
  inFlight = entry;
  void entry.read.finally(() => {
    if (inFlight === entry) inFlight = null;
  }).catch(() => undefined);
  return entry.read;
}

/** A write is starting: whatever was read before it is out of date. */
function startWrite(): void {
  generation += 1;
  cached = null;
}

/** For tests: forget the cached read. */
export function resetPaseoToolsCache(): void {
  generation += 1;
  cached = null;
  inFlight = null;
}

function report(config: DaemonToolsConfig, known: readonly string[] = []) {
  return { ...resolvePaseoTools(config, paseoToolProviders(config, known)), checkedAt: new Date().toISOString() };
}

export function toolsLoad(state: PaseoToolsState): PaseoToolsLoad {
  return {
    tools: Object.fromEntries(state.providers.map((entry) => [entry.id, entry.tools])),
    blocker: state.blocker,
    asOf: state.asOf,
  };
}

/**
 * What the workspace and agent RPCs count: tools per provider, including the
 * wired provider ids the caller knows. Undefined when the daemon config cannot
 * be read, so the panels show what they showed before rather than fail.
 */
export async function paseoToolsLoad(paseo: Paseo, known: readonly string[] = []): Promise<PaseoToolsLoad | undefined> {
  try {
    return toolsLoad(report(await readToolsConfig(paseo), known));
  } catch (error) {
    console.warn(`[paseo-mcp] Paseo tools not counted: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export async function handleMcpPaseoTools({ refresh }: { refresh?: boolean }, { paseo }: PluginHandlerContext) {
  return report(await readToolsConfig(paseo, Boolean(refresh)));
}

const APPLIES = "Agents started from now on get it; a running agent keeps the tools it started with.";

function names(list: string[]): string {
  return list.length <= 3 ? list.join(", ") : `${list.slice(0, 3).join(", ")} and ${list.length - 3} more`;
}

/** One sentence per thing written, in the order the card shows them. */
export function describePatch(patch: PaseoToolsPatch, before: DaemonToolsConfig): string {
  const lines: string[] = [];
  if (patch.mcp) {
    lines.push(patch.mcp.injectIntoAgents ? "Paseo tools are on for this host." : "Paseo tools are off for this host.");
  }
  if (patch.browserTools) lines.push(`Browser tools ${patch.browserTools.enabled ? "on" : "off"}.`);
  for (const [id, { paseoTools }] of Object.entries(patch.providers ?? {})) {
    if (paseoTools.enabled !== undefined) lines.push(`Paseo tools ${paseoTools.enabled ? "on" : "off"} for ${id}.`);
    if (paseoTools.disabledTools) {
      const was = new Set(before.providers[id]?.paseoTools?.disabledTools ?? []);
      const now = new Set(paseoTools.disabledTools);
      const off = [...now].filter((name) => !was.has(name));
      const on = [...was].filter((name) => !now.has(name));
      if (off.length) lines.push(`${names(off)} off for ${id}.`);
      if (on.length) lines.push(`${names(on)} on for ${id}.`);
    }
  }
  return lines.join(" ");
}

/**
 * Write a change: the smallest patch through `paseo.config.patch()`, then the
 * config read back and checked field by field. Every failure is reported in a
 * sentence, with the state as last read so the card never shows a guess.
 */
export async function handleMcpSetPaseoTools(change: PaseoToolsChange, { paseo }: PluginHandlerContext) {
  const unknown = unknownTools(change);
  if (unknown.length > 0) {
    return { ok: false, message: `Not a Paseo tool as of Paseo ${PASEO_TOOLS_AS_OF}: ${unknown.join(", ")}. Nothing was changed.` };
  }
  let before: DaemonToolsConfig;
  try {
    before = await readToolsConfig(paseo, true);
  } catch (error) {
    return { ok: false, message: `Could not read Paseo's settings, so nothing was changed. ${plainError(error)}` };
  }
  const patch = buildPaseoToolsPatch(before, change);
  if (!patch) return { ok: true, message: "Already set that way; nothing was written.", state: report(before) };
  startWrite();
  try {
    await withDeadline(paseo.config.patch(patch), "an answer to the settings change");
  } catch (error) {
    startWrite();
    return { ok: false, message: `Paseo did not accept the change. ${plainError(error)}` };
  }
  let after: DaemonToolsConfig;
  try {
    after = await readFresh(paseo);
  } catch (error) {
    startWrite();
    return { ok: false, message: `The change was sent but could not be read back, so it is not confirmed. ${plainError(error)}` };
  }
  const mismatch = patchMismatch(after, change);
  if (mismatch) {
    return { ok: false, message: `Paseo took the change but ${mismatch}; a launch flag or another client may hold that setting.`, state: report(after) };
  }
  // Our names read back as sent; the rest of a list can still have moved if
  // another client wrote the same provider at the same moment. Say so.
  const moved = concurrentListChanges(after, patch);
  const note = moved.length > 0
    ? ` Another client changed the tool list for ${moved.join(", ")} at the same time; the list shown is the one saved now.`
    : "";
  return { ok: true, message: `${describePatch(patch, before)} ${APPLIES}${note}`, state: report(after) };
}
