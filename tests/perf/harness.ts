/**
 * Load harness: how many processes the plugin starts, how long its RPCs take,
 * and how long its event loop stalls, with the panel closed and with it open.
 *
 *   npm run bench                  # full run, ~3-8 minutes
 *   npm run bench -- --quick       # 20 s windows, 1 s fake Codex
 *
 * Everything runs against a throwaway HOME: a sandbox with a Claude config, a
 * Codex config and auth file, two AgentLink Codex slots and one Claude slot,
 * a registered project with a `.mcp.json`, and a local HTTP server standing in
 * for remote MCP servers (some answer, some want OAuth, one never answers).
 *
 * `codex` on the sandbox PATH is a fake: it logs each run, prints the same
 * "stale arg0 temp dirs" warning the real CLI prints on the daemon, and then
 * waits `--codex-delay` seconds (default 5: Codex's own OAuth discovery
 * timeout, which is what a real `codex mcp list` spends per unreachable server)
 * before printing a server list.
 *
 * The plugin runs in its own process (tests/perf/plugin-host.ts), like it does
 * under Paseo, so this process can play daemon and app: it enforces the
 * daemon's 30 s RPC timeout, retries the way TanStack Query does, and keeps a
 * cheap RPC ticking every 2 s to see whether the plugin can still answer.
 */
import { fork } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const quick = args.includes("--quick");
const flag = (name: string, fallback: number) => {
  const index = args.indexOf(name);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};
const WINDOW_MS = flag("--window", quick ? 20 : 60) * 1000;
const CODEX_DELAY_S = flag("--codex-delay", quick ? 1 : 5);
const DAEMON_TIMEOUT_MS = 30_000;
const label = args.find((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--")) ?? "run";

// ------------------------------------------------------------------ sandbox

function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(payload)}.sig`;
}

function codexToml(servers: Record<string, { url?: string; command?: string }>): string {
  return Object.entries(servers)
    .map(([name, def]) => (def.url ? `[mcp_servers.${name}]\nurl = "${def.url}"\n` : `[mcp_servers.${name}]\ncommand = "${def.command}"\nargs = []\n`))
    .join("\n");
}

function buildSandbox(port: number) {
  const home = mkdtempSync(join(tmpdir(), "paseo-mcp-bench-"));
  const project = join(home, "code", "demo");
  const bin = join(home, ".local", "bin");
  const codexLog = join(home, "codex-runs.log");
  for (const dir of [project, bin, join(home, ".codex"), join(home, ".paseo", "plugin-settings", "paseo-mcp")]) {
    mkdirSync(dir, { recursive: true });
  }
  const base = `http://localhost:${port}`;
  type Def = { url?: string; command?: string };
  const http: Record<string, Def> = {
    "docs-ok": { url: `${base}/ok/docs` },
    "search-ok": { url: `${base}/ok/search` },
    "linear-oauth": { url: `${base}/oauth/linear` },
    "notion-oauth": { url: `${base}/oauth/notion` },
    "attio-oauth": { url: `${base}/oauth/attio` },
    "stuck-remote": { url: `${base}/hang` },
  };
  const stdio: Record<string, Def> = {
    "fs-local": { command: "node" },
    "git-local": { command: "sh" },
    "gone-binary": { command: "definitely-not-installed" },
  };
  const claudeServers = Object.fromEntries(
    Object.entries({ ...http, ...stdio }).map(([name, def]) => [name, def.url ? { type: "http", url: def.url } : { type: "stdio", command: def.command, args: [] }]),
  );
  // A real ~/.claude.json carries a long `projects` history; pad to ~250 KB.
  const projects: Record<string, unknown> = {
    [project]: { hasTrustDialogAccepted: true, mcpServers: { "local-only": { type: "stdio", command: "node", args: [] } }, disabledMcpServers: [] },
  };
  for (let index = 0; index < 900; index += 1) {
    projects[`/home/someone/code/project-${index}`] = { allowedTools: [], history: [{ display: "x".repeat(160) }], hasTrustDialogAccepted: index % 2 === 0 };
  }
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "primary@example.com" }, mcpServers: claudeServers, projects }, null, 2));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "mcp-needs-auth-cache.json"), JSON.stringify({ "linear-oauth": {} }));

  writeFileSync(join(home, ".codex", "config.toml"), codexToml({ ...http, ...stdio }));
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { id_token: jwt({ email: "primary@example.com" }) } }));
  for (const email of ["alpha@example.com", "beta@example.com"]) {
    const dir = join(home, ".agent-link", "accounts", "codex", email);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.toml"), codexToml(http));
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { id_token: jwt({ email }) } }));
  }
  const claudeSlot = join(home, ".agent-link", "accounts", "claude", "gamma@example.com");
  mkdirSync(claudeSlot, { recursive: true });
  writeFileSync(join(claudeSlot, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "gamma@example.com" }, mcpServers: claudeServers }));

  writeFileSync(
    join(project, ".mcp.json"),
    JSON.stringify({ mcpServers: { "project-docs": { type: "http", url: `${base}/ok/project` }, "project-tool": { command: "node", args: ["tool.js"] } } }, null, 2),
  );
  // Injection on for Codex so the agent.create hook does its real work.
  writeFileSync(
    join(home, ".paseo", "plugin-settings", "paseo-mcp", "injection.json"),
    JSON.stringify({ version: 1, values: { injectWorkspaceServers: true, providers: ["codex"], skipInlineCredentialServers: true } }),
  );

  const fake = `#!/bin/sh
echo "$$ \${CODEX_HOME:-default} $*" >> "${codexLog}"
echo "WARNING: failed to clean up stale arg0 temp dirs: Permission denied (os error 13)" >&2
sleep ${CODEX_DELAY_S}
echo '[{"name":"linear-oauth","auth_status":"o_auth"},{"name":"notion-oauth","auth_status":"not_logged_in"},{"name":"docs-ok","auth_status":"unsupported"}]'
`;
  writeFileSync(join(bin, "codex"), fake);
  chmodSync(join(bin, "codex"), 0o755);
  return { home, project, codexLog };
}

