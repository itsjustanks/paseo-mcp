import assert from "node:assert/strict";
import test from "node:test";
import { chipLabel, type McpHealthReport, type McpToolsReport } from "../shared/contracts";
import {
  TOOLS_LIST_REQUEST,
  cleanText,
  listToolsMcp,
  mapLimit,
  readRpcReply,
  schemaArguments,
  shapeServerInfo,
  shapeTool,
  shapeToolList,
  stdioOutcome,
  summarizeTools,
} from "../shared/tools";

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.sig-abcdefghijklmnop";
const URL_WITH_TOKEN = `https://mcp.example.test/mcp?token=${TOKEN}`;
const HEADERS = { Authorization: "Bearer hdr-secret-value-9876543210" };

const INIT_RESULT = {
  protocolVersion: "2025-06-18",
  capabilities: { tools: { listChanged: true } },
  serverInfo: { name: "example-mcp", version: "1.2.3" },
};
const TOOLS_RESULT = {
  tools: [
    {
      name: "search",
      title: "Search things",
      description: "Finds\nthings\twith   controlchars",
      inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    },
    { name: "ping", description: "No arguments", inputSchema: { type: "object", properties: {} } },
    { name: "search", description: "duplicate name, dropped" },
    { notAName: true },
  ],
};

function rpc(id: number, result: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
function sse(id: number, result: unknown) {
  return `event: message\ndata: ${rpc(id, result)}\n\n`;
}
function response(body: string, init: { status?: number; contentType?: string; sessionId?: string } = {}): Response {
  const headers: Record<string, string> = { "content-type": init.contentType ?? "application/json" };
  if (init.sessionId) headers["mcp-session-id"] = init.sessionId;
  return new Response(body, { status: init.status ?? 200, headers });
}

/** A fake server: answers initialize then tools/list, recording every request. */
function fakeServer(options: { sse?: boolean; sessionId?: string; listStatus?: number } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: { id: number; method: string } }> = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(init.body as string) as { id: number; method: string };
    calls.push({ url, headers: init.headers as Record<string, string>, body });
    const frame = options.sse ? sse : rpc;
    const contentType = options.sse ? "text/event-stream" : "application/json";
    if (body.method === "initialize") return response(frame(body.id, INIT_RESULT), { contentType, sessionId: options.sessionId });
    if (options.listStatus) return response("", { status: options.listStatus });
    return response(frame(body.id, TOOLS_RESULT), { contentType });
  };
  return { calls, fetch };
}

test("cleanText flattens server text to one safe, capped line", () => {
  assert.equal(cleanText("a\nb\tcd   e", 80), "a b c d e");
  assert.equal(cleanText("x".repeat(20), 10).length, 10);
  assert.equal(cleanText(42, 10), "");
});

test("schemaArguments reads property names and required from a JSON schema", () => {
  assert.deepEqual(schemaArguments({ properties: { a: {}, b: {} }, required: ["b", "zzz"] }), { names: ["a", "b"], required: ["b"] });
  assert.deepEqual(schemaArguments(undefined), { names: [], required: [] });
  assert.deepEqual(schemaArguments({ type: "object" }), { names: [], required: [] });
});

test("shapeTool keeps name, title, description and the argument summary", () => {
  const tool = shapeTool(TOOLS_RESULT.tools[0]);
  assert.ok(tool);
  assert.equal(tool.name, "search");
  assert.equal(tool.title, "Search things");
  assert.equal(tool.description, "Finds things with control chars");
  assert.equal(tool.takesArguments, true);
  assert.deepEqual(tool.arguments, ["query", "limit"]);
  assert.deepEqual(tool.required, ["query"]);
  assert.equal(shapeTool({ notAName: true }), null);
  assert.equal(shapeTool(TOOLS_RESULT.tools[1])?.takesArguments, false);
});

test("shapeToolList drops duplicates and nameless entries and sorts by name", () => {
  const tools = shapeToolList(TOOLS_RESULT);
  assert.deepEqual(tools.map((tool) => tool.name), ["ping", "search"]);
  assert.deepEqual(shapeToolList({}), []);
  assert.deepEqual(shapeToolList(null), []);
});

