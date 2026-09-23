import { readlinkSync } from "node:fs";
import { basename } from "node:path";
import type { ObservedWorkspace, ProcessTree } from "../shared/processes";
import { buildProcessTree, observeWorkspace, parseProcessTable } from "../shared/processes";
import type { McpDef } from "./handlers";
import { runFile } from "./run";

/**
 * The plugin runs in a process the Paseo daemon spawns, so `process.ppid` is
 * the daemon and the daemon's other children are the agent CLIs it launched.
 * That is what makes "which MCP servers are running for this workspace"
 * answerable here without any daemon API for it.
 *
 * `ps` (and `lsof` on macOS) run without blocking the plugin, with timeouts,
 * and one snapshot of the process table serves every panel that asks within
 * SNAPSHOT_TTL_MS: three open panels read one `ps`, not three.
 */

export type ObservationResult =
  | { available: true; checkedAt: string; observed: ObservedWorkspace }
  | { available: false; reason: string };

const SNAPSHOT_TTL_MS = 5_000;

type Snapshot = { at: number; tree: ProcessTree; roots: number[]; cwds: Map<number, string>; daemonSeen: boolean };

async function processTable(): Promise<string | null> {
  if (process.platform !== "linux" && process.platform !== "darwin") return null;
  const result = await runFile("ps", ["-eo", "pid=,ppid=,rss=,args="], { timeoutMs: 5_000, maxBytes: 16 * 1024 * 1024 });
  return result.code === 0 ? result.stdout : null;
}

/** Working directories for a set of pids; a pid that cannot be read is simply absent. */
async function workingDirectories(pids: number[]): Promise<Map<number, string>> {
  const cwds = new Map<number, string>();
  if (pids.length === 0) return cwds;
  if (process.platform === "linux") {
    for (const pid of pids) {
      try {
        cwds.set(pid, readlinkSync(`/proc/${pid}/cwd`));
      } catch {
        // Another user's process, or one that exited between ps and here.
      }
    }
    return cwds;
  }
  // macOS has no /proc; lsof answers for a batch of pids in one call. It exits
  // non-zero when any pid has gone, so its output is read whatever the code.
  const result = await runFile("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], { timeoutMs: 10_000 });
  let current: number | null = null;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("p")) current = Number(line.slice(1));
    else if (line.startsWith("n") && current !== null) cwds.set(current, line.slice(1));
  }
  return cwds;
}

// Daemon children that are never agents: the plugin hosts, and the git/gh
// calls the daemon itself makes while refreshing a workspace.
const NOT_AN_AGENT = /(^|\/)(git|gh|esbuild)$|plugin-process\.js/;

async function takeSnapshot(): Promise<Snapshot | null> {
  const table = await processTable();
  if (table === null) return null;
  const tree = buildProcessTree(parseProcessTable(table));
  const daemon = process.ppid;
  const roots = (tree.children.get(daemon) ?? []).filter((pid) => {
    if (pid === process.pid) return false;
    const args = tree.byPid.get(pid)?.args ?? "";
    const command = args.split(/\s+/)[0] ?? "";
    return !NOT_AN_AGENT.test(command) && !NOT_AN_AGENT.test(args.split(/\s+/)[1] ?? "");
  });
  const candidates = new Set<number>(roots);
  for (const root of roots) for (const pid of tree.children.get(root) ?? []) candidates.add(pid);
  // Servers sit one or two levels under an agent (agent → npm exec → sh → node);
  // reading the first two levels' cwd is enough to place them.
  for (const pid of [...candidates]) for (const child of tree.children.get(pid) ?? []) candidates.add(child);
  const cwds = await workingDirectories([...candidates]);
  return { at: Date.now(), tree, roots, cwds, daemonSeen: tree.byPid.has(daemon) };
}

let snapshot: Snapshot | null = null;
let pending: Promise<Snapshot | null> | null = null;

/** One process-table read shared by every caller within SNAPSHOT_TTL_MS. */
function currentSnapshot(): Promise<Snapshot | null> {
  if (snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL_MS) return Promise.resolve(snapshot);
  if (pending) return pending;
  pending = takeSnapshot()
    .then((taken) => {
      if (taken) snapshot = taken;
      return taken;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/**
 * Running MCP server processes for one workspace, from the live process table.
 * Returns `available: false` with the reason when the host cannot be read, so
 * the panel can say so instead of showing a zero that means nothing.
 */
export async function observeWorkspaceProcesses(directory: string, servers: Record<string, McpDef>): Promise<ObservationResult> {
  const taken = await currentSnapshot();
  if (taken === null) return { available: false, reason: `the process table could not be read on ${process.platform}` };
  if (taken.roots.length === 0 && !taken.daemonSeen) {
    return { available: false, reason: "the plugin is not running under a Paseo daemon, so agent processes cannot be found" };
  }
  const observed = observeWorkspace({
    tree: taken.tree,
    roots: taken.roots,
    directory,
    cwdOf: (pid) => taken.cwds.get(pid) ?? null,
    servers: Object.entries(servers).map(([name, def]) => ({ name, command: def.command, args: def.args })),
  });
  return { available: true, checkedAt: new Date(taken.at).toISOString(), observed };
}

/** For logs: the agent binary a root runs, never its arguments. */
export function rootLabel(args: string): string {
  return basename(args.split(/\s+/)[0] ?? "");
}
