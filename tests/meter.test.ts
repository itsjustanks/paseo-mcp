/** The context meter (0.14.0): the token estimator, the per-agent meter, its wording, and the chip label. */
import assert from "node:assert/strict";
import test from "node:test";
import { chipLabel, type McpHealthReport, type McpToolsReport } from "../shared/contracts";
import {
  PASEO_TOKENS_PER_TOOL,
  TOKENS_PER_TOOL_GUESS,
  UNLISTED_SERVER_TOKENS,
  definitionTokens,
  meterChipTail,
  meterFor,
  shortTokens,
  usageFrom,
  usageLine,
  type ToolsKnown,
} from "../shared/meter";
import { listToolsMcp } from "../shared/tools";

const tool = (name: string, description = "", inputSchema: unknown = { type: "object" }) => ({ name, description, inputSchema });

test("definitions cost their JSON (name, description, input schema) ÷ 4, rounded up", () => {
  const one = tool("search", "Find things.", { type: "object", properties: { q: { type: "string" } }, required: ["q"] });
  const json = JSON.stringify({ name: one.name, description: one.description, input_schema: one.inputSchema });
  assert.equal(definitionTokens([one]), Math.ceil(json.length / 4));
  assert.equal(definitionTokens([one, one]), Math.ceil((json.length * 2) / 4), "every tool counts");
  assert.equal(definitionTokens([{ description: "no name" }, null, 7, one]), Math.ceil(json.length / 4), "entries without a name are skipped");
  assert.equal(definitionTokens(undefined), 0);
  assert.equal(definitionTokens({ tools: [] }), 0, "only an array is a list");
  // A longer description costs more: the estimate reads the raw text, not the one-line display copy.
  assert.ok(definitionTokens([tool("a", "x".repeat(2000))]) > definitionTokens([tool("a", "x".repeat(200))]));
});

test("the host measures a listed server before its descriptions are shortened for display", async () => {
  const raw = [tool("long", "y".repeat(1200), { type: "object", properties: { id: { type: "string" } } }), tool("short")];
  const fetch = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string };
    const result = body.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } } : { tools: raw };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const outcome = await listToolsMcp("https://mcp.example.com/mcp", undefined, { fetch });
  assert.equal(outcome.kind, "listed");
  assert.ok(outcome.tools[0]!.description.length <= 240, "the display copy is capped");
  assert.equal(outcome.definitionTokens, definitionTokens(raw), "the estimate is of the full definitions");
});

test("a meter adds measured, counted, default and catalogue costs, heaviest first", () => {
  const known = new Map<string, ToolsKnown>([
    ["supabase", { listed: true, tools: 20, definitionTokens: 9000 }],
    ["old", { listed: true, tools: 3 }],
    ["linear", { listed: false, tools: 0 }],
  ]);
  const meter = meterFor({
    servers: [{ name: "supabase" }, { name: "old" }, { name: "linear" }, { name: "playwright" }, { name: "supabase" }],
    added: [{ name: "remote", tools: 2, definitionTokens: 400 }, { name: "shared-browser" }, { name: "old" }],
    known,
    paseoTools: 61,
  });
  assert.deepEqual(
    meter.costs.map((entry) => [entry.name, entry.tokens, entry.basis]),
    [
      ["supabase", 9000, "measured"],
      ["paseo", 61 * PASEO_TOKENS_PER_TOOL, "catalogue"],
      ["linear", UNLISTED_SERVER_TOKENS, "default"],
      ["playwright", UNLISTED_SERVER_TOKENS, "default"],
      ["shared-browser", UNLISTED_SERVER_TOKENS, "default"],
      ["old", 3 * TOKENS_PER_TOOL_GUESS, "counted"],
      ["remote", 400, "measured"],
    ],
  );
  assert.equal(meter.servers, 7, "a name is counted once, Paseo's server included");
  assert.equal(meter.tokens, meter.costs.reduce((sum, entry) => sum + entry.tokens, 0));
  assert.equal(meter.defaults, 3);
  assert.equal(meter.deferred, false, "no verdict: not deferred");
  assert.equal(UNLISTED_SERVER_TOKENS, 2500, "the documented default: five tools at 500");
});