test("shapeServerInfo reads the handshake's serverInfo", () => {
  assert.deepEqual(shapeServerInfo(INIT_RESULT), { name: "example-mcp", version: "1.2.3" });
  assert.equal(shapeServerInfo({}), null);
});

test("readRpcReply reads plain JSON and SSE framing and ignores other ids", async () => {
  assert.deepEqual((await readRpcReply(response(rpc(2, { ok: 1 })), 2))?.result, { ok: 1 });
  const mixed = `event: message\ndata: ${rpc(1, { first: true })}\n\nevent: message\ndata: ${rpc(2, { second: true })}\n\n`;
  assert.deepEqual((await readRpcReply(response(mixed, { contentType: "text/event-stream" }), 2))?.result, { second: true });
  assert.equal(await readRpcReply(response("not json"), 2), null);
});

test("listTools does initialize then tools/list and shapes the result", async () => {
  const server = fakeServer();
  const outcome = await listToolsMcp(URL_WITH_TOKEN, HEADERS, { fetch: server.fetch });
  assert.equal(outcome.kind, "listed");
  assert.equal(outcome.tools.length, 2);
  assert.deepEqual(outcome.serverInfo, { name: "example-mcp", version: "1.2.3" });
  assert.equal(outcome.protocolVersion, "2025-06-18");
  assert.deepEqual(server.calls.map((call) => call.body.method), ["initialize", TOOLS_LIST_REQUEST.method]);
  for (const call of server.calls) {
    assert.equal(call.url, URL_WITH_TOKEN, "configured URL sent intact");
    assert.equal(call.headers.Authorization, HEADERS.Authorization);
    assert.match(call.headers.accept, /text\/event-stream/);
  }
  // This server issued no session id, so none is sent.
  assert.equal("mcp-session-id" in server.calls[1]!.headers, false);
});

test("listTools reads SSE-framed answers and echoes the session id it was given", async () => {
  const server = fakeServer({ sse: true, sessionId: "sess-123" });
  const outcome = await listToolsMcp(URL_WITH_TOKEN, undefined, { fetch: server.fetch });
  assert.equal(outcome.kind, "listed");
  assert.equal(outcome.tools.length, 2);
  assert.equal(server.calls[0]!.headers["mcp-session-id"], undefined);
  assert.equal(server.calls[1]!.headers["mcp-session-id"], "sess-123");
});

test("a 401 is 'sign in to list tools', not an error", async () => {
  const outcome = await listToolsMcp(URL_WITH_TOKEN, HEADERS, { fetch: async () => response("", { status: 401 }) });
  assert.equal(outcome.kind, "auth-required");
  assert.equal(outcome.note, "sign in to list tools");
  assert.deepEqual(outcome.tools, []);
});

test("a server that initializes but refuses tools/list is unavailable with serverInfo kept", async () => {
  const server = fakeServer({ listStatus: 404 });
  const outcome = await listToolsMcp(URL_WITH_TOKEN, undefined, { fetch: server.fetch });
  assert.equal(outcome.kind, "unavailable");
  assert.deepEqual(outcome.serverInfo, { name: "example-mcp", version: "1.2.3" });
  assert.match(outcome.note, /404/);
});

test("a URL that lands on a web page is unavailable with a path hint", async () => {
  const outcome = await listToolsMcp(URL_WITH_TOKEN, undefined, {
    fetch: async () => response("<!DOCTYPE html><html><body>hi</body></html>", { contentType: "text/html; charset=utf-8" }),
  });
  assert.equal(outcome.kind, "unavailable");
  assert.match(outcome.note, /web page/);
  assert.match(outcome.note, /URL path/);
});

test("a server declaring no tools capability is listed with zero tools and not asked", async () => {
  const calls: string[] = [];
  const outcome = await listToolsMcp(URL_WITH_TOKEN, undefined, {
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body as string) as { id: number; method: string };
      calls.push(body.method);
      return response(rpc(body.id, { protocolVersion: "2025-06-18", capabilities: { prompts: {} } }));
    },
  });
  assert.equal(outcome.kind, "listed");
  assert.deepEqual(outcome.tools, []);
  assert.deepEqual(calls, ["initialize"]);
});

