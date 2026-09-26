import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { BUDGET_ATTENTION, BUDGET_PROBLEM, budgetTier } from "./budget";
import { DEFAULT_LIBRARIES, LibrariesSchema, migrateCatalogValues } from "./library-source";
import { sha256Hex } from "./sha256";

/**
 * Add from catalogue (0.12.0): three shelves of MCP servers the user can add
 * without knowing a URL, a command or a config format.
 *
 *   - Recommended: shipped with the plugin (shared/catalog-curated.ts), every
 *     URL copied from the vendor's own docs.
 *   - Team: a file or URL the user points the plugin at, same entry shape.
 *   - Registry: a search of the official MCP Registry. Official only when
 *     every address is one the Recommended shelf checked; Community otherwise.
 *
 * 0.13.0 adds libraries (shared/library.ts): catalogues the gallery subscribes
 * to by address or file. The team catalogue is now one of them, and a
 * registry (the official one included, off by default) is another kind.
 *
 * Everything in this file is pure so it can be unit-tested; the server fetches
 * and writes, the client renders. No entry ever carries a literal secret:
 * values the user fills in are `{INPUT}` placeholders. No entry carries a
 * `${VAR}` reference either: the plugin writes those itself, only at project
 * scope, and only under names it built (see envVarNames).
 */

// ------------------------------------------------------------------ entries

export const CATALOG_CATEGORIES = [
  "developer",
  "data",
  "docs",
  "productivity",
  "design",
  "crm",
  "support",
  "marketing",
  "analytics",
  "payments",
  "automation",
  "other",
] as const;

export const CATEGORY_LABELS: Record<string, string> = {
  developer: "Developer tools",
  data: "Databases",
  docs: "Docs",
  productivity: "Work tracking",
  design: "Design",
  crm: "CRM",
  support: "Support",
  marketing: "Marketing",
  analytics: "Analytics",
  payments: "Payments",
  automation: "Automation",
  other: "Other",
};

const INPUT_ID = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * One value the user fills in at install time. `secret` fields are masked and
 * never go into a project file. Secret is the default and mostly the rule: an
 * input is public only when its name is on a short list (see publicInputName)
 * and nothing about its position or value says otherwise (see
 * credentialInputIds, looksLikeCredentialValue). The variable a
 * project file refers to is named by the plugin (envVarNames), never by the
 * entry: an `envVar` field in an old team file is ignored.
 */
export const CatalogInputSchema = z.object({
  id: z.string().regex(INPUT_ID),
  label: z.string().min(1).max(80),
  secret: z.boolean().default(true),
  required: z.boolean().default(true),
  hint: z.string().max(200).optional(),
});
export type CatalogInput = z.output<typeof CatalogInputSchema>;

/** `unknown`: a registry remote that lists no headers, which the registry cannot tell apart from OAuth or no sign-in at all. */
export const CatalogAuthSchema = z.enum(["oauth", "header", "env", "none", "unknown"]);
export type CatalogAuth = z.infer<typeof CatalogAuthSchema>;

export const CatalogEntrySchema = z.object({
  id: z.string().regex(SERVER_NAME),
  name: z.string().min(1).max(80),
  publisher: z.string().max(120).default(""),
  description: z.string().max(400).default(""),
  category: z.string().max(40).default("other"),
  transport: z.enum(["http", "stdio"]),
  url: z.string().max(2048).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  command: z.string().max(512).optional(),
  args: z.array(z.string().max(1024)).max(64).optional(),
  env: z.record(z.string(), z.string()).optional(),
  inputs: z.array(CatalogInputSchema).max(16).optional(),
  auth: CatalogAuthSchema,
  docs: z.string().max(2048).default(""),
  verifiedAt: z.string().max(40).default(""),
  /** An https image shown on the card; never fetched by the host. */
  iconUrl: z.string().max(2048).optional(),
});
export type CatalogEntry = z.output<typeof CatalogEntrySchema>;

export type Shelf = "recommended" | "team" | "library" | "registry";
export type Trust = "official" | "team" | "library" | "community";

export const CatalogCardSchema = z.object({
  /** `<shelf>:<id>`, `library:<library id>:<server name>`, or `registry:<registry name>`: what the install RPCs take. */
  key: z.string(),
  shelf: z.enum(["recommended", "team", "library", "registry"]),
  entry: CatalogEntrySchema,
  trust: z.enum(["official", "team", "library", "community"]),
  /** Why the badge says what it says, in a sentence. */
  trustNote: z.string(),
  /** A plain warning for community entries; "" otherwise. */
  warning: z.string(),
  installable: z.boolean(),
  blockedReason: z.string(),
  version: z.string().optional(),
  registryName: z.string().optional(),
  /** The library the card came from (team, library and registry cards). */
  library: z.object({ id: z.string(), name: z.string() }).optional(),
  /** Where this card's endpoint is already defined (see addedFor); absent when nowhere. */
  added: z
    .object({
      label: z.string(),
      name: z.string(),
      editors: z.array(z.string()),
      projects: z.array(z.string()),
    })
    .optional(),
});
export type CatalogCard = z.output<typeof CatalogCardSchema>;
export type CatalogAdded = NonNullable<CatalogCard["added"]>;

// ------------------------------------------------------------ placeholders

const BRACE = /\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/g;

/** `{INPUT}` placeholders in a template, in order. */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(BRACE)].map((match) => match[1] ?? "");
}

/** What is left of a template once every placeholder is taken out. */
function literalPart(text: string): string {
  return text.replace(BRACE, " ");
}

/**
 * True when text holds a `${…}` reference, which Claude Code expands from its
 * environment. An entry never may: `${UNSET:-sk_live_…}` hides a literal key
 * in the fallback, and `${GITHUB_TOKEN}` picks which of the user's variables
 * goes to the server.
 */
export function hasEnvReference(text: string): boolean {
  return text.includes("${");
}

// ------------------------------------------------------------ text hygiene

/** Control characters TOML and JSON configs must not hold as typed: U+0000–U+001F and U+007F. */
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
/** Half of a UTF-16 pair with no other half: no config format can write it. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** True when text holds a control character or a lone surrogate. */
export function hasUnwritableChar(text: string): boolean {
  return CONTROL_CHAR.test(text) || LONE_SURROGATE.test(text);
}

/**
 * Characters that change how text reads without being seen: bidi controls
 * (U+202A–202E, U+2066–2069, U+200E/F, U+061C), zero-width characters and the
 * other control characters. "\u202eOfficial" would otherwise show a reversed
 * word; a zero-width space splits a name that looks whole.
 */
const INVISIBLE = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\ufeff]|${LONE_SURROGATE.source}`, "g");

/** Text from a team file or the registry as it may be shown: line breaks and tabs become spaces, invisible characters go. */
export function cleanText(text: string): string {
  return text.replace(/[\t\n\r]+/g, " ").replace(INVISIBLE, "");
}

/** At most `max` UTF-16 units (what the schemas count), cut between code points, never inside a pair. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = "";
  for (const point of text) {
    if (out.length + point.length > max) break;
    out += point;
  }
  return out;
}

// ------------------------------------------------------------ secret sniffing

/** Header and env names that carry credentials (same test the server uses for inline credentials). */
export const SECRETISH_NAME = /(token|secret|key|password|passwd|auth|bearer|credential|cookie|session|signature)/i;

const KNOWN_SECRET = new RegExp(
  [
    String.raw`\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}`,
    String.raw`\bsk-[A-Za-z0-9_-]{16,}`,
    String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`,
    String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
    String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`,
    String.raw`\bAKIA[0-9A-Z]{16}\b`,
    String.raw`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`,
    String.raw`\bglpat-[A-Za-z0-9_-]{16,}`,
    String.raw`\bnpm_[A-Za-z0-9]{30,}`,
    String.raw`\bph[xc]_[A-Za-z0-9]{20,}`,
    String.raw`\bdop_v1_[a-f0-9]{20,}`,
  ].join("|"),
);

/**
 * True when text reads like a credential: a known token prefix, or a long run
 * of letters and digits mixed, the shape of a random key. Deliberately loose;
 * it runs on values that are supposed to hold placeholders, where a false
 * alarm costs a rename and a miss costs a leaked key.
 */
export function looksLikeSecret(text: string): boolean {
  if (KNOWN_SECRET.test(text)) return true;
  // Runs never cross "/" or ".", so a path or a host name is judged a piece at
  // a time; words joined by - or _ ("supabase-mcp-lite") are not a key.
  const mixed = (piece: string) => /[A-Za-z]/.test(piece) && /[0-9]/.test(piece);
  for (const run of text.match(/[A-Za-z0-9+=_-]{20,}/g) ?? []) {
    if (run.split(/[-_]/).some((piece) => piece.length >= 20 && mixed(piece))) return true;
    if (run.length >= 32 && (run.match(/[0-9]/g) ?? []).length >= 6 && mixed(run)) return true;
  }
  return false;
}

const CREDENTIAL_URL = /:\/\/[^/\s@]*:[^@\s]*@/;
const CREDENTIAL_PREFIX = /^\s*(sk-|sk_|ghp_|gho_|xox|eyJ)/;
const SLACK_WEBHOOK = /hooks\.slack\.com\/services\//i;

/**
 * A value that is a credential whatever its input is called: an address with
 * a password in it (`postgresql://app:pw@db`), a well-known token prefix, a
 * Slack webhook, or anything looksLikeSecret flags. Checked on what the user
 * types and on a registry input's default.
 */
export function looksLikeCredentialValue(value: string): boolean {
  return CREDENTIAL_URL.test(value) || CREDENTIAL_PREFIX.test(value) || SLACK_WEBHOOK.test(value) || looksLikeSecret(value);
}