test("tool search on defers; off and unknown do not", () => {
  const base = { servers: [{ name: "a" }], known: new Map<string, ToolsKnown>(), paseoTools: 0 };
  assert.equal(meterFor({ ...base, toolSearch: { state: "on", reason: "Claude Code's default", cli: "claude" } }).deferred, true);
  assert.equal(meterFor({ ...base, toolSearch: { state: "off", reason: "x", cli: "claude" } }).deferred, false);
  assert.equal(meterFor({ ...base, toolSearch: { state: "unknown", reason: "x", cli: "codex" } }).deferred, false);
  assert.equal(meterFor({ ...base, paseoTools: 0 }).costs.some((entry) => entry.name === "paseo"), false, "no Paseo tools, no Paseo row");
});

test("numbers read short and say they are estimates", () => {
  assert.equal(shortTokens(950), "950");
  assert.equal(shortTokens(38_400), "38k");
  assert.equal(shortTokens(2500), "2.5k", "the default is not rounded up to 3k");
  assert.equal(shortTokens(8235), "8.2k");
  assert.equal(shortTokens(9_960), "10k");
  assert.equal(shortTokens(360_000), "360k");
  assert.equal(shortTokens(1_000_000), "1M");
  assert.equal(shortTokens(1_250_000), "1.3M");
  assert.equal(meterChipTail({ tokens: 38_400, deferred: false }), "~38k tokens");
  assert.equal(meterChipTail({ tokens: 38_400, deferred: true }), "deferred");
  assert.equal(usageLine({ usedTokens: 360_000, maxTokens: 1_000_000 }, { tokens: 38_000, deferred: false }), "This chat: 360k of 1M context; MCP definitions ≈38k of that.");
  assert.match(usageLine({ usedTokens: 360_000, maxTokens: 1_000_000 }, { tokens: 38_000, deferred: true }), /deferred/);
  assert.equal(usageLine({ usedTokens: 5000, maxTokens: 200_000 }, null), "This chat: 5k of 200k context.");
});

test("usage is read only when the snapshot carries both numbers", () => {
  assert.deepEqual(usageFrom({ contextWindowUsedTokens: 360_000, contextWindowMaxTokens: 1_000_000, inputTokens: 5 }), { usedTokens: 360_000, maxTokens: 1_000_000 });
  assert.equal(usageFrom({ contextWindowUsedTokens: 10 }), null);
  assert.equal(usageFrom({ contextWindowUsedTokens: 10, contextWindowMaxTokens: 0 }), null);
  assert.equal(usageFrom(null), null);
});

// ------------------------------------------------------------------ chip

const checkedAt = "2026-09-24T00:00:00.000Z";
const health = (statuses: McpHealthReport["results"][number]["status"][]): McpHealthReport => ({
  checkedAt,
  results: statuses.map((status, index) => ({ name: `s${index}`, status, note: "", scopes: [] })),
});
const tools: McpToolsReport = { checkedAt, servers: [] };
const meter = { servers: 14, tokens: 38_200, deferred: false };

test("the chip shows this agent's cost once its meter is in; issues and sign-ins still win", () => {
  assert.deepEqual(chipLabel(health(["ok", "ok"]), tools, 61, meter), { label: "14 MCP · ~38k tokens", tone: "calm" });
  assert.deepEqual(chipLabel(health(["ok"]), tools, 61, { ...meter, deferred: true }), { label: "14 MCP · deferred", tone: "calm" });
  assert.deepEqual(chipLabel(health(["down", "warn", "ok"]), tools, 0, meter), { label: "14 MCP · 2 issues", tone: "attention" }, "issues win");
  assert.deepEqual(chipLabel(health(["auth-required", "ok"]), tools, 0, meter), { label: "14 MCP · 1 need sign-in", tone: "calm" }, "sign-in wins over the cost");
  assert.deepEqual(chipLabel(null, tools, 0, meter), { label: "14 MCP · ~38k tokens", tone: "calm" }, "before the first health pass");
});

test("without a meter (loading, or a host older than 0.14.0) the chip reads as before", () => {
  const listed: McpToolsReport = { checkedAt, servers: [{ name: "a", transport: "http", kind: "listed", note: "", tools: [{ name: "t", title: "", description: "", takesArguments: false, arguments: [], required: [] }], serverInfo: null, protocolVersion: "" }] };
  assert.deepEqual(chipLabel(health(["ok"]), listed, 0), { label: "1 MCP · 1 tools", tone: "calm" });
  assert.deepEqual(chipLabel(health(["ok"]), listed, 0, null), { label: "1 MCP · 1 tools", tone: "calm" });
  assert.deepEqual(chipLabel(null, listed, 0, null), { label: "1 MCP", tone: "calm" });
});
