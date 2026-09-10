import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
// ---- universal MCP management -------------------------------------------------

export const DestinationSchema = z.object({
  id: z.string(), // stable: the config file path
  label: z.string(), // "Claude · you@work.com (primary)"
  provider: z.string(), // claude | codex | kimi | grok | <custom paseo id>
  // The Paseo provider id whose agents read this config ("claude", "codex", a
  // custom id that extends one of them), or "" for a slot no provider is wired
  // to. Absent on rows from older hosts.
  providerId: z.string().default(""),
  account: z.string(), // email, or "" when the CLI has no per-account identity here
  configPath: z.string(),
  format: z.enum(["json-mcp", "toml-mcp"]),
});
export type Destination = z.infer<typeof DestinationSchema>;

export const McpServerRowSchema = z.object({
  name: z.string(),
  transport: z.enum(["stdio", "http", "unknown"]),
  detail: z.string(),
  authStyle: z.enum(["inline-credentials", "oauth-or-none"]),
  inlineCredentialsIn: z.array(z.string()),
  presentIn: z.array(z.string()), // destination ids
});
export type McpServerRow = z.infer<typeof McpServerRowSchema>;

export const mcpMatrix = defineRpc({
  name: "paseo-mcp.matrix",
  input: z.object({}),
  output: z.object({
    destinations: z.array(DestinationSchema),
    servers: z.array(McpServerRowSchema),
  }),
});

