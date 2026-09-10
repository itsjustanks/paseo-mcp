/**
 * What tools an MCP server exposes, asked the way a client asks: `initialize`,
 * then `tools/list`, over streamable HTTP. Pure so it can be unit-tested with a
 * stubbed fetch; the server supplies the real fetch, caches the answer, and the
 * client only renders it.
 *
 * Honesty rules: an OAuth server answers an anonymous probe with 401, which is
 * "sign in to list tools", not an error. A stdio server's tools are only
 * knowable by running its command, which this module never does. A list is
 * either what the server said or absent — never guessed.
 */
import type { McpServerTools, McpTool, McpToolsKind } from "./contracts";
import { INITIALIZE_REQUEST, PROBE_TIMEOUT_MS, classifyProbe, describeError, parseJsonRpc, redactNote } from "./health";

/** Servers asked at once during a refresh; 29 HTTP servers in 5 batches, not 29 sockets. */
export const TOOLS_CONCURRENCY = 6;
/** Bodies past this are not read; a tools/list this large is not a list anyone renders. */
export const TOOLS_MAX_BODY_BYTES = 2 * 1024 * 1024;
const NAME_MAX = 80;
const DESCRIPTION_MAX = 240;

export const TOOLS_LIST_REQUEST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } as const;

// ------------------------------------------------------------------ shaping

/**
 * Server-controlled text, made safe to lay out: one line, no control
 * characters, capped. A description is free text from a third party and must
 * not be able to push a row off the screen or smuggle in a newline.
 */
export function cleanText(text: unknown, max: number): string {
  if (typeof text !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Argument names from a JSON-Schema `inputSchema`; empty when the tool takes nothing. */
export function schemaArguments(inputSchema: unknown): { names: string[]; required: string[] } {
  const schema = inputSchema as { properties?: unknown; required?: unknown } | null | undefined;
  const properties = schema && typeof schema === "object" && schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const names = Object.keys(properties as Record<string, unknown>).map((name) => cleanText(name, NAME_MAX)).filter(Boolean);
  const required = Array.isArray(schema?.required) ? schema.required.filter((entry): entry is string => typeof entry === "string" && names.includes(entry)) : [];
  return { names, required };
}

/** One `tools/list` entry reduced to what the UI shows, with the field a policy control will key on. */
export function shapeTool(raw: unknown): McpTool | null {
  const entry = raw as { name?: unknown; title?: unknown; description?: unknown; inputSchema?: unknown } | null;
  if (!entry || typeof entry !== "object") return null;
  const name = cleanText(entry.name, NAME_MAX);
  if (!name) return null;
  const { names, required } = schemaArguments(entry.inputSchema);
  return {
    name,
    title: cleanText(entry.title, NAME_MAX),
    description: cleanText(entry.description, DESCRIPTION_MAX),
    takesArguments: names.length > 0,
    arguments: names,
    required,
  };
}

/** The `tools` array out of a `tools/list` result, shaped and de-duplicated by name. */
export function shapeToolList(result: unknown): McpTool[] {
  const list = (result as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const tools: McpTool[] = [];
  for (const raw of list) {
    const tool = shapeTool(raw);
    if (!tool || seen.has(tool.name)) continue;
    seen.add(tool.name);
    tools.push(tool);
  }
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}

/** `serverInfo` from an `initialize` result, or null when the server sent none. */
export function shapeServerInfo(result: unknown): { name: string; version: string } | null {
  const info = (result as { serverInfo?: { name?: unknown; version?: unknown } } | null)?.serverInfo;
  if (!info || typeof info !== "object") return null;
  const name = cleanText(info.name, NAME_MAX);
  const version = cleanText(info.version, 40);
  return name || version ? { name, version } : null;
}

// ---------------------------------------------------------------- transport

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

type RpcReply =
  | { kind: "rpc"; code: number; result?: unknown; error?: unknown; sessionId: string | null }
  | { kind: "http"; code: number; contentType: string; body: string }
  | { kind: "timeout" }
  | { kind: "error"; code?: string; message: string };

/**
 * Read one JSON-RPC reply with the given id out of a response body. Streamable
 * HTTP may answer as plain JSON or as an SSE stream (`event: message\ndata: {…}`)
 * regardless of the accept header, so both framings are read; the stream is
 * stopped as soon as the matching envelope has arrived.
 */
export async function readRpcReply(response: Response, id: number): Promise<{ result?: unknown; error?: unknown } | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) text += decoder.decode(value, { stream: true });
      if (text.length > TOOLS_MAX_BODY_BYTES) return null;
      const found = findReply(text, id);
      if (found) return found;
      if (done) return findReply(text, id, true);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function findReply(text: string, id: number, final = false): { result?: unknown; error?: unknown } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidates: string[] = [];
  if (trimmed.startsWith("{")) {
    if (!final) {
      // A JSON body is complete when the last brace closes; cheaper to try the parse.
      const parsed = parseJsonRpc(trimmed);
      if (parsed) candidates.push(trimmed);
    } else candidates.push(trimmed);
  } else {
    // SSE: only complete events (terminated by a blank line) are read mid-stream.
    const events = text.split(/\r?\n\r?\n/);
    const complete = final ? events : events.slice(0, -1);
    for (const event of complete) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (data) candidates.push(data);
    }
  }
  for (const candidate of candidates) {
    const parsed = parseJsonRpc(candidate);
    if (!parsed) continue;
    if (parsed.id === id || parsed.id === undefined) return parsed;
  }
  return null;
}

