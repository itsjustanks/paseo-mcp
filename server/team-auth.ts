import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { readJson, writeTextAtomic } from "./handlers";
import { keepVersionCopy, settingsPath } from "./settings";

/**
 * Each library's header value, kept apart from the `catalog` settings
 * document. Paseo sends a settings document to every client that reads it; a
 * bearer token for a private repo does not belong there. This file is the
 * plugin's own, never registered as settings, created 0600, and the host only
 * ever says whether it holds a value and for which site.
 *
 * Each value is bound to the origin of the library address it was set for
 * (`{ keys: { <library id>: { value, origin } } }`): it is sent only to that
 * origin, so a client that can edit the (unprotected) address cannot point it
 * at its own site and collect the key. 0.12.0 kept one value for the team
 * catalogue (`{ teamHeaderValue, origin }`); that reads as the Team library's,
 * and the Team key is written in that shape too, beside `keys`, so 0.12.0
 * still finds it after a rollback. A value with no origin (an earlier build)
 * is sent nowhere.
 */
export type TeamAuth = { value: string; origin: string };
type Store = Record<string, TeamAuth>;
const TEAM = "team";
export function teamAuthPath(): string {
  return settingsPath("team-auth");
}

/** The origin a team address sends to (`https://raw.githubusercontent.com`), or "" for a file path, nothing, or anything not https. */
export function teamOrigin(source: string): string {
  const trimmed = source.trim();
  if (!/^https:\/\//i.test(trimmed)) return "";
  try {
    return new URL(trimmed).origin;
  } catch {
    return "";
  }
}

function readStore(path: string): Store {
  const raw = readJson(path);
  const store: Store = {};
  if (typeof raw?.teamHeaderValue === "string") store[TEAM] = { value: raw.teamHeaderValue, origin: typeof raw.origin === "string" ? raw.origin : "" };
  const keys = raw?.keys && typeof raw.keys === "object" ? (raw.keys as Record<string, unknown>) : {};
  for (const [id, entry] of Object.entries(keys)) {
    const value = (entry as { value?: unknown } | null)?.value;
    const origin = (entry as { origin?: unknown } | null)?.origin;
    if (typeof value === "string") store[id] = { value, origin: typeof origin === "string" ? origin : "" };
  }
  return store;
}

function writeStore(path: string, store: Store): void {
  if (Object.keys(store).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  // The Team key is also kept in 0.12.0's shape, so a rollback still sends it to its origin.
  const team = store[TEAM];
  const legacy = team ? { teamHeaderValue: team.value, origin: team.origin } : {};
  writeTextAtomic(path, `${JSON.stringify({ ...legacy, keys: store }, null, 2)}\n`);
  chmodSync(path, 0o600);
}

/** The Team library's address in a settings document of either version. */
function teamSourceOf(values: Record<string, unknown>): string {
  if (typeof values.teamSource === "string") return values.teamSource;
  const libraries = Array.isArray(values.libraries) ? (values.libraries as Array<{ id?: unknown; source?: unknown }>) : [];
  const team = libraries.find((library) => library?.id === TEAM);
  return typeof team?.source === "string" ? team.source : "";
}

/**
 * Move a value an older build saved in the settings document into the store
 * (unless the store already has one), bound to the origin of the document's
 * team address at that moment, then take it out of the document. The
 * envelope keeps its version and every other value; it is written the way
 * Paseo writes it (compact, 0600).
 */
function migrateLegacyValue(storePath: string, documentPath: string): void {
  if (!existsSync(documentPath)) return;
  let envelope: { version?: unknown; values?: Record<string, unknown> };
  try {
    envelope = JSON.parse(readFileSync(documentPath, "utf8"));
  } catch {
    return;
  }
  const values = envelope?.values;
  if (!values || typeof values !== "object" || !("teamHeaderValue" in values)) return;
  const legacy = values.teamHeaderValue;
  const store = readStore(storePath);
  if (typeof legacy === "string" && legacy && !store[TEAM]) {
    writeStore(storePath, { ...store, [TEAM]: { value: legacy, origin: teamOrigin(teamSourceOf(values)) } });
  }
  const { teamHeaderValue: _dropped, ...rest } = values;
  keepVersionCopy("catalog", 1);
  writeTextAtomic(documentPath, JSON.stringify({ ...envelope, values: rest }));
  chmodSync(documentPath, 0o600);
}

/** One library's stored value and the origin it may go to, null when none. Migrates an old settings value first. */
export function readLibraryAuth(libraryId: string, storePath = teamAuthPath(), documentPath = settingsPath("catalog")): TeamAuth | null {
  migrateLegacyValue(storePath, documentPath);
  return readStore(storePath)[libraryId] ?? null;
}

/** The ids of every library with a stored value. */
export function libraryAuthIds(storePath = teamAuthPath(), documentPath = settingsPath("catalog")): string[] {
  migrateLegacyValue(storePath, documentPath);
  return Object.keys(readStore(storePath));
}

/** Set (non-empty, one line) for one origin, or clear, one library's value. Returns only whether one is set, and for which origin. */
export function writeLibraryHeaderValue(libraryId: string, value: string | null, storePath = teamAuthPath(), origin = ""): { set: boolean; origin: string } {
  const { [libraryId]: _old, ...others } = readStore(storePath);
  if (value === null || value === "") {
    writeStore(storePath, others);
    return { set: false, origin: "" };
  }
  if (/[\r\n]/.test(value)) throw new Error("The header value must be one line.");
  writeStore(storePath, { ...others, [libraryId]: { value, origin } });
  const stored = readStore(storePath)[libraryId];
  return { set: stored?.value === value, origin: stored?.origin ?? "" };
}

/** The Team library's value (0.12.0's team catalogue key). */
export function readTeamAuth(storePath = teamAuthPath(), documentPath = settingsPath("catalog")): TeamAuth | null {
  return readLibraryAuth(TEAM, storePath, documentPath);
}

export function writeTeamHeaderValue(value: string | null, storePath = teamAuthPath(), origin = ""): { set: boolean; origin: string } {
  return writeLibraryHeaderValue(TEAM, value, storePath, origin);
}
