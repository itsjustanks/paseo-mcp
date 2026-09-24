import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CATALOG_DEFAULTS,
  addedFor,
  buildAddedIndex,
  budgetImpact,
  CatalogCardSchema,
  catalogSettings,
  commandLine,
  curatedCard,
  entryFromDefinition,
  nameClash,
  planHash,
  planInstall,
  SERVER_NAME,
  validateEntry,
  type CatalogCard,
  type AddedPlace,
  type CatalogSettings,
  type EntryOrigin,
  type InstallScope,
  type LibraryState,
} from "../shared/catalog";
import { CURATED_CATALOG } from "../shared/catalog-curated";
import type { Destination } from "../shared/contracts";
import { probeMcp } from "../shared/health";
import { libraryCard, mergeGallery, schemaReason } from "../shared/library";
import { GALLERY_LIBRARY_ID, TEAM_LIBRARY_ID, libraryLocation, type LibraryLocation, type LibrarySource } from "../shared/library-source";
import {
  DIALECTS,
  binaryOnPath,
  buildDestinations,
  destNames,
  destRead,
  destReadOne,
  dialectOf,
  discoverProjects,
  editProjectFile,
  findDef,
  jsonMcpRead,
  jsonSafeDef,
  readJson,
  tomlApply,
  type McpDef,
} from "./handlers";
import {
  cachedDocument,
  cachedSearches,
  catalogFetch,
  documentFor,
  forgetDocument,
  librariesSettled,
  registryFor,
  resetLibraryCaches,
  type LibraryCache,
  type RegistrySearch,
} from "./library";
import { handleMcpImportApply } from "./mcpjson";
import { keepVersionCopy, readSettingsDocument } from "./settings";
import { libraryAuthIds, readLibraryAuth, teamOrigin, writeLibraryHeaderValue } from "./team-auth";

export { readCappedBody, readCappedFile, setCatalogFetch } from "./library";

/**
 * Add from catalogue, host side. The gallery is the Recommended list shipped
 * with the plugin merged with every library the settings name (0.13.0; the
 * team catalogue is the library called Team) and, for a search, every
 * registry library. Reads and searches run in the background (server/library.ts);
 * a read answers from memory. Writes go through the writers every other add
 * uses (backup, atomic write, read-back); a project's `.mcp.json` goes through
 * editProjectFile, the writer removeFromProjectFile uses.
 */

export const TEAM_KEY_MOVED = "The key was cleared because the team address moved to another site; set it again.";
export const LIBRARY_KEY_MOVED = "The key was cleared because the library's address moved to another site; set it again.";
/** Said in a library's note from the moment its key is cleared for a moved address until a key is set or cleared by hand. */
const keyNotes = new Map<string, string>();

/**
 * The catalogue settings as the host registers them: the same definition,
 * with a migration that first keeps the version 1 document as
 * `catalog.v1.json` (keepVersionCopy). Paseo rewrites the file in place when
 * it migrates and keeps no backup; that copy is what a rollback to 0.12.0
 * restores.
 */
export const hostCatalogSettings: typeof catalogSettings = {
  ...catalogSettings,
  migrate: (values, fromVersion) => {
    if (fromVersion === 1) keepVersionCopy("catalog", 1);
    return catalogSettings.migrate ? catalogSettings.migrate(values, fromVersion) : values;
  },
};

export function readCatalogSettings(): CatalogSettings {
  keepVersionCopy("catalog", 1);
  return readSettingsDocument(catalogSettings, CATALOG_DEFAULTS);
}

/**
 * A stored key goes only to the origin it was set for. When a library's
 * address now points at another site (or at a file), its key is deleted, not
 * kept for a move back: whoever moved the address may not be whoever set the
 * key. A key whose library is not listed is left alone; it is sent nowhere.
 */
