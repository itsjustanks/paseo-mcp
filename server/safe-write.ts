import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, lstatSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Every file this plugin writes goes through here. Some of those files sit in
 * a project checkout, which is whatever the repository says it is, so a write
 * must never be redirected by a symbolic link the repository committed:
 *
 *  - the target itself must not be a symlink (a `.mcp.json` pointing at
 *    `~/.claude/settings.json` would otherwise get that file rewritten);
 *  - the temporary file gets a random name and is created exclusively
 *    (O_CREAT | O_EXCL | O_NOFOLLOW), so a planted `<file>.tmp-…` link can't
 *    catch the write either.
 *
 * Before 0.11.4 the temporary name was fixed (`<file>.tmp-paseo-mcp`) and
 * `writeFileSync` followed a link planted there, then `renameSync` moved it
 * into place.
 */
export class SymlinkRefusedError extends Error {}

export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function refuseSymlink(path: string): void {
  if (isSymlink(path)) {
    throw new SymlinkRefusedError(
      `${basename(path)} is a symbolic link, so paseo-mcp won't write through it (${path}). Edit the file it points to directly, or replace the link with a regular file.`,
    );
  }
}

/**
 * A temporary file beside `path`, created exclusively and owner-only (0600,
 * O_EXCL | O_NOFOLLOW), filled with every byte of `bytes` (a short write is
 * continued, never truncated), then given `mode`. Any failure on the way
 * (a full disk included) removes it before the error goes on.
 */
function writeTemp(path: string, bytes: Buffer, mode: number): string {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  let ok = false;
  try {
    try {
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, mode);
    ok = true;
    return tmp;
  } finally {
    if (!ok) rmSync(tmp, { force: true });
  }
}

/** Replace `path` in one step. `mode` defaults to the existing file's, or 0600 for a new one. */
export function writeFileSafely(path: string, text: string, mode?: number): void {
  refuseSymlink(path);
  let finalMode = mode;
  if (finalMode === undefined) {
    try {
      finalMode = statSync(path).mode & 0o777;
    } catch {
      finalMode = 0o600;
    }
  }
  const tmp = writeTemp(path, Buffer.from(text, "utf8"), finalMode);
  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** Copy `path` to a new `destination` that must not exist yet; refuses a symlinked source. */
export function copyFileSafely(path: string, destination: string): void {
  refuseSymlink(path);
  copyFileSync(path, destination, constants.COPYFILE_EXCL);
}

// ------------------------------------------------------------- compare-before-replace (0.20.0)

/**
 * Settings files other programs write too (Claude Code rewrites ~/.claude.json
 * constantly; Codex its config.toml; a teammate's git pull a .mcp.json) are
 * changed by compare-before-replace:
 *
 *  1. `readStamped` reads the file's bytes and records its inode, size, mtime
 *     and a hash of exactly those bytes (re-read when the file moved under
 *     it). A file that isn't valid UTF-8 is refused, never round-tripped
 *     through replacement characters;
 *  2. the new text goes to an owner-only temporary file in the same folder;
 *  3. right before the rename the file is stamped again; any difference
 *     deletes the temporary file, writes nothing and throws
 *     `ConcurrentChangeError` ("…changed … while saving. Nothing was changed;
 *     try again."): no silent merge;
 *  4. the rename keeps the file's permissions;
 *  5. the file is read back. If it isn't what was written, nothing more is
 *     written (no rollback: the difference is most likely another program's
 *     newer write) and the user is told, with where the backup is.
 * The check and the rename are separate system calls, so this narrows the
 * window to microseconds rather than closing it; 0.21.0 moves Claude Code's
 * own changes to its CLI.
 */
export type FileStamp = { exists: boolean; ino: number; size: number; mtimeMs: number; hash: string };

const MISSING: FileStamp = { exists: false, ino: 0, size: 0, mtimeMs: 0, hash: "" };

function statOrNull(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

const hashBytes = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Thrown when a settings file isn't valid UTF-8: it is never edited, so nothing in it is replaced by U+FFFD. */
export class NotUtf8Error extends Error {}

/** The file's text (null when missing) and its stamp, taken around the same read of its bytes. */
export function readStamped(path: string): { text: string | null; stamp: FileStamp } {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = statOrNull(path);
    if (!before) return { text: null, stamp: MISSING };
    const bytes = readFileSync(path);
    const after = statOrNull(path);
    if (after && after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs) {
      let text: string;
      try {
        text = strictUtf8.decode(bytes);
      } catch {
        throw new NotUtf8Error(`${basename(path)} isn't valid UTF-8 text, so it wasn't changed. Fix the file (or save it as UTF-8) and try again.`);
      }
      return { text, stamp: { exists: true, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs, hash: hashBytes(bytes) } };
    }
  }
  throw new ConcurrentChangeError(concurrentMessage(path));
}

/** The file as it is now, hashed over its bytes. */
export function stampNow(path: string): FileStamp {
  const stats = statOrNull(path);
  if (!stats) return MISSING;
  return { exists: true, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, hash: hashBytes(readFileSync(path)) };
}

export function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.exists === b.exists && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.hash === b.hash;
}

/** Retryable: the file changed between this plugin's read and its write. */
export class ConcurrentChangeError extends Error {
  readonly retryable = true;
}

/** The plain sentence for a file another program changed while saving. */
export function concurrentMessage(path: string): string {
  const who = /\.claude\.json$/.test(path) ? "Claude Code changed its settings file" : /config\.toml$/.test(path) ? "Codex changed its settings file" : `${basename(path)} was changed`;
  return `${who} while saving. Nothing was changed; try again.`;
}

/** "~/.claude.json.bak-…" for a path under home, else the path. */
function friendly(path: string): string {
  const home = homedir();
  return home && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

/** Test seams: run between the temporary write and the rename, and right after the rename. */
export const replaceHooks: { beforeRename?: (path: string) => void; afterRename?: (path: string) => void } = {};

/**
 * Replace `path` with `text` only if it is still exactly as `expected`
 * (`readStamped`). `backup` is the copy taken before (backupFile); it is kept
 * and named if the read-back doesn't match. `newMode` is for a file that
 * didn't exist (default 0600).
 */
export function replaceGuarded(path: string, text: string, expected: FileStamp, options: { backup?: string | null; newMode?: number } = {}): void {
  refuseSymlink(path);
  const existing = statOrNull(path);
  const mode = existing ? existing.mode & 0o777 : options.newMode ?? 0o600;
  const bytes = Buffer.from(text, "utf8");
  const tmp = writeTemp(path, bytes, mode);
  try {
    replaceHooks.beforeRename?.(path);
    if (!sameStamp(stampNow(path), expected)) throw new ConcurrentChangeError(concurrentMessage(path));
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  replaceHooks.afterRename?.(path);
  let readBack: Buffer | null = null;
  try {
    readBack = readFileSync(path);
  } catch {
    readBack = null;
  }
  if (readBack && readBack.equals(bytes)) return;
  // No rollback (0.20.0): whatever is there now is most likely a newer write by another program.
  const where = options.backup ? ` A backup from before is at ${friendly(options.backup)}.` : "";
  throw new ConcurrentChangeError(`The file changed right after saving (probably Claude Code). Your change may not be in it; check and try again.${where}`);
}
