/**
 * A stand-in for Paseo's plugin process: loads index.server.ts with a fake
 * server context, answers RPCs sent by the harness over IPC, and counts every
 * child process the plugin starts. The harness (tests/perf/harness.ts) forks
 * this file with HOME pointed at a sandbox, so nothing here touches real config.
 *
 * Child processes are counted by wrapping node:child_process before the plugin
 * is imported; `syncBuiltinESMExports` makes the plugin's named ESM imports see
 * the wrappers.
 */
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";

type Counts = Record<string, number>;
const spawns: Counts = {};

function count(file: unknown, args: unknown): void {
  const name = basename(String(file));
  const first = Array.isArray(args) && typeof args[0] === "string" ? ` ${args[0]}` : "";
  const key = `${name}${name === "codex" || name === "claude" ? first : ""}`;
  spawns[key] = (spawns[key] ?? 0) + 1;
}

const mutable = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>;
for (const method of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
  const original = mutable[method]!;
  mutable[method] = (...args: unknown[]) => {
    count(args[0], method.startsWith("exec") && !method.startsWith("execFile") ? [] : args[1]);
    return original.apply(childProcess, args);
  };
}
syncBuiltinESMExports();

const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();

type Handler = (input: unknown, context: unknown) => unknown;
const handlers = new Map<string, { parse: (input: unknown) => unknown; handler: Handler }>();
const beforeHooks = new Map<string, (event: { request: unknown }) => unknown>();

const project = process.env.HARNESS_PROJECT ?? "";
// --daemon-delay: a busy daemon, slow to answer its project list and settings.
const daemonDelayMs = Number(process.env.HARNESS_DAEMON_DELAY_MS ?? 0);
const slow = <T>(value: T) => (daemonDelayMs > 0 ? new Promise<T>((done) => setTimeout(() => done(value), daemonDelayMs)) : Promise.resolve(value));
const paseo = {
  config: { get: () => slow({ config: { providers: {} } }) },
  workspaces: {
    list: async () => ({ entries: [{ id: "ws-1", name: "demo", workspaceDirectory: project, projectRootPath: project }] }),
  },
  projects: { list: () => slow({ entries: [{ name: "demo", path: project }] }) },
};

const server = {
  registerSettings() {},
  registerProvider() {},
  handle(contract: { name: string; input: { parse: (input: unknown) => unknown } }, handler: Handler) {
    handlers.set(contract.name, { parse: (input) => contract.input.parse(input), handler });
  },
  before(name: string, hook: (event: { request: unknown }) => unknown) {
    beforeHooks.set(name, hook);
    return () => beforeHooks.delete(name);
  },
  on() {
    return () => {};
  },
};

const started = performance.now();
const { default: contribute } = (await import("../../index.server")) as { default: (server: unknown) => () => void };
const cleanup = contribute(server);
const loadMs = performance.now() - started;

type Message =
  | { id: number; type: "rpc"; name: string; input: unknown }
  | { id: number; type: "hook"; name: string; request: unknown }
  | { id: number; type: "stats"; reset?: boolean }
  | { id: number; type: "stop" };

function reply(message: Record<string, unknown>): void {
  process.send?.(message);
}

process.on("message", async (raw: Message) => {
  const began = performance.now();
  if (raw.type === "rpc") {
    const entry = handlers.get(raw.name);
    if (!entry) return reply({ id: raw.id, ok: false, error: `no handler ${raw.name}`, ms: 0 });
    try {
      const output = await entry.handler(entry.parse(raw.input), { paseo });
      reply({ id: raw.id, ok: true, output, ms: performance.now() - began });
    } catch (error) {
      reply({ id: raw.id, ok: false, error: error instanceof Error ? error.message : String(error), ms: performance.now() - began });
    }
    return;
  }
  if (raw.type === "hook") {
    const hook = beforeHooks.get(raw.name);
    const output = hook ? await hook({ request: raw.request }) : raw.request;
    return reply({ id: raw.id, ok: true, output, ms: performance.now() - began });
  }
  if (raw.type === "stats") {
    const stats = {
      spawns: { ...spawns },
      eventLoopMaxMs: Math.round(delay.max / 1e6),
      eventLoopP99Ms: Math.round(delay.percentile(99) / 1e6),
      loadMs: Math.round(loadMs),
    };
    if (raw.reset) {
      for (const key of Object.keys(spawns)) delete spawns[key];
      delay.reset();
    }
    return reply({ id: raw.id, ok: true, output: stats, ms: 0 });
  }
  if (raw.type === "stop") {
    cleanup();
    reply({ id: raw.id, ok: true, output: null, ms: 0 });
    setTimeout(() => process.exit(0), 50);
  }
});

reply({ id: 0, ok: true, output: { ready: true, loadMs: Math.round(loadMs) }, ms: 0 });
