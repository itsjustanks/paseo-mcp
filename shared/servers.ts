/**
 * What one server card says and does: its sign-in state across accounts, which
 * filter it falls under, and the exact words of a removal before it happens.
 * Pure so the copy can be unit-tested; the client only renders it.
 */
import type { Destination, McpAuthAccount, McpHealth, McpServerRow } from "./contracts";
import { healthNeedsAttention } from "./contracts";

// -------------------------------------------------------------------- sign-in

export type SignIn = "connected" | "needs" | "none";

type AccountGrants = Pick<McpAuthAccount, "needsAuth" | "authStatus">;

/**
 * One word for a server's OAuth standing across every account: `needs` when any
 * account still has to sign in, `connected` when one has and none is waiting,
 * `none` when no account reports anything (inline credentials, or not OAuth).
 */
export function signInState(name: string, accounts: readonly AccountGrants[]): SignIn {
  let connected = false;
  for (const account of accounts) {
    const status = account.authStatus[name];
    if (account.needsAuth.includes(name) || status === "not-connected") return "needs";
    if (status === "connected") connected = true;
  }
  return connected ? "connected" : "none";
}

/** Account emails that still have to sign in to this server. */
export function accountsNeedingSignIn(name: string, accounts: readonly McpAuthAccount[]): McpAuthAccount[] {
  return accounts.filter((account) => account.needsAuth.includes(name) || account.authStatus[name] === "not-connected");
}

// -------------------------------------------------------------------- filters

export type ServerFilter = "all" | "gaps" | "issues" | "sign-in";

export function serverMatches(
  server: McpServerRow,
  options: {
    filter: ServerFilter;
    query: string;
    destinationCount: number;
    health: McpHealth | undefined;
    signIn: SignIn;
  },
): boolean {
  const query = options.query.trim().toLowerCase();
  if (query && !server.name.toLowerCase().includes(query)) return false;
  switch (options.filter) {
    case "gaps":
      return server.presentIn.length < options.destinationCount;
    case "issues":
      return Boolean(options.health && healthNeedsAttention(options.health.status));
    case "sign-in":
      return options.signIn === "needs";
    default:
      return true;
  }
}

// -------------------------------------------------------------------- removal

/**
 * `one`: this editor's config. `all`: every editor config that defines it.
 * `everywhere`: all editors plus every registered project's `.mcp.json` that
 * defines it, which is the only scope after which the server stays gone: a
 * server left in a repo's `.mcp.json` is read straight back by Claude Code.
 */
export type RemoveScope = "one" | "all" | "everywhere";

/** A project `.mcp.json` that defines the server: the project's name and the file's path. */
export type ProjectFile = { project: string; path: string };

export type RemovePlan = {
  scope: RemoveScope;
  /** Destination ids `mcpRemove` will be called with. */
  targets: string[];
  /** Project `.mcp.json` paths `mcpRemove` will be called with (scope `everywhere` only). */
  projectFiles: string[];
  /** Destination labels, in the order they will be removed. */
  labels: string[];
  /** How many of those definitions carry a token in the definition itself. */
  credentialCount: number;
  title: string;
  /** One sentence each: what goes, what is lost, what is kept. */
  lines: string[];
  confirmLabel: string;
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * The removal, spelled out before it happens. `destId` picks the editor for
 * scope `one`; scope `all` takes every editor the server is defined in; scope
 * `everywhere` adds the project files in `projects`. Null when there is nothing
 * to remove, so the caller never offers an empty action.
 */
export function removePlan(
  server: Pick<McpServerRow, "name" | "presentIn" | "inlineCredentialsIn">,
  destinations: readonly Destination[],
  scope: RemoveScope,
  destId?: string,
  projects: readonly ProjectFile[] = [],
): RemovePlan | null {
  const present = destinations.filter((dest) => server.presentIn.includes(dest.id));
  const chosen = scope === "one" ? present.filter((dest) => dest.id === destId) : present;
  const files = scope === "everywhere" ? [...new Map(projects.map((entry) => [entry.path, entry])).values()] : [];
  if (chosen.length === 0 && files.length === 0) return null;
  const targets = chosen.map((dest) => dest.id);
  const credentialCount = chosen.filter((dest) => server.inlineCredentialsIn.includes(dest.id)).length;
  const labels = chosen.map((dest) => dest.label);
  const where = scope === "everywhere" ? "everywhere" : scope === "all" ? `all ${plural(chosen.length, "editor")}` : labels[0];
  const lines: string[] = [];
  if (chosen.length > 0) {
    lines.push(
      scope === "one"
        ? `1 definition will be deleted, from ${labels[0]}.`
        : `${plural(chosen.length, "editor definition")} will be deleted: ${labels.join(", ")}.`,
    );
  }
  if (scope === "everywhere") {
    lines.push(
      files.length > 0
        ? `${plural(files.length, "project .mcp.json file")} will lose it too: ${files.map((entry) => entry.path).join(", ")}. Those files are usually version-controlled, so the change shows up in git status.`
        : "No project .mcp.json defines it, so only the editor configs change.",
    );
  } else if (projects.length > 0) {
    lines.push(
      `${plural(projects.length, "project .mcp.json file")} still define${projects.length === 1 ? "s" : ""} it (${projects.map((entry) => entry.project).join(", ")}); Claude Code reads those back in that project. Choose Remove everywhere to take it out of them too.`,
    );
  }
  if (scope === "one" && present.length > 1) {
    lines.push(`The other ${plural(present.length - 1, "editor")} keep${present.length - 1 === 1 ? "s" : ""} ${server.name}.`);
  }
  if (credentialCount > 0) {
    lines.push(
      chosen.length === 1
        ? "It carries credentials inside the definition; those are lost with it."
        : credentialCount === chosen.length
          ? "Every one of them carries credentials inside the definition; those are lost with it."
          : credentialCount === 1
            ? "One of them carries credentials inside the definition; those are lost with it."
            : `${credentialCount} of them carry credentials inside the definition; those are lost with them.`,
    );
  }
  lines.push(
    "Each file is backed up before it is written. OAuth grants held by the editor are not touched. There is no undo: Export this server first if you might want it back.",
  );
  return {
    scope,
    targets,
    projectFiles: files.map((entry) => entry.path),
    labels,
    credentialCount,
    title: `Remove ${server.name} from ${where}?`,
    lines,
    confirmLabel:
      scope === "everywhere"
        ? `Remove from ${[chosen.length > 0 ? plural(chosen.length, "editor") : "", files.length > 0 ? plural(files.length, "project file") : ""].filter(Boolean).join(" and ")}`
        : scope === "all"
          ? `Remove from ${plural(chosen.length, "editor")}`
          : "Remove from this editor",
  };
}

/** The project files that define `name`, from the auth report's flat list. */
export function projectFilesFor(name: string, projectServers: readonly { project: string; name: string; path?: string }[]): ProjectFile[] {
  return projectServers.filter((entry) => entry.name === name && entry.path).map((entry) => ({ project: entry.project, path: entry.path as string }));
}