function unbindMovedKeys(libraries: LibrarySource[]): void {
  for (const id of libraryAuthIds()) {
    const library = libraries.find((candidate) => candidate.id === id);
    const auth = readLibraryAuth(id);
    if (!library || !auth || !library.source.trim() || auth.origin === teamOrigin(library.source)) continue;
    writeLibraryHeaderValue(id, null);
    keyNotes.set(id, id === TEAM_LIBRARY_ID ? TEAM_KEY_MOVED : LIBRARY_KEY_MOVED);
  }
}

/**
 * A library address as it may be shown: without its user name, password,
 * query or fragment (a `?token=` stays on the host); a path as is.
 */
export function redactSource(source: string): string {
  const trimmed = source.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}${url.pathname}${url.search || url.hash ? "?…" : ""}`;
  } catch {
    return trimmed.replace(/[?#].*$/, "?…").replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, "$1");
  }
}

/** Where the team file lives, as 0.12.0 read it (an address is always a document), or why it cannot be read. */
export function teamLocation(source: string): { kind: "url" | "file"; target: string } | { kind: "invalid"; reason: string } {
  const location = libraryLocation(source, "json");
  if (location.kind === "json") return { kind: "url", target: location.url };
  if (location.kind === "file") return { kind: "file", target: location.path };
  if (location.kind === "invalid") return location;
  return { kind: "invalid", reason: "not a document address" };
}

/** For tests: forget every cached read, search and note. */
export function resetCatalogCaches(): void {
  resetLibraryCaches();
  keyNotes.clear();
}

/** For tests: wait for whatever is fetching now. */
export async function catalogSettled(): Promise<void> {
  await librariesSettled();
}

// -------------------------------------------------------------------- read

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** A library's address, short, for a card's note. */
function shortSource(library: LibrarySource): string {
  const location = libraryLocation(library.source, library.format);
  const address = location.kind === "json" ? location.url : location.kind === "registry" ? location.base : "";
  if (address) {
    try {
      const url = new URL(address);
      return `${url.host}${url.pathname.length > 30 ? `…${url.pathname.slice(-24)}` : url.pathname}`;
    } catch {
      return redactSource(library.source);
    }
  }
  const source = library.source.trim();
  return source.length > 48 ? `…${source.slice(-44)}` : source;
}

function refOf(library: LibrarySource) {
  return { id: library.id, name: library.name, label: shortSource(library) };
}

export type DroppedCard = { id: string; reason: string };

/**
 * Every card checked against the schema the app parses the answer with, the
 * last step before it goes out: one card that fails would make the app refuse
 * the whole catalogue. A card that fails is left out, counted per shelf, and
 * listed per library with the reason in words (schemaReason), for the
 * library's row.
 */
export function cardsThatParse(cards: CatalogCard[]): { shown: CatalogCard[]; dropped: Record<CatalogCard["shelf"], number>; byLibrary: Map<string, DroppedCard[]> } {
  const dropped = { recommended: 0, team: 0, library: 0, registry: 0 };
  const byLibrary = new Map<string, DroppedCard[]>();
  const shown = cards.filter((card) => {
    const parsed = CatalogCardSchema.safeParse(card);
    if (!parsed.success) {
      dropped[card.shelf] += 1;
      const reason = schemaReason(parsed.error.issues[0]);
      if (card.library) byLibrary.set(card.library.id, [...(byLibrary.get(card.library.id) ?? []), { id: (card.registryName ?? card.entry.id ?? card.key).slice(0, 80), reason }]);
      console.warn(`[paseo-mcp] catalogue card left out, it does not fit the schema (${reason}): ${card.key.slice(0, 120)}`);
    }
    return parsed.success;
  });
  return { shown, dropped, byLibrary };
}

type LibraryRead = {
  library: LibrarySource;
  location: LibraryLocation;
  document: LibraryCache | null;
  search: RegistrySearch | null;
  cards: CatalogCard[];
};

type Refresh = "team" | "registry" | "both" | "libraries" | "all";

/** Read (or start reading) every enabled library; registries only for a search of two letters or more. */
function readLibraries(libraries: LibrarySource[], query: string, refresh?: Refresh, only?: string): LibraryRead[] {
  return libraries.map((library) => {
    const location = libraryLocation(library.source, library.format);
    const read: LibraryRead = { library, location, document: null, search: null, cards: [] };
    if (!library.enabled) return read;
    const forced = only === library.id || refresh === "all";
    if (location.kind === "registry") {
      read.search = registryFor(library, location.base, query, forced || refresh === "registry" || refresh === "both");
      read.cards = read.search?.cards ?? [];
    } else if (location.kind === "json" || location.kind === "file") {
      const teamAsked = library.id === TEAM_LIBRARY_ID && (refresh === "team" || refresh === "both");
      read.document = documentFor(library, location, forced || teamAsked || refresh === "libraries");
      read.cards = read.document.items.map((item) => libraryCard(item, refOf(library)));
    }
    return read;
  });
}

function documentState(document: LibraryCache): "loading" | "ready" | "error" {
  if (document.inFlight && document.items.length === 0 && !document.error) return "loading";
  if (document.error) return "error";
  return document.inFlight ? "loading" : "ready";
}

/** A library as the Libraries panel shows it. */
function libraryState(read: LibraryRead, droppedCards: DroppedCard[]): LibraryState {
  const { library, location, document, search } = read;
  const dropped = droppedCards.length;
  const base = {
    id: library.id,
    name: library.name,
    source: redactSource(library.source),
    kind: location.kind,
    enabled: library.enabled,
    headerName: library.headerName,
    refused: [...(document?.refused ?? []), ...droppedCards],
    fetchedAt: iso(document?.fetchedAt ?? search?.fetchedAt ?? null),
  };
  const notes = [keyNotes.get(library.id) ?? ""];
  let state: LibraryState["state"] = "off";
  let count = read.cards.length - dropped;
  if (!library.enabled) {
    state = "off";
    count = 0;
  } else if (location.kind === "invalid") {
    state = "error";
    notes.push(`Could not read the ${library.name} library: ${location.reason}.`);
  } else if (document) {
    state = documentState(document);
    if (document.error) {
      const fallback = document.items.length
        ? " Showing the last good copy."
        : library.id === GALLERY_LIBRARY_ID
          ? " The recommended servers shipped with the plugin are shown instead."
          : "";
      notes.push(`Could not read the ${library.name} library: ${document.error}.${fallback}`);
    }
  } else if (search) {
    state = search.inFlight ? "searching" : search.error && search.fetchedAt === null ? "error" : "ready";
    if (search.error) notes.push(`The ${library.name} search failed: ${search.error}.${search.fetchedAt ? " Showing the last answer." : ""}`);
    if (search.truncated) notes.push(`Only the first ${read.cards.length} results are shown; narrow the search.`);
  } else {
    state = "idle";
  }
  if (dropped > 0) {
    const reasons = [...new Set(droppedCards.map((card) => card.reason))].slice(0, 3).join("; ");
    notes.push(`${dropped} entr${dropped === 1 ? "y" : "ies"} couldn't be shown (${reasons}).`);
  }
  return { ...base, state, count: Math.max(0, count), note: notes.filter(Boolean).join(" ") };
}

