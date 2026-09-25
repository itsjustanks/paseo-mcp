/**
 * What one agent's MCP tool definitions cost in context, estimated honestly.
 * Pure: the host gathers the inputs (the agent's load, the cached tool lists,
 * the tool-search verdict), the chip and the panel render the result.
 *
 * Every number here is an estimate and is shown with "≈" or "~":
 *
 *  - A listed HTTP server is measured: the JSON of each tool's name,
 *    description and input schema, in characters, divided by four, the usual
 *    rule of thumb for English and JSON text. The host measures the raw
 *    `tools/list` answer before it is shortened for display (shared/tools.ts).
 *  - Paseo's built-in tools are counted at PASEO_TOKENS_PER_TOOL each, measured
 *    the same way on Paseo 0.9.1's own `tools/list` on 2026-09-24: 61 tools,
 *    about 8,250 tokens, 135 per tool (44 to 535).
 *  - Anything the plugin cannot list (a stdio server, an OAuth server before
 *    sign-in, an unreachable one) counts UNLISTED_SERVER_TOKENS: the budget's
 *    five tools per server (shared/budget.ts) at TOKENS_PER_TOOL_GUESS each.
 *    That per-tool figure is an assumption, between Paseo's measured 135 and
 *    the roughly 1,500 per tool Anthropic reported for large MCP servers.
 *
 * With tool search on, the CLI loads names up front and definitions on
 * demand, so the chip says "deferred" rather than a cost.
 */
import { TOOLS_PER_SERVER_GUESS } from "./budget";
import type { ToolSearchVerdict } from "./tool-search";

export const CHARS_PER_TOKEN = 4;
/** Measured on Paseo 0.9.1's `tools/list`, 2026-09-24 (61 tools, ≈8,250 tokens). */
export const PASEO_TOKENS_PER_TOOL = 135;
/** An assumption for a tool the plugin cannot read; see the module comment. */
export const TOKENS_PER_TOOL_GUESS = 500;
/** The documented default for a server whose tools cannot be listed: 5 × 500. */
export const UNLISTED_SERVER_TOKENS = TOOLS_PER_SERVER_GUESS * TOKENS_PER_TOOL_GUESS;
/** Past this many characters a single definition is not measured further (a broken server, not a real list). */
const MAX_DEFINITION_CHARS = 200_000;

/**
 * Estimated tokens for a raw `tools/list` `tools` array: name, description and
 * input schema per tool, as JSON, ÷ 4. Entries without a name are skipped.
 */
