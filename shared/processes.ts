/**
 * Running MCP server processes, attributed to a workspace.
 *
 * A stdio MCP server is a child process of the agent that started it, and the
 * agent is a child of the Paseo daemon. Given a process table, the daemon's
 * pid, and each process's working directory, the servers of one workspace can
 * be found without guessing: a process matches a server definition by the
 * package or script it runs, and belongs to the workspace when it, or its
 * agent, works in the workspace directory.
 *
 * Pure on purpose: the server module supplies `ps` output and cwd lookups,
 * and this file never sees a token. Only names, counts and memory leave it.
 */

export type ProcessRecord = { pid: number; ppid: number; rssKb: number; args: string };

/** Parses `ps -eo pid=,ppid=,rss=,args=` (Linux and macOS agree on this shape). */
export function parseProcessTable(text: string): ProcessRecord[] {
  const records: ProcessRecord[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    records.push({ pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]), args: match[4].trim() });
  }
  return records;
}

export type ProcessTree = { byPid: Map<number, ProcessRecord>; children: Map<number, number[]> };

export function buildProcessTree(records: ProcessRecord[]): ProcessTree {
  const byPid = new Map<number, ProcessRecord>();
  const children = new Map<number, number[]>();
  for (const record of records) {
    byPid.set(record.pid, record);
    const list = children.get(record.ppid) ?? [];
    list.push(record.pid);
    children.set(record.ppid, list);
  }
  return { byPid, children };
}

/** Every process under `pid`, not including `pid` itself. */
export function descendantsOf(tree: ProcessTree, pid: number): number[] {
  const found: number[] = [];
  const queue = [...(tree.children.get(pid) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    found.push(next);
    queue.push(...(tree.children.get(next) ?? []));
  }
  return found;
}

const SECRETISH = /(token|secret|key|password|auth|bearer|credential)/i;

/**
 * The token that identifies a stdio server's process: the last argument that
 * is not a flag, or the command's basename when there are no arguments. For
 * `npx -y @scope/pkg` that is `@scope/pkg`, which is what `npm exec` shows in
 * its own command line; for `node server.js --port 3` it is `server.js`. A
 * generic launcher with nothing else to go on (`npx` alone) returns null
 * rather than matching every npx on the machine. Secret-looking arguments are
 * never used as keys, so a token cannot leak by being matched against.
 */
export function processKey(def: { command?: string; args?: string[] }): string | null {
  if (!def.command) return null;
  const args = def.args ?? [];
  const candidates: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (SECRETISH.test(arg)) {
      // A secret flag's value is the next argument; skip it as redactDetail does.
      if (arg.startsWith("-") && !arg.includes("=")) index += 1;
      continue;
    }
    if (!arg.startsWith("-") && arg.length >= 3) candidates.push(arg);
  }
  if (candidates.length > 0) return candidates[candidates.length - 1];
  const base = def.command.split(/[\\/]/).pop() ?? def.command;
  if (/^(npx|npm|uvx|uv|node|python3?|docker|sh|bash|bun|deno)$/.test(base)) return null;
  return base;
}

export type ObservedServer = { name: string; processes: number; rssKb: number };

export type ObservedWorkspace = {
  /** Processes the daemon started that work in this directory (agents, in practice). */
  agents: number;
  servers: ObservedServer[];
  processes: number;
  rssKb: number;
  /** Servers whose definition gives nothing to match a process on. */
  unmatchable: string[];
};

function underDirectory(cwd: string | null, directory: string): boolean {
  if (!cwd || !directory) return false;
  return cwd === directory || cwd.startsWith(`${directory}/`) || cwd.startsWith(`${directory}\\`);
}

/**
 * Counts this workspace's running MCP server processes. `roots` are the
 * daemon's children worth looking under (agent CLIs); a root belongs to the
 * workspace when its own cwd is under `directory` (Claude Code) or when one of
 * its matched servers is (Codex keeps its app-server in $HOME and runs each
 * server in the workspace). A matched process and everything beneath it (the
 * `sh -c`, the node wrapper, the binary) count as one server's footprint.
 */
export function observeWorkspace(input: {
  tree: ProcessTree;
  roots: number[];
  directory: string;
  cwdOf: (pid: number) => string | null;
  servers: Array<{ name: string; command?: string; args?: string[] }>;
}): ObservedWorkspace {
  const { tree, roots, directory, cwdOf, servers } = input;
  const keys = servers.map((server) => ({ name: server.name, key: processKey(server) }));
  // Only stdio servers have a process to find; an http server is not "unmatched".
  const unmatchable = servers.filter((server, index) => server.command && keys[index].key === null).map((server) => server.name);
  const totals = new Map<string, ObservedServer>();
  const claimed = new Set<number>();
  let agents = 0;

  for (const root of roots) {
    const rootHere = underDirectory(cwdOf(root), directory);
    let matchedHere = false;
    for (const pid of descendantsOf(tree, root)) {
      if (claimed.has(pid)) continue;
      const record = tree.byPid.get(pid);
      if (!record) continue;
      const hit = keys.find((entry) => entry.key !== null && record.args.includes(entry.key));
      if (!hit) continue;
      const here = rootHere || underDirectory(cwdOf(pid), directory);
      const footprint = [pid, ...descendantsOf(tree, pid)];
      for (const member of footprint) claimed.add(member);
      if (!here) continue;
      matchedHere = true;
      const total = totals.get(hit.name) ?? { name: hit.name, processes: 0, rssKb: 0 };
      for (const member of footprint) {
        total.processes += 1;
        total.rssKb += tree.byPid.get(member)?.rssKb ?? 0;
      }
      totals.set(hit.name, total);
    }
    if (rootHere || matchedHere) agents += 1;
  }

  const list = [...totals.values()].sort((a, b) => b.rssKb - a.rssKb || a.name.localeCompare(b.name));
  return {
    agents,
    servers: list,
    processes: list.reduce((sum, entry) => sum + entry.processes, 0),
    rssKb: list.reduce((sum, entry) => sum + entry.rssKb, 0),
    unmatchable,
  };
}

/** "210 MB" or "850 KB", for a caption. */
export function formatMemory(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  if (kb >= 1024) return `${Math.round(kb / 1024)} MB`;
  return `${kb} KB`;
}