/** The Team library in the 0.12.0 shape of `team`: "off" when there is none. */
function teamStateOf(states: LibraryState[]) {
  const team = states.find((state) => state.id === TEAM_LIBRARY_ID);
  if (!team || !team.enabled) return { source: team?.source ?? "", state: "off" as const, count: 0, refused: [], fetchedAt: null, note: "" };
  const state = team.state === "searching" ? ("loading" as const) : team.state === "idle" || team.state === "off" ? ("ready" as const) : team.state;
  return { source: team.source, state, count: team.count, refused: team.refused, fetchedAt: team.fetchedAt, note: team.note };
}

/** Every registry library's search together, in the 0.12.0 shape of `registry`. */
function registryStateOf(reads: LibraryRead[], query: string, droppedRegistry: number) {
  const searched = reads.filter((read) => read.search);
  const state = searched.length === 0
    ? ("idle" as const)
    : searched.some((read) => read.search?.inFlight)
      ? ("searching" as const)
      : searched.every((read) => read.search?.error && read.search.fetchedAt === null)
        ? ("error" as const)
        : ("ready" as const);
  const fetched = searched.map((read) => read.search?.fetchedAt ?? 0).filter(Boolean);
  const failed = searched.filter((read) => read.search?.error);
  return {
    query: query.trim(),
    state,
    fetchedAt: fetched.length ? iso(Math.max(...fetched)) : null,
    note: [
      ...failed.map((read) =>
        searched.length === 1
          ? `The registry search failed: ${read.search?.error}.${read.search?.fetchedAt ? " Showing the last answer." : ""}`
          : `The ${read.library.name} search failed: ${read.search?.error}.`,
      ),
      droppedRegistry > 0 ? `${droppedRegistry} registry result${droppedRegistry === 1 ? "" : "s"} couldn't be shown.` : "",
      searched.some((read) => read.search?.truncated) ? "Only the first pages of results are shown; narrow the search." : "",
    ]
      .filter(Boolean)
      .join(" "),
    count: searched.reduce((sum, read) => sum + read.cards.length, 0) - droppedRegistry,
  };
}

