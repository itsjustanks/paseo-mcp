/**
 * The plugin in its own process (tests/perf/plugin-host.ts), the way Paseo runs
 * it, driven over IPC by a bench script playing daemon and app.
 */
import { fork, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export type Reply = { id: number; ok: boolean; output?: unknown; error?: string; ms: number };

export class PluginProcess {
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
  /** Shut the plugin down and wait for the process to exit, like a reload does. */
  async stop(): Promise<void> {
    const exited = new Promise((done) => this.child.once("exit", done));
    await this.send({ type: "stop" });
    await exited;
  }
}
