/**
 * The one redactor for text a person sees (0.20.0): toasts, inline messages,
 * dialog bodies, previews, diagnostics and copied text. Pure, so the server
 * and the app share it. Its cases live in `redact.cases.json` (input →
 * expected), for other plugins to reuse.
 *
 * What it hides:
 * - text that is wholly JSON, by structure: anything under a secret key, at
 *   any depth (`{"oauth":{"password":"x"}}`), and secret flags in `args`;
 * - PEM key blocks (`-----BEGIN … KEY-----` … `-----END … KEY-----`) whole,
 *   and TOML multiline strings under a secret key whole;
 * - an `Authorization:` (or `Proxy-Authorization:`) value, whatever the scheme;
 * - `Bearer …` anywhere, and `Basic …` / `Token …` with a credential-shaped value;
 * - a value whose key is a secret name, as a whole name (`token`, `api_key`,
 *   `client_secret`, `FOO_TOKEN`, …; never `tokenizer` or `monkey`), in JSON
 *   (`"k": "v"`), TOML and env (`k = "v"`, `K=v`), YAML (`k: v`) and query
 *   strings (`?k=v`). A quoted value is hidden whole;
 * - CLI flags that carry a secret (`--api-key X`, `--token=X`, `-p X` unless
 *   X is a port), as words in a string and as items in an argument list
 *   (`redactArgs`);
 * - addresses with credentials (`https://user:pass@host`), an OAuth `code=`;
 * - well-known key shapes (OpenAI and Anthropic, GitHub, Slack and AWS key prefixes, JWTs) and long
 *   hex or base64 runs (32+ characters with letters and digits).
 * A value that is already masked (starts with •••) is left as it is.
 */

export const REDACTED = "•••";

/** Secret key names, as the last part of a name split on `_`, `-` or `.`. */
const SECRET_WORDS = [
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "pass",
  "apikey",
  "auth",
  "authorization",
  "bearer",
  "credential",
  "credentials",
  "cookie",
  "pat",
  "passphrase",
];
/** Two-part names whose parts aren't secret words alone. */
const SECRET_PAIRS = ["api key", "private key", "access key", "secret key", "client key", "signing key", "session key"];