export async function handleMcpCatalog(
  { query = "", refresh, library }: { query?: string; refresh?: Refresh; library?: string },
  context?: PluginHandlerContext,
) {
  const settings = readCatalogSettings();
  unbindMovedKeys(settings.libraries);
  const reads = readLibraries(settings.libraries, query, refresh, library);
  const cards = mergeGallery(
    CURATED_CATALOG.map(curatedCard),
    reads.filter((read) => read.document).map((read) => read.cards),
    reads.filter((read) => read.search).flatMap((read) => read.cards),
  );

  const discovered = (await discoverProjects(context?.paseo ?? null)).map((project) => ({ ...project, defs: jsonMcpRead(join(project.path, ".mcp.json")) }));
  const projects = discovered.map((project) => ({ name: project.name, path: project.path, servers: Object.keys(project.defs).length }));

  // "Added": each card's endpoint against every editor config and project file.
  const destinations = await buildDestinations(context?.paseo ?? null);
  const index = buildAddedIndex([
    ...destinations.map((dest) => ({ place: { kind: "editor", id: dest.id, label: dest.label } as AddedPlace, defs: destRead(dest) })),
    ...discovered.map((project) => ({ place: { kind: "project", id: project.path, label: project.name } as AddedPlace, defs: project.defs })),
  ]);
  for (const card of cards) {
    const added = addedFor(card.entry, index, destinations.length);
    if (added) card.added = added;
  }
  const { shown, dropped, byLibrary } = cardsThatParse(cards);
  const libraries = reads.map((read) => libraryState(read, byLibrary.get(read.library.id) ?? []));

  return {
    cards: shown,
    team: teamStateOf(libraries),
    registry: registryStateOf(reads, query, dropped.registry),
    libraries,
    projects,
  };
}

// ----------------------------------------------------------------- install

type InstallInput = {
  key: string;
  scope: InstallScope;
  targets?: string[];
  projectPath?: string;
  name: string;
  values?: Record<string, string>;
  planHash?: string;
};

/** The rules a card's entry is held to: ours for Recommended, the registry's for registry results, a team file's for every library. */
function originOf(card: CatalogCard): EntryOrigin {
  if (card.shelf === "recommended") return "curated";
  return card.shelf === "registry" ? "registry" : "team";
}

/**
 * The card an install names, from what is already read (nothing is fetched
 * here): a Recommended entry, a library's server (`team:<name>`,
 * `library:<id>:<name>`), or a registry result, looked up in library order
 * so the card found is the one the gallery showed.
 */