/** One POST; the session id the server hands back, if any, is echoed on the next call. */
async function post(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string> | undefined,
  sessionId: string | null,
  request: { id: number; method: string },
  signal: AbortSignal,
): Promise<RpcReply> {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        ...headers,
      },
      body: JSON.stringify(request),
      signal,
      redirect: "follow",
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (response.status < 200 || response.status >= 300) {
      return { kind: "http", code: response.status, contentType, body: "" };
    }
    const reply = await readRpcReply(response, request.id);
    if (!reply) return { kind: "http", code: response.status, contentType, body: "" };
    return {
      kind: "rpc",
      code: response.status,
      result: reply.result,
      error: reply.error,
      sessionId: response.headers.get("mcp-session-id") ?? sessionId,
    };
  } catch (error) {
    if (signal.aborted) return { kind: "timeout" };
    const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "error",
      code: typeof cause?.code === "string" ? cause.code : undefined,
      message: typeof cause?.message === "string" ? cause.message : message,
    };
  }
}

// ------------------------------------------------------------------- listing

export type ListOutcome = Omit<McpServerTools, "name" | "transport">;

function unavailable(kind: McpToolsKind, note: string): ListOutcome {
  return { kind, note, tools: [], serverInfo: null, protocolVersion: "" };
}

/** A non-2xx or non-RPC answer, read with the health classifier so the two agree. */
function fromHttp(reply: Extract<RpcReply, { kind: "http" | "timeout" | "error" }>): ListOutcome {
  if (reply.kind === "timeout") return unavailable("unavailable", `timeout after ${PROBE_TIMEOUT_MS / 1000}s`);
  if (reply.kind === "error") return unavailable("unavailable", describeError(reply.code, reply.message));
  if (reply.code === 401 || reply.code === 403) return unavailable("auth-required", "sign in to list tools");
  // One real host has an HTTP server whose URL lands on a web page: a 200 with
  // HTML is a wrong URL path, not an MCP endpoint that declined.
  if (reply.code >= 200 && reply.code < 300 && /text\/html/i.test(reply.contentType)) {
    return unavailable("unavailable", `answered a web page, not MCP (HTTP ${reply.code}); check the URL path`);
  }
  const verdict = classifyProbe({ kind: "response", code: reply.code, body: reply.body, contentType: reply.contentType });
  return unavailable("unavailable", verdict.status === "ok" ? `reachable, but did not answer JSON-RPC (HTTP ${reply.code})` : verdict.note);
}

/**
 * Ask an HTTP server for its tools. Two round trips: `initialize` (which also
 * yields `serverInfo`) and `tools/list`, with the session id echoed when the
 * server issued one. The configured URL and headers are sent intact and
 * nothing from them reaches the note.
 */
export async function listToolsMcp(
  url: string,
  headers: Record<string, string> | undefined,
  options: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<ListOutcome> {
  const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PROBE_TIMEOUT_MS * 2);
  try {
    const outcome = await exchange(fetchImpl, url, headers, controller.signal);
    return { ...outcome, note: redactNote(outcome.note, url, headers) };
  } finally {
    clearTimeout(timer);
  }
}

async function exchange(fetchImpl: FetchLike, url: string, headers: Record<string, string> | undefined, signal: AbortSignal): Promise<ListOutcome> {
  const init = await post(fetchImpl, url, headers, null, INITIALIZE_REQUEST, signal);
  if (init.kind !== "rpc") return fromHttp(init);
  if (init.error !== undefined) return unavailable("unavailable", `initialize refused: ${rpcErrorText(init.error)}`);
  const serverInfo = shapeServerInfo(init.result);
  const protocolVersion = cleanText((init.result as { protocolVersion?: unknown } | null)?.protocolVersion, 20);
  const capabilities = (init.result as { capabilities?: { tools?: unknown } } | null)?.capabilities;
  if (capabilities && typeof capabilities === "object" && !("tools" in capabilities)) {
    return { kind: "listed", note: "server declares no tools", tools: [], serverInfo, protocolVersion };
  }
  const listed = await post(fetchImpl, url, headers, init.sessionId, TOOLS_LIST_REQUEST, signal);
  if (listed.kind !== "rpc") return { ...fromHttp(listed), serverInfo, protocolVersion };
  if (listed.error !== undefined) return { ...unavailable("unavailable", `tools/list refused: ${rpcErrorText(listed.error)}`), serverInfo, protocolVersion };
  const tools = shapeToolList(listed.result);
  return { kind: "listed", note: `${tools.length} tools`, tools, serverInfo, protocolVersion };
}

function rpcErrorText(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return cleanText(typeof message === "string" ? message : "JSON-RPC error", 80) || "JSON-RPC error";
}

/** The answer for a server this module will not ask: a command it would have to run. */
export function stdioOutcome(command: string | undefined): ListOutcome {
  return unavailable(
    "stdio",
    command
      ? `'${cleanText(command.split("/").pop(), 40)}' runs as a child process of the agent; its tools are only listed while it runs`
      : "command server; tools are only listed while it runs",
  );
}

// --------------------------------------------------------------- scheduling

/** Run `work` over `items`, at most `limit` at a time, keeping the order. */
export async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

// ------------------------------------------------------------------- totals

export type ToolsTotals = { servers: number; listed: number; tools: number; signIn: number; stdio: number; unavailable: number };

export function summarizeTools(servers: McpServerTools[]): ToolsTotals {
  const totals: ToolsTotals = { servers: servers.length, listed: 0, tools: 0, signIn: 0, stdio: 0, unavailable: 0 };
  for (const entry of servers) {
    if (entry.kind === "listed") {
      totals.listed += 1;
      totals.tools += entry.tools.length;
    } else if (entry.kind === "auth-required") totals.signIn += 1;
    else if (entry.kind === "stdio") totals.stdio += 1;
    else totals.unavailable += 1;
  }
  return totals;
}
