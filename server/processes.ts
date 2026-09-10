import { execFileSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import { basename } from "node:path";
import type { ObservedWorkspace } from "../shared/processes";
import { buildProcessTree, observeWorkspace, parseProcessTable } from "../shared/processes";
import type { McpDef } from "./handlers";

/**
 * The plugin runs in a process the Paseo daemon spawns, so `process.ppid` is
 * the daemon and the daemon's other children are the agent CLIs it launched.
 * That is what makes "which MCP servers are running for this workspace"
 * answerable here without any daemon API for it.
 */

export type ObservationResult =
  | { available: true; checkedAt: string; observed: ObservedWorkspace }
  | { available: false; reason: string };

function processTable(): string | null {
  if (process.platform !== "linux" && process.platform !== "darwin") return null;
  try {
    return execFileSync("ps", ["-eo", "pid=,ppid=,rss=,args="], { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** Working directories for a set of pids; a pid that cannot be read is simply absent. */
function workingDirectories(pids: number[]): Map<number, string> {
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
  // macOS has no /proc; lsof answers for a batch of pids in one call.
  try {
    const out = execFileSync("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], { encoding: "utf8", timeout: 10_000 });
    let current: number | null = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("p")) current = Number(line.slice(1));
      else if (line.startsWith("n") && current !== null) cwds.set(current, line.slice(1));
    }
  } catch {
    // lsof missing or refused: every cwd stays unknown and nothing is attributed.
  }
  return cwds;
}

// Daemon children that are never agents: the plugin hosts, and the git/gh
// calls the daemon itself makes while refreshing a workspace.
const NOT_AN_AGENT = /(^|\/)(git|gh|esbuild)$|plugin-process\.js/;

/**
 * Running MCP server processes for one workspace, from the live process table.
 * Returns `available: false` with the reason when the host cannot be read, so
 * the panel can say so instead of showing a zero that means nothing.
 */
export function observeWorkspaceProcesses(directory: string, servers: Record<string, McpDef>): ObservationResult {
  const table = processTable();
  if (table === null) return { available: false, reason: `process table not readable on ${process.platform}` };
  const tree = buildProcessTree(parseProcessTable(table));
  const daemon = process.ppid;
  const roots = (tree.children.get(daemon) ?? []).filter((pid) => {
    if (pid === process.pid) return false;
    const args = tree.byPid.get(pid)?.args ?? "";
    const command = args.split(/\s+/)[0] ?? "";
    return !NOT_AN_AGENT.test(command) && !NOT_AN_AGENT.test(args.split(/\s+/)[1] ?? "");
  });
  if (roots.length === 0 && !tree.byPid.has(daemon)) {
    return { available: false, reason: "the plugin is not running under a Paseo daemon, so agent processes cannot be found" };
  }
  const candidates = new Set<number>(roots);
  for (const root of roots) for (const pid of tree.children.get(root) ?? []) candidates.add(pid);
  // Servers sit one or two levels under an agent (agent → npm exec → sh → node);
  // reading the first two levels' cwd is enough to place them.
  for (const pid of [...candidates]) for (const child of tree.children.get(pid) ?? []) candidates.add(child);
  const cwds = workingDirectories([...candidates]);
  const observed = observeWorkspace({
    tree,
    roots,
    directory,
    cwdOf: (pid) => cwds.get(pid) ?? null,
    servers: Object.entries(servers).map(([name, def]) => ({ name, command: def.command, args: def.args })),
  });
  return { available: true, checkedAt: new Date().toISOString(), observed };
}

/** For logs: the agent binary a root runs, never its arguments. */
export function rootLabel(args: string): string {
  return basename(args.split(/\s+/)[0] ?? "");
}