function resolveCard(key: string): CatalogCard | null {
  const [shelf = "", ...rest] = key.split(":");
  if (shelf === "recommended") {
    const entry = CURATED_CATALOG.find((candidate) => candidate.id === rest.join(":"));
    return entry ? curatedCard(entry) : null;
  }
  const libraries = readCatalogSettings().libraries.filter((library) => library.enabled);
  if (shelf === "team" || shelf === "library") {
    const [id, name] = shelf === "team" ? [TEAM_LIBRARY_ID, rest.join(":")] : [rest[0] ?? "", rest.slice(1).join(":")];
    const library = libraries.find((candidate) => candidate.id === id);
    const item = library ? cachedDocument(library)?.items.find((candidate) => candidate.name === name) : undefined;
    return library && item ? libraryCard(item, refOf(library)) : null;
  }
  if (shelf === "registry") {
    for (const library of libraries) {
      const location = libraryLocation(library.source, library.format);
      if (location.kind !== "registry") continue;
      for (const search of cachedSearches(location.base)) {
        const card = search.cards.find((candidate) => candidate.key === key);
        if (card) return card;
      }
    }
  }
  return null;
}

function toMcpDef(definition: Record<string, unknown>): McpDef {
  const def: McpDef = {};
  if (typeof definition.url === "string") def.url = definition.url;
  if (typeof definition.command === "string") def.command = definition.command;
  if (Array.isArray(definition.args)) def.args = definition.args as string[];
  if (definition.headers) def.headers = definition.headers as Record<string, string>;
  if (definition.env) def.env = definition.env as Record<string, string>;
  if (typeof definition.type === "string") def.type = definition.type;
  return def;
}

function previewFor(dest: Destination, name: string, masked: Record<string, unknown>): string {
  const dialect = dialectOf(dest);
  const spec = DIALECTS[dialect];
  const def = toMcpDef(masked);
  if (spec.format === "json-mcp") {
    return `${JSON.stringify({ mcpServers: { [name]: jsonSafeDef(def, spec.writesType ? "claude-json" : "other") } }, null, 2)}\n`;
  }
  const { type: _type, ...rest } = def;
  return `${tomlApply("", name, rest, dest.configPath, spec.headerKey).trim()}\n`;
}

function describeTargets(labels: string[]): string {
  if (labels.length <= 2) return labels.join(" and ");
  return `${labels[0]} and ${labels.length - 1} more`;
}

type Prepared = {
  ok: boolean;
  issues: string[];
  clash: { files: string[]; suggestion: string } | null;
  previews: Array<{ file: string; label: string; text: string }>;
  envToSet: Array<{ name: string; label: string }>;
  budget: string;
  notes: string[];
  commandLine: string;
  planHash: string;
  card: CatalogCard | null;
  definition: Record<string, unknown>;
  destinations: Destination[];
  projectFile: string;
};