export function definitionTokens(rawTools: unknown): number {
  if (!Array.isArray(rawTools)) return 0;
  let chars = 0;
  for (const raw of rawTools) {
    const entry = raw as { name?: unknown; description?: unknown; inputSchema?: unknown } | null;
    if (!entry || typeof entry !== "object" || typeof entry.name !== "string" || !entry.name) continue;
    let text: string;
    try {
      text = JSON.stringify({ name: entry.name, description: typeof entry.description === "string" ? entry.description : "", input_schema: entry.inputSchema ?? {} });
    } catch {
      text = entry.name;
    }
    chars += Math.min(text.length, MAX_DEFINITION_CHARS);
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * How a server's cost was reached: `measured` from its own tool list,
 * `counted` from a tool count without definitions (a list saved by an older
 * plugin), `catalogue` for Paseo's tools, `default` when nothing was listed.
 */
export type CostBasis = "measured" | "counted" | "catalogue" | "default";

export type ServerCost = { name: string; tokens: number; basis: CostBasis };

/** What the host knows about one server's tools: from the tool lists or the added-server probe. */
export type ToolsKnown = { listed: boolean; tools: number; definitionTokens?: number };

export type MeterInput = {
  /** Editor-defined servers the agent loads, switched-off ones already left out. */
  servers: ReadonlyArray<{ name: string }>;
  /** Servers the agent was started with that no editor explains (0.11.2). */
  added?: ReadonlyArray<{ name: string; tools?: number; definitionTokens?: number }>;
  /** Tool lists by server name. */
  known: ReadonlyMap<string, ToolsKnown>;
  /** Paseo's built-in tools for this provider (0 when none). */
  paseoTools: number;
  toolSearch?: ToolSearchVerdict;
};

export type Meter = {
  /** Servers counted, Paseo's built-in one included. */
  servers: number;
  /** Estimated tokens for every definition, deferred or not. */
  tokens: number;
  /** Tool search is on for this provider: definitions load on demand. */
  deferred: boolean;
  /** Per server, heaviest first. */
  costs: ServerCost[];
  /** Servers counted at the default because nothing could be listed. */
  defaults: number;
};

export const PASEO_COST_NAME = "paseo";

export function costFor(name: string, known: ToolsKnown | undefined): ServerCost {
  if (known?.listed && typeof known.definitionTokens === "number") return { name, tokens: known.definitionTokens, basis: "measured" };
  if (known?.listed) return { name, tokens: known.tools * TOKENS_PER_TOOL_GUESS, basis: "counted" };
  return { name, tokens: UNLISTED_SERVER_TOKENS, basis: "default" };
}

export function meterFor(input: MeterInput): Meter {
  const costs: ServerCost[] = [];
  const seen = new Set<string>();
  for (const server of input.servers) {
    if (seen.has(server.name)) continue;
    seen.add(server.name);
    costs.push(costFor(server.name, input.known.get(server.name)));
  }
  for (const server of input.added ?? []) {
    if (seen.has(server.name)) continue;
    seen.add(server.name);
    const probed: ToolsKnown | undefined = server.tools !== undefined ? { listed: true, tools: server.tools, definitionTokens: server.definitionTokens } : input.known.get(server.name);
    costs.push(costFor(server.name, probed));
  }
  if (input.paseoTools > 0 && !seen.has(PASEO_COST_NAME)) {
    costs.push({ name: PASEO_COST_NAME, tokens: input.paseoTools * PASEO_TOKENS_PER_TOOL, basis: "catalogue" });
  }
  costs.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
  return {
    servers: costs.length,
    tokens: costs.reduce((sum, entry) => sum + entry.tokens, 0),
    deferred: input.toolSearch?.state === "on",
    costs,
    defaults: costs.filter((entry) => entry.basis === "default").length,
  };
}

// ------------------------------------------------------------------ wording

/** 38400 → "38k", 2500 → "2.5k", 950 → "950", 1000000 → "1M", 1250000 → "1.3M". */
export function shortTokens(tokens: number): string {
  const n = Math.max(0, Math.round(tokens));
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 || Number.isInteger(m) ? Math.round(m) : m.toFixed(1)}M`;
  }
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) {
    const k = Math.round(n / 100) / 10;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return String(n);
}

/** The chip's tail: "~38k tokens", or "deferred" while tool search is on. */
export function meterChipTail(meter: Pick<Meter, "tokens" | "deferred">): string {
  return meter.deferred ? "deferred" : `~${shortTokens(meter.tokens)} tokens`;
}

export function basisWord(basis: CostBasis): string {
  switch (basis) {
    case "measured":
      return "measured from its tool list";
    case "counted":
      return `tool count × ${TOKENS_PER_TOOL_GUESS}`;
    case "catalogue":
      return `${PASEO_TOKENS_PER_TOOL} per Paseo tool`;
    default:
      return `not listed: ${shortTokens(UNLISTED_SERVER_TOKENS)} default`;
  }
}

export type ContextUsage = { usedTokens: number; maxTokens: number };

/**
 * "This chat: 360k of 1M context; MCP definitions ≈38k of that." With tool
 * search on, the definitions are not all in the context, so it says that
 * instead of claiming a share.
 */
export function usageLine(usage: ContextUsage, meter: Pick<Meter, "tokens" | "deferred"> | null): string {
  const head = `This chat: ${shortTokens(usage.usedTokens)} of ${shortTokens(usage.maxTokens)} context`;
  if (!meter) return `${head}.`;
  if (meter.deferred) return `${head}; MCP definitions are deferred, so only the ones this chat used are in it.`;
  return `${head}; MCP definitions ≈${shortTokens(meter.tokens)} of that.`;
}

/** Usage from an agent snapshot's `lastUsage`, or null when it does not carry both numbers. */
export function usageFrom(lastUsage: unknown): ContextUsage | null {
  const usage = lastUsage as { contextWindowUsedTokens?: unknown; contextWindowMaxTokens?: unknown } | null | undefined;
  const used = usage?.contextWindowUsedTokens;
  const max = usage?.contextWindowMaxTokens;
  if (typeof used !== "number" || typeof max !== "number" || !Number.isFinite(used) || !Number.isFinite(max) || max <= 0 || used < 0) return null;
  return { usedTokens: used, maxTokens: max };
}
