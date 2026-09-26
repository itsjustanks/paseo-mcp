/**
 * Just enough TOML reading to keep a config file whole (0.15.0). The block
 * parser in handlers.ts reads one server at a time and carries lines it
 * doesn't model; this file answers the questions that need the whole file:
 *
 * - which server names a file has, in any form (`[mcp_servers.x]`, an inline
 *   table `x = { … }` under `[mcp_servers]`, a dotted `mcp_servers.x.url = …`);
 * - whether one value is complete on its own line (a list across lines or a
 *   `"""` string is not, and can't be carried as one line);
 * - whether a written file still holds together: every table header once,
 *   quotes and brackets closed per statement, no list left open into the next
 *   setting, no server both inline and as a table.
 *
 * It is a structural check, not a parser: it never decides what a value means.
 */

type Lex = { str: null | '"' | "'" | '"""' | "'''"; stack: string[]; problem: string };

/**
 * Scan one line of a value, carrying open strings and brackets from the lines
 * before. Returns where a comment starts (or the line's length).
 */
function lexLine(line: string, lex: Lex): number {
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (lex.str === '"""' || lex.str === "'''") {
      if (lex.str === '"""' && char === "\\") {
        index += 2;
        continue;
      }
      if (char === lex.str[0]) {
        let end = index;
        while (line[end] === char) end += 1;
        if (end - index >= 3) lex.str = null;
        index = end;
        continue;
      }
      index += 1;
      continue;
    }
    if (lex.str === '"') {
      if (char === "\\") index += 1;
      else if (char === '"') lex.str = null;
      index += 1;
      continue;
    }
    if (lex.str === "'") {
      if (char === "'") lex.str = null;
      index += 1;
      continue;
    }
    if (char === "#") return index;
    if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
      lex.str = line.startsWith('"""', index) ? '"""' : "'''";
      index += 3;
      continue;
    }
    if (char === '"' || char === "'") lex.str = char;
    else if (char === "[" || char === "{") lex.stack.push(char);
    else if (char === "]" || char === "}") {
      const open = lex.stack.pop();
      if (open !== (char === "]" ? "[" : "{")) lex.problem ||= "a bracket closes something that isn't open";
    } else if (char === "=" && lex.stack.at(-1) !== "{") {
      // Only an inline table holds `key = value`; anywhere else it is the next setting, reached through a list left open.
      lex.problem ||= lex.stack.length > 0 ? "a list is left open" : "two settings on one line";
    }
    index += 1;
  }
  return index;
}

/** A value complete on this one line, without its trailing comment; null when it runs on (a list across lines, a `"""` string) or doesn't close. */
export function tomlValueText(raw: string): string | null {
  if (raw.includes('"""') || raw.includes("'''")) return null;
  const lex: Lex = { str: null, stack: [], problem: "" };
  const end = lexLine(raw, lex);
  if (lex.problem || lex.str || lex.stack.length > 0) return null;
  const value = raw.slice(0, end).trim();
  return value === "" ? null : value;
}

/** A list of strings only (`["-y", "x"]`), or null for anything else. */
export function tomlStringArray(value: string, unquote: (raw: string) => string | null): string[] | null {
  const inner = /^\[([\s\S]*)\]$/.exec(value.trim());
  if (!inner) return null;
  const strings = [...inner[1].matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'/g)];
  const rest = inner[1].replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "");
  if (!/^[\s,]*$/.test(rest)) return null;
  const out: string[] = [];
  for (const match of strings) {
    const text = unquote(match[0]);
    if (text === null) return null;
    out.push(text);
  }
  return out;
}

const KEY_PART = String.raw`(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)`;
const KEY_PATH = new RegExp(String.raw`^(${KEY_PART}(?:\s*\.\s*${KEY_PART})*)\s*=(.*)$`);
const HEADER = new RegExp(String.raw`^(\[\[?)\s*(${KEY_PART}(?:\s*\.\s*${KEY_PART})*)\s*(\]\]?)\s*(?:#.*)?$`);