async function prepare(input: InstallInput, paseo: PluginHandlerContext["paseo"] | null): Promise<Prepared> {
  const result: Prepared = {
    ok: false,
    issues: [],
    clash: null,
    previews: [],
    envToSet: [],
    budget: "",
    notes: [],
    commandLine: "",
    planHash: "",
    card: null,
    definition: {},
    destinations: [],
    projectFile: "",
  };
  const card = resolveCard(input.key);
  if (!card) {
    result.issues.push("That entry is no longer listed. Search again and pick it from the fresh list.");
    return result;
  }
  result.card = card;
  if (!card.installable) result.issues.push(card.blockedReason);
  // Re-check on the host: a card is only as good as the rules it passed.
  if (card.shelf !== "registry") result.issues.push(...validateEntry(card.entry, originOf(card)));
  const name = input.name.trim();
  if (!SERVER_NAME.test(name)) result.issues.push("The name must be letters, numbers, hyphens and underscores (up to 64).");

  const plan = planInstall(card.entry, input.scope, input.values ?? {}, originOf(card));
  result.issues.push(...plan.issues);
  result.definition = plan.definition;
  result.envToSet = plan.envToSet;
  if (card.entry.auth === "oauth") result.notes.push("After adding, sign in with Connect OAuth.");
  if (card.entry.auth === "unknown") result.notes.push("If it asks you to sign in after adding, use Connect OAuth on its card.");
  if (card.warning) result.notes.push(card.warning);

  if (input.scope === "user") {
    const destinations = await buildDestinations(paseo);
    const chosen = (input.targets ?? []).map((id) => destinations.find((dest) => dest.id === id)).filter((dest): dest is Destination => Boolean(dest));
    if (chosen.length === 0) result.issues.push("Pick at least one editor.");
    result.destinations = chosen;
    const taken = new Set<string>();
    const clashFiles: string[] = [];
    let heaviest = 0;
    for (const dest of chosen) {
      const names = destNames(dest);
      names.forEach((entry) => taken.add(entry));
      heaviest = Math.max(heaviest, names.length);
      if (SERVER_NAME.test(name) && destReadOne(dest, name)) clashFiles.push(dest.label);
      result.previews.push({ file: dest.configPath, label: dest.label, text: previewFor(dest, name, plan.masked) });
    }
    if (clashFiles.length > 0) result.clash = { files: clashFiles, suggestion: nameClash(name, taken).suggestion };
    if (chosen.length > 0) result.budget = budgetImpact("user", heaviest + 1, describeTargets(chosen.map((dest) => dest.label)));
  } else {
    const projects = await discoverProjects(paseo);
    const project = projects.find((candidate) => candidate.path === input.projectPath);
    if (!project) {
      result.issues.push("Pick one of the registered projects.");
    } else {
      const file = join(project.path, ".mcp.json");
      result.projectFile = file;
      const existing = existsSync(file) ? readJson(file) : {};
      if (existing === null) result.issues.push(`${file} exists but is not valid JSON; fix it first, nothing will overwrite it.`);
      const servers = (existing?.mcpServers as Record<string, unknown> | undefined) ?? {};
      if (SERVER_NAME.test(name) && name in servers) result.clash = { files: [file], suggestion: nameClash(name, Object.keys(servers)).suggestion };
      result.previews.push({ file, label: `${project.name} · .mcp.json`, text: `${JSON.stringify({ mcpServers: { [name]: plan.masked } }, null, 2)}\n` });
      const destinations = await buildDestinations(paseo);
      const userLevel = Math.max(0, ...destinations.filter((dest) => dest.providerId).map((dest) => destNames(dest).length));
      result.budget = budgetImpact("project", Object.keys(servers).length + 1 + userLevel, `${project.name}'s .mcp.json`);
      result.notes.push(".mcp.json is usually in git: the change shows in git status, and everyone who pulls it gets this server.");
      for (const { name: variable } of plan.envToSet) {
        // Name only, never the value: the daemon already holds it, and Claude Code started from here would send it.
        if (process.env[variable] !== undefined) result.notes.push(`${variable} is already set on this host: this server would receive that value.`);
      }
      if (plan.envToSet.length > 0) {
        result.notes.push(
          `The key is not written into the file. It says \${${plan.envToSet[0]?.name}} instead, which Claude Code fills in from its environment when it loads the file. Set ${plan.envToSet.map((entry) => entry.name).join(", ")} where Claude Code starts: for Paseo agents, the daemon's environment or the provider's env in Paseo's settings.`,
        );
        result.notes.push("Codex does not read .mcp.json; Add project servers to agents passes the file on as written (no ${…} expansion) and skips servers with credentials unless told otherwise.");
      }
      result.notes.push("Claude Code asks once before it uses a new project server; approve it at launch or in the workspace's MCP connections tab.");
    }
  }
  if (typeof plan.masked.command === "string") result.commandLine = commandLine(plan.masked.command, Array.isArray(plan.masked.args) ? (plan.masked.args as string[]) : []);
  result.planHash = planHash({ entry: card.entry, scope: input.scope, targets: input.targets ?? [], projectPath: input.projectPath ?? "", name, previews: result.previews });
  result.issues = [...new Set(result.issues.filter(Boolean))];
  result.ok = result.issues.length === 0 && result.clash === null;
  return result;
}