test("network failures and timeouts are unavailable, and notes never carry the URL or token", async () => {
  const leaky = await listToolsMcp(URL_WITH_TOKEN, HEADERS, {
    fetch: async () => {
      throw new Error(`request to ${URL_WITH_TOKEN} failed with ${HEADERS.Authorization}`);
    },
  });
  assert.equal(leaky.kind, "unavailable");
  for (const fragment of [URL_WITH_TOKEN, TOKEN, "mcp.example.test", "hdr-secret-value-9876543210"]) {
    assert.equal(leaky.note.includes(fragment), false, `note leaked ${fragment.slice(0, 12)}`);
  }
  const slow = await listToolsMcp(URL_WITH_TOKEN, undefined, {
    timeoutMs: 10,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  });
  assert.equal(slow.kind, "unavailable");
  assert.match(slow.note, /timeout/);
});

test("stdio servers are never run; the outcome says so without the command's arguments", () => {
  const outcome = stdioOutcome("/home/demo/.npm/bin/mcp-server-x");
  assert.equal(outcome.kind, "stdio");
  assert.match(outcome.note, /mcp-server-x/);
  assert.equal(outcome.note.includes("/home/demo"), false);
  assert.deepEqual(outcome.tools, []);
});

test("mapLimit keeps order and never exceeds the limit", async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5 - (n % 3)));
    active -= 1;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(peak <= 3 && peak > 1);
});

const toolsReport = (servers: Array<Partial<McpToolsReport["servers"][number]>>): McpToolsReport => ({
  checkedAt: "2026-09-10T00:00:00.000Z",
  servers: servers.map((entry) => ({ name: "x", transport: "http", kind: "listed", note: "", tools: [], serverInfo: null, protocolVersion: "", ...entry })),
});
const healthReport = (statuses: McpHealthReport["results"][number]["status"][]): McpHealthReport => ({
  checkedAt: "2026-09-10T00:00:00.000Z",
  results: statuses.map((status, index) => ({ name: `s${index}`, status, note: "", scopes: [] })),
});
const tool = (name: string) => ({ name, title: "", description: "", takesArguments: false, arguments: [], required: [] });

test("summarizeTools counts each outcome kind", () => {
  const totals = summarizeTools(
    toolsReport([
      { kind: "listed", tools: [tool("a"), tool("b")] },
      { kind: "listed", tools: [tool("c")] },
      { kind: "auth-required" },
      { kind: "stdio", transport: "stdio" },
      { kind: "unavailable" },
    ]).servers,
  );
  assert.deepEqual(totals, { servers: 5, listed: 2, tools: 3, signIn: 1, stdio: 1, unavailable: 1 });
});

test("chipLabel leads with the problem, then sign-in, then the tool total", () => {
  const tools = toolsReport([{ tools: [tool("a"), tool("b")] }, { tools: [tool("c")] }]);
  assert.deepEqual(chipLabel(healthReport(["ok", "down", "warn"]), tools), { label: "3 MCP · 2 issues", tone: "attention" });
  assert.deepEqual(chipLabel(healthReport(["ok", "binary-missing", "auth-required"]), tools), { label: "3 MCP · 1 issue", tone: "attention" });
  assert.deepEqual(chipLabel(healthReport(["ok", "auth-required", "auth-required"]), tools), { label: "3 MCP · 2 need sign-in", tone: "calm" });
  assert.deepEqual(chipLabel(healthReport(["ok", "ok"]), tools), { label: "2 MCP · 3 tools", tone: "calm" });
  assert.deepEqual(chipLabel(healthReport(["ok", "ok"]), null), { label: "2 MCP · healthy", tone: "calm" });
  assert.deepEqual(chipLabel(null, null), { label: "MCP", tone: "calm" });
  assert.deepEqual(chipLabel(null, tools), { label: "2 MCP", tone: "calm" });
});
