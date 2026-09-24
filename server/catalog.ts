import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { constants, existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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
  latestRegistryServers,
  nameClash,
  normaliseUrl,
  parseTeamCatalogue,
  planHash,
  planInstall,
  registryCard,
  registrySearchUrl,
  SECRETISH_NAME,
  SERVER_NAME,
  TEAM_MAX_BYTES,
  teamCard,
  validateEntry,
  type CatalogCard,
  type CatalogEntry,
  type AddedPlace,
  type CatalogSettings,
  type InstallScope,
} from "../shared/catalog";
import { CURATED_CATALOG } from "../shared/catalog-curated";
import type { Destination } from "../shared/contracts";
import { probeMcp } from "../shared/health";
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
import { handleMcpImportApply } from "./mcpjson";
import { readSettingsDocument } from "./settings";
import { readTeamAuth, teamOrigin, writeTeamHeaderValue } from "./team-auth";

/**
 * Add from catalogue, host side. Two things here talk to the network, the
 * registry search and a team catalogue at a URL, and neither ever runs while
 * an RPC waits: a read answers from memory and starts the fetch in the
 * background, and the panel reads again while the state says it is running.
 * Writes go through the writers every other add uses (backup, atomic write,
 * read-back); a project's `.mcp.json` goes through editProjectFile, the
 * writer removeFromProjectFile uses. Every read from the network or a file is
 * capped before it is held in memory.
 */

const TAG = "[paseo-mcp]";
export const REGISTRY_TTL_MS = 24 * 60 * 60_000;
export const REGISTRY_RETRY_MS = 60_000;
export const TEAM_TTL_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;
const REGISTRY_CACHE_MAX = 200;
export const REGISTRY_MAX_BYTES = 8 * 1024 * 1024;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init);

/** For tests: answer network calls from a fake. */
export function setCatalogFetch(next: FetchLike | null): void {
  fetchImpl = next ?? ((url, init) => globalThis.fetch(url, init));
}

function tooBig(maxBytes: number): Error {
  return new Error(`answered more than ${maxBytes / (1024 * 1024)} MB, more than a catalogue should be`);
}

/**
 * A response body as text, never more than `maxBytes`: a declared length over
 * the cap is refused unread, and the body is counted as it streams and
 * dropped the moment it passes the cap, so an endless answer costs one chunk.
 */