export async function handleMcpCatalogPlan(input: InstallInput, { paseo }: PluginHandlerContext) {
  const prepared = await prepare(input, paseo);
  return {
    ok: prepared.ok,
    issues: prepared.issues,
    clash: prepared.clash,
    previews: prepared.previews,
    envToSet: prepared.envToSet,
    budget: prepared.budget,
    notes: prepared.notes,
    commandLine: prepared.commandLine,
    planHash: prepared.planHash,
  };
}

/**
 * Add one server to a registered project's `.mcp.json`, never replacing one of
 * the same name, through the same writer as removeFromProjectFile (backup,
 * atomic write, read back and compare; a new file is created 0644).
 */
export function addToProjectFile(path: string, name: string, definition: Record<string, unknown>): void {
  editProjectFile(path, {
    create: true,
    change: (servers) => {
      if (name in servers) throw new Error(`already defines '${name}'`);
      servers[name] = definition;
      return true;
    },
    check: (servers) => (JSON.stringify(servers[name]) === JSON.stringify(definition) ? "" : "written file does not hold the server as planned"),
  });
}

function sameServer(read: McpDef | null, planned: Record<string, unknown>): boolean {
  if (!read) return false;
  if (typeof planned.url === "string") return read.url === planned.url;
  return read.command === planned.command;
}

async function healthOf(definition: Record<string, unknown>, scope: InstallScope): Promise<{ status: string; note: string } | null> {
  if (typeof definition.url === "string") {
    // Project scope holds ${VAR} references the host cannot expand for Claude,
    // so the probe goes without them and an OAuth-style 401 is the expected answer.
    const headers = scope === "user" ? (definition.headers as Record<string, string> | undefined) : undefined;
    return probeMcp(definition.url, headers, { fetch: (url, init) => catalogFetch(url, init) });
  }
  if (typeof definition.command === "string") {
    return binaryOnPath(definition.command)
      ? { status: "ok", note: `${definition.command} is on this host's PATH; the server starts when an agent does.` }
      : { status: "binary-missing", note: `${definition.command} is not on this host's PATH.` };
  }
  return null;
}

export const PLAN_CHANGED = "The server's details changed since you reviewed them; review again.";