/** True for a whole key name that holds a secret: `token`, `FOO_TOKEN`, `x-api-key`, `client_secret`; not `tokenizer`, `monkey`, `author`. */
export function isSecretName(name: string): boolean {
  const parts = name
    .replace(/^[-"']+|["']+$/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_\-.\s]+/)
    .filter(Boolean);
  if (parts.length === 0) return false;
  const last = parts[parts.length - 1];
  if (SECRET_WORDS.includes(last)) return true;
  if (parts.length === 1 && last === "key") return true;
  const tail = parts.slice(-2).join(" ");
  return SECRET_PAIRS.includes(tail);
}

/**
 * True when a flag carries a secret: a long flag with a secret name
 * (`--api-key`, `--token`, `--pass`), or `-p` unless a port follows it
 * (`-p 3000` stays visible; `-p hunter2` is a password).
 */
export function isSecretFlag(flag: string, value: string): boolean {
  if (flag === "-p") return !/^["']?\d{1,5}["']?$/.test(value);
  return flag.startsWith("--") && isSecretName(flag.slice(2));
}

const quoteOf = (value: string) => /^("""|'''|["'])/.exec(value)?.[1] ?? "";
const masked = (value: string) => value.slice(quoteOf(value).length).startsWith(REDACTED);
/** The replacement for a value: quotes kept, everything inside hidden. */
const hide = (value: string) => (masked(value) ? value : `${quoteOf(value)}${REDACTED}${quoteOf(value)}`);
/** A credential after Basic or Token: 8+ characters with a digit, mixed case or a symbol, so "Token expired" and "Basic authentication" stay. */
const credentialShaped = (value: string) => value.length >= 8 && (/\d/.test(value) || (/[A-Z]/.test(value) && /[a-z]/.test(value)) || /[+/=_.~-]/.test(value));

// A key, quoted or bare, then `=` or `:`, then a quoted value or a bare one.
const QUOTED = `"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'`;
const KEY = `"[^"\\n]{1,80}"|'[^'\\n]{1,80}'|[A-Za-z_][A-Za-z0-9_.-]{0,79}`;
// The lead is a lookbehind, so a match never eats the `{` the next key needs (`{"oauth":{"password":"x"}}`).
// A bare value stops at `?` and `&`, so `url=https://h/p?token=x` still finds the `token` inside it.
const PAIR = new RegExp(`(?<=^|[\\s{,;&?(\\[])(${KEY})(\\s*)(=|:)(\\s*)("""[\\s\\S]*?"""|'''[\\s\\S]*?'''|${QUOTED}|[^\\s"',;&?{}\\]]+)`, "g");
// YAML and header style `key: rest of line` (unquoted): the rest of the line is the value.
const COLON_LINE = new RegExp(`(^|\\n)([ \\t-]*)(${KEY})([ \\t]*:[ \\t]+)(?!["'])([^\\n]+)`, "g");
// A PEM key block, whole, wherever it sits (a TOML multiline string, a JSON string with \n, a log).
// An unterminated block stops at a closing quote, so a one-line string keeps its quotes.
const PEM = /-----BEGIN [A-Z0-9 ]*?KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*?KEY-----|(?=["'])|$)/g;
// A TOML multiline string ("""…""" or '''…'''), whole.
const TOML_MULTI = new RegExp(`(^|\\n)([ \\t]*)(${KEY})([ \\t]*=[ \\t]*)("""[\\s\\S]*?"""|'''[\\s\\S]*?''')`, "g");

function redactPairs(text: string): string {
  return text.replace(PAIR, (match, key: string, s1: string, sep: string, s2: string, value: string) => {
    // A URL's scheme ("https:") or a time ("10:30") is not a pair.
    if (sep === ":" && /^\/\//.test(value)) return match;
    if (isSecretName(key)) return `${key}${s1}${sep}${s2}${hide(value)}`;
    // Not a secret key, but its bare value may hold one ("logout: token=x").
    return quoteOf(value) ? match : `${key}${s1}${sep}${s2}${redactPairs(value)}`;
  });
}

function redactColonLines(text: string): string {
  return text.replace(COLON_LINE, (match, lead: string, indent: string, key: string, sep: string, value: string) =>
    isSecretName(key) && !masked(value) ? `${lead}${indent}${key}${sep}${REDACTED}` : match,
  );
}

/**
 * Command-line words in a string (0.20.0, final review): split on whitespace,
 * keeping a quoted run ("a b", 'y z') or a backslash-escaped character inside
 * its word. Spans into `text`, so a value can be masked in place and every
 * other byte, spacing and quotes included, stays as it was.
 */
function words(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (index >= text.length) break;
    const start = index;
    while (index < text.length && !/\s/.test(text[index])) {
      const char = text[index];
      if (char === "\\") {
        index += 2;
      } else if (char === '"' || char === "'") {
        index += 1;
        while (index < text.length && text[index] !== char) index += text[index] === "\\" && char === '"' ? 2 : 1;
        index += 1;
      } else {
        index += 1;
      }
    }
    spans.push({ start, end: Math.min(index, text.length) });
  }
  return spans;
}

/** A word without the punctuation around it in a list (`["--token",` → `"--token"`), and where that core sits. */
function core(text: string, span: { start: number; end: number }): { start: number; end: number; value: string } {
  let start = span.start;
  let end = span.end;
  while (start < end && "[({,".includes(text[start])) start += 1;
  while (end > start && ",;)]}".includes(text[end - 1])) end -= 1;
  return { start, end, value: text.slice(start, end) };
}

const unquote = (value: string) => (/^(["']).*\1$/s.test(value) && value.length >= 2 ? value.slice(1, -1) : value);
const FLAG_WORD = /^(--[A-Za-z][A-Za-z0-9_-]*|-p)$/;
const FLAG_WITH_VALUE = /^(--[A-Za-z][A-Za-z0-9_-]*|-p)=([\s\S]*)$/;

/**
 * Secret flags in a string, word by word, with the same rule as argument
 * lists: the word after a secret flag is always its value (even "-x" or
 * "a b"), and `--flag=value` is one word. No match ever spans two flags, so
 * `--verbose --api-key X` checks `--api-key` on its own. A quoted word with
 * spaces inside (`"exec server --api-key X"`) is checked inside too.
 */
function redactFlags(text: string): string {
  const spans = words(text);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (let index = 0; index < spans.length; index += 1) {
    const here = core(text, spans[index]);
    const quote = quoteOf(here.value);
    const word = unquote(here.value);
    const inline = FLAG_WITH_VALUE.exec(word);
    if (inline && isSecretFlag(inline[1], inline[2])) {
      if (!inline[2].startsWith(REDACTED)) edits.push({ start: here.start, end: here.end, text: `${quote}${inline[1]}=${REDACTED}${quote}` });
      continue;
    }
    if (FLAG_WORD.test(word) && index + 1 < spans.length) {
      const next = core(text, spans[index + 1]);
      if (isSecretFlag(word, unquote(next.value))) {
        if (!masked(next.value)) edits.push({ start: next.start, end: next.end, text: hide(next.value) });
        index += 1;
        continue;
      }
    }
    if (quote && /\s/.test(word)) {
      const inner = redactFlags(word);
      if (inner !== word) edits.push({ start: here.start, end: here.end, text: `${quote}${inner}${quote}` });
    }
  }
  let out = text;
  for (const edit of edits.reverse()) out = `${out.slice(0, edit.start)}${edit.text}${out.slice(edit.end)}`;
  return out;
}

function redactTomlMultiline(text: string): string {
  return text.replace(TOML_MULTI, (_match, lead: string, indent: string, key: string, sep: string, value: string) => {
    const fence = value.slice(0, 3);
    const inner = isSecretName(key) ? REDACTED : redactSecrets(value.slice(3, -3));
    return `${lead}${indent}${key}${sep}${fence}${inner}${fence}`;
  });
}

/**
 * A value as the app may show it, by structure: anything under a secret key,
 * at any depth, is hidden (strings become •••, objects are walked); an `args`
 * list goes through `redactArgs`; every other string through `redactSecrets`.
 */
export function redactValue(value: unknown, underSecret = false, key = ""): unknown {
  if (typeof value === "string") return underSecret ? (masked(value) ? value : REDACTED) : redactSecrets(value);
  if (typeof value === "number" || typeof value === "boolean") return underSecret ? REDACTED : value;
  if (Array.isArray(value)) {
    if (!underSecret && key === "args" && value.every((item) => typeof item === "string")) return redactArgs(value as string[]);
    return value.map((item) => redactValue(item, underSecret));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, redactValue(item, underSecret || isSecretName(name), name)]));
  }
  return value;
}

/** Text that is wholly a JSON object or list is redacted by structure, keeping its indentation; null when it isn't. */
function redactJsonText(text: string): string | null {
  const trimmed = text.trim();
  if (!/^[{[]/.test(trimmed)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const indent = /\n([ \t]+)\S/.exec(trimmed)?.[1] ?? "";
  const start = text.indexOf(trimmed);
  const redacted = redactValue(parsed);
  // Keep the original layout: indented as it was, or on one line with its own spacing after ":" and ",".
  const body = indent ? JSON.stringify(redacted, null, indent) : oneLine(redacted, /":\s/.test(trimmed) ? ": " : ":", /,\s/.test(trimmed) ? ", " : ",");
  return `${text.slice(0, start)}${body}${text.slice(start + trimmed.length)}`;
}

function oneLine(value: unknown, colon: string, comma: string): string {
  if (Array.isArray(value)) return `[${value.map((item) => oneLine(item, colon, comma)).join(comma)}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).map(([name, item]) => `${JSON.stringify(name)}${colon}${oneLine(item, colon, comma)}`).join(comma)}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const SHAPES: Array<[RegExp, string]> = [
  // scheme://user:pass@host and scheme://token@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi, `$1${REDACTED}@`],
  // An OAuth authorisation code in a callback address
  [/([?&]code=)[^&\s"']+/gi, `$1${REDACTED}`],
  // Bearer anywhere, any value of 4+
  [/\b(bearer)\s+(?!•••)[^\s"',;]{4,}/gi, `$1 ${REDACTED}`],
  // Well-known key shapes
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{12,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // Long hex, then long base64 / base64url (needs a letter and a digit, so words and paths survive)
  [/\b[0-9a-f]{32,}\b/gi, REDACTED],
  [/(?<![A-Za-z0-9+_-])(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{32,}={0,2}/g, REDACTED],
];

export function redactSecrets(text: string): string {
  // Wholly JSON: by structure, secret keys at any depth.
  const json = redactJsonText(text);
  if (json !== null) return json;
  // Multi-line shapes before anything reads line by line.
  let out = text.replace(PEM, REDACTED);
  out = redactTomlMultiline(out);
  // Headers, whole value, any scheme: `Authorization: bearer x`, `"Authorization": "Basic x"`.
  // A quoted value is hidden whole; a bare one after ":" to the end of the line, after "=" to the next space or "&".
  out = out.replace(
    /((?:^|[\s{,"'?&])["']?(?:proxy-)?authorization["']?\s*([:=])\s*)(?!\s|["']?•••)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s}][^\n}]*)/gi,
    (_match, head: string, sep: string, value: string) => {
      if (quoteOf(value)) return `${head}${quoteOf(value)}${REDACTED}${quoteOf(value)}`;
      const rest = sep === "=" ? value.replace(/^[^\s&,;]+/, "") : value.replace(/^.*?(\s*)$/, "$1");
      return `${head}${REDACTED}${rest}`;
    },
  );
  out = redactFlags(out);
  // Whole YAML-style lines before single words, so `api_key: two words` is hidden whole.
  out = redactColonLines(out);
  out = redactPairs(out);
  // Basic and Token with a credential-shaped value, anywhere.
  out = out.replace(/\b(basic|token)\s+(?!•••)([A-Za-z0-9+/=._~-]+)/gi, (match, scheme: string, value: string) => (credentialShaped(value) ? `${scheme} ${REDACTED}` : match));
  for (const [pattern, replacement] of SHAPES) out = out.replace(pattern, replacement);
  return out;
}

/**
 * An argument list as the app may show it: a secret flag's value (`--token X`,
 * `--token=X`, `-p X` unless X is a port) and an environment-style
 * `FOO_TOKEN=X` are hidden by position, not by guessing at the value; every
 * other item still goes through `redactSecrets`.
 */
export function redactArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const flag = /^(--?[A-Za-z][A-Za-z0-9_-]*)(=)([\s\S]*)$/.exec(arg);
    if (flag && isSecretFlag(flag[1], flag[3])) {
      out.push(`${flag[1]}=${REDACTED}`);
      continue;
    }
    const env = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(arg);
    if (env && isSecretName(env[1])) {
      out.push(`${env[1]}=${REDACTED}`);
      continue;
    }
    // The item after a secret flag is always its value, even "-fixtureSecret" (0.20.0).
    if (/^(--[A-Za-z][A-Za-z0-9_-]*|-p)$/.test(arg) && index + 1 < args.length && isSecretFlag(arg, args[index + 1])) {
      out.push(arg, REDACTED);
      index += 1;
      continue;
    }
    out.push(redactSecrets(arg));
  }
  return out;
}

/** A command line as the app shows it with keys hidden: the program, then its arguments through `redactArgs`. */
export function displayCommand(command: string, args: readonly string[] = []): string {
  return [command, ...redactArgs(args)].filter(Boolean).join(" ");
}

/**
 * A failed CLI step as the user sees it: a fixed sentence and how to see more.
 * The CLI's own output is left out entirely, since a provider can print
 * anything (0.20.0 review: no arbitrary CLI detail in a toast).
 */
export function cliFailure(what: string, command: string, code: number | null): string {
  const how = code === null ? `${command} didn't finish` : `${command} stopped with code ${code}`;
  return `${what} (${how}). Run it in a terminal to see why.`;
}
