import assert from "node:assert/strict";
import test from "node:test";
import { healthIsSignIn, healthNeedsAttention } from "../shared/contracts";
import { INITIALIZE_REQUEST, classifyProbe, probeMcp, redactNote } from "../shared/health";

// A definition with a token in the query string and a bearer header, like the
// n8n / Attio / HeroUI entries in a real config. Nothing from it may reach a note.
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.sig-abcdefghijklmnop";
const URL_WITH_TOKEN = `https://mcp.example.test/mcp?attio_token=${TOKEN}&x=1`;
const HEADERS = { Authorization: "Bearer hdr-secret-value-9876543210" };

function response(code: number, body = "", contentType = "application/json"): Response {
  return new Response(body, { status: code, headers: { "content-type": contentType } });
}

const fetchReturning = (code: number, body = "", contentType?: string) => async () => response(code, body, contentType);

test("a JSON-RPC initialize result is healthy", () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {} } });
  const verdict = classifyProbe({ kind: "response", code: 200, body, contentType: "application/json" });
  assert.equal(verdict.status, "ok");
  assert.match(verdict.note, /initialize/);
});

test("an SSE-framed initialize result is healthy", () => {
  const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n\n`;
  assert.equal(classifyProbe({ kind: "response", code: 200, body, contentType: "text/event-stream" }).status, "ok");
});

test("401 and 403 are sign-in, not a problem", () => {
  for (const code of [401, 403]) {
    const verdict = classifyProbe({ kind: "response", code, body: "", contentType: "" });
    assert.equal(verdict.status, "auth-required");
    assert.equal(healthNeedsAttention(verdict.status), false);
    assert.equal(healthIsSignIn(verdict.status), true);
  }
});

test("405 and 400 mean the endpoint is alive and rejecting the wrong request", () => {
  for (const code of [405, 400, 406]) {
    const verdict = classifyProbe({ kind: "response", code, body: "", contentType: "" });
    assert.equal(verdict.status, "ok", `HTTP ${code}`);
    assert.match(verdict.note, /reachable/);
  }
});

test("redirects read as reachable when they are not followed", () => {
  for (const code of [301, 307]) {
    assert.equal(classifyProbe({ kind: "response", code, body: "", contentType: "" }).status, "ok");
  }
});

test("404 and 5xx are real warnings", () => {
  assert.equal(classifyProbe({ kind: "response", code: 404, body: "", contentType: "" }).status, "warn");
  const server = classifyProbe({ kind: "response", code: 500, body: "", contentType: "" });
  assert.equal(server.status, "warn");
  assert.match(server.note, /500/);
  assert.equal(classifyProbe({ kind: "response", code: 503, body: "", contentType: "" }).status, "warn");
});

test("timeouts and DNS failures are down", () => {
  const timeout = classifyProbe({ kind: "timeout" });
  assert.equal(timeout.status, "down");
  assert.match(timeout.note, /timeout after 5s/);
  const dns = classifyProbe({ kind: "error", code: "ENOTFOUND", message: `getaddrinfo ENOTFOUND ${URL_WITH_TOKEN}` });
  assert.equal(dns.status, "down");
  assert.equal(dns.note, "DNS lookup failed");
  assert.equal(classifyProbe({ kind: "error", code: "ECONNREFUSED", message: "x" }).note, "connection refused");
});

test("only down, binary-missing and warn need attention", () => {
  assert.equal(healthNeedsAttention("down"), true);
  assert.equal(healthNeedsAttention("binary-missing"), true);
  assert.equal(healthNeedsAttention("warn"), true);
  assert.equal(healthNeedsAttention("ok"), false);
  assert.equal(healthNeedsAttention("unknown"), false);
  assert.equal(healthNeedsAttention("auth-required"), false);
});

test("probe sends a JSON-RPC initialize POST with the configured URL and headers intact", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  await probeMcp(URL_WITH_TOKEN, HEADERS, {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
    },
  });
  assert.equal(calls.length, 1);
  const [seen] = calls;
  assert.equal(seen.url, URL_WITH_TOKEN);
  assert.equal(seen.init.method, "POST");
  const headers = seen.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, HEADERS.Authorization);
  assert.equal(headers["content-type"], "application/json");
  assert.match(headers.accept, /text\/event-stream/);
  assert.deepEqual(JSON.parse(seen.init.body as string).method, INITIALIZE_REQUEST.method);
  assert.equal(seen.init.redirect, "follow");
});

test("probe verdicts for each stubbed status", async () => {
  const cases: Array<[number, string, string]> = [
    [200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), "ok"],
    [401, "", "auth-required"],
    [403, "", "auth-required"],
    [405, "", "ok"],
    [400, "", "ok"],
    [307, "", "ok"],
    [500, "", "warn"],
  ];
  for (const [code, body, expected] of cases) {
    const verdict = await probeMcp(URL_WITH_TOKEN, HEADERS, { fetch: fetchReturning(code, body) });
    assert.equal(verdict.status, expected, `HTTP ${code}`);
  }
});

test("probe reports a timeout as down", async () => {
  const verdict = await probeMcp(URL_WITH_TOKEN, undefined, {
    timeoutMs: 10,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  });
  assert.equal(verdict.status, "down");
  assert.match(verdict.note, /timeout/);
});

test("probe reports a DNS failure as down without the host or token", async () => {
  const verdict = await probeMcp(URL_WITH_TOKEN, HEADERS, {
    fetch: async () => {
      throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND", message: `getaddrinfo ENOTFOUND ${URL_WITH_TOKEN}` } });
    },
  });
  assert.equal(verdict.status, "down");
  assert.equal(verdict.note, "DNS lookup failed");
});

test("a note never contains the URL, its query, the token or a header value", async () => {
  const leaky = async () => {
    // An error whose message echoes the whole request, the worst case for a note.
    throw new Error(`request to ${URL_WITH_TOKEN} failed with ${HEADERS.Authorization}`);
  };
  const verdict = await probeMcp(URL_WITH_TOKEN, HEADERS, { fetch: leaky });
  assert.equal(verdict.status, "down");
  for (const fragment of [URL_WITH_TOKEN, TOKEN, "attio_token", "mcp.example.test", "hdr-secret-value-9876543210", "Bearer hdr"]) {
    assert.equal(verdict.note.includes(fragment), false, `note leaked ${fragment.slice(0, 12)}`);
  }
  // Redaction also works on any free text, query fragments included.
  const redacted = redactNote(`HTTP 404 at ${URL_WITH_TOKEN}; token ${TOKEN}; ?jwt=${TOKEN}`, URL_WITH_TOKEN, HEADERS);
  assert.equal(redacted.includes(TOKEN), false);
  assert.equal(redacted.includes("mcp.example.test"), false);
  assert.match(redacted, /^HTTP 404 at \[redacted\]/);
});
