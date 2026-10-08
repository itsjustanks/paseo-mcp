/**
 * Where a connector is set up, in plain words (0.20.0; the user: "with MCP
 * should easily distinguish user level MCPs vs project level", "especially
 * when opening in the workspace stuff").
 *
 * - Everywhere: a user-level config every project gets (~/.claude.json's
 *   top level, ~/.codex/config.toml, the other apps' own files).
 * - This project · <name>: the project's .mcp.json (shared with the team),
 *   and what this plugin's agent.create hook adds from it.
 * - This project, just for you: Claude Code's "local" scope, an entry for
 *   this project inside ~/.claude.json.
 *
 * Which copy wins when one name is set up at two levels follows Claude Code's
 * documented order: local, then project, then user, whole entry, no merging
 * (code.claude.com/docs/en/mcp, "Scope hierarchy and precedence"). Codex has
 * no documented rule for a .mcp.json the hook adds, so no winner is claimed.
 *
 * Pure, shared by the panel, the list, the Remove dialog and the Add flow.
 */

export type ConnectorScope = "user" | "project" | "local";

export const EVERYWHERE = "Everywhere";
export const JUST_FOR_YOU = "This project, just for you";
/** The Connectors tab's one line: everything on it is set up everywhere. */
export const EVERYWHERE_LINE = "Everywhere: these are in your AI apps' own settings, so every project gets them. Claude Code's \"just for you\" copies show here too, marked. A project's shared connectors are under Projects.";

export function thisProject(projectName: string): string {
  return projectName ? `This project · ${projectName}` : "This project";
}

export function scopeLabel(scope: ConnectorScope, projectName: string): string {
  if (scope === "user") return EVERYWHERE;
  if (scope === "local") return JUST_FOR_YOU;
  return thisProject(projectName);
}

/** The project scopes first (what this workspace adds), then Everywhere (what it inherits). */
export function scopeOrder(scope: ConnectorScope): number {
  return scope === "local" ? 0 : scope === "project" ? 1 : 2;
}

const lastPart = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
const parentName = (path: string) => lastPart(path.replace(/[\\/][^\\/]*$/, ""));

/** "~/.claude.json" for a file under home, else the path as it is. For expanded detail, next to a Copy. */
export function homeRelative(path: string, home: string): string {
  const base = home.replace(/[\\/]+$/, "");
  if (!base || !path) return path;
  if (path === base) return "~";
  return path.startsWith(`${base}/`) ? `~/${path.slice(base.length + 1)}` : path;
}

const APP_FILES: Array<[RegExp, string]> = [
  [/\.claude\.json$/, "Claude Code settings"],
  [/\.codex[\\/]config\.toml$/, "Codex settings"],
  [/\.kimi[^\\/]*[\\/]mcp\.json$/, "Kimi settings"],
  [/\.grok[\\/]config\.toml$/, "Grok settings"],
];

/**
 * Where an entry comes from, without a path, for the row itself:
 * "data-glue · .mcp.json", "Claude Code settings", "Claude Code settings · just for you".
 */
export function sourceLabel(scope: ConnectorScope, configPath: string): string {
  if (scope === "project") {
    const project = parentName(configPath);
    return project ? `${project} · ${lastPart(configPath) || ".mcp.json"}` : ".mcp.json";
  }
  // 0.20.0: Claude's per-project entries read "Claude Code · just for you" (read only here).
  if (scope === "local") return "Claude Code · just for you";
  return APP_FILES.find(([pattern]) => pattern.test(configPath))?.[1] ?? (lastPart(configPath) || "Settings");
}

/**
 * One short line when the same name is set up at more than one level, or ""
 * when it isn't. `winner` is the copy this project's chats load; `others` the
 * levels it hides. Claude Code's order is documented; for Codex only the fact
 * is stated.
 */
export function shadowLine(winner: ConnectorScope, others: readonly ConnectorScope[], provider: string): string {
  const hidden = others.filter((scope) => scope !== winner);
  if (hidden.length === 0) return "";
  const where = hidden
    .map((scope) => (scope === "user" ? "everywhere" : scope === "project" ? "in this project's .mcp.json" : "just for you"))
    .join(" and ");
  if (provider !== "claude") return `Also set up ${where}, with the same name.`;
  const used = winner === "local" ? "your own copy" : winner === "project" ? "this project's copy" : "this copy";
  return `Also set up ${where}; ${used} is used here.`;
}

/**
 * The Add flow's starting scope (0.20.0): the scope the user was browsing
 * ("This project" from a workspace or the Projects tab, "Everywhere" from the
 * Connectors tab), when the connector can go there. With no browsing scope,
 * the old rule: a project only when every app already has it and a project doesn't.
 */
export function startingScope(input: {
  browsing: "user" | "project" | null;
  projectAllowed: boolean;
  added: boolean;
  missingApps: number;
  missingProjects: number;
}): "user" | "project" {
  if (input.browsing === "project") return input.projectAllowed ? "project" : "user";
  if (input.browsing === "user") return "user";
  return input.projectAllowed && input.added && input.missingApps === 0 && input.missingProjects > 0 ? "project" : "user";
}
