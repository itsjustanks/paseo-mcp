import { z } from "zod";
import {
  CATALOG_CATEGORIES,
  CatalogEntrySchema,
  TEAM_MAX_BYTES,
  TEAM_MAX_ENTRIES,
  cleanEntryText,
  cleanText,
  cutText,
  httpsImage,
  idFromRegistryName,
  inputIdFrom,
  jsonErrorLine,
  linkOrEmpty,
  looksLikeCredentialValue,
  namespaceDomain,
  normaliseUrl,
  parseTeamCatalogue,
  placeholdersIn,
  SERVER_NAME,
  titleFromId,
  validateEntry,
  withCredentialSecrets,
  type CatalogCard,
  type CatalogEntry,
  type CatalogInput,
} from "./catalog";
import { TEAM_LIBRARY_ID, libraryTrustRank } from "./library-source";

/**
 * Libraries (0.13.0), the pure part: a library document read into catalogue
 * entries, cards built from them, and every library's cards merged into one
 * gallery. The host fetches (server/library.ts); nothing here does I/O.
 *
 * A library is untrusted text. Each server in it becomes a catalogue entry
 * and passes the same rules a team catalogue entry does (validateEntry with
 * origin "team": https only, no literal key, no `${…}`, exact package
 * versions, no runtime variables); one that fails is refused by name with the
 * reason, the rest still show. Values are `{PLACEHOLDER}` inputs the user
 * fills in at install time, secret unless their name is on the short public
 * list. Nothing in a library is ever a stored value.
 */

/** Where a library keeps its curation for a server: `_meta["io.github.itsjustanks/mcp-gallery"]`. */
export const GALLERY_META = "io.github.itsjustanks/mcp-gallery";

export const LIBRARY_MAX_BYTES = TEAM_MAX_BYTES;
export const LIBRARY_MAX_SERVERS = TEAM_MAX_ENTRIES;
const INPUTS_MAX = 16;

// ------------------------------------------------------------------ readers

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Shown text from a library: cleaned (cleanText) and cut to its cap. */
function shown(value: unknown, max: number): string {
  return cutText(cleanText(str(value)).trim(), max);
}

/**
 * The curation a library adds to a server. Every field is optional and read
 * on its own: one that does not fit is ignored, never the whole server.
 */
export const GalleryMetaSchema = z.object({
  id: z.string().regex(SERVER_NAME).optional().catch(undefined),
  displayName: z.string().max(400).optional().catch(undefined),
  category: z.string().max(40).optional().catch(undefined),
  iconUrl: z.string().max(2048).optional().catch(undefined),
  auth: z.enum(["oauth", "token", "none"]).optional().catch(undefined),
  docsUrl: z.string().max(2048).optional().catch(undefined),
  verifiedAt: z.string().max(40).optional().catch(undefined),
  publisher: z.string().max(400).optional().catch(undefined),
});
export type GalleryMeta = z.output<typeof GalleryMetaSchema>;

