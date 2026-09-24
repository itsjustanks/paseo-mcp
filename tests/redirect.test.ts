import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { probeMcp } from "../shared/health";
import { listToolsMcp } from "../shared/tools";

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

async function serve(handler: Handler): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { server, port: (server.address() as AddressInfo).port };
}

function mcp(res: ServerResponse, body: string): void {
  const { id, method } = JSON.parse(body) as { id: number; method: string };
  const result = method === "initialize"
    ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }
    : { tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }] };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

test("a redirect to another host is not followed, so the server's headers never reach it", async () => {
  const seenByOther: Array<string | undefined> = [];
  const other = await serve((req, res, body) => {
    seenByOther.push(req.headers["x-api-key"] as string | undefined);
    mcp(res, body);
  });
  // 127.0.0.1 and localhost are different origins, as a different host would be.
  const first = await serve((_req, res) => {
    res.writeHead(307, { location: `http://localhost:${other.port}/mcp` });
    res.end();
  });
  try {
    const url = `http://127.0.0.1:${first.port}/mcp`;
    const headers = { "X-Api-Key": "SECRET2" };
    const listed = await listToolsMcp(url, headers);
    assert.equal(listed.kind, "unavailable");
    assert.match(listed.note, /redirects to another address \(HTTP 307\); not followed/);
    const health = await probeMcp(url, headers);
    assert.equal(health.status, "ok", "a redirect still means the server is reachable");
    assert.deepEqual(seenByOther, [], "the other host received nothing");
    assert.ok(!listed.note.includes("SECRET2") && !health.note.includes("SECRET2"));
  } finally {
    first.server.close();
    other.server.close();
  }
});

test("a redirect on the same server is followed, headers and all", async () => {
  const keys: Array<string | undefined> = [];
  const one = await serve((req, res, body) => {
    if (req.url === "/mcp") {
      res.writeHead(308, { location: "/mcp/" });
      res.end();
      return;
    }
    keys.push(req.headers["x-api-key"] as string | undefined);
    mcp(res, body);
  });
  try {
    const listed = await listToolsMcp(`http://127.0.0.1:${one.port}/mcp`, { "X-Api-Key": "k" });
    assert.equal(listed.kind, "listed");
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["ping"]);
    assert.deepEqual(keys, ["k", "k"], "initialize and tools/list both reached /mcp/ with the header");
  } finally {
    one.server.close();
  }
});
