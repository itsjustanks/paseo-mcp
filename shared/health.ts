/**
 * How a remote MCP server's health is judged. Pure so it can be unit-tested
 * with a stubbed fetch; the server supplies the real fetch and timeout, the
 * client only reads the verdict.
 *
 * Streamable-HTTP MCP servers speak JSON-RPC over POST. A bare GET is the wrong
 * protocol: a correctly working server answers it with 405 or 400, and an
 * OAuth-protected one answers anything unauthenticated with 401. Neither is a
 * fault, so the probe sends the same `initialize` request a real client would
 * and reads the answer the way a client would.
 */
import type { McpHealthStatus } from "./contracts";

export const PROBE_TIMEOUT_MS = 5000;

/** The request an MCP client opens a session with; the probe sends the same thing. */
export const INITIALIZE_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "paseo-mcp-health", version: "0.5.1" },
  },
} as const;

/** What happened when the endpoint was asked to initialize, with no URL or header values in it. */
export type ProbeOutcome =
  | { kind: "response"; code: number; body: string; contentType: string }
  | { kind: "timeout" }
  | { kind: "error"; code?: string; message: string };

export type ProbeVerdict = { status: McpHealthStatus; note: string };

/** Redirects are followed, so a 3xx only lands here when the fetch was told not to follow. */
function isRedirect(code: number): boolean {
  return code >= 300 && code < 400;
}

/** True when the body is a JSON-RPC envelope; `result` means the server completed `initialize`. */
function readJsonRpc(body: string): "result" | "error" | null {
  const text = body.trim();
  // Streamable HTTP may answer as an SSE stream; the envelope sits on a data: line.
  const payload = text.startsWith("event:") || text.startsWith("data:")
    ? text.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim() ?? ""
    : text;
  if (!payload.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(payload) as { jsonrpc?: unknown; result?: unknown; error?: unknown };
    if (parsed.jsonrpc !== "2.0") return null;
    if (parsed.result !== undefined) return "result";
    if (parsed.error !== undefined) return "error";
  } catch {
    // not JSON
  }
  return null;
}

/**
 * The verdict for one probe outcome. `ok` is "alive and speaking MCP", which
 * includes rejecting an unauthenticated or malformed request the way the
 * protocol says to. `auth-required` is a resting state, not a problem: every
 * OAuth server answers an anonymous probe with 401, and the editor holds the
 * grant. Only failures to reach or run the server are problems.
 */
export function classifyProbe(outcome: ProbeOutcome): ProbeVerdict {
  if (outcome.kind === "timeout") return { status: "down", note: `timeout after ${PROBE_TIMEOUT_MS / 1000}s` };
  if (outcome.kind === "error") return { status: "down", note: describeError(outcome.code, outcome.message) };
  const { code } = outcome;
  if (code === 401 || code === 403) return { status: "auth-required", note: `HTTP ${code} — OAuth server; sign in through your editor` };
  if (code >= 200 && code < 300) {
    const rpc = readJsonRpc(outcome.body);
    if (rpc === "result") return { status: "ok", note: "MCP initialize answered" };
    if (rpc === "error") return { status: "ok", note: "MCP endpoint answered (JSON-RPC error)" };
    if (outcome.contentType.includes("text/event-stream")) return { status: "ok", note: "MCP endpoint streaming" };
    return { status: "ok", note: `HTTP ${code}` };
  }
  if (isRedirect(code)) return { status: "ok", note: `reachable (HTTP ${code} redirect)` };
  if (code === 404) return { status: "warn", note: "HTTP 404 — endpoint not found; check the URL path" };
  if (code >= 400 && code < 500) return { status: "ok", note: `reachable (HTTP ${code})` };
  if (code >= 500) return { status: "warn", note: `HTTP ${code} — server error` };
  return { status: "warn", note: `HTTP ${code}` };
}

/** A short, URL-free reading of a network error. */
export function describeError(code: string | undefined, message: string): string {
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "DNS lookup failed";
    case "ECONNREFUSED":
      return "connection refused";
    case "ECONNRESET":
      return "connection reset";
    case "ETIMEDOUT":
      return "connection timed out";
    case "CERT_HAS_EXPIRED":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
      return "TLS certificate rejected";
    default:
      return message.replace(/\s+/g, " ").trim().slice(0, 80) || "request failed";
  }
}

// --------------------------------------------------------------- redaction

/**
 * Strip anything from a note that could identify the server or its secret:
 * the URL, its query string, every query value, every header value, and any
 * bare token-looking run. Notes are rendered in the UI and written to the
 * daemon log, and several definitions carry a JWT or API token in the URL.
 */
export function redactNote(note: string, url: string, headers: Record<string, string> | undefined): string {
  let out = note;
  const secrets = new Set<string>();
  secrets.add(url);
  try {
    const parsed = new URL(url);
    if (parsed.search) secrets.add(parsed.search);
    for (const value of parsed.searchParams.values()) if (value.length >= 4) secrets.add(value);
    secrets.add(`${parsed.host}${parsed.pathname}`);
    secrets.add(parsed.host);
  } catch {
    // not a URL; the raw string is still redacted below
  }
  for (const value of Object.values(headers ?? {})) {
    if (value.length >= 4) secrets.add(value);
    const bearer = value.match(/^\s*Bearer\s+(\S+)/i);
    if (bearer) secrets.add(bearer[1]);
  }
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  // Belt and braces: query fragments and long opaque tokens that slipped through.
  out = out.replace(/[?&][A-Za-z0-9_-]+=[^\s&]+/g, "[redacted]");
  out = out.replace(/\b(eyJ[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{32,})\b/g, "[redacted]");
  return out;
}

// ------------------------------------------------------------------- probe

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Ask the endpoint to initialize and classify the answer. The configured URL is
 * sent intact — a token in the query string is part of how the server
 * authenticates, so without it the verdict is not real — but nothing from the
 * URL or headers reaches the note. `fetchImpl` is injectable for tests; the
 * server passes the runtime fetch.
 */
export async function probeMcp(
  url: string,
  headers: Record<string, string> | undefined,
  options: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<ProbeVerdict> {
  const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike);
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let outcome: ProbeOutcome;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(INITIALIZE_REQUEST),
      signal: controller.signal,
      redirect: "follow",
    });
    outcome = {
      kind: "response",
      code: response.status,
      body: await readBodyHead(response),
      contentType: response.headers.get("content-type") ?? "",
    };
  } catch (error) {
    const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
    const message = error instanceof Error ? error.message : String(error);
    outcome = controller.signal.aborted
      ? { kind: "timeout" }
      : {
          kind: "error",
          code: typeof cause?.code === "string" ? cause.code : undefined,
          message: typeof cause?.message === "string" ? cause.message : message,
        };
  } finally {
    clearTimeout(timer);
  }
  const verdict = classifyProbe(outcome);
  return { ...verdict, note: redactNote(verdict.note, url, headers) };
}

/** The first few KB of the body; an SSE stream never ends, so the reader is cancelled after one chunk. */
async function readBodyHead(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  try {
    const { value } = await reader.read();
    return value ? new TextDecoder().decode(value).slice(0, 4096) : "";
  } catch {
    return "";
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}
