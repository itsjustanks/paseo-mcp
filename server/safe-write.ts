import { randomBytes } from "node:crypto";
import { closeSync, constants, copyFileSync, lstatSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
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
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), finalMode);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
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
