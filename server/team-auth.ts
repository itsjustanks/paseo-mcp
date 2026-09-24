import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { readJson, writeTextAtomic } from "./handlers";
import { settingsPath } from "./settings";

/**
 * The team catalogue's header value, kept apart from the `catalog` settings
 * document. Paseo sends a settings document to every client that reads it; a
 * bearer token for a private repo does not belong there. This file is the
 * plugin's own, never registered as settings, created 0600, and the host only
 * ever says whether it holds a value and for which site.
 *
 * The value is bound to the origin of the team address it was set for
 * (`{ teamHeaderValue, origin }`): it is sent only to that origin, so a client
 * that can edit the (unprotected) address cannot point it at its own site and
 * collect the key. A store with no origin (an earlier build) is sent nowhere.
 */
export type TeamAuth = { value: string; origin: string };
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

function readStore(path: string): TeamAuth | null {
  const store = readJson(path);
  const value = store?.teamHeaderValue;
  if (typeof value !== "string") return null;
  return { value, origin: typeof store?.origin === "string" ? store.origin : "" };
}

function writeStore(path: string, auth: TeamAuth): void {
  mkdirSync(dirname(path), { recursive: true });
  writeTextAtomic(path, `${JSON.stringify({ teamHeaderValue: auth.value, origin: auth.origin }, null, 2)}\n`);
  chmodSync(path, 0o600);
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
  if (typeof legacy === "string" && legacy && readStore(storePath) === null) {
    writeStore(storePath, { value: legacy, origin: teamOrigin(typeof values.teamSource === "string" ? values.teamSource : "") });
  }
  const { teamHeaderValue: _dropped, ...rest } = values;
  writeTextAtomic(documentPath, JSON.stringify({ ...envelope, values: rest }));
  chmodSync(documentPath, 0o600);
}

/** The stored value and the origin it may go to, null when none. Migrates an old settings value first. */
export function readTeamAuth(storePath = teamAuthPath(), documentPath = settingsPath("catalog")): TeamAuth | null {
  migrateLegacyValue(storePath, documentPath);
  return readStore(storePath);
}

/** Set (non-empty, one line) for one origin, or clear, the value. Returns only whether one is set, and for which origin. */
export function writeTeamHeaderValue(value: string | null, storePath = teamAuthPath(), origin = ""): { set: boolean; origin: string } {
  if (value === null || value === "") {
    rmSync(storePath, { force: true });
    return { set: false, origin: "" };
  }
  if (/[\r\n]/.test(value)) throw new Error("The header value must be one line.");
  writeStore(storePath, { value, origin });
  const stored = readStore(storePath);
  return { set: stored?.value === value, origin: stored?.origin ?? "" };
}
