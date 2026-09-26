/**
 * What one server card says and does: its sign-in state across accounts, which
 * filter it falls under, and the exact words of a removal before it happens.
 * Pure so the copy can be unit-tested; the client only renders it.
 */
import type { Destination, McpAuthAccount, McpHealth, McpHealthStatus, McpServerRow } from "./contracts";
import { healthNeedsAttention } from "./contracts";
import { endpointKey } from "./catalog";

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
    /** The card's one-line description (0.15.0): searched as well as the name. */
    description?: string;
  },
): boolean {
  const query = options.query.trim().toLowerCase();
  if (query) {
    const hay = `${server.name} ${options.description ?? ""}`.toLowerCase();
    if (!query.split(/\s+/).every((word) => hay.includes(word))) return false;
  }
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

// -------------------------------------------------------------------- gallery

/**
 * The Servers tab as a gallery (0.15.0): one card per server with a plain
 * description, a health word, which apps have it, and its sign-in state. The
 * filter pills are the existing filters under plain names.
 */
export const SERVER_FILTERS: ReadonlyArray<{ value: ServerFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "issues", label: "Needs attention" },
  { value: "sign-in", label: "Needs sign-in" },
  { value: "gaps", label: "Missing from some apps" },
];

const PROVIDER_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", kimi: "Kimi", grok: "Grok" };

export function providerName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? (provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : "Editor");
}

/** "A", "A and B", "A, B and C". */
export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * Which apps have a server and which don't, by app: "In Claude and Codex ·
 * missing in Kimi". An app with more than one account that has it in some of
 * them reads "missing in 1 Claude account".
 */
export function appsLine(presentIn: readonly string[], destinations: readonly Destination[]): { line: string; missing: number } {
  const byApp = new Map<string, { have: number; total: number }>();
  for (const dest of destinations) {
    const name = providerName(dest.provider);
    const entry = byApp.get(name) ?? { have: 0, total: 0 };
    entry.total += 1;
    if (presentIn.includes(dest.id)) entry.have += 1;
    byApp.set(name, entry);
  }
  const have: string[] = [];
  const lack: string[] = [];
  for (const [name, { have: count, total }] of byApp) {
    if (count > 0) have.push(name);
    if (count === 0) lack.push(name);
    else if (count < total) lack.push(`${total - count} ${name} account${total - count === 1 ? "" : "s"}`);
  }
  const missing = destinations.filter((dest) => !presentIn.includes(dest.id)).length;
  const head = have.length > 0 ? `In ${joinWords(have)}` : "In none of your apps";
  return { line: lack.length > 0 ? `${head} · missing in ${joinWords(lack)}` : `${head}`, missing };
}

/** A catalogue entry, as far as a description needs it. */
export type KnownServer = { url?: string; command?: string; args?: string[]; description: string };

/** The endpoint a matrix row's `detail` names: its address, or its command and arguments. */
function detailEndpoint(server: Pick<McpServerRow, "transport" | "detail">): string {
  const detail = server.detail.trim();
  if (!detail) return "";
  if (server.transport === "http") return endpointKey({ url: detail });
  const [command, ...args] = detail.split(/\s+/);
  return endpointKey({ command, args });
}

function hostOf(url: string): string {
  try {
    return new URL(url.trim()).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * One plain line about a server: the catalogue's description when its
 * endpoint is a known one, otherwise where it runs ("Your server at
 * mcp.example.com", "Runs on this computer").
 */
export function serverDescription(server: Pick<McpServerRow, "transport" | "detail">, known: readonly KnownServer[]): string {
  const key = detailEndpoint(server);
  if (key) {
    const match = known.find((entry) => entry.description && endpointKey(entry) === key);
    if (match) return match.description;
  }
  if (server.transport === "http") {
    const host = hostOf(server.detail);
    return host ? `Your server at ${host}` : "Your own server on the web";
  }
  return "Runs on this computer";
}

/** The health check in a word or two. */
export function healthPlainWord(status: McpHealthStatus | undefined): string {
  switch (status) {
    case "ok":
      return "Working";
    case "warn":
      return "Warning";
    case "down":
      return "Not working";
    case "binary-missing":
      return "Not installed";
    case "auth-required":
      return "Needs sign-in";
    default:
      return "Not checked yet";
  }
}

/** What a health result means, in a sentence, for the Overview's list of what needs a look. */
export function healthPlainNote(status: McpHealthStatus | undefined): string {
  switch (status) {
    case "down":
      return "It didn't answer. Open it to see what's wrong and fix it.";
    case "binary-missing":
      return "The program it needs isn't installed on this computer. Open it to see which.";
    case "warn":
      return "It answered, but not cleanly. Open it to see what's wrong.";
    case "auth-required":
      return "It needs you to sign in.";
    default:
      return "Open it to see more.";
  }
}

/** The sign-in state in words. `authRead`: the sign-in state has been read at least once. */
export function signInLine(
  server: Pick<McpServerRow, "transport" | "inlineCredentialsIn">,
  signIn: SignIn,
  waiting: number,
  authRead: boolean,
): string {
  if (signIn === "needs") return waiting > 1 ? `${waiting} accounts need to sign in` : "Needs you to sign in";
  if (signIn === "connected") return "Signed in";
  if (server.inlineCredentialsIn.length > 0) return "Uses a saved key";
  if (!authRead) return "Checking sign-in…";
  return "No sign-in needed";
}

export type ServerCardModel = {
  name: string;
  description: string;
  health: McpHealthStatus | undefined;
  healthWord: string;
  apps: string;
  missing: number;
  signIn: SignIn;
  signInText: string;
};

/**
 * The Servers gallery: every card in name order, the ones the filter and the
 * search keep, and how many each filter pill would show.
 */
export function serverGallery(input: {
  servers: readonly McpServerRow[];
  destinations: readonly Destination[];
  health: ReadonlyMap<string, McpHealth> | null;
  accounts: readonly McpAuthAccount[];
  authRead: boolean;
  known: readonly KnownServer[];
  filter: ServerFilter;
  query: string;
}): { cards: ServerCardModel[]; counts: Record<ServerFilter, number>; total: number } {
  const counts: Record<ServerFilter, number> = { all: 0, issues: 0, "sign-in": 0, gaps: 0 };
  const cards: ServerCardModel[] = [];
  for (const server of [...input.servers].sort((a, b) => a.name.localeCompare(b.name))) {
    const health = input.health?.get(server.name);
    const signIn = signInState(server.name, input.accounts);
    const description = serverDescription(server, input.known);
    const base = { query: "", destinationCount: input.destinations.length, health, signIn, description };
    for (const filter of SERVER_FILTERS) {
      if (serverMatches(server, { ...base, filter: filter.value })) counts[filter.value] += 1;
    }
    if (!serverMatches(server, { ...base, filter: input.filter, query: input.query })) continue;
    const apps = appsLine(server.presentIn, input.destinations);
    cards.push({
      name: server.name,
      description,
      health: health?.status,
      healthWord: healthPlainWord(health?.status),
      apps: apps.line,
      missing: apps.missing,
      signIn,
      signInText: signInLine(server, signIn, accountsNeedingSignIn(server.name, input.accounts).length, input.authRead),
    });
  }
  return { cards, counts, total: input.servers.length };
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