/** The only names an input may have and still be public. Everything else is secret. */
export const PUBLIC_INPUT_NAMES = [
  "region", "project", "project_id", "workspace", "workspace_id", "org", "org_id", "organization", "team", "team_id",
  "site", "host", "port", "database", "db_name", "schema", "env", "environment", "locale", "timezone", "mode",
] as const;
const PUBLIC_NAMES = new Set<string>(PUBLIC_INPUT_NAMES);

/**
 * True when an input, or the header or env line it fills, may be public: its
 * name, in any case and with `_` or `-` between words, is on the list as the
 * whole name or as its last words (`REGION`, `aws-region`, `MONGO_DB_NAME`,
 * `X-Region`), and nothing in it reads like a credential (`AUTH_MODE` is not).
 */
export function publicInputName(name: string): boolean {
  if (SECRETISH_NAME.test(name)) return false;
  const words = name.toLowerCase().split(/[_-]+/).filter(Boolean);
  return words.length > 0 && [words.join("_"), words.slice(-2).join("_"), words.slice(-1).join("_")].some((tail) => PUBLIC_NAMES.has(tail));
}

/** A credential header's literal text may be a scheme word and separators only: `Bearer {TOKEN}`, `{KEY}:{SECRET}`. */
function literalAllowedForCredential(literal: string): boolean {
  return /^\s*(bearer|basic|token|apikey|api-key)?[\s:=,;]*$/i.test(literal.replace(/\s+/g, " "));
}

// -------------------------------------------------------------- validation

export type EntryOrigin = "curated" | "team" | "registry";

function parseTemplateUrl(url: string): URL | null {
  try {
    return new URL(url.replace(BRACE, "x"));
  } catch {
    return null;
  }
}

function safeDecode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/** Does this argument (with the one before it) carry a credential: `--token=…`, or the value after `--api-key`? */
function credentialArg(arg: string, previous: string): boolean {
  return (arg.includes("=") && SECRETISH_NAME.test(arg.split("=")[0] ?? "")) || (/^--?/.test(previous) && SECRETISH_NAME.test(previous));
}

/**
 * Inputs that are secret whatever the entry says:
 *   - any input whose own name is not on the public list (publicInputName);
 *   - one in a header or env line whose name is not on it: Authorization,
 *     X-Access, DATABASE_URL, SLACK_WEBHOOK_URL;
 *   - one in the URL's query string, or in a credential argument;
 *   - for a team or registry entry, one anywhere in the URL (host and path
 *     too) or in any argument (a bare database address, the value after `-k`
 *     or `--connection-string`): nothing there says what it holds.
 * So a team file or registry entry cannot mark a key `secret: false` and have
 * it written into a project file as typed. Unknown origin counts as team.
 */