// ---------------------------------------------------------- stand-in servers

function startMcpStandIn(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const url = request.url ?? "";
      if (url.startsWith("/hang")) return; // never answers
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
          ? { tools: [{ name: "search", description: "Search", inputSchema: { type: "object", properties: { q: {} }, required: ["q"] } }, { name: "fetch", inputSchema: {} }] }
          : { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stand-in", version: "1.0.0" } };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  return new Promise((done) => server.listen(0, "localhost", () => done({ server, port: (server.address() as { port: number }).port })));
}

// ------------------------------------------------------------------ plugin

type Reply = { id: number; ok: boolean; output?: unknown; error?: string; ms: number };

class PluginProcess {
  child: ChildProcess;
  next = 1;
  waiting = new Map<number, (reply: Reply) => void>();
  ready: Promise<Reply>;
  constructor(env: NodeJS.ProcessEnv) {
    this.child = fork(join(here, "plugin-host.ts"), [], { execArgv: ["--import", "tsx"], env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    this.child.stdout?.on("data", (chunk) => (this.log += chunk.toString()));
    this.child.stderr?.on("data", (chunk) => (this.log += chunk.toString()));
    this.ready = new Promise((done) => this.waiting.set(0, done));
    this.child.on("message", (reply: Reply) => {
      const resolve = this.waiting.get(reply.id);
      this.waiting.delete(reply.id);
      resolve?.(reply);
    });
  }
  log = "";
  send(message: Record<string, unknown>): Promise<Reply> {
    const id = this.next++;
    return new Promise((done) => {
      this.waiting.set(id, done);
      this.child.send({ ...message, id });
    });
  }
  rpc(name: string, input: unknown = {}) {
    return this.send({ type: "rpc", name, input });
  }
  stats(reset = false) {
    return this.send({ type: "stats", reset }).then((reply) => reply.output as { spawns: Record<string, number>; eventLoopMaxMs: number; eventLoopP99Ms: number; loadMs: number });
  }
}

// ------------------------------------------------------- daemon + app model

type Outcome = { name: string; ms: number; timedOut: boolean; attempt: number };

/** One RPC as the daemon relays it: the app gives up at 30 s, the plugin keeps working. */
async function daemonCall(plugin: PluginProcess, name: string, input: unknown, attempt: number, log: Outcome[]): Promise<boolean> {
  const began = Date.now();
  const reply = plugin.rpc(name, input).then((result) => ({ result, timedOut: false }));
  const timeout = new Promise<{ result: null; timedOut: true }>((done) => setTimeout(() => done({ result: null, timedOut: true }), DAEMON_TIMEOUT_MS));
  const settled = await Promise.race([reply, timeout]);
  const ms = Date.now() - began;
  log.push({ name, ms, timedOut: settled.timedOut, attempt });
  return !settled.timedOut && Boolean(settled.result?.ok);
}

/** A query the way TanStack Query runs it: `retry` extra attempts, 1 s, 2 s, 4 s apart. */
async function query(plugin: PluginProcess, name: string, input: unknown, retry: number, log: Outcome[]): Promise<void> {
  for (let attempt = 0; attempt <= retry; attempt += 1) {
    if (await daemonCall(plugin, name, input, attempt, log)) return;
    if (attempt < retry) await sleep(Math.min(1000 * 2 ** attempt, 30_000));
  }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A cheap RPC every 2 s: how long does the plugin take to answer anything at all? */
function heartbeat(plugin: PluginProcess, stopAt: number): Promise<number[]> {
  const samples: number[] = [];
  const pending: Promise<void>[] = [];
  return new Promise((done) => {
    const tick = () => {
      if (Date.now() >= stopAt) {
        void Promise.all(pending).then(() => done(samples));
        return;
      }
      const began = Date.now();
      pending.push(plugin.rpc("paseo-mcp.health-cached").then(() => void samples.push(Date.now() - began)));
      setTimeout(tick, 2000);
    };
    tick();
  });
}

function summarize(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0);
  return { p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0 };
}

function codexRuns(path: string): number {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).length : 0;
}

async function hookCall(plugin: PluginProcess, project: string): Promise<number> {
  const began = Date.now();
  await plugin.send({ type: "hook", name: "agent.create", request: { config: { provider: "codex", cwd: project, mcpServers: {} } } });
  return Date.now() - began;
}

// -------------------------------------------------------------------- run

const { server: standIn, port } = await startMcpStandIn();
const sandbox = buildSandbox(port);
const env: NodeJS.ProcessEnv = {
  HOME: sandbox.home,
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  SHELL: "/bin/sh",
  PASEO_HOME: join(sandbox.home, ".paseo"),
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  HARNESS_PROJECT: sandbox.project,
};
// Stand-in agents: children of the "daemon" (this process) working in the
// project, so the running-process scan has something real to look at.
const agents = [0, 1, 2].map(() => spawn("sleep", ["900"], { cwd: sandbox.project, stdio: "ignore" }));

const plugin = new PluginProcess(env);
const readyReply = await plugin.ready;
console.error(`[bench] ${label}: plugin loaded in ${(readyReply.output as { loadMs: number }).loadMs} ms; windows ${WINDOW_MS / 1000}s, fake codex ${CODEX_DELAY_S}s`);
await plugin.stats(true);

// ---- window 1: panel closed. The app is open (chip settings poll + one chip's reads).
let codexBefore = codexRuns(sandbox.codexLog);
let log: Outcome[] = [];
let closed: Record<string, unknown> = {};
let opened: Record<string, unknown> = {};
let drainCodexRuns = 0;
{
  const stopAt = Date.now() + WINDOW_MS;
  const beats = heartbeat(plugin, stopAt);
  const atStop = sleep(WINDOW_MS).then(() => codexRuns(sandbox.codexLog) - codexBefore);
  const chip = (async () => {
    while (Date.now() < stopAt) {
      await query(plugin, "paseo-mcp.health-cached", {}, 0, log);
      await sleep(Math.min(60_000, Math.max(0, stopAt - Date.now())));
    }
  })();
  const tools = query(plugin, "paseo-mcp.tools-cached", {}, 0, log);
  const hookIdle = await hookCall(plugin, sandbox.project);
  const [samples] = await Promise.all([beats, chip, tools]);
  const stats = await plugin.stats(true);
  closed = {
    windowS: WINDOW_MS / 1000,
    codexRunsPerMin: Math.round(((await atStop) * 60_000) / WINDOW_MS),
    codexRuns: codexRuns(sandbox.codexLog) - codexBefore,
    spawns: stats.spawns,
    eventLoopMaxMs: stats.eventLoopMaxMs,
    cheapRpcMs: summarize(samples),
    agentCreateHookMs: hookIdle,
  };
}

// ---- window 2: panel open. MCP surface + workspace panel + a Codex agent's panel.
codexBefore = codexRuns(sandbox.codexLog);
log = [];
{
  const stopAt = Date.now() + WINDOW_MS;
  const beats = heartbeat(plugin, stopAt);
  const atStop = sleep(WINDOW_MS).then(() => codexRuns(sandbox.codexLog) - codexBefore);
  const open = () => [
    query(plugin, "paseo-mcp.matrix", {}, 1, log),
    query(plugin, "paseo-mcp.auth", {}, 1, log),
    query(plugin, "paseo-mcp.health-cached", {}, 0, log),
    query(plugin, "paseo-mcp.tools-cached", {}, 0, log),
    query(plugin, "paseo-mcp.login-status", {}, 3, log),
    query(plugin, "paseo-mcp.workspace", { workspaceId: "ws-1" }, 3, log),
    query(plugin, "paseo-mcp.agent-servers", { workspaceId: "ws-1", providerId: "claude" }, 3, log),
    query(plugin, "paseo-mcp.agent-servers", { workspaceId: "ws-1", providerId: "codex" }, 3, log),
  ];
  const work: Promise<unknown>[] = open();
  // A new agent is created a few seconds after the panel opens.
  const hook = sleep(5000).then(() => hookCall(plugin, sandbox.project));
  // The user presses Refresh on the workspace panel halfway through.
  work.push(
    sleep(WINDOW_MS / 2).then(() =>
      Promise.all([
        query(plugin, "paseo-mcp.workspace", { workspaceId: "ws-1" }, 3, log),
        query(plugin, "paseo-mcp.agent-servers", { workspaceId: "ws-1", providerId: "codex" }, 3, log),
        query(plugin, "paseo-mcp.login-status", {}, 3, log),
      ]),
    ),
  );
  const samples = await beats;
  const answeredAfterS = Math.round((Date.now() - stopAt + WINDOW_MS) / 1000);
  const stats = await plugin.stats(true);
  const hookOpen = await hook;
  opened = {
    windowS: WINDOW_MS / 1000,
    codexRunsPerMin: Math.round(((await atStop) * 60_000) / WINDOW_MS),
    // The window closes when the last heartbeat is answered; a blocked plugin answers late.
    windowActuallyEndedAtS: answeredAfterS,
    codexRuns: codexRuns(sandbox.codexLog) - codexBefore,
    spawns: stats.spawns,
    eventLoopMaxMs: stats.eventLoopMaxMs,
    cheapRpcMs: summarize(samples),
    agentCreateHookMs: hookOpen,
    daemonTimeouts: log.filter((entry) => entry.timedOut).length,
    retries: log.filter((entry) => entry.attempt > 0).length,
  };
  // Let queued work drain before timing handlers one by one.
  const drainUntil = Date.now() + 180_000;
  await Promise.race([Promise.all(work), sleep(Math.max(0, drainUntil - Date.now()))]);
  drainCodexRuns = codexRuns(sandbox.codexLog) - codexBefore;
}

// ---- handler timings, one at a time, on a quiet plugin.
await plugin.stats(true);
const timings: Record<string, { first: number; median: number; codexRuns: number }> = {};
const handlerCalls: Array<[string, Record<string, string>]> = [
  ["paseo-mcp.health-cached", {}],
  ["paseo-mcp.tools-cached", {}],
  ["paseo-mcp.matrix", {}],
  ["paseo-mcp.auth", {}],
  ["paseo-mcp.workspace", { workspaceId: "ws-1" }],
  ["paseo-mcp.agent-servers", { workspaceId: "ws-1", providerId: "claude" }],
  ["paseo-mcp.agent-servers", { workspaceId: "ws-1", providerId: "codex" }],
];
for (const [name, input] of handlerCalls) {
  const runs: number[] = [];
  const before = codexRuns(sandbox.codexLog);
  for (let index = 0; index < 3; index += 1) runs.push((await plugin.rpc(name, input)).ms);
  const key = input.providerId ? `${name} (${input.providerId})` : name;
  timings[key] = { first: Math.round(runs[0]!), median: Math.round([...runs].sort((a, b) => a - b)[1]!), codexRuns: codexRuns(sandbox.codexLog) - before };
}
const quiet = await plugin.stats(true);

await plugin.send({ type: "stop" });
for (const agent of agents) agent.kill();
standIn.close();

const warnings = (plugin.log.match(/stale arg0 temp dirs/g) ?? []).length;
const explained = (plugin.log.match(/Codex could not tidy/g) ?? []).length;
const result = {
  label,
  codexDelayS: CODEX_DELAY_S,
  closed,
  open: { ...opened, codexRunsIncludingDrain: drainCodexRuns },
  handlers: timings,
  handlerPhase: { eventLoopMaxMs: quiet.eventLoopMaxMs, spawns: quiet.spawns },
  arg0WarningsInPluginLog: warnings,
  arg0ExplanationsInPluginLog: explained,
};
console.log(JSON.stringify(result, null, 2));
const out = join(here, "results");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `${label}.json`), `${JSON.stringify(result, null, 2)}\n`);
if (!args.includes("--keep")) rmSync(sandbox.home, { recursive: true, force: true });
process.exit(0);