/** A dotted key as its parts, quotes taken off: `mcp_servers."a b"` is ["mcp_servers", "a b"]. */
function keyParts(text: string): string[] | null {
  const parts: string[] = [];
  for (const match of text.matchAll(new RegExp(KEY_PART, "g"))) {
    const raw = match[0];
    if (raw.startsWith('"')) {
      try {
        parts.push(JSON.parse(raw) as string);
      } catch {
        return null;
      }
    } else if (raw.startsWith("'")) parts.push(raw.slice(1, -1));
    else parts.push(raw);
  }
  return parts.length > 0 ? parts : null;
}

const joinPath = (parts: string[]) => parts.join("\u0001");
const showPath = (parts: string[]) => parts.join(".");

export type TomlOutline = {
  /** The first thing that doesn't hold together, in plain words; "" when none. */
  problem: string;
  /** Every `[table]` header, as its parts. */
  headers: string[][];
  /** Every `key = value`, as the full path of the key (table + key). */
  assignments: string[][];
};

/** One pass over a whole TOML file: its tables, its settings, and the first structural problem. */
export function tomlOutline(text: string): TomlOutline {
  const headers: string[][] = [];
  const assignments: string[][] = [];
  const seenHeaders = new Set<string>();
  const seenKeys = new Set<string>();
  let problem = "";
  let table: string[] = [];
  const lex: Lex = { str: null, stack: [], problem: "" };
  const fail = (line: number, what: string) => {
    problem ||= `line ${line}: ${what}`;
  };
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1;
    if (lex.str || lex.stack.length > 0) {
      // Still inside a value from an earlier line.
      lexLine(line, lex);
    } else {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      if (trimmed.startsWith("[")) {
        const header = HEADER.exec(trimmed);
        const parts = header ? keyParts(header[2]) : null;
        if (!header || !parts || header[1].length !== header[3].length) {
          fail(lineNo, "a table name isn't written properly");
          continue;
        }
        const key = joinPath(parts);
        if (header[1] === "[") {
          if (seenHeaders.has(key)) fail(lineNo, `[${showPath(parts)}] appears twice`);
          seenHeaders.add(key);
        }
        for (const set of assignments) {
          const path = joinPath(set);
          if (key === path || key.startsWith(`${path}\u0001`)) fail(lineNo, `${showPath(parts)} is set twice (once as a table, once inline)`);
        }
        headers.push(parts);
        table = parts;
        continue;
      }
      const pair = KEY_PATH.exec(trimmed);
      const parts = pair ? keyParts(pair[1]) : null;
      if (!pair || !parts) {
        fail(lineNo, "this line isn't a setting or a table name");
        continue;
      }
      const full = [...table, ...parts];
      const key = joinPath(full);
      if (seenKeys.has(key)) fail(lineNo, `${showPath(full)} is set twice`);
      for (const seen of seenHeaders) {
        if (seen === key || seen.startsWith(`${key}\u0001`)) fail(lineNo, `${showPath(full)} is set twice (once as a table, once inline)`);
      }
      seenKeys.add(key);
      assignments.push(full);
      if (pair[2].trim() === "") {
        fail(lineNo, `${showPath(full)} has no value`);
        continue;
      }
      lexLine(pair[2], lex);
    }
    if (lex.problem) {
      fail(lineNo, lex.problem);
      lex.problem = "";
    }
    if (lex.str === '"' || lex.str === "'") {
      fail(lineNo, "a quote is left open");
      lex.str = null;
    }
  }
  if (lex.str) fail(lines.length, "a text value is left open at the end of the file");
  else if (lex.stack.length > 0) fail(lines.length, "a list is left open at the end of the file");
  return { problem, headers, assignments };
}

/** "" when the file holds together; otherwise what's wrong, in plain words. */
export function tomlStructureProblem(text: string): string {
  return tomlOutline(text).problem;
}

/**
 * Every server name the file has, in any form: `[mcp_servers.x]` (quoted
 * too), `x = { … }` under `[mcp_servers]`, and dotted keys. Presence is
 * decided by name, never by whether this app could read the definition.
 */
export function tomlServerNamesFromText(text: string): string[] {
  const { headers, assignments } = tomlOutline(text);
  const names = new Set<string>();
  for (const parts of [...headers, ...assignments]) {
    if (parts[0] === "mcp_servers" && parts.length >= 2 && parts[1]) names.add(parts[1]);
  }
  return [...names];
}