export function credentialInputIds(entry: CatalogEntry, origin: EntryOrigin = "team"): Set<string> {
  const ids = new Set<string>();
  const add = (text: string) => placeholdersIn(text).forEach((id) => ids.add(id));
  for (const input of entry.inputs ?? []) if (!publicInputName(input.id)) ids.add(input.id);
  for (const [name, value] of Object.entries(entry.headers ?? {})) if (!publicInputName(name)) add(value);
  for (const [name, value] of Object.entries(entry.env ?? {})) if (!publicInputName(name)) add(value);
  if (origin !== "curated") {
    add(entry.url ?? "");
    (entry.args ?? []).forEach(add);
    return ids;
  }
  add(/\?([^#]*)/.exec(entry.url ?? "")?.[1] ?? "");
  (entry.args ?? []).forEach((arg, index) => {
    if (credentialArg(arg, index > 0 ? (entry.args ?? [])[index - 1] ?? "" : "")) add(arg);
  });
  return ids;
}

/** The entry with every input credentialInputIds names marked secret. */
export function withCredentialSecrets(entry: CatalogEntry, origin: EntryOrigin = "team"): CatalogEntry {
  if (!entry.inputs?.length) return entry;
  const forced = credentialInputIds(entry, origin);
  if (!entry.inputs.some((input) => forced.has(input.id) && !input.secret)) return entry;
  return { ...entry, inputs: entry.inputs.map((input) => (forced.has(input.id) ? { ...input, secret: true } : input)) };
}

// ------------------------------------------------------------ packages

const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PYPI_NAME = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
/** A PEP 440 version, normalised form (epoch, release, pre, post, dev, local). */
const EXACT_PEP440 = /^([1-9]\d*!)?(0|[1-9]\d*)(\.(0|[1-9]\d*))*((a|b|rc)(0|[1-9]\d*))?(\.post(0|[1-9]\d*))?(\.dev(0|[1-9]\d*))?(\+[a-z0-9]+(\.[a-z0-9]+)*)?$/;
/** Runner flags that choose where the code comes from, or run a shell command instead of the package. */
const SOURCE_FLAG = /^(-c|--call|-p|--package|--registry|--userconfig|--prefix|-i|--index|--index-url|--extra-index-url|--default-index|-f|--find-links|--with|--with-requirements|--with-editable)(=|$)/;

/** A package name and the version asked for: `@scope/name@1.2.3`, `name==1.2.3` or `name@1.2.3`. */
function splitPackageSpec(ecosystem: "npm" | "pypi", spec: string): { name: string; version: string } {
  if (ecosystem === "pypi") {
    const at = /^(.*?)(==|@)(.*)$/.exec(spec);
    return at ? { name: at[1] ?? "", version: at[3] ?? "" } : { name: spec, version: "" };
  }
  const at = spec.lastIndexOf("@");
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec, version: "" };
}

/** The package name on its ecosystem's allowlist: no leading `-`, no `:`, no `/` but an npm scope's, no space. */
export function packageNameOk(ecosystem: "npm" | "pypi", name: string): boolean {
  if (ecosystem === "pypi") return PYPI_NAME.test(name);
  return NPM_NAME.test(name) && !/(^|\/)-/.test(name);
}

/**
 * What is wrong with the package an npm or PyPI runner would start, for a
 * recommended or team entry ([] when nothing is, or the command is not one of
 * those runners). The name must be on the allowlist and the version exact:
 * `latest`, a range, `*`, none or an address would let whoever publishes next
 * decide what runs. One exception, for recommended entries only: `latest`.
 * Playwright's own docs install `@playwright/mcp@latest`; the plugin's authors
 * checked that package, and a team file or the registry cannot use the same
 * word. Runner flags that pick another source (`-p`, `--registry`,
 * `--index-url`, `--with`) or run a shell command (`-c`, `--call`) are refused.
 */
export function packageProblems(entry: Pick<CatalogEntry, "command" | "args">, origin: EntryOrigin): string[] {
  const found = packageSpec(entry);
  const command = runnerName(entry.command);
  const args = entry.args ?? [];
  const runner = ["npx", "bunx", "pnpx", "uvx"].includes(command) || (command === "npm" && ["exec", "x"].includes(args[0] ?? "")) || (command === "pipx" && args[0] === "run");
  if (!found) return runner ? [`${command} is given no package to run`] : [];
  if (found.ecosystem === "oci") return [];
  const issues: string[] = [];
  for (const flag of args.slice(found.start, found.index)) {
    if (SOURCE_FLAG.test(flag)) issues.push(`the runner flag '${cleanText(flag.split("=")[0] ?? flag)}' picks where the code comes from; name the package on its own`);
  }
  const { name, version } = splitPackageSpec(found.ecosystem, found.spec);
  if (!packageNameOk(found.ecosystem, name)) {
    issues.push(`'${cutText(cleanText(name), 80)}' is not a plain ${found.ecosystem === "npm" ? "npm" : "PyPI"} package name`);
  } else if (!(origin === "curated" && version === "latest")) {
    const exact = found.ecosystem === "npm" ? EXACT_SEMVER.test(version) : EXACT_PEP440.test(version);
    if (!exact) issues.push(`${name} needs an exact version (${found.ecosystem === "npm" ? `${name}@1.2.3` : `${name}==1.2.3`}); '${cutText(cleanText(version), 40) || "none"}' is not one`);
  }
  return issues;
}

/**
 * Variables that change how a command or its runner starts, or what it
 * loads: Node's options, npm/uv/pip configuration (a registry, an index),
 * Python's path, the dynamic loader, PATH, HOME and SHELL. A team entry may
 * not set these, nor any name on RESERVED_ENV_NAMES. Case does not matter
 * (npm reads `npm_config_*` too).
 */
const RUNTIME_ENV = /^(NODE_OPTIONS|NPM_CONFIG_|UV_|PIP_|PYTHON|PATH$|LD_|DYLD_|HOME$|SHELL$)/i;

export function runtimeEnvName(name: string): boolean {
  return RUNTIME_ENV.test(name) || reservedEnvName(name);
}

/**
 * Every rule an entry must pass before it is shown as installable. Returns
 * plain-English problems, empty when the entry is fine. The same rules cover
 * the shipped list and a team file, so a team entry cannot do what the
 * plugin's own entries may not: plain http, a password in the URL, or a key
 * written into a header, an env value, an argument or a query string.
 */
export function validateEntry(entry: CatalogEntry, origin: EntryOrigin): string[] {
  const issues: string[] = [];
  const declared = new Map((entry.inputs ?? []).map((input) => [input.id, input] as const));
  const used = new Set<string>();
  const secretIn = (where: string) => `${where} holds what looks like a literal key; use a {PLACEHOLDER} the user fills in`;

  const checkTemplate = (where: string, value: string, credential: boolean) => {
    if (hasUnwritableChar(value)) issues.push(`${where} holds a control character`);
    if (hasEnvReference(value)) issues.push(`${where} holds a \${…} reference; use a {PLACEHOLDER} input (the plugin writes \${VAR} itself where it is safe)`);
    for (const id of placeholdersIn(value)) {
      used.add(id);
      if (!declared.has(id)) issues.push(`${where} uses {${id}}, which is not in inputs`);
    }
    const literal = literalPart(value);
    if (looksLikeSecret(literal)) issues.push(secretIn(where));
    else if (credential && literal.trim() !== "" && !literalAllowedForCredential(literal)) issues.push(secretIn(where));
  };

  if (entry.transport === "http") {
    if (!entry.url) issues.push("an HTTP server needs a url");
    if (entry.command || entry.args?.length || (entry.env && Object.keys(entry.env).length)) {
      issues.push("an HTTP server has a url and headers, not a command, args or env");
    }
    const parsed = entry.url ? parseTemplateUrl(entry.url) : null;
    if (entry.url && !parsed) issues.push("url is not a valid address");
    // The address parser drops tabs and line breaks, so the text as written is checked too.
    if (entry.url && hasUnwritableChar(entry.url)) issues.push("url holds a control character");
    if (entry.url && hasEnvReference(entry.url)) checkTemplate("url", entry.url, false);
    if (parsed) {
      if (parsed.protocol !== "https:") issues.push("url must be https");
      if (parsed.username || parsed.password) issues.push("url carries a user name or password; use a header input instead");
      const path = safeDecode(parsed.pathname);
      if (path === null) issues.push("url path has a broken % escape");
      else checkTemplate("url path", path, false);
      let query: URLSearchParams | null = null;
      try {
        query = new URL(entry.url!).searchParams;
      } catch {
        query = parsed.searchParams;
      }
      for (const [key, value] of query.entries()) {
        checkTemplate(`url query ${key}`, value, SECRETISH_NAME.test(key));
      }
      for (const id of placeholdersIn(entry.url!)) {
        used.add(id);
        if (!declared.has(id)) issues.push(`url uses {${id}}, which is not in inputs`);
      }
    }
    for (const [name, value] of Object.entries(entry.headers ?? {})) {
      // No `.`: a TOML writer that ever wrote the name bare would nest a table under it.
      if (!/^[A-Za-z0-9!#$%&'*+^_`|~-]+$/.test(name)) issues.push(`header name '${cleanText(name)}' is not valid`);
      checkTemplate(`header ${name}`, value, SECRETISH_NAME.test(name));
    }
  } else {
    if (!entry.command) issues.push("a command server needs a command");
    if (entry.url || (entry.headers && Object.keys(entry.headers).length)) issues.push("a command server has a command and env, not a url or headers");
    if (entry.command && /\s/.test(entry.command)) issues.push("command is the program only; put its arguments in args");
    if (entry.command) checkTemplate("command", entry.command, false);
    (entry.args ?? []).forEach((arg, index) => {
      const previous = index > 0 ? (entry.args ?? [])[index - 1] ?? "" : "";
      const credential = credentialArg(arg, previous);
      if (credential && arg.includes("=") && hasUnwritableChar(arg)) issues.push(`argument ${index + 1} holds a control character`);
      checkTemplate(`argument ${index + 1}`, credential && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg, credential);
    });
    issues.push(...packageProblems(entry, origin));
    for (const [name, value] of Object.entries(entry.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) issues.push(`env name '${cleanText(name)}' is not valid`);
      else if (origin !== "curated" && runtimeEnvName(name)) issues.push(`env ${name} changes how the command or its runner starts; a team entry can't set it`);
      checkTemplate(`env ${name}`, value, SECRETISH_NAME.test(name));
    }
  }

  for (const id of declared.keys()) if (!used.has(id)) issues.push(`input ${id} is declared but never used`);
  if (entry.auth === "header" && !(entry.headers && Object.keys(entry.headers).length)) issues.push("auth is header but no header is set");
  if (entry.auth === "env" && !(entry.env && Object.keys(entry.env).length)) issues.push("auth is env but no env is set");
  if ((entry.auth === "oauth" || entry.auth === "header") && entry.transport !== "http") issues.push(`auth ${entry.auth} needs an HTTP server`);
  if (entry.docs) {
    const docs = parseTemplateUrl(entry.docs);
    if (!docs || docs.protocol !== "https:") issues.push("docs must be an https link");
    if (hasEnvReference(entry.docs)) issues.push("docs holds a ${…} reference");
  }
  if (entry.iconUrl !== undefined && !httpsImage(entry.iconUrl)) issues.push("iconUrl must be an https link");
  if (origin === "curated") {
    if (!entry.docs) issues.push("a recommended entry must cite the vendor's docs");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.verifiedAt)) issues.push("a recommended entry needs verifiedAt as YYYY-MM-DD");
    if (!entry.publisher) issues.push("a recommended entry needs a publisher");
  }
  return [...new Set(issues)];
}

/** An https address an image may be shown from: parses, https, no user name, no control character. */
export function httpsImage(link: string): boolean {
  if (link.length > 2048 || hasUnwritableChar(link)) return false;
  try {
    const url = new URL(link);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ team catalogue

/**
 * The line JSON.parse stops on, found without showing its message: the
 * shortest prefix that fails before its own end ends at the bad character.
 * A prefix that only runs out ("Unexpected end", or a position at its end)
 * is not a failure yet.
 */
export function jsonErrorLine(text: string): number {
  const failsEarly = (length: number): boolean => {
    try {
      JSON.parse(text.slice(0, length));
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/end of JSON input/i.test(message)) return false;
      const at = /position (\d+)/.exec(message);
      return !(at && Number(at[1]) >= length);
    }
  };
  let low = 0;
  let high = text.length;
  if (!failsEarly(high)) return text.split("\n").length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (failsEarly(middle)) high = middle;
    else low = middle + 1;
  }
  return text.slice(0, Math.max(0, low - 1)).split("\n").length;
}

export type TeamParse = {
  entries: CatalogEntry[];
  refused: Array<{ id: string; reason: string }>;
  /** A problem with the file as a whole; entries is empty when set. */
  error: string;
};

export const TEAM_MAX_BYTES = 1024 * 1024;
export const TEAM_MAX_ENTRIES = 500;

/**
 * A team catalogue is JSON: a list of entries, or `{ "entries": [...] }`. Each
 * entry goes through the same rules as the shipped list; one that fails is
 * refused by id with the reason, the rest still show. An entry carrying a
 * literal secret is refused outright, never shown with the value in it.
 */
export function parseTeamCatalogue(text: string): TeamParse {
  if (text.length > TEAM_MAX_BYTES) return { entries: [], refused: [], error: `the file is ${Math.round(text.length / 1024)} KB; a catalogue should be well under 1 MB` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Never the parser's message: it quotes the text, and a mistyped path can
    // point at ~/.env or a key file.
    return { entries: [], refused: [], error: `not valid JSON (line ${jsonErrorLine(text)})` };
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries)
      ? (parsed as { entries: unknown[] }).entries
      : null;
  if (!list) return { entries: [], refused: [], error: 'expected a list of entries, or { "entries": [ … ] }' };
  const entries: CatalogEntry[] = [];
  const refused: TeamParse["refused"] = [];
  const seen = new Set<string>();
  for (const [index, raw] of list.slice(0, TEAM_MAX_ENTRIES).entries()) {
    const id = raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }).id : `#${index + 1}`;
    const result = CatalogEntrySchema.safeParse(raw);
    if (!result.success) {
      const first = result.error.issues[0];
      refused.push({ id, reason: first ? `${first.path.join(".") || "entry"}: ${first.message}` : "not a catalogue entry" });
      continue;
    }
    const issues = validateEntry(result.data, "team");
    if (issues.length > 0) {
      refused.push({ id, reason: issues[0] ?? "invalid" });
      continue;
    }
    if (seen.has(result.data.id)) {
      refused.push({ id, reason: "another entry already uses this id" });
      continue;
    }
    seen.add(result.data.id);
    entries.push(withCredentialSecrets(result.data, "team"));
  }
  if (list.length > TEAM_MAX_ENTRIES) refused.push({ id: `#${TEAM_MAX_ENTRIES + 1}…`, reason: `only the first ${TEAM_MAX_ENTRIES} entries are read` });
  // The id and reason quote the file; shown as clean, short text.
  return { entries, refused: refused.map(({ id, reason }) => ({ id: cutText(cleanText(id), 80), reason: cutText(cleanText(reason), 300) })), error: "" };
}

// ------------------------------------------------------------------ trust

/** Two-label public suffixes common enough to matter here (a full list is not worth shipping). */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "gov.au", "edu.au", "co.nz", "org.nz",
  "co.jp", "ne.jp", "or.jp", "com.br", "com.cn", "com.hk", "com.sg", "com.tw", "co.in", "co.kr", "co.za", "com.mx",
  "com.ar", "com.tr", "co.il", "com.my", "com.ph", "com.vn", "co.id",
]);

