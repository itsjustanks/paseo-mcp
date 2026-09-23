import { readFileSync, statSync } from "node:fs";

/**
 * Read-only views of config files, re-read only when the file changes.
 *
 * `~/.claude.json` is often hundreds of kilobytes (it carries every project's
 * history) and one panel refresh used to parse it five or six times. Here a
 * file is read and parsed once per change, judged by size, mtime and inode (an
 * atomic rename always changes the inode). Callers that WRITE must not use
 * these: they read the file themselves so a refusal to overwrite an unreadable
 * file still happens.
 *
 * Parsed values are shared between callers. Anything returned from here must
 * be treated as read-only; `readJsonCopy` exists for callers that want to
 * change what they get.
 */

type Stamp = string;
type TextEntry = { stamp: Stamp; text: string };
type JsonEntry = { stamp: Stamp; value: unknown; parsedAt: number };

const texts = new Map<string, TextEntry>();
const jsons = new Map<string, JsonEntry>();

/** A file that fails to parse right after a good read is most likely mid-write; keep the good copy this long. */
export const PARSE_GRACE_MS = 60_000;

/** Size, mtime and inode as one comparable string; "missing" when the file cannot be stat'ed. */
export function fileStamp(path: string): Stamp {
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
  } catch {
    return "missing";
  }
}

/** File text, or null when it does not exist or cannot be read. */
export function readTextCached(path: string): string | null {
  const stamp = fileStamp(path);
  if (stamp === "missing") {
    texts.delete(path);
    return null;
  }
  const hit = texts.get(path);
  if (hit && hit.stamp === stamp) return hit.text;
  try {
    const text = readFileSync(path, "utf8");
    texts.set(path, { stamp, text });
    return text;
  } catch {
    texts.delete(path);
    return null;
  }
}

/**
 * Parsed JSON, or null when the file is missing or not JSON. A parse failure
 * within PARSE_GRACE_MS of a good parse returns the good copy: an editor
 * rewriting its config must not make every server vanish from a panel for a
 * refresh cycle.
 */
export function readJsonCached(path: string, now = Date.now()): unknown {
  const stamp = fileStamp(path);
  const hit = jsons.get(path);
  if (hit && hit.stamp === stamp) return hit.value;
  const text = readTextCached(path);
  if (text === null) {
    jsons.delete(path);
    return null;
  }
  try {
    const value = JSON.parse(text) as unknown;
    jsons.set(path, { stamp, value, parsedAt: now });
    return value;
  } catch {
    if (hit && now - hit.parsedAt < PARSE_GRACE_MS) return hit.value;
    jsons.delete(path);
    return null;
  }
}

/** A private copy of the parsed JSON, safe to change. */
export function readJsonCopy<T = unknown>(path: string): T | null {
  const value = readJsonCached(path);
  return value === null ? null : (structuredClone(value) as T);
}

/** Drop what is known about a file; called after this plugin writes it. */
export function forgetFile(path: string): void {
  texts.delete(path);
  jsons.delete(path);
}

/** For tests. */
export function forgetAllFiles(): void {
  texts.clear();
  jsons.clear();
}
