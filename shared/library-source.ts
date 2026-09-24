import { z } from "zod";

/**
 * Libraries (0.13.0): catalogues of MCP servers the gallery subscribes to, by
 * address or by file. This file holds what the settings document stores and
 * how a library's address is read; it imports nothing from the catalogue so
 * the settings definition can use it without a cycle.
 *
 * A library is one of:
 *   - a JSON file at an address, in the official MCP Registry's list shape
 *     (`{ "servers": [ { "server": …, "_meta": … } ], "metadata": … }`) or the
 *     0.12.0 team catalogue shape (a list of entries);
 *   - a registry: any address that does not end in `.json`, searched through
 *     `GET {base}/v0.1/servers?search=…`, like the official MCP Registry;
 *   - a file on the host (an absolute path or one starting with `~/`), for a
 *     private library that must not be hosted.
 */

export const DEFAULT_LIBRARY_URL = "https://raw.githubusercontent.com/itsjustanks/mcp-gallery/main/v0.1/servers.json";
export const OFFICIAL_REGISTRY_URL = "https://registry.modelcontextprotocol.io";

/** The library the 0.12.0 team catalogue setting becomes. Its cards keep the Team badge and `team:` keys. */
export const TEAM_LIBRARY_ID = "team";
export const GALLERY_LIBRARY_ID = "mcp-gallery";
export const REGISTRY_LIBRARY_ID = "mcp-registry";

export const LIBRARY_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** An HTTP header name, without `.` (see validateEntry's header rule). */
export const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+^_`|~-]{1,64}$/;
export const LIBRARIES_MAX = 20;

/** How an address is read: `auto` by its path (`.json` is a document, anything else a registry). A file is always a document. */
export const LIBRARY_FORMATS = ["auto", "json", "registry"] as const;
export type LibraryFormat = (typeof LIBRARY_FORMATS)[number];

export const LibrarySourceSchema = z.object({
  id: z.string().regex(LIBRARY_ID),
  name: z.string().min(1).max(60),
  source: z.string().max(2048),
  format: z.enum(LIBRARY_FORMATS).default("auto"),
  enabled: z.boolean().default(true),
  /** Optional header for a private address; its value is write-only, kept by the host (server/team-auth.ts). */
  headerName: z.string().max(64).default(""),
});
export type LibrarySource = z.output<typeof LibrarySourceSchema>;

export const DEFAULT_LIBRARIES: LibrarySource[] = [
  { id: GALLERY_LIBRARY_ID, name: "MCP Gallery", source: DEFAULT_LIBRARY_URL, format: "json", enabled: true, headerName: "" },
  { id: REGISTRY_LIBRARY_ID, name: "MCP Registry", source: OFFICIAL_REGISTRY_URL, format: "registry", enabled: false, headerName: "" },
];

/** What makes a list of libraries unsavable: a duplicate id, or a header name that isn't one. "" when fine. */
export function librariesProblem(libraries: LibrarySource[]): string {
  const seen = new Set<string>();
  for (const library of libraries) {
    if (seen.has(library.id)) return `two libraries use the id '${library.id}'`;
    seen.add(library.id);
    if (library.headerName && !HEADER_NAME.test(library.headerName)) return `'${library.headerName}' is not a header name`;
  }
  return "";
}

export const LibrariesSchema = z
  .array(LibrarySourceSchema)
  .max(LIBRARIES_MAX)
  .superRefine((libraries, context) => {
    const problem = librariesProblem(libraries);
    if (problem) context.addIssue({ code: "custom", message: problem });
  });

/**
 * How far a library is trusted when two list the same server name: the Team
 * library (0), then the user's own libraries (1), then the default public
 * ones (2). Recommended, shipped with the plugin, comes before all of them.
 * The settings order applies only within a class. By id, so a default
 * library pointed somewhere else still ranks last: ranking lower only ever
 * loses a name clash.
 */
export function libraryTrustRank(libraryId: string): number {
  if (libraryId === TEAM_LIBRARY_ID) return 0;
  return libraryId === GALLERY_LIBRARY_ID || libraryId === REGISTRY_LIBRARY_ID ? 2 : 1;
}

/** Libraries in trust order (libraryTrustRank), the settings order kept within each class. */
export function byTrust<T>(items: T[], idOf: (item: T) => string): T[] {
  return items
    .map((item, index) => ({ item, index, rank: libraryTrustRank(idOf(item)) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) => item);
}

/**
 * A version 1 document (0.12.0: `teamSource`, `teamHeaderName`) as version 2:
 * the team catalogue as the library "Team" when one was set, first, read as a
 * document whatever its address looks like (0.12.0 fetched it as one), then
 * the default libraries. Pure and synchronous, so the host's own reader can
 * run it on a document Paseo has not migrated yet (server/settings.ts).
 */
export function migrateCatalogValues(values: unknown, fromVersion: number): unknown {
  if (fromVersion !== 1) return {};
  const old = values && typeof values === "object" ? (values as Record<string, unknown>) : {};
  const source = typeof old.teamSource === "string" ? old.teamSource.trim() : "";
  const headerName = typeof old.teamHeaderName === "string" && HEADER_NAME.test(old.teamHeaderName.trim()) ? old.teamHeaderName.trim() : "";
  const team: LibrarySource[] = source ? [{ id: TEAM_LIBRARY_ID, name: "Team", source: source.slice(0, 2048), format: "json", enabled: true, headerName }] : [];
  return { libraries: [...team, ...DEFAULT_LIBRARIES] };
}

/** A new library's id from its name, not one already taken: `Acme tools` → `acme-tools`, else `acme-tools-2` … */
export function libraryIdFor(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const stem = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "library";
  const base = LIBRARY_ID.test(stem) ? stem : `lib-${stem}`.slice(0, 32);
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`.slice(0, 40);
}

