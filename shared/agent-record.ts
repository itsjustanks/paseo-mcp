/**
 * MCP servers an agent was started with that no editor config or Paseo tools
 * explain: the ones other plugins add from their `agent.create` hooks (Shared
 * Browser's `shared-browser`, for one), or a creator passed in.
 *
 * What the daemon keeps (read from @getpaseo/server 0.9.1):
 *
 *  - Before hooks run one plugin at a time, sorted by plugin id
 *    (`plugins/runtime.js` `before`), each seeing only what earlier ids added.
 *    `paseo-mcp` sorts before `shared-browser`, so its own hook never sees
 *    that server; a hook is no way to learn the final list.
 *  - The agent snapshot the client and `paseo.agents` return has no
 *    `mcpServers` (`AgentSnapshotPayloadSchema`).
 *  - After every hook, `createAgentInternal` stores the config
 *    (`prepareSessionConfig` → `storedConfig`, the internal Paseo server
 *    stripped) in `$PASEO_HOME/agents/<project dir>/<agent id>.json`
 *    (`agent-storage.js` `buildRecordPath`), `config.mcpServers` included.
 *    That file is what this reads.
 *
 * Pure: the host reads the file, this shapes it.
 */

/** One server from the agent's stored config. `url` and `headers` stay on the host (the probe needs them); only name and transport are shown. */
export type RecordServer = {
  name: string;
  transport: "stdio" | "http" | "unknown";
  url?: string;
  headers?: Record<string, string>;
};

/** Agent ids are UUIDs; anything with a separator or a dot is refused before it becomes part of a path. */
export function isSafeAgentId(agentId: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(agentId);
}

/** The daemon's internal Paseo server: http or sse at `/mcp/agents` (`runtime-mcp-config.js`). */
function isInternalPaseoServer(def: { type?: unknown; url?: unknown }): boolean {
  if ((def.type !== "http" && def.type !== "sse") || typeof def.url !== "string") return false;
  try {
    return new URL(def.url).pathname === "/mcp/agents";
  } catch {
    return false;
  }
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) if (typeof entry === "string") out[key] = entry;
  return Object.keys(out).length ? out : undefined;
}

/**
 * The stored record's `config.mcpServers`, or null when the record is not this
 * agent's or has no readable config. An empty list means the agent was started
 * with none.
 */
export function recordServers(record: unknown, agentId: string): RecordServer[] | null {
  const parsed = record && typeof record === "object" && !Array.isArray(record) ? (record as { id?: unknown; config?: unknown }) : null;
  if (!parsed || parsed.id !== agentId) return null;
  const config = parsed.config && typeof parsed.config === "object" ? (parsed.config as { mcpServers?: unknown }) : null;
  const servers = config?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
  const out: RecordServer[] = [];
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const def = value as { type?: unknown; command?: unknown; url?: unknown; headers?: unknown };
    if (isInternalPaseoServer(def)) continue;
    if (typeof def.command === "string" || def.type === "stdio") {
      out.push({ name, transport: "stdio" });
    } else if (typeof def.url === "string") {
      const headers = stringRecord(def.headers);
      out.push({ name, transport: "http", url: def.url, ...(headers ? { headers } : {}) });
    } else {
      out.push({ name, transport: "unknown" });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The servers no editor config explains: everything in the record whose name the load does not already have. */
export function unexplainedServers(servers: readonly RecordServer[], explained: ReadonlySet<string>): RecordServer[] {
  return servers.filter((entry) => !explained.has(entry.name));
}
