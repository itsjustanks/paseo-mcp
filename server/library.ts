import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { latestRegistryServers, normaliseUrl, registryCard, TEAM_MAX_BYTES, type CatalogCard } from "../shared/catalog";
import { CURATED_CATALOG } from "../shared/catalog-curated";
import { LIBRARY_MAX_BYTES, nextCursorOf, parseLibrary, type LibraryItem } from "../shared/library";
import { registryListUrl, type LibrarySource } from "../shared/library-source";
import { readLibraryAuth } from "./team-auth";

/**
 * Libraries, host side: the only code in the plugin that reads a library or
 * a registry. Nothing here runs while an RPC waits: a read answers from
 * memory and starts the fetch in the background, and the panel reads again
 * while the state says it is running. Every read from the network or a file
 * is capped before it is held in memory; a failed read keeps the last good
 * copy and waits a minute before it is tried again.
 */

const TAG = "[paseo-mcp]";
export const LIBRARY_TTL_MS = 15 * 60_000;
export const LIBRARY_RETRY_MS = 60_000;
export const REGISTRY_TTL_MS = 24 * 60 * 60_000;
export const REGISTRY_RETRY_MS = 60_000;
export const REGISTRY_MAX_BYTES = 8 * 1024 * 1024;
/** Pages of 100 a registry search follows (`metadata.nextCursor`) before it stops. */
export const REGISTRY_MAX_PAGES = 3;
const REGISTRY_CACHE_MAX = 200;
const FETCH_TIMEOUT_MS = 8_000;

// ------------------------------------------------------------------ fetching

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init);

/** For tests: answer network calls from a fake. */
export function setCatalogFetch(next: FetchLike | null): void {
  fetchImpl = next ?? ((url, init) => globalThis.fetch(url, init));
}

/** The fetch every catalogue network call goes through (the health probe after an install too). */
export function catalogFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetchImpl(url, init);
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
 * A library file as text. Only a regular file under the cap is read: stat
 * first (a directory, a FIFO or /dev/zero is refused before it is opened),
 * then open without blocking and check the opened file again, in case the
 * path changed in between, and never read past the cap.
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