// ------------------------------------------------------------------ sources

export type LibraryLocation =
  | { kind: "json"; url: string }
  | { kind: "registry"; base: string }
  | { kind: "file"; path: string }
  | { kind: "invalid"; reason: string };

/** `localhost`, `127.0.0.1` or `::1`: the one place plain http is read from. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/** Query keys that carry a credential, which must not sit in an address every connected app can read. */
const KEYED_QUERY = /(token|secret|key|password|passwd|auth|bearer|credential|cookie|session|signature)|^(code|sig|sv|se|sp|x-amz-.*)$/i;

/** A registry base without a trailing `/`, `/v0.1/servers`, `/v0/servers` or `/v0.1` a user pasted with it. */
function registryBase(url: URL): string {
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v0(\.1)?(\/servers)?$/i, "").replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * Where a library lives and how it is read, or why it cannot be. Addresses
 * must be https (plain http only on this machine), carry no user name or
 * password, and no key in the query (use the key field, which is
 * write-only). With format `auto`, an address whose path ends in `.json` is
 * one document and any other address is a registry. A path must be absolute
 * or start with `~/`; the host expands `~`.
 */
export function libraryLocation(source: string, format: LibraryFormat = "auto"): LibraryLocation {
  const trimmed = source.trim();
  if (!trimmed) return { kind: "invalid", reason: "no address or file is set" };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return { kind: "invalid", reason: "not a valid address" };
    }
    const https = url.protocol === "https:";
    if (!https && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
      return { kind: "invalid", reason: "only https addresses (or http on this machine) or file paths are read" };
    }
    if (url.username || url.password) return { kind: "invalid", reason: "put credentials in the header setting, not in the address" };
    const keyed = [...url.searchParams.keys()].find((name) => KEYED_QUERY.test(name));
    if (keyed) {
      return { kind: "invalid", reason: `take '${keyed}' out of the address and put the key in the key field: the address is visible to every connected app, the key field is not` };
    }
    url.hash = "";
    if (format === "json" || (format === "auto" && /\.json$/i.test(url.pathname))) return { kind: "json", url: url.toString() };
    if (url.search) return { kind: "invalid", reason: "a registry address takes no query; a JSON library's address ends in .json" };
    return { kind: "registry", base: registryBase(url) };
  }
  if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("/")) return { kind: "file", path: trimmed };
  return { kind: "invalid", reason: "use an https address, or an absolute path (or one starting with ~/)" };
}

/** The address a registry search asks: `{base}/v0.1/servers?search=…&version=latest&limit=…[&cursor=…]`. */
export function registryListUrl(base: string, query: string, limit = 100, cursor = ""): string {
  const params = new URLSearchParams();
  if (query) params.set("search", query);
  params.set("version", "latest");
  params.set("limit", String(limit));
  if (cursor) params.set("cursor", cursor);
  return `${base.replace(/\/+$/, "")}/v0.1/servers?${params.toString().replace(/\+/g, "%20")}`;
}