export const mcpAdd = defineRpc({
  name: "paseo-mcp.add",
  input: z.object({
    name: z.string().min(1),
    kind: z.enum(["stdio", "http"]),
    command: z.string().optional(), // stdio: full command line (first token = binary)
    url: z.string().optional(), // http
    kvLines: z.string().optional(), // env (stdio) or headers (http), one KEY=VALUE per line
    targets: z.array(z.string()).min(1), // destination ids
  }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const mcpApply = defineRpc({
  name: "paseo-mcp.apply",
  input: z.object({
    name: z.string(),
    targets: z.array(z.string()).min(1),
    sourceDestId: z.string().optional(), // copy THIS destination's version; default = best available
  }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const mcpRemove = defineRpc({
  name: "paseo-mcp.remove",
  input: z.object({ name: z.string(), targets: z.array(z.string()).min(1) }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const McpAuthAccountSchema = z.object({
  provider: z.enum(["claude", "codex"]),
  email: z.string(),
  dir: z.string(),
  isPrimary: z.boolean(),
  definedServers: z.number(),
  needsAuth: z.array(z.string()),
  authStatus: z.record(z.string(), z.enum(["connected", "not-connected", "unsupported", "unknown"])),
});
export type McpAuthAccount = z.infer<typeof McpAuthAccountSchema>;

export const mcpAuth = defineRpc({
  name: "paseo-mcp.auth",
  input: z.object({}),
  output: z.object({
    accounts: z.array(McpAuthAccountSchema),
    projectServers: z.array(z.object({ project: z.string(), name: z.string() })),
  }),
});

export const ProjectMcpServerSchema = z.object({
  name: z.string(),
  transport: z.enum(["stdio", "http", "unknown"]),
  detail: z.string(),
  authStyle: z.enum(["inline-credentials", "oauth-or-none"]),
});
export type ProjectMcpServer = z.infer<typeof ProjectMcpServerSchema>;

const TransportSchema = z.enum(["stdio", "http", "unknown"]);

const ProfileServerSchema = z.object({ name: z.string(), transport: TransportSchema });

/** One editor config and what an agent reading it loads in this workspace. See shared/budget.ts. */
export const ProfileScopeSchema = z.object({
  id: z.string(),
  label: z.string(),
  provider: z.string(),
  providerId: z.string(),
  configPath: z.string(),
  servers: z.array(ProfileServerSchema), // user level: every workspace
  local: z.array(ProfileServerSchema), // Claude's per-directory entries for this workspace
});

export const WorkspaceProfileSchema = z.object({
  project: z.array(ProfileServerSchema),
  projectConfigPath: z.string(),
  scopes: z.array(ProfileScopeSchema),
});

/** Running MCP server processes attributed to the workspace. See shared/processes.ts. */
export const ObservedServerSchema = z.object({ name: z.string(), processes: z.number(), rssKb: z.number() });

export const ProcessObservationSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    checkedAt: z.string(),
    observed: z.object({
      agents: z.number(),
      servers: z.array(ObservedServerSchema),
      processes: z.number(),
      rssKb: z.number(),
      unmatchable: z.array(z.string()),
    }),
  }),
  z.object({ available: z.literal(false), reason: z.string() }),
]);
export type ProcessObservation = z.infer<typeof ProcessObservationSchema>;

/** Read-only project MCP inventory resolved from a live Paseo workspace id. */
export const mcpWorkspace = defineRpc({
  name: "paseo-mcp.workspace",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({
    workspace: z.object({
      id: z.string(),
      name: z.string(),
      directory: z.string(),
      projectRootPath: z.string(),
    }),
    configPath: z.string(),
    servers: z.array(ProjectMcpServerSchema),
    accounts: z.array(McpAuthAccountSchema),
    // What an agent started here loads, per editor config, and the injection
    // settings the load was computed against. Optional so a 0.5 client can
    // read a 0.4 host.
    profile: WorkspaceProfileSchema.optional(),
    injection: z
      .object({
        injectWorkspaceServers: z.boolean(),
        providers: z.array(z.string()),
        skipInlineCredentialServers: z.boolean(),
      })
      .optional(),
    processes: ProcessObservationSchema.optional(),
  }),
});

export const mcpSync = defineRpc({
  name: "paseo-mcp.sync",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), log: z.string() }),
});

// Per-destination editable view of one server. Secrets are MASKED (•••last4)
// unless reveal=true — it is the user's own machine and their own secrets.
// An edit that keeps a masked value keeps that destination's stored secret.
export const McpDefRowSchema = z.object({
  destId: z.string(),
  found: z.boolean(),
  kind: z.enum(["stdio", "http"]),
  command: z.string(),
  url: z.string(),
  kvLines: z.string(), // KEY=value per line (env for stdio, headers for http)
});
export type McpDefRow = z.infer<typeof McpDefRowSchema>;

export const mcpDefAll = defineRpc({
  name: "paseo-mcp.def-all",
  input: z.object({ name: z.string(), reveal: z.boolean() }),
  output: z.object({ rows: z.array(McpDefRowSchema) }),
});

export const mcpEditOne = defineRpc({
  name: "paseo-mcp.edit-one",
  input: z.object({
    name: z.string(),
    destId: z.string(),
    kind: z.enum(["stdio", "http"]),
    command: z.string().optional(),
    url: z.string().optional(),
    kvLines: z.string().optional(), // masked values (•••…) keep that destination's stored secret
  }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const mcpRename = defineRpc({
  name: "paseo-mcp.rename",
  input: z.object({ name: z.string(), newName: z.string().min(1) }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/**
 * Where a checked definition was found. `user` means an editor's global config
 * (~/.claude.json, ~/.codex/config.toml, …); `project` means a `.mcp.json` in a
 * registered Paseo project. A server can be defined at both levels.
 */
export const McpHealthScopeSchema = z.object({
  level: z.enum(["user", "project"]),
  label: z.string(), // destination label, or project name
  configPath: z.string(),
});
export type McpHealthScope = z.infer<typeof McpHealthScopeSchema>;

export const McpHealthStatusSchema = z.enum(["ok", "auth-required", "warn", "down", "binary-missing", "unknown"]);
export type McpHealthStatus = z.infer<typeof McpHealthStatusSchema>;

export const McpHealthSchema = z.object({
  name: z.string(),
  status: McpHealthStatusSchema,
  note: z.string(),
  // Every config that defines this server. Absent on results from older hosts.
  scopes: z.array(McpHealthScopeSchema).default([]),
});
export type McpHealth = z.infer<typeof McpHealthSchema>;

export const McpHealthReportSchema = z.object({
  results: z.array(McpHealthSchema),
  checkedAt: z.string(),
});
export type McpHealthReport = z.infer<typeof McpHealthReportSchema>;

/** Probe every server now and refresh the cached report. */
export const mcpHealth = defineRpc({
  name: "paseo-mcp.health",
  input: z.object({}),
  output: McpHealthReportSchema,
});

/**
 * Last known health without probing. `report` is null until the first check
 * (manual or background) has completed on this host.
 */
export const mcpHealthCached = defineRpc({
  name: "paseo-mcp.health-cached",
  input: z.object({}),
  output: z.object({
    report: McpHealthReportSchema.nullable(),
    backgroundChecks: z.boolean(),
    intervalMinutes: z.number(),
    showComposerPill: z.boolean(),
    nextCheckAt: z.string().nullable(),
  }),
});

/** Statuses a user has to act on; `ok` and `unknown` are not problems. */
export function healthNeedsAttention(status: McpHealthStatus): boolean {
  return status !== "ok" && status !== "unknown";
}

/** True when one of the result's project scopes is the `.mcp.json` of `directory` or one of its parents. */
export function scopedToDirectory(scope: McpHealthScope, directory: string): boolean {
  if (scope.level !== "project" || !directory) return false;
  const root = scope.configPath.replace(/[\\/]\.mcp\.json$/, "");
  return directory === root || directory.startsWith(`${root}/`) || directory.startsWith(`${root}\\`);
}