export async function fetchText(url: string, headers: Record<string, string>, maxBytes: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // No redirects: a header meant for the library's host must not follow a hop elsewhere.
    const response = await fetchImpl(url, { headers: { accept: "application/json", ...headers }, signal: controller.signal, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) throw new Error(`answered with a redirect (HTTP ${response.status}); use the final address`);
    if (response.status === 404) throw new Error("answered HTTP 404: nothing is published at that address (yet)");
    if (!response.ok) throw new Error(`answered HTTP ${response.status}`);
    return await readCappedBody(response, maxBytes);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`no answer in ${FETCH_TIMEOUT_MS / 1000} s`);
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * The library's header, with its write-only value, for one address: only
 * when a header name is set, a value is stored for this library, and the
 * address is on the origin the value was set for. Checked again at the moment
 * of sending, every time.
 */
function keyHeaders(library: LibrarySource, url: string): Record<string, string> {
  const name = library.headerName.trim();
  if (!name) return {};
  const auth = readLibraryAuth(library.id);
  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch {
    return {};
  }
  return auth?.value && auth.origin && origin === auth.origin ? { [name]: auth.value } : {};
}

// ----------------------------------------------------------------- documents

export type LibraryCache = {
  /** What the cache was read for: the address, its format and header name. A change starts over. */
  key: string;
  items: LibraryItem[];
  refused: Array<{ id: string; reason: string }>;
  fetchedAt: number | null;
  failedAt: number | null;
  error: string;
  inFlight: Promise<void> | null;
};

const documents = new Map<string, LibraryCache>();

function cacheKey(library: LibrarySource): string {
  return JSON.stringify([library.source.trim(), library.format, library.headerName.trim()]);
}

function cacheFor(library: LibrarySource): LibraryCache {
  const key = cacheKey(library);
  let cache = documents.get(library.id);
  if (!cache || cache.key !== key) {
    cache = { key, items: [], refused: [], fetchedAt: null, failedAt: null, error: "", inFlight: null };
    documents.set(library.id, cache);
  }
  return cache;
}

function startDocumentFetch(library: LibrarySource, location: { kind: "json"; url: string } | { kind: "file"; path: string }, cache: LibraryCache): Promise<void> {
  if (cache.inFlight) return cache.inFlight;
  cache.inFlight = (async () => {
    try {
      const text =
        location.kind === "json"
          ? await fetchText(location.url, keyHeaders(library, location.url), LIBRARY_MAX_BYTES)
          : await readCappedFile(resolve(expandHome(location.path)), LIBRARY_MAX_BYTES);
      const parsed = parseLibrary(text);
      if (parsed.error) throw new Error(parsed.error);
      cache.items = parsed.items;
      cache.refused = parsed.refused;
      cache.fetchedAt = Date.now();
      cache.failedAt = null;
      cache.error = "";
    } catch (error) {
      // Keep the last good copy; say why the new read failed.
      cache.error = error instanceof Error ? error.message : String(error);
      cache.failedAt = Date.now();
      console.warn(`${TAG} library ${library.id}: ${cache.error}`);
    } finally {
      cache.inFlight = null;
    }
  })();
  return cache.inFlight;
}

/** A document library's cached read, starting a background read when there is none, it is stale, or `force`. */
export function documentFor(library: LibrarySource, location: { kind: "json"; url: string } | { kind: "file"; path: string }, force = false): LibraryCache {
  const cache = cacheFor(library);
  const now = Date.now();
  const stale = cache.fetchedAt === null || now - cache.fetchedAt > LIBRARY_TTL_MS;
  const resting = cache.failedAt !== null && now - cache.failedAt < LIBRARY_RETRY_MS;
  if (force || (stale && !resting)) void startDocumentFetch(library, location, cache);
  return cache;
}

/** The cached read of a library, without starting one (for the install RPCs). */
export function cachedDocument(library: LibrarySource): LibraryCache | null {
  const cache = documents.get(library.id);
  return cache && cache.key === cacheKey(library) ? cache : null;
}

/** Read this library again on its next read (its key changed). */
export function forgetDocument(libraryId: string): void {
  const cache = documents.get(libraryId);
  if (cache) {
    cache.fetchedAt = null;
    cache.failedAt = null;
  }
}

// ---------------------------------------------------------------- registries

export const knownOfficialUrls: ReadonlyMap<string, string> = new Map(
  CURATED_CATALOG.filter((entry) => entry.url).map((entry) => [normaliseUrl(entry.url ?? ""), entry.name] as const),
);

export type RegistrySearch = {
  cards: CatalogCard[];
  fetchedAt: number | null;
  failedAt: number | null;
  error: string;
  /** True when the answer had more pages than REGISTRY_MAX_PAGES. */
  truncated: boolean;
  inFlight: Promise<void> | null;
};

const searches = new Map<string, RegistrySearch>();

export function registryQueryKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function searchKey(base: string, query: string): string {
  return `${base}\n${registryQueryKey(query)}`;
}

/**
 * One search of a registry, following `metadata.nextCursor` for up to
 * REGISTRY_MAX_PAGES pages of 100, then only the latest active version of
 * each name. One answer the card builder chokes on is left out, not the whole
 * search.
 */
function startRegistrySearch(library: LibrarySource, base: string, query: string, search: RegistrySearch): Promise<void> {
  if (search.inFlight) return search.inFlight;
  search.inFlight = (async () => {
    try {
      const items: unknown[] = [];
      let cursor = "";
      let pages = 0;
      do {
        const url = registryListUrl(base, query, 100, cursor);
        const body = JSON.parse(await fetchText(url, keyHeaders(library, url), REGISTRY_MAX_BYTES)) as { servers?: unknown };
        if (Array.isArray(body?.servers)) items.push(...body.servers);
        cursor = nextCursorOf(body);
        pages += 1;
      } while (cursor && pages < REGISTRY_MAX_PAGES);
      search.truncated = cursor !== "";
      search.cards = latestRegistryServers({ servers: items }).flatMap((server) => {
        try {
          return [{ ...registryCard(server, knownOfficialUrls), library: { id: library.id, name: library.name } }];
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

/** The cached answer for a query, starting a background search when there is none, it is a day old, or `force`. Null under two letters. */
export function registryFor(library: LibrarySource, base: string, query: string, force = false): RegistrySearch | null {
  const normal = registryQueryKey(query);
  if (normal.length < 2) return null;
  const key = searchKey(base, normal);
  let search = searches.get(key);
  if (!search) {
    if (searches.size >= REGISTRY_CACHE_MAX) {
      const oldest = [...searches.entries()].sort((a, b) => (a[1].fetchedAt ?? 0) - (b[1].fetchedAt ?? 0))[0];
      if (oldest) searches.delete(oldest[0]);
    }
    search = { cards: [], fetchedAt: null, failedAt: null, error: "", truncated: false, inFlight: null };
    searches.set(key, search);
  }
  const now = Date.now();
  const stale = search.fetchedAt === null || now - search.fetchedAt > REGISTRY_TTL_MS;
  const resting = search.failedAt !== null && now - search.failedAt < REGISTRY_RETRY_MS;
  if (force || (stale && !resting)) void startRegistrySearch(library, base, normal, search);
  return search;
}

/** Every cached search of one registry, newest first (for the install RPCs). */
export function cachedSearches(base: string): RegistrySearch[] {
  return [...searches.entries()]
    .filter(([key]) => key.startsWith(`${base}\n`))
    .map(([, search]) => search)
    .sort((a, b) => (b.fetchedAt ?? 0) - (a.fetchedAt ?? 0));
}

// --------------------------------------------------------------------- tests

/** For tests: forget every cached read and search. */
export function resetLibraryCaches(): void {
  documents.clear();
  searches.clear();
}

/** For tests: wait for whatever is reading now. */
export async function librariesSettled(): Promise<void> {
  await Promise.all([...documents.values(), ...searches.values()].map((entry) => entry.inFlight).filter(Boolean));
}