/** The last two labels of a host name, three under a two-label suffix: `mcp.supabase.com` → `supabase.com`, `api.example.co.uk` → `example.co.uk`. */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  const lastTwo = labels.slice(-2).join(".");
  if (labels.length >= 3 && MULTI_LABEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

/** A registry namespace as the domain it stands for: `com.supabase` → `supabase.com`, `app.vercel.foo` → `foo.vercel.app`. */
export function namespaceDomain(namespace: string): string {
  return namespace.toLowerCase().split(".").reverse().join(".").replace(/\.$/, "");
}

export function normaliseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

export type TrustVerdict = { trust: "official" | "community"; note: string; warning: string };

export const RELAY_WARNING = "A third party relays your traffic and any key you give it.";
export const PACKAGE_WARNING = "Runs code on this server.";

/**
 * Official means every remote address is one the Recommended shelf already
 * checked against the vendor's own docs. Everything else is Community, with a
 * warning that says what that costs. There is no tier in between: the
 * registry checks that a publisher owns the domain (or GitHub account) its
 * namespace names, and nothing about who runs the service behind the address,
 * so a namespace is shown as plain text ("published as supabase.com") and the
 * note says what the registry did and did not check.
 */
export function classifyRegistryServer(
  server: { name: string; remotes: Array<{ url: string }>; packages: number },
  knownOfficialUrls: ReadonlyMap<string, string> = new Map(),
): TrustVerdict {
  const namespace = server.name.split("/")[0] ?? "";
  if (server.remotes.length > 0) {
    const matches = server.remotes.map((remote) => knownOfficialUrls.get(normaliseUrl(remote.url)));
    if (matches.every(Boolean)) {
      return { trust: "official", note: `Same endpoint as the recommended ${matches[0]}, checked against the vendor's docs.`, warning: "" };
    }
  }
  const warning = server.remotes.length > 0 ? RELAY_WARNING : PACKAGE_WARNING;
  if (namespace.startsWith("io.github.")) {
    return { trust: "community", note: `The registry checks the GitHub account ${namespace.slice("io.github.".length)}, not who runs the service.`, warning };
  }
  return { trust: "community", note: `The registry checks that the publisher owns ${namespaceDomain(namespace) || "its namespace"}, not who runs the service.`, warning };
}

// ---------------------------------------------------------------- registry

export const REGISTRY_BASE = "https://registry.modelcontextprotocol.io/v0.1/servers";

export function registrySearchUrl(query: string, limit = 100): string {
  return `${REGISTRY_BASE}?search=${encodeURIComponent(query)}&version=latest&limit=${limit}`;
}

type RegistryInput = { name?: string; description?: string; value?: string; isRequired?: boolean; isSecret?: boolean; default?: string };
type RegistryServer = {
  name?: string;
  description?: string;
  version?: string;
  title?: string;
  websiteUrl?: string;
  repository?: { url?: string };
  remotes?: Array<{ type?: string; url?: string; headers?: RegistryInput[] }>;
  packages?: Array<{
    registryType?: string;
    identifier?: string;
    version?: string;
    transport?: { type?: string };
    environmentVariables?: RegistryInput[];
    packageArguments?: Array<{ isRequired?: boolean }>;
    runtimeArguments?: Array<{ isRequired?: boolean }>;
  }>;
};
type RegistryItem = {
  server?: RegistryServer;
  _meta?: Record<string, { status?: string; isLatest?: boolean; publishedAt?: string } | undefined>;
};

const OFFICIAL_META = "io.modelcontextprotocol.registry/official";

/**
 * The registry's answer, reduced to the latest active version of each name.
 * `version=latest` is asked for already; `isLatest` is checked again here in
 * case a response ignores it, and a name listed twice keeps its newest copy.
 */
export function latestRegistryServers(body: unknown): RegistryServer[] {
  const items = (body as { servers?: RegistryItem[] } | null)?.servers;
  if (!Array.isArray(items)) return [];
  const byName = new Map<string, { server: RegistryServer; publishedAt: string }>();
  for (const item of items) {
    const server = item?.server;
    const meta = item?._meta?.[OFFICIAL_META];
    if (!server?.name || meta?.isLatest !== true) continue;
    if (meta.status && meta.status !== "active") continue;
    const publishedAt = meta.publishedAt ?? "";
    const held = byName.get(server.name);
    if (!held || publishedAt > held.publishedAt) byName.set(server.name, { server, publishedAt });
  }
  return [...byName.values()].map((entry) => entry.server);
}

export function inputIdFrom(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z_]+/, "");
  return (cleaned || "VALUE").slice(0, 64);
}

export function idFromRegistryName(name: string): string {
  const last = name.split("/").pop() ?? name;
  return (last.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "server").slice(0, 64);
}