export async function handleMcpCatalogInstall(input: InstallInput, context: PluginHandlerContext) {
  const prepared = await prepare(input, context.paseo);
  const base = { written: [] as string[], skipped: [] as string[], health: null, oauth: false, envToSet: prepared.envToSet, budget: prepared.budget };
  if (prepared.clash) {
    return {
      ...base,
      ok: false,
      message: `A server called '${input.name.trim()}' is already in ${prepared.clash.files.join(", ")}. Nothing was written. Use '${prepared.clash.suggestion}' instead, or skip it.`,
    };
  }
  if (!prepared.ok || !prepared.card) return { ...base, ok: false, message: prepared.issues[0] ?? "Refused." };
  if (input.planHash !== prepared.planHash) return { ...base, ok: false, message: PLAN_CHANGED };
  const name = input.name.trim();
  const written: string[] = [];
  const skipped: string[] = [];

  if (input.scope === "user") {
    const json = JSON.stringify(prepared.definition);
    const result = await handleMcpImportApply(
      { servers: [{ name, json }], targets: prepared.destinations.map((dest) => dest.id), overwrite: false, allowPlaceholders: json.includes("${") },
      context,
    );
    if (result.issues.length > 0) return { ...base, ok: false, message: result.issues[0]?.message ?? result.message };
    skipped.push(...(result.skipped as string[]));
    for (const dest of prepared.destinations) {
      if (!(result.written as string[]).includes(dest.label)) continue;
      if (sameServer(destReadOne(dest, name), prepared.definition)) written.push(dest.label);
      else skipped.push(`${dest.label}: written, but it did not read back as planned; open the server to check it`);
    }
  } else {
    try {
      addToProjectFile(prepared.projectFile, name, prepared.definition);
      written.push(prepared.projectFile);
    } catch (error) {
      skipped.push(`${prepared.projectFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (written.length === 0) return { ...base, ok: false, written, skipped, message: ["Nothing was written.", ...skipped].join("\n") };
  const health = await healthOf(prepared.definition, input.scope).catch(() => null);
  return {
    ...base,
    ok: true,
    written,
    skipped,
    health,
    oauth: prepared.card.entry.auth === "oauth",
    message: `Added '${name}' to ${written.length === 1 ? written[0] : `${written.length} places`} (backups saved).`,
  };
}

// ------------------------------------------------------------ copy as entry

export async function handleMcpCatalogEntry({ name }: { name: string }, { paseo }: PluginHandlerContext) {
  const destinations = await buildDestinations(paseo);
  let def = findDef(destinations, name);
  if (!def) {
    for (const project of await discoverProjects(paseo)) {
      const found = jsonMcpRead(join(project.path, ".mcp.json"))[name];
      if (found) {
        def = found;
        break;
      }
    }
  }
  if (!def) return { ok: false, json: "", message: `No definition of '${name}' was found.` };
  const today = new Date().toISOString().slice(0, 10);
  const entry = entryFromDefinition(name, def, { today, oauth: Boolean(def.url) && !(def.headers && Object.keys(def.headers).length) });
  if (!entry) return { ok: false, json: "", message: `The address of '${name}' could not be read, so nothing was copied.` };
  const issues = validateEntry(entry, "team");
  const json = `${JSON.stringify(entry, null, 2)}\n`;
  const notes = [
    "No stored value is in this text: every header, env and query value is a {PLACEHOLDER}.",
    ...(entry.auth === "oauth" ? ["auth says oauth because no key is stored; set it to none if the server needs no sign-in."] : []),
    ...(issues.length > 0 ? [`Fix before sharing: ${issues[0]}.`] : []),
    "Add a description, a category and a docs link, then paste it into your team file.",
  ];
  return { ok: true, json, message: notes.join(" ") };
}

// ------------------------------------------------------- library header value

/**
 * Write-only: set or clear a library's header value (the Team library's by
 * default, as in 0.12.0), or ask whether one is set. Never returns it;
 * `origin` (not secret) says which site it goes to. A value is set for the
 * origin of the library address saved at that moment.
 */
export async function handleMcpCatalogTeamAuth({ action = "status", value = "", library = TEAM_LIBRARY_ID }: { action?: "status" | "set" | "clear"; value?: string; library?: string }) {
  const settings = readCatalogSettings();
  unbindMovedKeys(settings.libraries);
  if (action === "set" || action === "clear") {
    const source = settings.libraries.find((candidate) => candidate.id === library)?.source ?? "";
    const origin = teamOrigin(source);
    if (action === "set" && !origin) {
      throw new Error(
        library === TEAM_LIBRARY_ID
          ? "Save an https team address first: the key is only ever sent to that address's site."
          : "Save an https address for this library first: the key is only ever sent to that address's site.",
      );
    }
    const result = writeLibraryHeaderValue(library, action === "set" ? value.trim() : null, undefined, origin);
    keyNotes.delete(library);
    forgetDocument(library); // the next read fetches with the new header
    return result;
  }
  const auth = readLibraryAuth(library);
  return auth ? { set: true, origin: auth.origin } : { set: false, origin: "" };
}