export async function readCappedBody(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooBig(maxBytes);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooBig(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A team file as text. Only a regular file under the cap is read: stat first
 * (a directory, a FIFO or /dev/zero is refused before it is opened), then
 * open without blocking and check the opened file again, in case the path
 * changed in between, and never read past the cap.
 */
export async function readCappedFile(path: string, maxBytes = TEAM_MAX_BYTES): Promise<string> {
  const refuse = (info: { isFile(): boolean; size: number }) => {
    if (!info.isFile()) throw new Error("not a regular file");
    if (info.size > maxBytes) throw new Error(`the file is ${Math.round(info.size / 1024)} KB; a catalogue should be well under 1 MB`);
  };
  refuse(await stat(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    refuse(await handle.stat());
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) throw new Error("the file is over 1 MB; a catalogue should be well under that");
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function fetchText(url: string, headers: Record<string, string>, maxBytes: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // No redirects: a header meant for the catalogue's host must not follow a hop elsewhere.
    const response = await fetchImpl(url, { headers: { accept: "application/json", ...headers }, signal: controller.signal, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) throw new Error(`answered with a redirect (HTTP ${response.status}); use the final address`);
    if (!response.ok) throw new Error(`answered HTTP ${response.status}`);
    return await readCappedBody(response, maxBytes);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`no answer in ${FETCH_TIMEOUT_MS / 1000} s`);
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

const knownOfficialUrls = new Map(
  CURATED_CATALOG.filter((entry) => entry.url).map((entry) => [normaliseUrl(entry.url ?? ""), entry.name] as const),
);

// ----------------------------------------------------------------- registry

type RegistrySearch = {
  cards: CatalogCard[];
  fetchedAt: number | null;
  failedAt: number | null;
  error: string;
  inFlight: Promise<void> | null;
};

const searches = new Map<string, RegistrySearch>();

function registryKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function startRegistrySearch(query: string, search: RegistrySearch): Promise<void> {
  if (search.inFlight) return search.inFlight;
  search.inFlight = (async () => {
    try {
      const text = await fetchText(registrySearchUrl(query), {}, REGISTRY_MAX_BYTES);
      const servers = latestRegistryServers(JSON.parse(text));
      // One answer the card builder chokes on is left out, not the whole search.
      search.cards = servers.flatMap((server) => {
        try {
          return [registryCard(server, knownOfficialUrls)];
        } catch (error) {
          console.warn(`${TAG} registry result left out: ${error instanceof Error ? error.message : String(error)}`);
          return [];
        }
      });
      search.fetchedAt = Date.now();
      search.failedAt = null;
      search.error = "";
    } catch (error) {
      search.failedAt = Date.now();
      search.error = error instanceof Error ? error.message : String(error);
      console.warn(`${TAG} registry search failed: ${search.error}`);
    } finally {
      search.inFlight = null;
    }
  })();
  return search.inFlight;
}

/** The cached answer for a query, starting a background search when there is none, it is a day old, or `force`. */
export function registryFor(query: string, force = false): RegistrySearch | null {
  const key = registryKey(query);
  if (key.length < 2) return null;
  let search = searches.get(key);
  if (!search) {
    if (searches.size >= REGISTRY_CACHE_MAX) {
      const oldest = [...searches.entries()].sort((a, b) => (a[1].fetchedAt ?? 0) - (b[1].fetchedAt ?? 0))[0];
      if (oldest) searches.delete(oldest[0]);
    }
    search = { cards: [], fetchedAt: null, failedAt: null, error: "", inFlight: null };
    searches.set(key, search);
  }
  const now = Date.now();
  const stale = search.fetchedAt === null || now - search.fetchedAt > REGISTRY_TTL_MS;
  const resting = search.failedAt !== null && now - search.failedAt < REGISTRY_RETRY_MS;
  if (force || (stale && !resting)) void startRegistrySearch(key, search);
  return search;
}

// --------------------------------------------------------------------- team

type TeamCache = {
  source: string;
  entries: CatalogEntry[];
  refused: Array<{ id: string; reason: string }>;
  fetchedAt: number | null;
  error: string;
  inFlight: Promise<void> | null;
};

let team: TeamCache = { source: "", entries: [], refused: [], fetchedAt: null, error: "", inFlight: null };

export const TEAM_KEY_MOVED = "The key was cleared because the team address moved to another site; set it again.";
/** Said in the team note from the moment a key is cleared for a moved address until a key is set or cleared by hand. */
let teamKeyNote = "";

/**
 * A stored key goes only to the origin it was set for. When the team address
 * now points at another site (or at a file), the key is deleted, not kept for
 * a move back: whoever moved the address may not be whoever set the key.
 */
function unbindMovedKey(source: string): void {
  const auth = readTeamAuth(); // first, so a value an older build kept in settings is moved even with no address
  if (!auth || !source.trim() || auth.origin === teamOrigin(source)) return;
  writeTeamHeaderValue(null);
  teamKeyNote = TEAM_KEY_MOVED;
}

export function readCatalogSettings(): CatalogSettings {
  return readSettingsDocument(catalogSettings, CATALOG_DEFAULTS);
}

/**
 * The team source as it may be shown: an address without its user name,
 * password, query or fragment (a `?token=` stays on the host); a path as is.
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

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/** Where the team file lives, as the user wrote it, or why it cannot be read. */
export function teamLocation(source: string): { kind: "url" | "file"; target: string } | { kind: "invalid"; reason: string } {
  const trimmed = source.trim();
  if (/^https:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.username || url.password) return { kind: "invalid", reason: "put credentials in the header setting, not in the address" };
      // The address is an ordinary setting every connected app can read; a key
      // in its query string would reach them all. The header setting is write-only.
      const keyed = [...url.searchParams.keys()].find((name) => SECRETISH_NAME.test(name) || /^(code|sig|sv|se|sp|x-amz-.*)$/i.test(name));
      if (keyed) return { kind: "invalid", reason: `take '${keyed}' out of the address and put the key in the team key field: the address is visible to every connected app, the key field is not` };
      return { kind: "url", target: url.toString() };
    } catch {
      return { kind: "invalid", reason: "not a valid address" };
    }
  }
  if (/^[a-z]+:\/\//i.test(trimmed)) return { kind: "invalid", reason: "only https addresses or file paths are read" };
  const path = expandHome(trimmed);
  if (!isAbsolute(path)) return { kind: "invalid", reason: "use an absolute path (or one starting with ~/)" };
  return { kind: "file", target: resolve(path) };
}

function startTeamFetch(settings: CatalogSettings): Promise<void> {
  if (team.inFlight && team.source === settings.teamSource) return team.inFlight;
  if (team.source !== settings.teamSource) team = { source: settings.teamSource, entries: [], refused: [], fetchedAt: null, error: "", inFlight: null };
  const current = team;
  current.inFlight = (async () => {
    try {
      const location = teamLocation(settings.teamSource);
      if (location.kind === "invalid") throw new Error(location.reason);
      const headers: Record<string, string> = {};
      const auth = location.kind === "url" && settings.teamHeaderName.trim() ? readTeamAuth() : null;
      // Checked again here, at the moment of sending: only to the origin the key was set for.
      if (auth?.value && auth.origin && new URL(location.target).origin === auth.origin) headers[settings.teamHeaderName.trim()] = auth.value;
      const text = location.kind === "url" ? await fetchText(location.target, headers, TEAM_MAX_BYTES) : await readCappedFile(location.target, TEAM_MAX_BYTES);
      const parsed = parseTeamCatalogue(text);
      if (parsed.error) throw new Error(parsed.error);
      current.entries = parsed.entries;
      current.refused = parsed.refused;
      current.fetchedAt = Date.now();
      current.error = "";
    } catch (error) {
      // Keep the last good list; say why the new read failed.
      current.error = error instanceof Error ? error.message : String(error);
      if (current.fetchedAt === null) current.fetchedAt = Date.now();
      console.warn(`${TAG} team catalogue: ${current.error}`);
    } finally {
      current.inFlight = null;
    }
  })();
  return current.inFlight;
}

export function teamFor(settings: CatalogSettings, force = false): TeamCache | null {
  if (!settings.teamSource.trim()) return null;
  if (team.source !== settings.teamSource) team = { source: settings.teamSource, entries: [], refused: [], fetchedAt: null, error: "", inFlight: null };
  const stale = team.fetchedAt === null || Date.now() - team.fetchedAt > TEAM_TTL_MS;
  if (force || stale) void startTeamFetch(settings);
  return team;
}

/** For tests: forget every cached search and team read. */
export function resetCatalogCaches(): void {
  searches.clear();
  team = { source: "", entries: [], refused: [], fetchedAt: null, error: "", inFlight: null };
  teamKeyNote = "";
}

/** For tests: wait for whatever is fetching now. */
export async function catalogSettled(): Promise<void> {
  await Promise.all([...[...searches.values()].map((search) => search.inFlight), team.inFlight].filter(Boolean));
}

// -------------------------------------------------------------------- read

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function shortSource(source: string): string {
  const location = teamLocation(source);
  if (location.kind === "url") {
    try {
      const url = new URL(location.target);
      return `${url.host}${url.pathname.length > 30 ? `…${url.pathname.slice(-24)}` : url.pathname}`;
    } catch {
      return redactSource(source);
    }
  }
  return source.length > 48 ? `…${source.slice(-44)}` : source;
}

/**
 * Every card checked against the schema the app parses the answer with, the
 * last step before it goes out: one card that fails would make the app refuse
 * the whole catalogue. A card that fails is left out and counted per shelf.
 */
export function cardsThatParse(cards: CatalogCard[]): { shown: CatalogCard[]; dropped: Record<CatalogCard["shelf"], number> } {
  const dropped = { recommended: 0, team: 0, registry: 0 };
  const shown = cards.filter((card) => {
    const ok = CatalogCardSchema.safeParse(card).success;
    if (!ok) {
      dropped[card.shelf] += 1;
      console.warn(`${TAG} catalogue card left out, it does not fit the schema: ${card.key.slice(0, 120)}`);
    }
    return ok;
  });
  return { shown, dropped };
}

export async function handleMcpCatalog(
  { query = "", refresh }: { query?: string; refresh?: "team" | "registry" | "both" },
  context?: PluginHandlerContext,
) {
  const settings = readCatalogSettings();
  unbindMovedKey(settings.teamSource);
  const teamCache = teamFor(settings, refresh === "team" || refresh === "both");
  const search = registryFor(query, refresh === "registry" || refresh === "both");

  const cards: CatalogCard[] = CURATED_CATALOG.map(curatedCard);
  const teamLabel = shortSource(settings.teamSource);
  for (const entry of teamCache?.entries ?? []) cards.push(teamCard(entry, teamLabel));
  // A registry result for an endpoint already on a shelf adds nothing but a second card.
  const shelved = new Set(cards.map((card) => normaliseUrl(card.entry.url ?? "")).filter(Boolean));
  for (const card of search?.cards ?? []) {
    if (card.entry.url && shelved.has(normaliseUrl(card.entry.url))) continue;
    cards.push(card);
  }

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
  const { shown, dropped } = cardsThatParse(cards);

  return {
    cards: shown,
    team: {
      source: redactSource(settings.teamSource),
      state: !teamCache ? ("off" as const) : teamCache.inFlight && teamCache.entries.length === 0 && !teamCache.error ? ("loading" as const) : teamCache.error ? ("error" as const) : teamCache.inFlight ? ("loading" as const) : ("ready" as const),
      count: teamCache?.entries.length ?? 0,
      refused: teamCache?.refused ?? [],
      fetchedAt: iso(teamCache?.fetchedAt ?? null),
      note: [
        teamKeyNote,
        teamCache?.error ? `Could not read the team catalogue: ${teamCache.error}.${teamCache.entries.length ? " Showing the last good copy." : ""}` : "",
        dropped.team > 0 ? `${dropped.team} team entr${dropped.team === 1 ? "y" : "ies"} couldn't be shown.` : "",
      ]
        .filter(Boolean)
        .join(" "),
    },
    registry: {
      query: query.trim(),
      state: !search ? ("idle" as const) : search.inFlight ? ("searching" as const) : search.error && search.fetchedAt === null ? ("error" as const) : ("ready" as const),
      fetchedAt: iso(search?.fetchedAt ?? null),
      note: [
        search?.error ? `The registry search failed: ${search.error}.${search.fetchedAt ? " Showing the last answer." : ""}` : "",
        dropped.registry > 0 ? `${dropped.registry} registry result${dropped.registry === 1 ? "" : "s"} couldn't be shown.` : "",
      ]
        .filter(Boolean)
        .join(" "),
      count: (search?.cards.length ?? 0) - dropped.registry,
    },
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

function resolveCard(key: string): CatalogCard | null {
  const [shelf, ...rest] = key.split(":");
  const id = rest.join(":");
  if (shelf === "recommended") {
    const entry = CURATED_CATALOG.find((candidate) => candidate.id === id);
    return entry ? curatedCard(entry) : null;
  }
  if (shelf === "team") {
    const entry = team.entries.find((candidate) => candidate.id === id);
    return entry ? teamCard(entry, shortSource(team.source)) : null;
  }
  if (shelf === "registry") {
    for (const search of searches.values()) {
      const card = search.cards.find((candidate) => candidate.key === key);
      if (card) return card;
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
  if (card.shelf !== "registry") result.issues.push(...validateEntry(card.entry, card.shelf === "recommended" ? "curated" : "team"));
  const name = input.name.trim();
  if (!SERVER_NAME.test(name)) result.issues.push("The name must be letters, numbers, hyphens and underscores (up to 64).");

  const plan = planInstall(card.entry, input.scope, input.values ?? {}, card.shelf === "recommended" ? "curated" : card.shelf);
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
    return probeMcp(definition.url, headers, { fetch: (url, init) => fetchImpl(url, init) });
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

// ---------------------------------------------------------- team header value

/**
 * Write-only: set or clear the team catalogue's header value, or ask whether
 * one is set. Never returns it; `origin` (not secret) says which site it goes
 * to. A value is set for the origin of the team address saved at that moment.
 */
export async function handleMcpCatalogTeamAuth({ action = "status", value = "" }: { action?: "status" | "set" | "clear"; value?: string }) {
  if (action === "set" || action === "clear") {
    const settings = readCatalogSettings();
    unbindMovedKey(settings.teamSource);
    const origin = teamOrigin(settings.teamSource);
    if (action === "set" && !origin) throw new Error("Save an https team address first: the key is only ever sent to that address's site.");
    const result = writeTeamHeaderValue(action === "set" ? value.trim() : null, undefined, origin);
    teamKeyNote = "";
    team.fetchedAt = null; // the next read fetches with the new header
    return result;
  }
  const settings = readCatalogSettings();
  unbindMovedKey(settings.teamSource);
  const auth = readTeamAuth();
  return auth ? { set: true, origin: auth.origin } : { set: false, origin: "" };
}