export function titleFromId(id: string): string {
  return id.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Why a registry server that only ships a package is shown but not added (0.12.0). */
export const REGISTRY_PACKAGE_REASON = "Packages from the public registry aren't added in one click: check the repository and add it by hand.";

const INPUTS_MAX = 16;
const URL_MAX = 2048;
const ARG_MAX = 1024;

/** An https link no longer than the schema allows, or "". */
export function linkOrEmpty(link: string | undefined): string {
  return typeof link === "string" && link.startsWith("https://") && link.length <= URL_MAX && !hasUnwritableChar(link) ? link : "";
}

/**
 * One registry server as a card. Only a remote can be added in one click;
 * a server that ships only a package (npm, PyPI, an image) is shown as
 * Community, "Runs code on this server", with its repository and the reason
 * (REGISTRY_PACKAGE_REASON): the registry checks who owns a namespace, not
 * what a package does or which version is safe to run.
 *
 * Nothing a registry answer holds can break the card: shown text is cleaned
 * (cleanText) and cut to the schema's caps; more than 16 inputs, an address
 * or docs link over 2048 characters, or an address with parts to fill in
 * make it not installable, with the reason, rather than invalid.
 */
export function registryCard(server: RegistryServer, knownOfficialUrls: ReadonlyMap<string, string> = new Map()): CatalogCard {
  const name = typeof server.name === "string" ? server.name : "";
  const id = idFromRegistryName(name);
  const namespace = name.split("/")[0] ?? "";
  const remotes = (Array.isArray(server.remotes) ? server.remotes : []).filter((remote) => typeof remote?.url === "string" && (remote.type === "streamable-http" || remote.type === "sse"));
  const remote = remotes.find((entry) => entry.type === "streamable-http") ?? remotes[0];
  const packages = (Array.isArray(server.packages) ? server.packages : []).filter((item) => item && typeof item === "object");
  const verdict = classifyRegistryServer({ name, remotes: remote ? [{ url: remote.url ?? "" }] : [], packages: packages.length }, knownOfficialUrls);
  const publisher = namespace.startsWith("io.github.") ? `github.com/${namespace.slice("io.github.".length)}` : namespaceDomain(namespace);
  const text = (raw: unknown, max: number) => cutText(cleanText(typeof raw === "string" ? raw : ""), max);
  const repository = typeof server.repository?.url === "string" ? server.repository.url : "";
  const base = {
    id,
    name: text(server.title, 80) || titleFromId(id),
    publisher: text(publisher, 120),
    description: text(server.description, 400),
    category: "other",
    docs: linkOrEmpty(repository) || linkOrEmpty(server.websiteUrl),
    verifiedAt: "",
  };
  let entry: CatalogEntry;
  let blockedReason = "";

  const toInputs = (list: RegistryInput[], template: (item: RegistryInput, id: string) => string) => {
    const record: Record<string, string> = {};
    const inputs: CatalogInput[] = [];
    for (const item of Array.isArray(list) ? list : []) {
      if (!item?.name || typeof item.name !== "string") continue;
      const fallbackId = inputIdFrom(item.name);
      const value = typeof item.value === "string" && item.value ? item.value : template(item, fallbackId);
      const ids = placeholdersIn(value);
      if (ids.length === 0 && !item.value) continue;
      for (const placeholder of ids) {
        if (inputs.some((input) => input.id === placeholder)) continue;
        // Public only when both the header or variable and the input are
        // named on the public list, isSecret is not true, and the default is
        // not a credential. `isSecret: false` alone never makes it public.
        const listed = publicInputName(item.name) && publicInputName(placeholder);
        inputs.push({
          id: placeholder,
          label: text(item.description, 80) || placeholder,
          secret: item.isSecret === true || !listed || looksLikeCredentialValue(typeof item.default === "string" ? item.default : ""),
          required: item.isRequired === true,
          hint: undefined,
        });
      }
      record[item.name] = value;
    }
    return { record, inputs };
  };

  if (remote) {
    const url = remote.url ?? "";
    const { record, inputs } = toInputs(remote.headers ?? [], (_item, inputId) => `{${inputId}}`);
    entry = {
      ...base,
      transport: "http",
      ...(url.length <= URL_MAX ? { url } : {}),
      ...(Object.keys(record).length ? { headers: record } : {}),
      ...(inputs.length ? { inputs: inputs.slice(0, INPUTS_MAX) } : {}),
      auth: Object.keys(record).length ? "header" : "unknown",
    };
    if (url.length > URL_MAX) blockedReason = `Its address is over ${URL_MAX} characters; see its repository.`;
    else if (inputs.length > INPUTS_MAX) blockedReason = `It asks for ${inputs.length} values, more than the ${INPUTS_MAX} the plugin fills in; add it by hand.`;
    else if (placeholdersIn(url).length > 0) blockedReason = "Its address has parts to fill in that the registry does not describe; see its repository.";
  } else {
    // Shown, never added: the package is only named so "Added" can find it.
    const pkg = packages.find((item) => item?.registryType === "npm" || item?.registryType === "pypi");
    const ecosystem = pkg?.registryType === "pypi" ? "pypi" : "npm";
    const identifier = typeof pkg?.identifier === "string" ? pkg.identifier : "";
    const named = pkg && identifier.length <= ARG_MAX && packageNameOk(ecosystem, identifier);
    const listsEnv = Array.isArray(pkg?.environmentVariables) && pkg.environmentVariables.length > 0;
    entry = {
      ...base,
      transport: "stdio",
      ...(named ? { command: ecosystem === "pypi" ? "uvx" : "npx", args: [identifier] } : {}),
      auth: listsEnv ? "env" : "none",
    };
    blockedReason = packages.length === 0 ? "It lists no remote address and no package." : REGISTRY_PACKAGE_REASON;
  }
  entry = withCredentialSecrets(entry, "registry");
  if (!blockedReason) {
    const issues = validateEntry(entry, "registry");
    if (issues.length > 0) blockedReason = cutText(`Not installable here: ${issues[0]}.`, 400);
  }
  return {
    key: `registry:${name}`,
    shelf: "registry",
    entry,
    trust: verdict.trust,
    trustNote: cleanText(verdict.note),
    warning: entry.transport === "stdio" ? PACKAGE_WARNING : verdict.warning,
    installable: blockedReason === "",
    blockedReason,
    version: typeof server.version === "string" ? text(server.version, 64) : undefined,
    registryName: cleanText(name),
  };
}

export function curatedCard(entry: CatalogEntry): CatalogCard {
  return {
    key: `recommended:${entry.id}`,
    shelf: "recommended",
    entry: withCredentialSecrets(entry, "curated"),
    trust: "official",
    trustNote: `Checked against ${entry.publisher}'s docs on ${entry.verifiedAt}.`,
    warning: "",
    installable: true,
    blockedReason: "",
  };
}

/** An entry's shown text (name, publisher, description, input labels and hints) through cleanText. */
export function cleanEntryText(entry: CatalogEntry): CatalogEntry {
  return {
    ...entry,
    name: cleanText(entry.name) || entry.id,
    publisher: cleanText(entry.publisher),
    description: cleanText(entry.description),
    ...(entry.inputs
      ? { inputs: entry.inputs.map((input) => ({ ...input, label: cleanText(input.label) || input.id, ...(input.hint !== undefined ? { hint: cleanText(input.hint) } : {}) })) }
      : {}),
  };
}

export function teamCard(entry: CatalogEntry, source: string): CatalogCard {
  return {
    key: `team:${entry.id}`,
    shelf: "team",
    entry: cleanEntryText(withCredentialSecrets(entry, "team")),
    trust: "team",
    trustNote: `From your team catalogue (${cleanText(source)}).`,
    warning: "",
    installable: true,
    blockedReason: "",
  };
}

// ------------------------------------------------------------------ search

export function cardMatches(card: CatalogCard, query: string, category: string): boolean {
  if (category && category !== "all" && card.entry.category !== category) return false;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [card.entry.id, card.entry.name, card.entry.publisher, card.entry.description, card.registryName ?? "", card.entry.url ?? ""].join(" ").toLowerCase();
  return words.every((word) => hay.includes(word));
}

/**
 * The gallery shows what you don't have yet (0.15.0): a card you already have
 * (`isOwned`; by default the host's `added` match) is left out unless
 * `showAdded` is on, and the count of those left out is kept for the line
 * under the search.
 */
export function hideAdded<T extends Pick<CatalogCard, "added">>(
  cards: readonly T[],
  showAdded: boolean,
  isOwned: (card: T) => boolean = (card) => Boolean(card.added),
): { shown: T[]; hidden: number } {
  if (showAdded) return { shown: [...cards], hidden: 0 };
  const shown = cards.filter((card) => !isOwned(card));
  return { shown, hidden: cards.length - shown.length };
}

/** A server the user has, as far as "already have" needs it. */
export type OwnedServer = { name: string; url?: string; command?: string; args?: string[] };

/** A matrix row as an owned server: its address, or its command line split into a command and arguments. */
export function ownedFromRow(row: { name: string; transport: string; detail: string }): OwnedServer {
  const detail = row.detail.trim();
  if (row.transport === "http") return { name: row.name, url: detail };
  const [command, ...args] = detail.split(/\s+/);
  return { name: row.name, command, args };
}

function hostOf(url: string | undefined): string {
  if (!url || url.includes("{") || hasEnvReference(url)) return "";
  try {
    return new URL(url.trim()).hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Hosts many unrelated servers share (a hosting platform, a tunnel, this
 * computer): being on one says nothing about which server it is, so the host
 * rule skips them.
 */
const SHARED_HOSTS = ["server.smithery.ai", "github.com", "raw.githubusercontent.com", "vercel.app", "netlify.app", "workers.dev", "pages.dev", "onrender.com", "herokuapp.com", "fly.dev", "localhost", "127.0.0.1", "0.0.0.0", "[::1]"];

export function isSharedHost(host: string): boolean {
  if (!host) return true;
  if (/(^|\.)ngrok/.test(host)) return true;
  return SHARED_HOSTS.some((shared) => host === shared || host.endsWith(`.${shared}`));
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Prefixes the user demonstrably names servers with: a first word (`ikit-`) that two or more of their servers share. */
function ownPrefixes(owned: readonly OwnedServer[]): Set<string> {
  const counts = new Map<string, number>();
  for (const server of owned) {
    const name = slug(server.name);
    const cut = name.indexOf("-");
    if (cut <= 0 || cut === name.length - 1) continue;
    const prefix = name.slice(0, cut + 1);
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count >= 2).map(([prefix]) => prefix));
}

/** A user's server name against a card's id or name: EXACTLY the same, once a prefix they use (`ikit-`) and an `-mcp` ending are taken off. `old-github` is not GitHub. */
function nameMatches(owned: string, card: CatalogEntry, prefixes: ReadonlySet<string>): boolean {
  let mine = slug(owned);
  for (const prefix of prefixes) {
    if (mine.startsWith(prefix) && mine.length > prefix.length) {
      mine = mine.slice(prefix.length);
      break;
    }
  }
  mine = mine.replace(/-mcp$/, "");
  if (!mine) return false;
  return [card.id, card.name].map((text) => slug(text).replace(/-mcp$/, "")).filter(Boolean).some((theirs) => mine === theirs);
}

/**
 * "Already have" the way a person thinks of it (0.15.0). A card is one you
 * have when any of your servers:
 * - is at the same endpoint (the host's `added`, or `endpointKey`), or
 * - is on the same host, unless many servers share that host (anything on
 *   `mcp.zapier.com`: paths often carry a personal token, so the address
 *   alone rarely matches; not `vercel.app` or `localhost`), or
 * - runs the same package (npm, PyPI, OCI; any version), not a generic
 *   runner like `mcp-remote`, or
 * - is named exactly after the card's id or name, ignoring case, an `-mcp`
 *   ending, and a prefix two or more of your servers share (`ikit-notion` is
 *   Notion when you also have `ikit-linear`).
 * Returns the first of your servers that matches, or null.
 */
export function alreadyHave(card: Pick<CatalogCard, "added" | "entry">, owned: readonly OwnedServer[]): { name: string; how: "added" | "endpoint" | "host" | "package" | "name" } | null {
  if (card.added) return { name: card.added.name, how: "added" };
  const key = endpointKey(card.entry);
  const host = hostOf(card.entry.url);
  const hostRule = host !== "" && !isSharedHost(host);
  for (const server of owned) {
    const theirs = endpointKey(server);
    if (key && theirs === key) return { name: server.name, how: key.startsWith("pkg:") ? "package" : "endpoint" };
    if (hostRule && hostOf(server.url) === host) return { name: server.name, how: "host" };
  }
  const prefixes = ownPrefixes(owned);
  for (const server of owned) {
    if (nameMatches(server.name, card.entry, prefixes)) return { name: server.name, how: "name" };
  }
  return null;
}

/** On a card shown through "Show ones I already have": "You have a Zapier server already, called ikit-zapier." */
export function alreadyHaveLine(card: Pick<CatalogCard, "entry">, have: { name: string }): string {
  const vendor = card.entry.name || card.entry.id;
  return slug(have.name) === slug(vendor) || slug(have.name) === slug(card.entry.id)
    ? `You have a ${vendor} server already.`
    : `You have a ${vendor} server already, called ${have.name}.`;
}

/** "12 you already have are hidden." — or "" when none are. */
export function hiddenLine(hidden: number): string {
  if (hidden <= 0) return "";
  return `${hidden} you already have ${hidden === 1 ? "is" : "are"} hidden.`;
}

/**
 * The empty-state line: says what was searched and what came back, so "no
 * results" never reads as "nothing exists". Example: "Searched the registry
 * and 31 recommended servers for 'jira': 0 official, 3 community."
 */
export function searchSummary(input: {
  query: string;
  recommended: number;
  team: number;
  /** Servers from libraries other than the team one (0.13.0). */
  library?: number;
  registrySearched: boolean;
  shown: CatalogCard[];
}): string {
  const libraryTotal = input.library ?? 0;
  const places: string[] = [];
  if (input.registrySearched) places.push("the registry");
  places.push(`${input.recommended} recommended server${input.recommended === 1 ? "" : "s"}`);
  if (libraryTotal > 0) places.push(`${libraryTotal} library server${libraryTotal === 1 ? "" : "s"}`);
  if (input.team > 0) places.push(`${input.team} team server${input.team === 1 ? "" : "s"}`);
  const joined = places.length > 1 ? `${places.slice(0, -1).join(", ")} and ${places[places.length - 1]}` : places[0];
  const official = input.shown.filter((card) => card.trust === "official").length;
  const team = input.shown.filter((card) => card.trust === "team").length;
  const library = input.shown.filter((card) => card.trust === "library").length;
  const community = input.shown.filter((card) => card.trust === "community").length;
  const counts = [`${official} official`, ...(libraryTotal > 0 ? [`${library} library`] : []), ...(input.team > 0 ? [`${team} team`] : []), `${community} community`].join(", ");
  return input.query.trim() ? `Searched ${joined} for '${input.query.trim()}': ${counts}.` : `Showing ${joined}: ${counts}.`;
}

// ----------------------------------------------------------------- install

export type InstallScope = "user" | "project";

/**
 * Names the plugin never writes as a `${VAR}`: ones Claude Code reads itself
 * (its MCP settings and OAuth client secret, checked against Claude Code
 * 2.1.280), ones it refuses to expand toward a remote server ("Credential
 * variables that read as empty", code.claude.com/docs/en/mcp), and ones common
 * tools use. A generated name that equals or starts with one is refused.
 * The one list; envVarNames and planInstall read it from here.
 */
export const RESERVED_ENV_NAMES = [
  "MCP_CLIENT_SECRET", "MCP_CLIENT_ID", "MCP_CLIENT_METADATA_URL", "MCP_OAUTH_", "MCP_TIMEOUT", "MCP_TOOL_TIMEOUT",
  "MCP_CONNECT_TIMEOUT_MS", "MCP_CONNECTION_NONBLOCKING", "MCP_SERVER_CONNECTION_BATCH_SIZE", "MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE",
  "MCP_DISCOVERY_CACHE", "MCP_PROXY_", "MCP_PROTOCOL_", "MCP_TRUNCATION_", "MCP_XAA_", "MCP_APP_", "MAX_MCP_OUTPUT_TOKENS",
  "ANTHROPIC_", "CLAUDE_", "AWS_", "GOOGLE_", "GCLOUD_", "AZURE_", "VERTEX_", "BEDROCK_",
  "NPM_TOKEN", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
] as const;

export function reservedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return RESERVED_ENV_NAMES.some((reserved) => upper === reserved || upper.startsWith(reserved));
}

/** Capitals, digits and single `_` only: a token never holds `__`, so `__` can join tokens unambiguously. */
function envToken(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

/** What a team or registry entry connects to, for its variable names: the address, or the package with its ecosystem. */
function endpointIdentity(entry: Pick<CatalogEntry, "url" | "command" | "args">): string {
  if (entry.url) return `url:${entry.url.trim()}`;
  return packageKey(entry) || `cmd:${JSON.stringify([entry.command ?? "", ...(entry.args ?? [])])}`;
}

/**
 * The variable each input becomes in a project file, built here and never
 * taken from the entry, so an entry cannot choose which of the user's
 * variables (`OPENAI_API_KEY`, `GITHUB_TOKEN`) Claude Code sends to its server.
 *
 *   - Recommended (ids are ours): `MCP_<ID>_<INPUT>`; an input that repeats
 *     the id is not repeated (digitalocean's DIGITALOCEAN_API_TOKEN is
 *     MCP_DIGITALOCEAN_API_TOKEN).
 *   - Team and registry: `MCP_TEAM__<ID>__<HASH6>__<INPUT>` (`MCP_REG__…`),
 *     HASH6 the first 6 hex of the SHA-256 of the endpoint. The shelf keeps a
 *     registry `digitalocean` off the recommended one's variable, the hash
 *     keeps two entries with one id apart, and `__` (which no token holds)
 *     keeps `a-b` + `C` apart from `a` + `B_C`.
 *
 * Unknown origin counts as team. Reserved names are left to planInstall to refuse.
 */
export function envVarNames(entry: Pick<CatalogEntry, "id" | "inputs"> & Partial<Pick<CatalogEntry, "url" | "command" | "args">>, origin: EntryOrigin = "team"): Map<string, string> {
  const server = envToken(entry.id) || "SERVER";
  const names = new Map<string, string>();
  const taken = new Set<string>();
  const curated = origin === "curated";
  const prefix = curated ? `MCP_${server}_` : `MCP_${origin === "registry" ? "REG" : "TEAM"}__${server}__${sha256Hex(endpointIdentity(entry)).slice(0, 6).toUpperCase()}__`;
  for (const input of entry.inputs ?? []) {
    let part = envToken(input.id) || "VALUE";
    if (curated && part.startsWith(`${server}_`)) part = part.slice(server.length + 1);
    const stem = `${prefix}${part}`;
    let name = stem;
    for (let index = 2; taken.has(name); index += 1) name = `${stem}${curated ? "_" : "__"}${index}`;
    taken.add(name);
    names.set(input.id, name);
  }
  return names;
}

export type InstallPlan = {
  ok: boolean;
  issues: string[];
  /** The server as Claude-shaped JSON, ready for the writers. */
  definition: Record<string, unknown>;
  /** The same definition with each secret the user typed masked, for previews. A project plan holds no typed secret, so there it equals `definition`. */
  masked: Record<string, unknown>;
  /** Project scope: variables the user must set where the agent starts. */
  envToSet: Array<{ name: string; label: string }>;
};

export function maskSecret(value: string): string {
  return value.length > 8 ? `•••${value.slice(-4)}` : "•••";
}

/** Every template string an entry holds. */
function templatesOf(entry: CatalogEntry): string[] {
  return [entry.url ?? "", entry.command ?? "", ...(entry.args ?? []), ...Object.values(entry.headers ?? {}), ...Object.values(entry.env ?? {})];
}

/**
 * Turn an entry plus what the user typed into the definition to write.
 *
 * User scope fills every placeholder with the value. Project scope never does
 * that for a secret: `.mcp.json` is usually committed, so a secret becomes a
 * `${VAR}` reference that Claude Code expands from its environment when it
 * loads the file ("Environment variable expansion in .mcp.json",
 * code.claude.com/docs/en/mcp), and the user is told which variables to set.
 * An input is secret unless credentialInputIds lets it be public, and a
 * typed value that reads like a credential is secret whatever its input is
 * called. Only public inputs (a region, a project id) are written as typed.
 * A variable name Claude Code or a common tool uses itself is refused. As a
 * last guard, a project definition that still reads like a key, or holds any
 * `${…}` the plugin did not write, is refused. `origin` is the entry's shelf;
 * unknown counts as team, the strictest.
 */
export function planInstall(original: CatalogEntry, scope: InstallScope, values: Record<string, string>, origin: EntryOrigin = "team"): InstallPlan {
  const entry = withCredentialSecrets(original, origin);
  const issues: string[] = [];
  const envToSet: InstallPlan["envToSet"] = [];
  const inputs = new Map(
    (entry.inputs ?? []).map((input) => [input.id, { ...input, secret: input.secret || looksLikeCredentialValue((values[input.id] ?? "").trim()) }] as const),
  );
  const varNames = envVarNames(entry, origin);
  const secretValues = new Set<string>();

  if (origin === "registry" && entry.transport === "stdio") issues.push(REGISTRY_PACKAGE_REASON);
  if (templatesOf(entry).some(hasEnvReference)) issues.push("The entry holds a ${…} reference; entries may only use {PLACEHOLDER} inputs.");
  for (const input of inputs.values()) {
    const value = (values[input.id] ?? "").trim();
    if (/[\r\n]/.test(value)) issues.push(`${input.label} must be one line`);
    else if (hasUnwritableChar(value)) issues.push(`${input.label} holds a control character`);
    if (hasEnvReference(value)) issues.push(`${input.label} can't hold \${…}: Claude Code would fill it in from its environment`);
    const needsValue = input.required && (scope === "user" || !input.secret);
    if (needsValue && !value) issues.push(`${input.label} is required`);
    if (input.secret && value) secretValues.add(value);
    if (scope === "project" && input.secret) {
      const name = varNames.get(input.id) ?? "";
      if (reservedEnvName(name)) issues.push(`${name} is a variable Claude Code or a common tool uses itself; add this server at user level instead.`);
      envToSet.push({ name, label: input.label });
    }
  }

  // Build the definition, or its preview: the same fill with each typed secret
  // masked, so the preview shows exactly what is written and hides only what
  // is a secret. A template that refers to an optional input left empty is
  // null (the whole header or env line is then left out).
  const build = (masked: boolean): Record<string, unknown> => {
    const fill = (template: string): string | null => {
      let empty = false;
      const out = template.replace(BRACE, (_match, id: string) => {
        const input = inputs.get(id);
        if (!input) {
          issues.push(`{${id}} has no input`);
          return "";
        }
        if (scope === "project" && input.secret) return `\${${varNames.get(id)}}`;
        const value = (values[id] ?? "").trim();
        if (!value) empty = true;
        return masked && input.secret ? maskSecret(value) : value;
      });
      return empty ? null : out;
    };
    const fillRecord = (record: Record<string, string> | undefined) => {
      const out: Record<string, string> = {};
      for (const [key, template] of Object.entries(record ?? {})) {
        const value = fill(template);
        if (value !== null) out[key] = value;
      }
      return out;
    };
    const definition: Record<string, unknown> = {};
    if (entry.transport === "http") {
      definition.type = "http";
      const url = fill(entry.url ?? "");
      if (url === null) issues.push("the address needs a value that was left empty");
      definition.url = url ?? "";
      const headers = fillRecord(entry.headers);
      if (Object.keys(headers).length) definition.headers = headers;
    } else {
      definition.command = entry.command ?? "";
      const args = (entry.args ?? []).map((arg) => fill(arg));
      if (args.some((arg) => arg === null)) issues.push("an argument needs a value that was left empty");
      if (args.length) definition.args = args.filter((arg): arg is string => arg !== null);
      const env = fillRecord(entry.env);
      if (Object.keys(env).length) definition.env = env;
    }
    return definition;
  };
  const definition = build(false);
  const masked = build(true);

  if (scope === "project") {
    const text = JSON.stringify(definition);
    const leaked = [...secretValues].some((value) => value && text.includes(value));
    let withoutRefs = text;
    for (const name of varNames.values()) withoutRefs = withoutRefs.split(`\${${name}}`).join(" ");
    if (leaked || looksLikeSecret(withoutRefs) || hasEnvReference(withoutRefs)) {
      issues.push("This would put a key into the project's .mcp.json, which is usually in git. Add it at user level instead, or use an entry whose key is an input.");
    }
  }
  return { ok: issues.length === 0, issues: [...new Set(issues)], definition, masked, envToSet };
}

/** First free name: `supabase`, else `supabase-2`, `supabase-3` … */
export function nameClash(name: string, existing: Iterable<string>): { clash: boolean; suggestion: string } {
  const taken = new Set(existing);
  if (!taken.has(name)) return { clash: false, suggestion: name };
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${name}-${index}`.slice(0, 64);
    if (!taken.has(candidate)) return { clash: true, suggestion: candidate };
  }
  return { clash: true, suggestion: `${name}-${Date.now()}`.slice(0, 64) };
}

// ------------------------------------------------------------ copy as entry

/** A host's first label kept as written: a plain word such as `mcp`, `api` or `www`. */
const PLAIN_HOST_LABEL = /^[a-z]{1,12}$/;

/**
 * A path segment kept as written: lowercase letters, digits and `-`, 20 at
 * most, no credential prefix, and letters mixed with digits only as a short
 * version (`v2`), so `sk-abc123` and `hunter2pass` are not kept.
 */
function plainPathSegment(segment: string): boolean {
  if (!/^[a-z0-9-]{1,20}$/.test(segment) || looksLikeCredentialValue(segment)) return false;
  return !(/[a-z]/.test(segment) && /[0-9]/.test(segment)) || /^v\d{1,3}$/.test(segment);
}

/**
 * An address as it may be shared, templated aggressively: only the scheme
 * and host survive as written. The host's first label becomes {HOST_PREFIX}
 * unless it is a plain word; the path is kept only when every segment is
 * plain, and becomes {PATH} otherwise (always when it holds `;` or `%`); each
 * query key becomes PARAM_n with its value an input; the user name, password
 * and fragment are dropped. Null when the address does not parse.
 */
function shareableUrl(raw: string, addInput: (raw: string, label: string) => string): { url: string; publisher: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const [first = "", ...rest] = parsed.hostname.split(".");
  const hostname = [PLAIN_HOST_LABEL.test(first) ? first : addInput("HOST_PREFIX", "Start of the host name"), ...rest].join(".");
  const segments = parsed.pathname.split("/").filter(Boolean);
  const path = /[;%]/.test(parsed.pathname) || !segments.every(plainPathSegment) ? `/${addInput("PATH", "Path")}` : segments.length ? parsed.pathname : "";
  let query = "";
  try {
    const keys = [...parsed.searchParams.keys()];
    query = keys.length ? `?${keys.map((_key, index) => `PARAM_${index + 1}=${addInput(`PARAM_${index + 1}`, `Query parameter ${index + 1}`)}`).join("&")}` : "";
  } catch {
    query = "";
  }
  const publisher = registrableDomain(hostname);
  return { url: `${parsed.protocol}//${hostname}${parsed.port ? `:${parsed.port}` : ""}${path}${query}`, publisher: publisher.includes("{") ? "" : publisher };
}

/**
 * An existing server as a catalogue entry a team can share. Nothing stored on
 * this machine goes into the text: the address is templated (shareableUrl),
 * every header and env value is a {PLACEHOLDER} input, and of a command's
 * arguments only the package it runs and flag names stay as written; every
 * other argument, and every flag's `=value`, is an input. Every input is
 * secret. Null when the server's address cannot be read.
 */
export function entryFromDefinition(
  name: string,
  def: { url?: string; headers?: Record<string, string>; command?: string; args?: string[]; env?: Record<string, string> },
  options: { today: string; oauth: boolean },
): CatalogEntry | null {
  const inputs: CatalogInput[] = [];
  const addInput = (raw: string, label: string) => {
    let id = inputIdFrom(raw).toUpperCase();
    while (inputs.some((input) => input.id === id)) id = `${id}_2`;
    inputs.push({ id, label: label.slice(0, 80) || id, secret: true, required: true });
    return `{${id}}`;
  };
  const id = SERVER_NAME.test(name) ? name : idFromRegistryName(name);
  const base = { id, name: titleFromId(id), description: "", category: "other", docs: "", verifiedAt: options.today };
  if (def.url) {
    const shared = shareableUrl(def.url, addInput);
    if (shared === null) return null;
    const headers: Record<string, string> = {};
    for (const [header, value] of Object.entries(def.headers ?? {})) {
      const scheme = /^(Bearer|Basic|Token)\s+/i.exec(value)?.[0] ?? "";
      headers[header] = `${scheme}${addInput(header, header)}`;
    }
    return {
      ...base,
      publisher: shared.publisher,
      transport: "http",
      url: shared.url,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(inputs.length ? { inputs } : {}),
      auth: Object.keys(headers).length ? "header" : options.oauth ? "oauth" : "none",
    };
  }
  const source = def.args ?? [];
  const found = packageSpec(def);
  const keep = found && !looksLikeCredentialValue(found.spec) && !hasEnvReference(found.spec) ? found.index : -1;
  const args = source.map((arg, index) => {
    if (index === keep || arg === "--" || (keep >= 0 && index < (found?.start ?? 0))) return arg;
    if (arg.startsWith("-") && !looksLikeCredentialValue(arg) && !hasEnvReference(arg)) {
      const equals = arg.indexOf("=");
      if (equals < 0) return arg;
      const flag = arg.slice(0, equals);
      return `${flag}=${addInput(flag.replace(/^-+/, ""), flag)}`;
    }
    const previous = source[index - 1] ?? "";
    const afterFlag = index - 1 !== keep && /^-/.test(previous) && !previous.includes("=");
    return afterFlag ? addInput(previous.replace(/^-+/, ""), `Value of ${previous}`) : addInput(`ARG_${index + 1}`, `Argument ${index + 1}`);
  });
  const env: Record<string, string> = {};
  for (const key of Object.keys(def.env ?? {})) env[key] = addInput(key, key);
  return {
    ...base,
    publisher: "",
    transport: "stdio",
    command: def.command ?? "",
    ...(args.length ? { args } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    ...(inputs.length ? { inputs } : {}),
    auth: Object.keys(env).length ? "env" : "none",
  };
}

// ------------------------------------------------------------------- added

type Ecosystem = "npm" | "pypi" | "oci";

/** Flags whose value is the next argument, for the runners packageSpec reads. */
const VALUE_FLAGS = new Set([
  "-p", "--package", "--python", "--with", "--index-url", "--registry",
  "-e", "--env", "--env-file", "-v", "--volume", "--mount", "--name", "--network", "-w", "--workdir", "--entrypoint",
  "-u", "--user", "--platform", "--pull", "-l", "--label", "-m", "--memory", "--cpus", "--add-host",
]);

/**
 * The package a runner starts: npx, bunx, pnpx and `npm exec` run npm
 * packages; uvx and `pipx run` run PyPI ones; `docker run` an OCI image.
 * `start` is where the runner's own words end (`exec`, `run`). Null for any
 * other command, or when no package is named.
 */
/** A command's program name without its directory or `.cmd`/`.exe`, lowercased: `/usr/local/bin/npx` → `npx`. */
function runnerName(command: string | undefined): string {
  return (command ?? "").split(/[\\/]/).pop()?.replace(/\.(cmd|exe)$/i, "").toLowerCase() ?? "";
}

function packageSpec(def: { command?: string; args?: string[] }): { ecosystem: Ecosystem; spec: string; index: number; start: number } | null {
  const command = runnerName(def.command);
  const args = def.args ?? [];
  let ecosystem: Ecosystem;
  let start = 0;
  if (["npx", "bunx", "pnpx"].includes(command)) ecosystem = "npm";
  else if (command === "npm" && (args[0] === "exec" || args[0] === "x")) [ecosystem, start] = ["npm", 1];
  else if (command === "uvx") ecosystem = "pypi";
  else if (command === "pipx" && args[0] === "run") [ecosystem, start] = ["pypi", 1];
  else if ((command === "docker" || command === "podman") && args[0] === "run") [ecosystem, start] = ["oci", 1];
  else return null;
  for (let index = start; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") continue;
    if (ecosystem === "pypi" && arg.startsWith("--from=")) return { ecosystem, spec: arg.slice("--from=".length), index, start };
    if (ecosystem === "pypi" && arg === "--from") return args[index + 1] ? { ecosystem, spec: args[index + 1] ?? "", index: index + 1, start } : null;
    if (arg.startsWith("-")) {
      if (!arg.includes("=") && VALUE_FLAGS.has(arg)) index += 1;
      continue;
    }
    return { ecosystem, spec: arg, index, start };
  }
  return null;
}

/** `pkg:<ecosystem>:<name>` without a version or tag, or "". */
function packageKey(def: { command?: string; args?: string[] }): string {
  const found = packageSpec(def);
  if (!found) return "";
  const spec = found.spec.trim().toLowerCase();
  const name =
    found.ecosystem === "npm"
      ? spec.replace(/(.)@.*$/, "$1")
      : found.ecosystem === "pypi"
        ? (spec.split(/[[<>=!~@;\s]/)[0] ?? "").replace(/[-_.]+/g, "-")
        : spec.replace(/@.*$/, "").replace(/:[^/]*$/, "");
  return name ? `pkg:${found.ecosystem}:${name}` : "";
}

/**
 * What makes two definitions the same server, whatever they are called: for a
 * remote, the address without credentials, query, fragment, trailing slash or
 * a last `/mcp` or `/sse` (one server's two transports); for a package, its
 * ecosystem and name without a version (packageKey), so an npm package never
 * matches a PyPI one of the same name. "" when there is nothing to match on
 * (an address with parts to fill in, another command, a generic runner).
 */
export function endpointKey(def: { url?: string; command?: string; args?: string[] }): string {
  if (def.url) {
    if (placeholdersIn(def.url).length > 0 || hasEnvReference(def.url)) return "";
    try {
      const url = new URL(def.url.trim());
      const path = url.pathname.replace(/\/+$/, "").replace(/\/(mcp|sse)$/i, "").replace(/\/+$/, "");
      return `url:${url.hostname.toLowerCase().replace(/\.$/, "")}${url.port ? `:${url.port}` : ""}${path.toLowerCase()}`;
    } catch {
      return "";
    }
  }
  const key = packageKey(def);
  // A generic runner, or a package whose real target is an address in its
  // arguments, is a pipe to another server: its package says nothing about
  // which one (`npx mcp-remote https://mcp.linear.app/sse` is not Notion's).
  if (RUNNER_PACKAGES.has(key) || (def.args ?? []).some((arg) => /^https?:\/\//i.test(arg))) return "";
  return key;
}

/** Generic runners and proxies: `mcp-remote`, `supergateway`, the MCP inspector. */
const RUNNER_PACKAGES = new Set(["pkg:npm:mcp-remote", "pkg:npm:supergateway", "pkg:npm:@modelcontextprotocol/inspector"]);

export type AddedPlace = { kind: "editor"; id: string; label: string } | { kind: "project"; id: string; label: string };
export type AddedIndex = Map<string, Array<{ place: AddedPlace; name: string }>>;

/** Every defined server's endpoint, with where it is and what it is called there. */
export function buildAddedIndex(sources: Array<{ place: AddedPlace; defs: Record<string, { url?: string; command?: string; args?: string[] }> }>): AddedIndex {
  const index: AddedIndex = new Map();
  for (const { place, defs } of sources) {
    for (const [name, def] of Object.entries(defs)) {
      const key = endpointKey(def);
      if (!key) continue;
      const list = index.get(key) ?? [];
      if (!list.some((hit) => hit.place.kind === place.kind && hit.place.id === place.id)) list.push({ place, name });
      index.set(key, list);
    }
  }
  return index;
}

/**
 * Where a card's endpoint is already defined: "in 3 of 4 editors",
 * "in data-glue", "in 2 of 4 editors, data-glue and portal". Undefined when nowhere.
 * `name` is what the first place calls it, so adding it to more places can
 * keep the same name.
 */
export function addedFor(entry: CatalogEntry, index: AddedIndex, editorCount: number): CatalogAdded | undefined {
  const key = endpointKey(entry);
  const hits = key ? index.get(key) ?? [] : [];
  if (hits.length === 0) return undefined;
  const editors = hits.filter((hit) => hit.place.kind === "editor");
  const projects = hits.filter((hit) => hit.place.kind === "project");
  const parts: string[] = [];
  if (editors.length > 0) parts.push(editorCount > 1 ? `${editors.length} of ${editorCount} editors` : editors[0]?.place.label ?? "an editor");
  if (projects.length > 2) parts.push(`${projects.length} projects`);
  else parts.push(...projects.map((hit) => hit.place.label));
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return {
    label: `in ${list}`,
    name: (editors[0] ?? projects[0])?.name ?? entry.id,
    editors: editors.map((hit) => hit.place.id),
    projects: projects.map((hit) => hit.place.id),
  };
}

// ------------------------------------------------------------------ budget

/** One line on what adding a server does to the load; see shared/budget.ts for the thresholds. */
export function budgetImpact(scope: InstallScope, after: number, where: string): string {
  const tier = budgetTier(after);
  const head = scope === "user"
    ? `Adds 1 server to every workspace for ${where}; an agent there would load ${after} user-level server${after === 1 ? "" : "s"}.`
    : `Adds 1 server to ${where}; this workspace's agents would load ${after} server${after === 1 ? "" : "s"}.`;
  if (tier === "problem") return `${head} That is over budget (${BUDGET_PROBLEM}+): expect "Prompt is too long" without tool search.`;
  if (tier === "attention") return `${head} That is getting heavy (${BUDGET_ATTENTION}+).`;
  return head;
}

// ---------------------------------------------------------------- settings

/**
 * Host-scoped: the libraries the gallery reads, in order (the first to list a
 * server name wins). Stored by Paseo under
 * `$PASEO_HOME/plugin-settings/paseo-mcp/catalog.json`, and sent by Paseo to
 * every client that reads it, so it holds no secret. A library's header value
 * is write-only, kept by the host in `team-auth.json` beside it (0600), bound
 * to the origin of the library address it was set for, and set through
 * mcpCatalogTeamAuth.
 *
 * Version 2 (0.13.0). Version 1 held one team catalogue (`teamSource`,
 * `teamHeaderName`); migrateCatalogValues turns it into the default
 * libraries plus a library called Team. Paseo runs the migration when it
 * reads the document; the host's own reader runs it too (server/settings.ts).
 */
export const catalogSettings = defineSettings({
  id: "catalog",
  scope: "host",
  version: 2,
  schema: z.object({
    libraries: LibrariesSchema.default(DEFAULT_LIBRARIES).describe("Libraries of MCP servers the gallery reads, in order"),
  }),
  migrate: migrateCatalogValues,
});
export type CatalogSettings = z.infer<typeof catalogSettings.schema>;
export const CATALOG_DEFAULTS: CatalogSettings = catalogSettings.schema.parse({});

// ------------------------------------------------------------------ RPCs

export const CatalogProjectSchema = z.object({ name: z.string(), path: z.string(), servers: z.number() });

export const TeamStateSchema = z.object({
  source: z.string(),
  state: z.enum(["off", "loading", "ready", "error"]),
  count: z.number(),
  refused: z.array(z.object({ id: z.string(), reason: z.string() })),
  fetchedAt: z.string().nullable(),
  note: z.string(),
});

/** One library as the gallery shows it: where it lives (without any key), whether it read, and what it holds. */
export const LibraryStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  source: z.string(),
  kind: z.enum(["json", "registry", "file", "invalid"]),
  enabled: z.boolean(),
  /** `idle`: a registry waiting for a search of two letters or more. */
  state: z.enum(["off", "loading", "ready", "error", "idle", "searching"]),
  count: z.number(),
  refused: z.array(z.object({ id: z.string(), reason: z.string() })),
  fetchedAt: z.string().nullable(),
  note: z.string(),
  headerName: z.string(),
});
export type LibraryState = z.output<typeof LibraryStateSchema>;

export const RegistryStateSchema = z.object({
  query: z.string(),
  state: z.enum(["idle", "searching", "ready", "error"]),
  fetchedAt: z.string().nullable(),
  note: z.string(),
  count: z.number(),
});

/**
 * Every shelf for one search. Answers at once from memory: a registry search
 * or a team fetch that is not cached yet starts in the background, and the
 * state says "searching" / "loading" until the next read has it.
 */
export const mcpCatalog = defineRpc({
  name: "paseo-mcp.catalog",
  input: z.object({
    query: z.string().max(200).default(""),
    /** `team` and `registry` as in 0.12.0; `libraries` reads every library file again, `all` everything. */
    refresh: z.enum(["team", "registry", "both", "libraries", "all"]).optional(),
    /** Read this one library again (its id). */
    library: z.string().max(64).optional(),
  }),
  output: z.object({
    cards: z.array(CatalogCardSchema),
    /** The library called Team (0.12.0's team catalogue), "off" when there is none. */
    team: TeamStateSchema,
    /** Every registry library's search, together. */
    registry: RegistryStateSchema,
    libraries: z.array(LibraryStateSchema),
    projects: z.array(CatalogProjectSchema),
  }),
});

export const CatalogInstallInputSchema = z.object({
  key: z.string().min(1),
  scope: z.enum(["user", "project"]),
  targets: z.array(z.string()).default([]),
  projectPath: z.string().default(""),
  name: z.string().min(1),
  values: z.record(z.string(), z.string()).default({}),
});

export const CatalogPreviewSchema = z.object({ file: z.string(), label: z.string(), text: z.string() });

/**
 * What an install is bound to: the entry as the host holds it, where it goes
 * and what it is called, and the previews the user read. The install RPC
 * takes this back and refuses when it no longer matches, so a team file or
 * registry answer that changed after the review is never written unseen.
 */
export function planHash(input: { entry: CatalogEntry; scope: InstallScope; targets: string[]; projectPath: string; name: string; previews: Array<{ file: string; text: string }> }): string {
  return sha256Hex(JSON.stringify([input.entry, input.scope, input.targets, input.projectPath, input.name, input.previews.map((preview) => [preview.file, preview.text])]));
}

/** A program and its arguments as one line to read: arguments with spaces or quotes are quoted. */
export function commandLine(command: string, args: string[]): string {
  const quote = (word: string) => (word !== "" && /^[A-Za-z0-9@%+=:,./_~-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);
  return [command, ...args].map(quote).join(" ");
}

/** What installing would write, per file, with secrets masked. Writes nothing. */
export const mcpCatalogPlan = defineRpc({
  name: "paseo-mcp.catalog-plan",
  input: CatalogInstallInputSchema,
  output: z.object({
    ok: z.boolean(),
    issues: z.array(z.string()),
    clash: z.object({ files: z.array(z.string()), suggestion: z.string() }).nullable(),
    previews: z.array(CatalogPreviewSchema),
    envToSet: z.array(z.object({ name: z.string(), label: z.string() })),
    budget: z.string(),
    notes: z.array(z.string()),
    /** A command server's program and arguments as one line (typed secrets masked); "" for a remote. */
    commandLine: z.string(),
    /** Binds an install to this preview: see planHash. */
    planHash: z.string(),
  }),
});

/** Write it through the existing writers (backup, atomic write, read-back), then check its health. */
export const mcpCatalogInstall = defineRpc({
  name: "paseo-mcp.catalog-install",
  input: CatalogInstallInputSchema.extend({ planHash: z.string().default("") }),
  output: z.object({
    ok: z.boolean(),
    message: z.string(),
    written: z.array(z.string()),
    skipped: z.array(z.string()),
    health: z.object({ status: z.string(), note: z.string() }).nullable(),
    oauth: z.boolean(),
    envToSet: z.array(z.object({ name: z.string(), label: z.string() })),
    budget: z.string(),
  }),
});

/**
 * A library's header value, write-only: set it, clear it, or ask whether one
 * is set. The answer is only ever `{ set, origin }`, the site the value is
 * bound to (not secret); the value never leaves the host. `library` defaults
 * to the Team library, as in 0.12.0.
 */
export const mcpCatalogTeamAuth = defineRpc({
  name: "paseo-mcp.catalog-team-auth",
  input: z.object({
    action: z.enum(["status", "set", "clear"]).default("status"),
    value: z.string().max(8192).default(""),
    library: z.string().max(64).default("team"),
  }),
  output: z.object({ set: z.boolean(), origin: z.string() }),
});

/** An existing server as a secret-free catalogue entry, to paste into a team file. */
export const mcpCatalogEntry = defineRpc({
  name: "paseo-mcp.catalog-entry",
  input: z.object({ name: z.string().min(1) }),
  output: z.object({ ok: z.boolean(), json: z.string(), message: z.string() }),
});
