/**
 * Cold-start bench: how long the first MCP panel open waits right after the
 * plugin starts, and again right after a reload.
 *
 *   npm run bench:cold
 *
 * A throwaway HOME defines 36 servers in ~/.claude.json, the size of a real
 * daemon's list: 26 HTTP servers that answer after 400 ms (a remote round
 * trip), 4 that want OAuth, one slow server that answers after 4.5 s, one that
 * never answers, and 4 stdio servers.
 *
 * The app side is modelled on client/health.tsx and client/tools.tsx: read the
 * cached report; with none, an older client asks for a fresh probe and waits
 * for it, a newer one (the host says `checking`) shows "checking" and reads the
 * cache again every 3 s. "Panel answered" is when the panel has something to
 * render; "verdict" is when it has a real report.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginProcess } from "./plugin-process";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const label = args.find((arg) => !arg.startsWith("--")) ?? "cold";
const POLL_MS = 3000;
const OK_DELAY_MS = 400;
const SLOW_DELAY_MS = 4500;

// ---------------------------------------------------------- stand-in servers

function startStandIn(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const url = request.url ?? "";
      if (url.startsWith("/hang")) return;
      if (url.startsWith("/oauth")) {
        response.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="x"' }).end();
        return;
      }
      let id: unknown = 1;
      let method = "";
      try {
        const parsed = JSON.parse(body) as { id?: unknown; method?: string };
        id = parsed.id;
        method = parsed.method ?? "";
      } catch {
        // fall through
      }
      const result =
        method === "tools/list"
          ? { tools: [{ name: "search", description: "Search", inputSchema: { type: "object", properties: { q: {} }, required: ["q"] } }] }
          : { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stand-in", version: "1.0.0" } };
      const send = () => {
        if (response.destroyed) return;
        if (id === undefined) return void response.writeHead(202).end();
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      };
      setTimeout(send, url.startsWith("/slow") ? SLOW_DELAY_MS : OK_DELAY_MS);
    });
  });
  return new Promise((done) => server.listen(0, "localhost", () => done({ server, port: (server.address() as { port: number }).port })));
}

function buildSandbox(port: number) {
  const home = mkdtempSync(join(tmpdir(), "paseo-mcp-cold-"));
  const project = join(home, "code", "demo");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(home, ".paseo"), { recursive: true });
  const base = `http://localhost:${port}`;
  const servers: Record<string, unknown> = {};
  for (let index = 0; index < 26; index += 1) servers[`remote-${index}`] = { type: "http", url: `${base}/ok/${index}?token=secret-${index}` };
  for (let index = 0; index < 4; index += 1) servers[`oauth-${index}`] = { type: "http", url: `${base}/oauth/${index}` };
  servers["slow-remote"] = { type: "http", url: `${base}/slow/one` };
  servers["stuck-remote"] = { type: "http", url: `${base}/hang/one` };
  for (const command of ["node", "sh", "npx", "definitely-not-installed"]) servers[`local-${command}`] = { type: "stdio", command, args: [] };
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@example.com" }, mcpServers: servers, projects: {} }));
  return { home, project, count: Object.keys(servers).length };
}

// ------------------------------------------------------------------ app side

type Cached = { report: unknown | null; checking?: boolean; inFlight?: boolean };
type FirstRead = { panelAnsweredMs: number; verdictMs: number; waitedOnProbe: boolean; restored: boolean };

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function firstRead(plugin: PluginProcess, kind: "health" | "tools"): Promise<FirstRead> {
  const began = Date.now();
  const read = async () => (await plugin.rpc(`paseo-mcp.${kind}-cached`)).output as Cached;
  const cached = await read();
  const restored = (report: unknown) => Boolean((report as { stale?: unknown } | null)?.stale);
  if (cached.report) {
    const ms = Date.now() - began;
    return { panelAnsweredMs: ms, verdictMs: ms, waitedOnProbe: false, restored: restored(cached.report) };
  }
  if (cached.checking === undefined) {
    // 0.11.2 and earlier: the panel asks for a fresh pass and waits for it.
    await plugin.rpc(`paseo-mcp.${kind}`);
    const ms = Date.now() - began;
    return { panelAnsweredMs: ms, verdictMs: ms, waitedOnProbe: true, restored: false };
  }
  const panelAnsweredMs = Date.now() - began;
  for (;;) {
    await sleep(POLL_MS);
    const next = await read();
    if (next.report) return { panelAnsweredMs, verdictMs: Date.now() - began, waitedOnProbe: false, restored: restored(next.report) };
  }
}

async function openPanel(plugin: PluginProcess) {
  const [health, tools] = await Promise.all([firstRead(plugin, "health"), firstRead(plugin, "tools")]);
  return { health, tools };
}

// -------------------------------------------------------------------- run

const { server: standIn, port } = await startStandIn();
const sandbox = buildSandbox(port);
const env: NodeJS.ProcessEnv = {
  HOME: sandbox.home,
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  SHELL: "/bin/sh",
  PASEO_HOME: join(sandbox.home, ".paseo"),
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  HARNESS_PROJECT: sandbox.project,
};
const cacheFile = join(sandbox.home, ".paseo", "plugin-data", "paseo-mcp", "cache.json");

// 1. A fresh host: nothing on disk, nothing in memory. The panel opens as soon as the plugin is up.
let plugin = new PluginProcess(env);
await plugin.ready;
const cold = await openPanel(plugin);
// Let any pass the reads started finish, so the reload below has something to keep.
await Promise.all([plugin.rpc("paseo-mcp.health"), plugin.rpc("paseo-mcp.tools")]);
const persisted = existsSync(cacheFile);
await plugin.stop();

// 2. A reload: a new plugin process on the same host, panel opened straight away.
plugin = new PluginProcess(env);
await plugin.ready;
const reload = await openPanel(plugin);
await plugin.stop();
standIn.close();

const result = { label, servers: sandbox.count, okDelayMs: OK_DELAY_MS, slowDelayMs: SLOW_DELAY_MS, cold, reload, cacheFileWritten: persisted };
console.log(JSON.stringify(result, null, 2));
const out = join(here, "results");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `${label}.json`), `${JSON.stringify(result, null, 2)}\n`);
if (!args.includes("--keep")) rmSync(sandbox.home, { recursive: true, force: true });
process.exit(0);