export function galleryMeta(meta: unknown): GalleryMeta {
  const raw = obj(obj(meta)?.[GALLERY_META]);
  if (!raw) return {};
  const parsed = GalleryMetaSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/**
 * A library's category as one of the plugin's (CATALOG_CATEGORIES). The
 * gallery's schema uses the plugin's names; the words it used before (and
 * other libraries use) map to the closest one. Anything else is `other`.
 */
const CATEGORY_ALIASES: Record<string, string> = {
  database: "data",
  databases: "data",
  documentation: "docs",
  observability: "developer",
  monitoring: "developer",
  ai: "developer",
  websites: "design",
  website: "design",
};

export function categoryOf(raw: string | undefined): string {
  const word = (raw ?? "").trim().toLowerCase();
  const category = CATEGORY_ALIASES[word] ?? word;
  return (CATALOG_CATEGORIES as readonly string[]).includes(category) ? category : "other";
}

/** What a field is called when it does not fit the card schema. */
const FIELD_WORDS: Record<string, string> = {
  url: "address",
  command: "command",
  args: "arguments",
  env: "environment variables",
  headers: "headers",
  inputs: "values to fill in",
  name: "name",
  publisher: "publisher",
  description: "description",
  docs: "docs address",
  iconUrl: "icon address",
  id: "id",
  category: "category",
  verifiedAt: "checked date",
};

/**
 * Why an entry does not fit the card schema, in words: "address too long",
 * "too many arguments", "an argument is too long". From the first schema
 * issue; its path may start at the card (`entry.url`) or at the entry.
 */
export function schemaReason(issue: { path: readonly PropertyKey[]; code?: string } | undefined): string {
  if (!issue) return "does not fit the card";
  const path = issue.path.map(String);
  const [field = "", index] = path[0] === "entry" ? path.slice(1) : path;
  const tooBig = issue.code === "too_big";
  const words = FIELD_WORDS[field] ?? (field || "entry");
  if (field === "args" || field === "inputs") {
    if (index === undefined) return tooBig ? `too many ${words}` : `the ${words} are not a list`;
    return field === "args" ? (tooBig ? "an argument is too long" : "an argument is not text") : "a value to fill in does not fit";
  }
  if (field === "headers" || field === "env") return `${field === "env" ? "an environment variable" : "a header"} is not text`;
  return tooBig ? `${words} too long` : `${words} is not valid`;
}

/** Why an entry would be dropped by the card schema, "" when it fits. */
export function entryProblem(entry: CatalogEntry): string {
  const parsed = CatalogEntrySchema.safeParse(entry);
  return parsed.success ? "" : schemaReason(parsed.error.issues[0]);
}

// ------------------------------------------------------------------ inputs

/**
 * The `{PLACEHOLDER}` inputs of one entry. A placeholder is secret unless
 * what describes it says `isSecret: false` and its default does not read
 * like a key; withCredentialSecrets then makes secret anything whose name or
 * position is not on the public list, so `isSecret: false` alone never makes
 * a key public.
 */
class Inputs {
  readonly list: CatalogInput[] = [];

  add(id: string, spec: Json | null, fallback: Json | null) {
    if (this.list.some((input) => input.id === id)) return;
    const pick = (key: string) => (spec && key in spec ? spec[key] : fallback?.[key]);
    this.list.push({
      id,
      label: shown(pick("description"), 80) || id,
      secret: pick("isSecret") !== false || looksLikeCredentialValue(str(pick("default"))),
      required: pick("isRequired") === true,
      hint: undefined,
    });
  }
}

/**
 * One server.json input (a header, an env line, an argument) as a template.
 * With a `value`, its `{name}` placeholders are the inputs, described by the
 * input's `variables`; without one, the whole value is one input named after
 * `name`.
 */
function template(input: Json, name: string, inputs: Inputs): string {
  const value = str(input.value);
  if (value) {
    const variables = obj(input.variables);
    for (const id of placeholdersIn(value)) inputs.add(id, obj(variables?.[id]), input);
    return value;
  }
  const id = inputIdFrom(name).toUpperCase();
  inputs.add(id, null, input);
  return `{${id}}`;
}

function keyValues(items: unknown, inputs: Inputs): Record<string, string> {
  const record: Record<string, string> = {};
  for (const raw of list(items)) {
    const item = obj(raw);
    const name = str(item?.name);
    if (item && name) record[name] = template(item, name, inputs);
  }
  return record;
}

/**
 * server.json arguments as command-line words: a positional one is its value
 * (or an input when it has none and is required), a named one `--flag=value`
 * (or `--flag={INPUT}` when required). Optional ones without a value are left
 * out. `problem` when one can't be read.
 */
function argumentWords(items: unknown, inputs: Inputs): { words: string[]; problem: string } {
  const words: string[] = [];
  for (const raw of list(items)) {
    const item = obj(raw);
    if (!item) continue;
    const type = str(item.type);
    const given = str(item.value) !== "";
    const required = item.isRequired === true;
    if (type === "positional") {
      if (given || required) words.push(template(item, str(item.valueHint) || "ARG", inputs));
    } else if (type === "named") {
      const flag = str(item.name);
      if (!/^--?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(flag)) return { words, problem: `the argument '${cutText(cleanText(flag), 40)}' is not a flag` };
      if (given || required) words.push(`${flag}=${template(item, flag.replace(/^-+/, ""), inputs)}`);
    } else {
      return { words, problem: "an argument is neither positional nor named" };
    }
  }
  return { words, problem: "" };
}

// ---------------------------------------------------------------- servers

export type LibraryItem = {
  entry: CatalogEntry;
  /** The server's registry name (`com.notion/mcp`), or the entry id for a 0.12.0 team entry: what libraries are merged on. */
  name: string;
  version?: string;
  /** Why it is shown but not added in one click; "" when it can be. */
  blockedReason: string;
};

export type LibraryParse = {
  items: LibraryItem[];
  refused: Array<{ id: string; reason: string }>;
  /** A problem with the document as a whole; items is empty when set. */
  error: string;
};

/** Why a server that only ships a package the plugin can't start is shown but not added. */
export const LIBRARY_PACKAGE_REASON = "Only npm and PyPI packages that run over stdio are added in one click; see its docs and add it by hand.";

const REGISTRY_NAME = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;

/**
 * The entry id for a registry name without a curated one: its last part, or
 * the publisher's name when that part says nothing (`com.acme/mcp` → `acme`,
 * `io.github.jane/server` → `jane`).
 */
export function idForRegistryName(name: string): string {
  const last = idFromRegistryName(name);
  if (!/^(mcp|server|mcp-server|remote|sse|api)$/i.test(last)) return last;
  const namespace = name.split("/")[0] ?? "";
  const owner = namespace.startsWith("io.github.") ? namespace.slice("io.github.".length) : (namespaceDomain(namespace).split(".")[0] ?? "");
  const id = owner.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return SERVER_NAME.test(id) ? id : last;
}

function publisherOf(name: string): string {
  const namespace = name.split("/")[0] ?? "";
  return namespace.startsWith("io.github.") ? `github.com/${namespace.slice("io.github.".length)}` : namespaceDomain(namespace);
}

function iconOf(server: Json, meta: GalleryMeta): string | undefined {
  const candidates = [meta.iconUrl, ...list(server.icons).map((icon) => str(obj(icon)?.src))];
  // An icon is decoration: one that does not fit is skipped, never the server.
  return candidates.find((link): link is string => typeof link === "string" && link !== "" && link.length <= 2048 && httpsImage(link));
}

/** The entry's auth from the library's word for it, kept only where the entry backs it up. */
function authOf(meta: GalleryMeta, transport: "http" | "stdio", headers: Record<string, string>, env: Record<string, string>): CatalogEntry["auth"] {
  if (meta.auth === "oauth" && transport === "http") return "oauth";
  if (meta.auth === "none") return "none";
  if (transport === "http") return Object.keys(headers).length > 0 ? "header" : "unknown";
  return Object.keys(env).length > 0 ? "env" : "none";
}

/**
 * One server.json (with its list item's `_meta`) as a catalogue entry. A
 * remote is preferred (streamable HTTP, then SSE); otherwise an npm or PyPI
 * package that runs over stdio, at its exact version (`npx name@1.2.3`,
 * `uvx name==1.2.3`). Anything else is shown, not installable, with
 * LIBRARY_PACKAGE_REASON. Returns the reason instead when the server breaks a
 * rule.
 */
export function libraryItem(server: Json, meta: unknown): LibraryItem | { refused: string } {
  const name = str(server.name);
  if (!REGISTRY_NAME.test(name) || name.length > 200) return { refused: "name is not a registry name (namespace/name)" };
  const curation = galleryMeta(meta);
  const id = curation.id ?? idForRegistryName(name);
  const category = categoryOf(curation.category);
  const icon = iconOf(server, curation);
  const base = {
    id,
    name: shown(curation.displayName, 80) || shown(server.title, 80) || titleFromId(id),
    publisher: shown(curation.publisher, 120) || shown(publisherOf(name), 120),
    description: shown(server.description, 400),
    category,
    docs: linkOrEmpty(curation.docsUrl) || linkOrEmpty(str(server.websiteUrl)) || linkOrEmpty(str(obj(server.repository)?.url)),
    verifiedAt: /^\d{4}-\d{2}-\d{2}/.test(curation.verifiedAt ?? "") ? (curation.verifiedAt ?? "").slice(0, 10) : "",
    ...(icon ? { iconUrl: icon } : {}),
  };
  const inputs = new Inputs();
  const remotes = list(server.remotes).map(obj).filter((remote): remote is Json => remote !== null && (remote.type === "streamable-http" || remote.type === "sse"));
  const remote = remotes.find((entry) => entry.type === "streamable-http") ?? remotes[0];
  let entry: CatalogEntry;
  let blockedReason = "";

  if (remote) {
    const url = str(remote.url);
    const variables = obj(remote.variables);
    for (const placeholder of placeholdersIn(url)) inputs.add(placeholder, obj(variables?.[placeholder]), null);
    const headers = keyValues(remote.headers, inputs);
    entry = { ...base, transport: "http", url, ...(Object.keys(headers).length ? { headers } : {}), auth: authOf(curation, "http", headers, {}) };
  } else {
    const packages = list(server.packages).map(obj).filter((item): item is Json => item !== null);
    const runnable = packages.find((item) => (item.registryType === "npm" || item.registryType === "pypi") && (str(obj(item.transport)?.type) || "stdio") === "stdio");
    if (!runnable) {
      entry = { ...base, transport: "stdio", auth: "none" };
      blockedReason = packages.length === 0 ? "It lists no remote address and no package." : LIBRARY_PACKAGE_REASON;
    } else {
      const npm = runnable.registryType === "npm";
      const identifier = str(runnable.identifier);
      const version = str(runnable.version);
      const runtime = argumentWords(runnable.runtimeArguments, inputs);
      const program = argumentWords(runnable.packageArguments, inputs);
      const problem = runtime.problem || program.problem;
      if (problem) return { refused: problem };
      const env = keyValues(runnable.environmentVariables, inputs);
      entry = {
        ...base,
        transport: "stdio",
        command: npm ? "npx" : "uvx",
        args: [...runtime.words, npm ? `${identifier}@${version}` : `${identifier}==${version}`, ...program.words],
        ...(Object.keys(env).length ? { env } : {}),
        auth: authOf(curation, "stdio", {}, env),
      };
    }
  }
  if (inputs.list.length > INPUTS_MAX) return { refused: `it asks for ${inputs.list.length} values, more than the ${INPUTS_MAX} the plugin fills in` };
  if (inputs.list.length) entry.inputs = inputs.list;
  entry = withCredentialSecrets(entry, "team");
  // Checked here, not only before the answer goes out, so the library's row says why.
  const problem = entryProblem(entry);
  if (problem) return { refused: problem };
  if (!blockedReason) {
    const issues = validateEntry(entry, "team");
    if (issues.length > 0) return { refused: issues[0] ?? "invalid" };
  }
  const version = shown(server.version, 64);
  return { entry, name, blockedReason, ...(version ? { version } : {}) };
}

/**
 * A library document: the MCP Registry's list shape (`{ servers: [ { server,
 * _meta } ], metadata }`), or a 0.12.0 team catalogue (a list of entries, or
 * `{ entries }`), read with parseTeamCatalogue. A server name listed twice
 * keeps its first copy. A static document has no next page, so
 * `metadata.nextCursor` is not followed. Errors never quote the text (it may
 * be a mistyped path to a key file); ids and reasons are cleaned and cut.
 */
export function parseLibrary(text: string): LibraryParse {
  const empty = (error: string): LibraryParse => ({ items: [], refused: [], error });
  if (text.length > LIBRARY_MAX_BYTES) return empty(`the file is ${Math.round(text.length / 1024)} KB; a library should be well under 1 MB`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return empty(`not valid JSON (line ${jsonErrorLine(text)})`);
  }
  const document = obj(parsed);
  if (!document || !Array.isArray(document.servers)) {
    const team = parseTeamCatalogue(text);
    if (team.error) return empty('expected the MCP Registry\'s { "servers": [ … ] }, a list of entries, or { "entries": [ … ] }');
    return { items: team.entries.map((entry) => ({ entry: cleanEntryText(entry), name: entry.id, blockedReason: "" })), refused: team.refused, error: "" };
  }
  const items: LibraryItem[] = [];
  const refused: LibraryParse["refused"] = [];
  const seen = new Set<string>();
  const servers = document.servers as unknown[];
  for (const [index, raw] of servers.slice(0, LIBRARY_MAX_SERVERS).entries()) {
    const wrapper = obj(raw);
    const server = obj(wrapper?.server);
    const label = str(server?.name) || `#${index + 1}`;
    if (!server) {
      refused.push({ id: label, reason: "not a { server, _meta } item" });
      continue;
    }
    const result = libraryItem(server, wrapper?._meta);
    if ("refused" in result) {
      refused.push({ id: label, reason: result.refused });
      continue;
    }
    if (seen.has(result.name)) continue;
    seen.add(result.name);
    items.push(result);
  }
  if (servers.length > LIBRARY_MAX_SERVERS) refused.push({ id: `#${LIBRARY_MAX_SERVERS + 1}…`, reason: `only the first ${LIBRARY_MAX_SERVERS} servers are read` });
  return { items, refused: refused.map(({ id, reason }) => ({ id: cutText(cleanText(id), 80), reason: cutText(cleanText(reason), 300) })), error: "" };
}

/** A registry list page's `metadata.nextCursor`, "" when there is none (or it isn't text). */
export function nextCursorOf(body: unknown): string {
  const cursor = obj(obj(body)?.metadata)?.nextCursor;
  return typeof cursor === "string" && cursor.length <= 512 && !/[\u0000-\u001f]/.test(cursor) ? cursor : "";
}

// ------------------------------------------------------------------- cards

export type LibraryRef = { id: string; name: string; label: string };

/** What the install RPCs take for a library's server: `team:<name>` for the Team library (as in 0.12.0), `library:<id>:<name>` otherwise. */
export function libraryCardKey(libraryId: string, name: string): string {
  return libraryId === TEAM_LIBRARY_ID ? `team:${name}` : `library:${libraryId}:${name}`;
}

/**
 * A library's server as a card: Team for the Team library, as in 0.12.0,
 * Library for any other. Never Official: a library's copy of a Recommended
 * server is shown as the Recommended card itself (mergeGallery), with the
 * shipped text and auth, and whoever can change a library can change the
 * rest. Shown text goes through cleanText whatever shape the library had.
 */
export function libraryCard(item: LibraryItem, library: LibraryRef): CatalogCard {
  const team = library.id === TEAM_LIBRARY_ID;
  const source = cleanText(library.label);
  return {
    key: libraryCardKey(library.id, item.name),
    shelf: team ? "team" : "library",
    entry: cleanEntryText(item.entry),
    trust: team ? "team" : "library",
    trustNote: team
      ? `From your team catalogue (${source}).`
      : `From the ${cleanText(library.name)} library (${source}); whoever can change that library can change this entry.`,
    warning: "",
    installable: item.blockedReason === "",
    blockedReason: item.blockedReason,
    ...(item.version ? { version: item.version } : {}),
    ...(item.name !== item.entry.id ? { registryName: cleanText(item.name) } : {}),
    library: { id: library.id, name: cleanText(library.name) },
  };
}

/** A remote address compared as written: scheme, host and port as URL reads them, the path without trailing slashes, query and fragment kept. */
function exactAddress(url: string | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url.trim());
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}${parsed.hash}`;
  } catch {
    return "";
  }
}

function sameRecord(a: Record<string, string> | undefined, b: Record<string, string> | undefined, foldNames: boolean): boolean {
  const flat = (record: Record<string, string> | undefined) =>
    Object.entries(record ?? {})
      .map(([name, value]) => [foldNames ? name.toLowerCase() : name, value] as const)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return JSON.stringify(flat(a)) === JSON.stringify(flat(b));
}

function sameInputs(a: CatalogInput[] | undefined, b: CatalogInput[] | undefined): boolean {
  const flat = (inputs: CatalogInput[] | undefined) =>
    (inputs ?? []).map((input) => [input.id, input.secret, input.required] as const).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return JSON.stringify(flat(a)) === JSON.stringify(flat(b));
}

/**
 * Whether two entries are the same server, down to what gets installed. A
 * remote: the same address (exactAddress), the same header names and
 * templates, the same values to fill in and the same auth. A package: the
 * same command and arguments word for word (so the same package at the same
 * version with the same flags), and the same environment variables. The one
 * test both for "a library's copy is the Recommended server" and for the
 * Official badge that copy then carries.
 */
export function sameServer(a: CatalogEntry, b: CatalogEntry): boolean {
  if (a.transport !== b.transport || a.auth !== b.auth || !sameInputs(a.inputs, b.inputs)) return false;
  if (a.transport === "http") {
    const address = exactAddress(a.url);
    return address !== "" && address === exactAddress(b.url) && sameRecord(a.headers, b.headers, true);
  }
  return (
    (a.command ?? "") !== "" &&
    a.command === b.command &&
    JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []) &&
    sameRecord(a.env, b.env, false)
  );
}

/** What libraries are merged on: the server's registry name, or its entry id. */
function mergeName(card: CatalogCard): string {
  return (card.registryName ?? card.entry.id).toLowerCase();
}

/**
 * One gallery from the shipped Recommended list, every library's cards and
 * registry results:
 *   - Libraries are read in trust order (libraryTrustRank: Team, the user's
 *     own, then the default public ones; the given order within a class),
 *     and a server name is shown once: the most trusted library to list it
 *     wins.
 *   - A Recommended card is never hidden. A library card for exactly the
 *     same server (sameServer) is shown as that Recommended card, with the
 *     shipped text; anything less than exact is its own card beside it.
 *   - A registry result whose name or address is already shown is left out.
 */
export function mergeGallery(recommended: CatalogCard[], libraries: CatalogCard[][], registry: CatalogCard[] = []): CatalogCard[] {
  const names = new Set<string>();
  const rankOf = (cards: CatalogCard[]) => libraryTrustRank(cards[0]?.library?.id ?? (cards[0]?.shelf === "team" ? TEAM_LIBRARY_ID : ""));
  const ordered = libraries
    .map((cards, index) => ({ cards, index, rank: rankOf(cards) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  const fromLibraries: CatalogCard[] = [];
  for (const { cards } of ordered) {
    for (const card of cards) {
      const name = mergeName(card);
      if (names.has(name)) continue;
      names.add(name);
      if (recommended.some((shipped) => sameServer(shipped.entry, card.entry))) continue;
      fromLibraries.push(card);
    }
  }
  const shelved = new Set([...recommended, ...fromLibraries].map((card) => normaliseUrl(card.entry.url ?? "")).filter(Boolean));
  const fromRegistry: CatalogCard[] = [];
  for (const card of registry) {
    const name = mergeName(card);
    if (names.has(name) || (card.entry.url && shelved.has(normaliseUrl(card.entry.url)))) continue;
    names.add(name);
    fromRegistry.push(card);
  }
  return [...recommended, ...fromLibraries, ...fromRegistry];
}
