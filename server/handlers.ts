import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import type { Destination } from "../shared/contracts";
import { onStart } from "./lifecycle";
import type { Dialect } from "../shared/mcpjson";

const HOME = homedir();
// Home dir: prefer whichever location actually holds accounts. Picking a
// merely-existing empty dir made the panel look at the wrong place and report
// working accounts as missing and the auto-router as unwired.
function hasAccounts(root: string): boolean {
  for (const provider of ["claude", "codex"]) {
    try {
      if (readdirSync(join(root, "accounts", provider)).length > 0) return true;
    } catch {
      // missing dir is simply "no accounts here"
    }
  }
  return false;
}

const AGENT_LINK_HOME_DIR = (() => {
  const explicit = process.env.AGENT_LINK_HOME ?? process.env.AGENT_AUTH_HOME;
  if (explicit) return explicit;
  const link = join(HOME, ".agent-link");
  const auth = join(HOME, ".agent-auth");
  if (hasAccounts(link)) return link;
  if (hasAccounts(auth)) return auth;
  return existsSync(link) ? link : auth;
})();

const AGENT_LINK_ROOT = join(AGENT_LINK_HOME_DIR, "accounts");
// Hand-rolled slot layouts some setups use outside agent-link (read-only here).
const EXTERNAL_ROOTS: Array<{ provider: "claude" | "codex"; root: string }> = [
  { provider: "claude", root: join(HOME, ".claude-accounts") },
  { provider: "codex", root: join(HOME, ".codex-accounts") },
];

// ---------------------------------------------------------------- fs helpers

function listDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

export function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const BACKUP_KEEP = 20;

export function backupFile(path: string): void {
  if (!existsSync(path)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(path, `${path}.bak-paseo-mcp-${stamp}`);
  // Keep the most recent few so config dirs do not fill with backups. The count
  // is per file and generous on purpose: applying one server to seven
  // destinations is a single user action that writes seven files, and a tighter
  // cap would push the pre-change copy out within two such presses.
  try {
    const dir = dirname(path);
    const prefix = `${basename(path)}.bak-paseo-mcp-`;
    const old = readdirSync(dir)
      .filter((entry) => entry.startsWith(prefix))
      .sort() // ISO timestamps sort chronologically
      .slice(0, -BACKUP_KEEP);
    for (const entry of old) rmSync(join(dir, entry), { force: true });
  } catch {
    // Pruning is best-effort; never block a write on it.
  }
}

/**
 * Replace a file's contents in one step, keeping the permissions it already
 * had. These files hold bearer tokens, so a fresh one is created private, and
 * an existing 0600 config is never widened by being edited here.
 */
export function writeTextAtomic(path: string, text: string): void {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const tmp = `${path}.tmp-paseo-mcp`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------- accounts / slots

// Only the account email is ever read from credential-adjacent files — no token
// material leaves the handler.
function claudeAccountEmail(configDir: string): string {
  const config = readJson(configDir === HOME ? join(HOME, ".claude.json") : join(configDir, ".claude.json"));
  const account = config?.oauthAccount as { emailAddress?: string } | undefined;
  return account?.emailAddress ?? "";
}

function codexAccountEmail(codexHome: string): string {
  const auth = readJson(join(codexHome, "auth.json"));
  const idToken = (auth?.tokens as { id_token?: string } | undefined)?.id_token;
  if (!idToken) return "";
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString());
    return typeof payload.email === "string" ? payload.email : "";
  } catch {
    return "";
  }
}

// Claude Code does NOT drop a credentials file inside CLAUDE_CONFIG_DIR on
// macOS — the tokens go to the OS keychain, keyed per config dir. Verified:
// three config dirs report three different `claude auth status` accounts at the
// same time. So identity in .claude.json, not a credentials file, is what says
// "this slot is logged in". Codex does keep auth.json inside CODEX_HOME.
function slotLoggedIn(provider: "claude" | "codex", dir: string, accountEmail: string): boolean {
  if (provider === "claude") return accountEmail !== "";
  return existsSync(join(dir, "auth.json"));
}

// Claude records why extra usage is unavailable in its own config — a
// token-free signal that an account has hit a spend limit.
export function envVarFor(provider: "claude" | "codex"): string {
  return provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
}

type AccountDirectory = {
  provider: "claude" | "codex";
  email: string;
  dir: string;
  source: "agent-link" | "external";
  loggedIn: boolean;
  actualEmail: string;
  wrongAccount: boolean;
};

function collectSlots(): AccountDirectory[] {
  const slots: AccountDirectory[] = [];
  const seen = new Set<string>();
  const add = (provider: "claude" | "codex", dir: string, source: "agent-link" | "external") => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const email = basename(dir);
    const actualEmail = provider === "claude" ? claudeAccountEmail(dir) : codexAccountEmail(dir);
    const loggedIn = slotLoggedIn(provider, dir, actualEmail);
    slots.push({
      provider,
      email,
      dir,
      source,
      loggedIn,
      actualEmail,
      wrongAccount: loggedIn && actualEmail !== "" && actualEmail !== email,
    });
  };
  for (const provider of ["claude", "codex"] as const) {
    for (const dir of listDirs(join(AGENT_LINK_ROOT, provider))) add(provider, dir, "agent-link");
  }
  for (const { provider, root } of EXTERNAL_ROOTS) {
    for (const dir of listDirs(root)) add(provider, dir, "external");
  }
  return slots;
}

type ProviderOverrides = Record<
  string,
  {
    extends?: string;
    env?: Record<string, string>;
    enabled?: boolean;
    label?: string;
    command?: string[];
    models?: Array<{ id: string; label?: string; description?: string; isDefault?: boolean }>;
  } | undefined
>;

// The daemon returns config FLATTENED — providers live at config.providers,
// even though a patch is written as { agents: { providers } }. Reading the
// nested path silently yielded {} , so every provider looked unconfigured:
// wired accounts showed as unwired and the auto-router always offered "Wire".
async function providerOverrides(paseo: PluginHandlerContext["paseo"] | null): Promise<ProviderOverrides> {
  // The background health check may run before any RPC has handed us a paseo
  // handle; without one, every discovered editor counts as enabled.
  if (!paseo) return {};
  const { config } = await paseo.config.get();
  const shape = config as { providers?: ProviderOverrides; agents?: { providers?: ProviderOverrides } };
  return (shape.providers ?? shape.agents?.providers ?? {}) as ProviderOverrides;
}

// A GUI-launched daemon inherits a minimal PATH, not the user's login PATH, so
// tools installed in /opt/homebrew/bin, ~/.local/bin etc. look "missing".
// Resolve the login shell's PATH once per process.
let cachedSearchPath: string[] | null = null;

export function searchPath(): string[] {
  if (cachedSearchPath === null) {
    let raw = process.env.PATH ?? "";
    try {
      const shell = process.env.SHELL || "/bin/sh";
      const out = execFileSync(shell, ["-lc", 'printf %s "$PATH"'], { encoding: "utf8", timeout: 5000 });
      if (out.trim()) raw = out.trim();
    } catch {
      // Fall back to the inherited PATH.
    }
    const extras = [join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
    cachedSearchPath = [...new Set(raw.split(delimiter).concat(extras).filter(Boolean))];
  }
  return cachedSearchPath;
}

// A slow shell rc can take seconds, so fill the cache once the plugin is up
// rather than leaving the first RPC that needs a PATH lookup to stall on it.
onStart(searchPath);

// ---------------------------------------------------------------- MCP formats

export type McpDef = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  type?: string;
  // Verbatim TOML lines this mini-parser does not model (enabled,
  // startup_timeout_sec, …). Carried through so a rename or a copy never
  // silently drops settings it did not understand.
  extra?: string[];
  // Which subtable this destination keeps HTTP headers in. Codex uses
  // `http_headers`; Grok uses `headers`. Reading the wrong one reports a server
  // as credential-free, and writing the wrong one deletes its token.
  headerTable?: "headers" | "http_headers";
};

/**
 * What each config language actually accepts, in one table so nothing has to
 * guess twice. Measured on this machine: ~/.claude.json holds 19 servers, 18
 * carrying `type`; ~/.codex/config.toml holds 27, 7 of them with an
 * `http_headers` subtable and 26 with `enabled`.
 *
 * Reading is forgiving — either header spelling is understood, so a file
 * already written with the wrong one is recovered rather than reported as
 * credential-free. Writing is strict: only the dialect's own spelling is
 * emitted, and a key the target has no word for is reported as dropped.
 */
export const DIALECTS: Record<
  Dialect,
  {
    format: "json-mcp" | "toml-mcp";
    label: string;
    headerKey: "headers" | "http_headers";
    writesType: boolean;
  }
> = {
  "claude-json": { format: "json-mcp", label: "Claude", headerKey: "headers", writesType: true },
  "kimi-json": { format: "json-mcp", label: "Kimi", headerKey: "headers", writesType: false },
  "codex-toml": { format: "toml-mcp", label: "Codex", headerKey: "http_headers", writesType: false },
  "grok-toml": { format: "toml-mcp", label: "Grok", headerKey: "headers", writesType: false },
};

export function dialectOf(dest: Destination): Dialect {
  if (dest.provider === "claude") return "claude-json";
  if (dest.provider === "kimi") return "kimi-json";
  if (dest.provider === "codex") return "codex-toml";
  if (dest.provider === "grok") return "grok-toml";
  // A destination contributed by some other provider id still has to land in a
  // real language. Path, not provider name, is the reliable tell for Codex.
  if (dest.format === "json-mcp") return dest.configPath.endsWith(".claude.json") ? "claude-json" : "kimi-json";
  return /codex/i.test(dest.configPath) ? "codex-toml" : "grok-toml";
}

/** TOML-only bookkeeping that must never be written into a JSON config. */
export function jsonSafeDef(def: McpDef, dialect: "claude-json" | "other"): McpDef {
  const { extra: _extra, headerTable: _headerTable, ...rest } = def;
  const clean: McpDef = { ...rest };
  // Claude Code needs `type` to treat an entry as HTTP; 18 of the 19 servers in
  // a real config carry it, and an entry that loses it stops loading.
  if (dialect === "claude-json" && !clean.type) clean.type = clean.url ? "http" : "stdio";
  return clean;
}

// json-mcp: a JSON file with a top-level `mcpServers` object. Claude Code's
// ~/.claude.json and Kimi Code's mcp.json both use this shape.
export function jsonMcpRead(path: string): Record<string, McpDef> {
  const config = readJson(path);
  return (config?.mcpServers as Record<string, McpDef> | undefined) ?? {};
}

function jsonMcpWrite(path: string, name: string, def: McpDef | null): void {
  // A file that EXISTS but will not parse must never be overwritten: rewriting
  // it from `{}` would drop everything else it holds (account identity, project
  // history, settings). Missing is fine — that is a genuine first write.
  const config = existsSync(path) ? readJson(path) : {};
  if (config === null) {
    throw new Error(`${path} exists but is not valid JSON — refusing to overwrite it`);
  }
  const servers = (config.mcpServers as Record<string, McpDef> | undefined) ?? {};
  if (def === null) delete servers[name];
  else servers[name] = jsonSafeDef(def, path.endsWith(".claude.json") ? "claude-json" : "other");
  config.mcpServers = servers;
  backupFile(path);
  writeJsonAtomic(path, config);
}

// toml-mcp: [mcp_servers.<name>] tables. Codex and Grok both use this shape.
function tomlString(value: string): string {
  return JSON.stringify(value);
}

// Table headers may be indented — valid TOML, and missing it once caused a
// duplicate table to be appended (which makes the whole file unparseable).
export function tomlMcpNamesFromText(text: string): string[] {
  return [...new Set([...text.matchAll(/^[ \t]*\[mcp_servers\.([^\].]+)/gm)].map((match) => match[1] ?? ""))];
}

export function tomlMcpNames(path: string): string[] {
  try {
    return tomlMcpNamesFromText(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

// TOML basic ("…", escapes) and literal ('…', no escapes) strings.
function tomlUnquote(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return null;
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return null;
}

export function tomlServerBlock(text: string, name: string): { start: number; end: number } | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^[ \\t]*\\[mcp_servers\\.${escaped}(?:\\.[^\\]]+)?\\]`, "m");
  const startMatch = header.exec(text);
  if (!startMatch) return null;
  const start = startMatch.index;
  const rest = text.slice(start);
  const lines = rest.split("\n");
  const next = lines.findIndex((line, index) => {
    if (index === 0) return false;
    return /^\s*\[/.test(line) && !new RegExp(`^\\s*\\[mcp_servers\\.${escaped}[.\\]]`).test(line);
  });
  if (next === -1) return { start, end: text.length };
  const offset = lines.slice(0, next).join("\n").length + 1;
  return { start, end: start + offset };
}

// Minimal parse of one server block — enough to re-create the definition elsewhere.
export function tomlMcpReadOne(path: string, name: string): McpDef | null {
  try {
    return tomlMcpReadOneFromText(readFileSync(path, "utf8"), name);
  } catch {
    return null;
  }
}

// Same parse against a buffer rather than a file, so a computed document can be
// re-read and compared before anything is written to disk.
export function tomlMcpReadOneFromText(text: string, name: string): McpDef | null {
  const block = tomlServerBlock(text, name);
  if (!block) return null;
  const body = text.slice(block.start, block.end);
  const def: McpDef = {};
  const bodyLines = body.split("\n");
  // Top-level lines of the block: everything before the first subtable header.
  const subStart = bodyLines.findIndex((line, index) => index > 0 && /^[ \t]*\[/.test(line));
  const topLines = (subStart === -1 ? bodyLines : bodyLines.slice(0, subStart)).slice(1);
  const extra: string[] = [];
  for (const line of topLines) {
    const pair = /^[ \t]*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!pair) continue;
    const [, key, rawValue] = pair;
    if (key === "url" || key === "command") {
      const value = tomlUnquote(rawValue);
      if (value !== null) def[key] = value;
      continue;
    }
    if (key === "args") {
      const inner = /^\[(.*)\]$/.exec(rawValue.trim());
      if (inner) {
        def.args = [...inner[1].matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'/g)]
          .map((match) => tomlUnquote(match[0]))
          .filter((value): value is string => value !== null);
      }
      continue;
    }
    // Anything else (enabled, startup_timeout_sec, …) survives verbatim.
    extra.push(line.trim());
  }
  if (extra.length > 0) def.extra = extra;
  for (const sub of ["env", "headers", "http_headers"] as const) {
    const subHeader = new RegExp(`^[ \\t]*\\[mcp_servers\\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.${sub}\\]`, "m").exec(body);
    if (!subHeader) continue;
    const subBody = body.slice(subHeader.index).split("\n").slice(1);
    const record: Record<string, string> = {};
    for (const line of subBody) {
      if (/^[ \t]*\[/.test(line)) break;
      const pair = /^[ \t]*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (!pair) continue;
      const value = tomlUnquote(pair[2]);
      if (value !== null) record[pair[1]] = value;
    }
    if (Object.keys(record).length === 0) continue;
    if (sub === "env") def.env = record;
    else {
      def.headers = { ...def.headers, ...record };
      def.headerTable = sub;
    }
  }
  // A block we could not read meaningfully must not be treated as a definition:
  // re-serializing an empty def would silently destroy the real one.
  if (!def.command && !def.url) return null;
  return def;
}

// A bare TOML table key. Anything else (dots, quotes, spaces, brackets) would
// either nest the table under a different server or make the file unparseable.
export const TOML_SAFE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Which subtable a brand-new block should use. Codex reads `http_headers`;
 * Grok reads `headers`. Only consulted when neither the file nor the source
 * definition already answers the question.
 */
export function headerTableFor(configPath: string): "headers" | "http_headers" {
  return /codex/i.test(configPath) ? "http_headers" : "headers";
}

// Pure text transform so callers can apply several servers in memory and write once.
// `forceHeaderTable` is how a dialect-aware caller corrects a file that was
// written with the other CLI's spelling; without it the file's own choice wins.
export function tomlApply(
  text: string,
  name: string,
  def: McpDef | null,
  fileHint = "",
  forceHeaderTable?: "headers" | "http_headers",
): string {
  if (!TOML_SAFE_NAME.test(name)) {
    throw new Error(`'${name}' is not a valid TOML table name (letters, numbers, - and _ only)`);
  }
  let next = text;
  // Whichever subtable this file already used for headers wins: rewriting a
  // Codex block's `http_headers` as `headers` deletes the token Codex reads.
  const existingHeaderTable = new RegExp(
    `^[ \\t]*\\[mcp_servers\\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(http_headers|headers)\\]`,
    "m",
  ).exec(text)?.[1] as "headers" | "http_headers" | undefined;
  let block = tomlServerBlock(next, name);
  while (block) {
    next = next.slice(0, block.start) + next.slice(block.end);
    block = tomlServerBlock(next, name);
  }
  if (def) {
    const lines = [`\n[mcp_servers.${name}]`];
    if (def.command) lines.push(`command = ${tomlString(def.command)}`);
    if (def.args?.length) lines.push(`args = [${def.args.map(tomlString).join(", ")}]`);
    if (def.url) lines.push(`url = ${tomlString(def.url)}`);
    for (const line of def.extra ?? []) lines.push(line);
    const headerTable = forceHeaderTable ?? existingHeaderTable ?? def.headerTable ?? headerTableFor(fileHint);
    for (const [sub, record] of [
      ["env", def.env],
      [headerTable, def.headers],
    ] as const) {
      if (record && Object.keys(record).length > 0) {
        lines.push(`[mcp_servers.${name}.${sub}]`);
        for (const [key, value] of Object.entries(record)) lines.push(`${key} = ${tomlString(value)}`);
      }
    }
    next = `${next.replace(/\n*$/, "\n")}${lines.join("\n")}\n`;
  }
  return next;
}

// Only a MISSING file may be created from scratch. An unreadable existing file
// is an error, never a reason to replace it.
export function tomlReadForWrite(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`${path} exists but could not be read (${error instanceof Error ? error.message : String(error)}) — refusing to overwrite it`);
  }
}

function tomlMcpWrite(path: string, name: string, def: McpDef | null): void {
  const text = tomlReadForWrite(path);
  const next = tomlApply(text, name, def, path); // throws before any write on a bad name
  backupFile(path);
  writeTextAtomic(path, next);
}

// The one-line summary shown in the always-visible list must never carry a
// secret: tokens hide in command args (--header "Authorization: Bearer …",
// --api-key …) and in URL query strings.
const SECRETISH = /(token|secret|key|password|auth|bearer|credential)/i;

export function hasInlineCredentials(def: McpDef | null): boolean {
  if (!def) return false;
  if ((def.env && Object.keys(def.env).length > 0) || (def.headers && Object.keys(def.headers).length > 0)) return true;
  if ((def.args ?? []).some((arg) => SECRETISH.test(arg))) return true;
  if (!def.url) return false;
  try {
    return [...new URL(def.url).searchParams.keys()].some((key) => SECRETISH.test(key));
  } catch {
    // A malformed URL is already surfaced by health/editing. Do not infer auth.
    return false;
  }
}

export function redactDetail(def: McpDef | null): string {
  if (!def) return "";
  if (def.url) return def.url.replace(/\?.*/, "?…");
  if (!def.command) return "";
  const parts: string[] = [def.command];
  const args = def.args ?? [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (SECRETISH.test(arg)) {
      // Redact the flag's value too, whether inline (--key=v) or the next arg.
      parts.push(arg.includes("=") ? `${arg.split("=")[0]}=•••` : `${arg.split(/\s/)[0]} •••`);
      if (!arg.includes("=") && !/\s/.test(arg)) index += 1;
      continue;
    }
    parts.push(arg.replace(/\?.*/, "?…"));
  }
  return parts.join(" ");
}

export function destRead(dest: Destination): Record<string, McpDef> {
  if (dest.format === "json-mcp") return jsonMcpRead(dest.configPath);
  // One read of the file, then every block is parsed from that text.
  let text = "";
  try {
    text = readFileSync(dest.configPath, "utf8");
  } catch {
    return {};
  }
  const defs: Record<string, McpDef> = {};
  for (const name of tomlMcpNamesFromText(text)) {
    const def = tomlMcpReadOneFromText(text, name);
    if (def) defs[name] = def;
  }
  return defs;
}

export function destNames(dest: Destination): string[] {
  return dest.format === "json-mcp" ? Object.keys(jsonMcpRead(dest.configPath)) : tomlMcpNames(dest.configPath);
}

export function destWrite(dest: Destination, name: string, def: McpDef | null): void {
  if (dest.format === "json-mcp") jsonMcpWrite(dest.configPath, name, def);
  else tomlMcpWrite(dest.configPath, name, def);
}

// ---------------------------------------------------------------- destinations

export async function buildDestinations(paseo: PluginHandlerContext["paseo"] | null): Promise<Destination[]> {
  const overrides = await providerOverrides(paseo);
  const destinations: Destination[] = [];
  const seen = new Set<string>();
  const push = (dest: Destination) => {
    if (seen.has(dest.configPath) || !existsSync(dirname(dest.configPath))) return;
    seen.add(dest.configPath);
    destinations.push(dest);
  };

  const enabled = (id: string) => overrides[id]?.enabled !== false;

  // Claude's config sits directly in $HOME, so the generic parent-dir check in
  // push() cannot tell "Claude Code is installed" from "this is a home dir".
  if (enabled("claude") && (existsSync(join(HOME, ".claude.json")) || existsSync(join(HOME, ".claude")))) {
    const account = claudeAccountEmail(HOME);
    push({
      id: join(HOME, ".claude.json"),
      label: `Claude · ${account || "primary"} (primary)`,
      provider: "claude",
      account,
      configPath: join(HOME, ".claude.json"),
      format: "json-mcp",
    });
  }
  if (enabled("codex")) {
    const account = codexAccountEmail(join(HOME, ".codex"));
    push({
      id: join(HOME, ".codex", "config.toml"),
      label: `Codex · ${account || "primary"} (primary)`,
      provider: "codex",
      account,
      configPath: join(HOME, ".codex", "config.toml"),
      format: "toml-mcp",
    });
  }
  if (enabled("kimi") && existsSync(join(HOME, ".kimi-code"))) {
    push({
      id: join(HOME, ".kimi-code", "mcp.json"),
      label: "Kimi Code",
      provider: "kimi",
      account: "",
      configPath: join(HOME, ".kimi-code", "mcp.json"),
      format: "json-mcp",
    });
  }
  if (enabled("grok") && existsSync(join(HOME, ".grok"))) {
    push({
      id: join(HOME, ".grok", "config.toml"),
      label: "Grok",
      provider: "grok",
      account: "",
      configPath: join(HOME, ".grok", "config.toml"),
      format: "toml-mcp",
    });
  }
  // Derived per-account providers (extends claude/codex with a config-dir env).
  for (const [id, override] of Object.entries(overrides)) {
    const base = override?.extends;
    if (base !== "claude" && base !== "codex") continue;
    if (override?.enabled === false) continue;
    const dir = override?.env?.[envVarFor(base)];
    if (!dir) continue;
    const configPath = base === "claude" ? join(dir, ".claude.json") : join(dir, "config.toml");
    const account = base === "claude" ? claudeAccountEmail(dir) : codexAccountEmail(dir);
    push({
      id: configPath,
      label: `${base === "claude" ? "Claude" : "Codex"} · ${account || basename(dir)} (${id})`,
      provider: base,
      account: account || basename(dir),
      configPath,
      format: base === "claude" ? "json-mcp" : "toml-mcp",
    });
  }
  // Slots that exist but are not wired as providers yet.
  for (const slot of collectSlots()) {
    const configPath = slot.provider === "claude" ? join(slot.dir, ".claude.json") : join(slot.dir, "config.toml");
    push({
      id: configPath,
      label: `${slot.provider === "claude" ? "Claude" : "Codex"} · ${slot.email} (slot)`,
      provider: slot.provider,
      account: slot.email,
      configPath,
      format: slot.provider === "claude" ? "json-mcp" : "toml-mcp",
    });
  }
  return destinations;
}

// ---------------------------------------------------------------- handlers
export async function handleMcpMatrix(_input: Record<string, never>, { paseo }: PluginHandlerContext) {
  const destinations = await buildDestinations(paseo);
  const nameSets = new Map<string, Set<string>>();
  for (const dest of destinations) nameSets.set(dest.id, new Set(destNames(dest)));
  const allNames = [...new Set([...nameSets.values()].flatMap((set) => [...set]))].sort();
  // Every definition, read once per destination — not once per server × destination.
  const defsByDest = new Map(destinations.map((dest) => [dest.id, destRead(dest)] as const));

  const servers = allNames.map((name) => {
    const presentIn = destinations.filter((dest) => nameSets.get(dest.id)?.has(name)).map((dest) => dest.id);
    // Best definition for display: prefer a json-mcp source.
    let def: McpDef | null = null;
    for (const dest of destinations) {
      const candidate = defsByDest.get(dest.id)?.[name];
      if (candidate) {
        def = candidate;
        if (dest.format === "json-mcp") break;
      }
    }
    const transport: "stdio" | "http" | "unknown" = def?.command ? "stdio" : def?.url ? "http" : "unknown";
    // Key names only — env/header VALUES never leave the handler.
    const inlineCredentialsIn = destinations
      .filter((dest) => hasInlineCredentials(defsByDest.get(dest.id)?.[name] ?? null))
      .map((dest) => dest.id);
    const detail = redactDetail(def).slice(0, 80);
    return {
      name,
      transport,
      detail,
      authStyle: inlineCredentialsIn.length > 0 ? ("inline-credentials" as const) : ("oauth-or-none" as const),
      inlineCredentialsIn,
      presentIn,
    };
  });
  return { destinations, servers };
}

function parseKvLines(text: string | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  for (const line of (text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    record[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return record;
}

function applyDefToTargets(
  destinations: Destination[],
  targets: string[],
  name: string,
  def: McpDef,
): { written: string[]; skipped: string[] } {
  const written: string[] = [];
  const skipped: string[] = [];
  for (const target of targets) {
    const dest = destinations.find((candidate) => candidate.id === target);
    if (!dest) {
      skipped.push(`${target}: unknown destination`);
      continue;
    }
    try {
      destWrite(dest, name, def);
      written.push(dest.label);
    } catch (error) {
      skipped.push(`${dest.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { written, skipped };
}

export async function handleMcpAdd(
  input: { name: string; kind: "stdio" | "http"; command?: string; url?: string; kvLines?: string; targets: string[] },
  { paseo }: PluginHandlerContext,
) {
  if (!/^[A-Za-z0-9_-]+$/.test(input.name)) {
    return { ok: false, message: "name must be letters, numbers, hyphens, underscores" };
  }
  const def: McpDef = {};
  if (input.kind === "stdio") {
    const parts = (input.command ?? "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { ok: false, message: "stdio server needs a command" };
    def.command = parts[0];
    if (parts.length > 1) def.args = parts.slice(1);
    const env = parseKvLines(input.kvLines);
    if (Object.keys(env).length > 0) def.env = env;
  } else {
    if (!input.url?.trim()) return { ok: false, message: "http server needs a URL" };
    def.url = input.url.trim();
    const headers = parseKvLines(input.kvLines);
    if (Object.keys(headers).length > 0) def.headers = headers;
  }
  const destinations = await buildDestinations(paseo);
  const { written, skipped } = applyDefToTargets(destinations, input.targets, input.name, def);
  return {
    ok: written.length > 0,
    message: [
      written.length ? `added '${input.name}' to: ${written.join(", ")} (backups saved)` : "nothing written",
      ...skipped,
    ].join("\n"),
  };
}

export async function handleMcpApply(
  { name, targets, sourceDestId }: { name: string; targets: string[]; sourceDestId?: string },
  { paseo }: PluginHandlerContext,
) {
  const destinations = await buildDestinations(paseo);
  let def: McpDef | null = null;
  if (sourceDestId) {
    const source = destinations.find((candidate) => candidate.id === sourceDestId);
    def = source ? destReadOne(source, name) : null;
    if (!def) return { ok: false, message: `'${name}' not found in the selected source destination` };
  } else {
    def = findDef(destinations, name);
  }
  if (!def) return { ok: false, message: `no existing definition of '${name}' found anywhere` };
  const { written, skipped } = applyDefToTargets(destinations, targets, name, def);
  return {
    ok: written.length > 0,
    message: [
      written.length ? `applied '${name}' to: ${written.join(", ")} (backups saved)` : "nothing written",
      ...skipped,
    ].join("\n"),
  };
}

export async function handleMcpRemove({ name, targets }: { name: string; targets: string[] }, { paseo }: PluginHandlerContext) {
  const destinations = await buildDestinations(paseo);
  const removed: string[] = [];
  const skipped: string[] = [];
  for (const target of targets) {
    const dest = destinations.find((candidate) => candidate.id === target);
    if (!dest) {
      skipped.push(`${target}: unknown destination`);
      continue;
    }
    try {
      destWrite(dest, name, null);
      removed.push(dest.label);
    } catch (error) {
      skipped.push(`${dest.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    ok: removed.length > 0,
    message: [
      removed.length
        ? `removed '${name}' from: ${removed.join(", ")} (backups saved). Note: a running CLI session may rewrite its own config from memory.`
        : "nothing removed",
      ...skipped,
    ].join("\n"),
  };
}

// `preRead` lets a caller that looks up many names read each destination once
// up front instead of once per name.
export function findDef(destinations: Destination[], name: string, preRead?: Map<string, Record<string, McpDef>>): McpDef | null {
  let def: McpDef | null = null;
  for (const dest of destinations) {
    const candidate = preRead ? (preRead.get(dest.id)?.[name] ?? null) : destReadOne(dest, name);
    if (candidate) {
      def = candidate;
      if (dest.format === "json-mcp") break;
    }
  }
  return def;
}

export function maskValue(value: string): string {
  return value.length > 4 ? `•••${value.slice(-4)}` : "•••";
}

export function destReadOne(dest: Destination, name: string): McpDef | null {
  return dest.format === "json-mcp" ? (jsonMcpRead(dest.configPath)[name] ?? null) : tomlMcpReadOne(dest.configPath, name);
}

export async function handleMcpDefAll({ name, reveal }: { name: string; reveal: boolean }, { paseo }: PluginHandlerContext) {
  const destinations = await buildDestinations(paseo);
  const rows = destinations.map((dest) => {
    const def = destReadOne(dest, name);
    if (!def) return { destId: dest.id, found: false, kind: "http" as const, command: "", url: "", kvLines: "" };
    const kind = def.command ? ("stdio" as const) : ("http" as const);
    const record = (kind === "stdio" ? def.env : def.headers) ?? {};
    const kvLines = Object.entries(record)
      .map(([key, value]) => `${key}=${reveal ? value : maskValue(value)}`)
      .join("\n");
    return {
      destId: dest.id,
      found: true,
      kind,
      command: def.command ? [def.command, ...(def.args ?? [])].join(" ") : "",
      url: def.url ?? "",
      kvLines,
    };
  });
  return { rows };
}

export async function handleMcpEditOne(
  input: { name: string; destId: string; kind: "stdio" | "http"; command?: string; url?: string; kvLines?: string },
  { paseo }: PluginHandlerContext,
) {
  const destinations = await buildDestinations(paseo);
  const dest = destinations.find((candidate) => candidate.id === input.destId);
  if (!dest) return { ok: false, message: `unknown destination ${input.destId}` };
  // Masked values restore from THIS destination's stored secret — per-account
  // auth settings are the point.
  const stored = destReadOne(dest, input.name);
  const storedRecord = (input.kind === "stdio" ? stored?.env : stored?.headers) ?? {};
  const parsed = parseKvLines(input.kvLines);
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value.startsWith("•••")) {
      // Renaming the key of a masked line would otherwise resolve to "" and
      // silently drop the secret while reporting success.
      if (!(key in storedRecord)) {
        return {
          ok: false,
          message: `'${key}' has no stored value here — press Reveal secrets and paste the real value, or keep the original key name`,
        };
      }
      record[key] = storedRecord[key];
      continue;
    }
    if (value !== "") record[key] = value;
  }
  // Start from what is stored and change only the four things this form owns.
  // Rebuilding the entry from the form dropped every key the form cannot show —
  // `type` (18 of 19 real Claude entries carry it, and an HTTP entry without it
  // stops loading) and Codex's `enabled` (a disabled server came back to life on
  // an unrelated header edit).
  const def: McpDef = { ...(stored ?? {}) };
  if (input.kind === "stdio") {
    const parts = (input.command ?? "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { ok: false, message: "stdio server needs a command" };
    def.command = parts[0];
    if (parts.length > 1) def.args = parts.slice(1);
    else delete def.args;
    delete def.url;
    delete def.headers;
    if (Object.keys(record).length > 0) def.env = record;
    else delete def.env;
  } else {
    if (!input.url?.trim()) return { ok: false, message: "http server needs a URL" };
    def.url = input.url.trim();
    delete def.command;
    delete def.args;
    delete def.env;
    if (Object.keys(record).length > 0) def.headers = record;
    else delete def.headers;
  }
  // Only correct `type` when the transport itself changed: an entry that says
  // "sse" must keep saying "sse" through a header edit.
  if (def.type && (def.type === "stdio") !== (input.kind === "stdio")) def.type = input.kind === "stdio" ? "stdio" : "http";
  try {
    destWrite(dest, input.name, def);
    return { ok: true, message: `updated '${input.name}' in ${dest.label} (backup saved)` };
  } catch (error) {
    return { ok: false, message: `${dest.label}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function handleMcpRename({ name, newName }: { name: string; newName: string }, { paseo }: PluginHandlerContext) {
  if (!/^[A-Za-z0-9_-]+$/.test(newName)) {
    return { ok: false, message: "new name must be letters, numbers, hyphens, underscores" };
  }
  if (newName === name) return { ok: false, message: "new name is the same" };
  const destinations = await buildDestinations(paseo);
  const renamed: string[] = [];
  const skipped: string[] = [];
  for (const dest of destinations) {
    const def = destReadOne(dest, name);
    if (!def) continue;
    if (destReadOne(dest, newName)) {
      skipped.push(`${dest.label}: '${newName}' already exists there`);
      continue;
    }
    try {
      destWrite(dest, newName, def); // write the copy first, then remove the old —
      destWrite(dest, name, null); //   a failure in between leaves both, never neither
      renamed.push(dest.label);
    } catch (error) {
      skipped.push(`${dest.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (renamed.length === 0) return { ok: false, message: ["nothing renamed", ...skipped].join("\n") };
  return {
    ok: true,
    message: [
      `renamed '${name}' → '${newName}' in: ${renamed.join(", ")} (backups saved). OAuth grants keyed to the old name may need re-authorizing in each CLI.`,
      ...skipped,
    ].join("\n"),
  };
}

export function binaryOnPath(command: string): boolean {
  if (command.includes("/")) return existsSync(command);
  return searchPath().some((dir) => existsSync(join(dir, command)));
}

export async function probeHttp(url: string, headers: Record<string, string> | undefined) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { method: "GET", headers, signal: controller.signal, redirect: "manual" });
    const code = response.status;
    if (code === 401 || code === 403) return { status: "auth-required" as const, note: `HTTP ${code} — authentication needed` };
    if (code >= 200 && code < 400) return { status: "ok" as const, note: `HTTP ${code}` };
    if (code === 404 || code === 405 || code === 406) return { status: "ok" as const, note: `reachable (HTTP ${code})` };
    return { status: "warn" as const, note: `HTTP ${code}` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "down" as const, note: reason.includes("abort") ? "timeout after 5s" : reason.slice(0, 80) };
  } finally {
    clearTimeout(timer);
  }
}

// Only MCP definitions and Claude project trust are shared between accounts.
// Provider preferences, prompts, output styles, and OAuth grants remain owned
// by the account that created them.
const SYNC_PROJECT_FIELDS = [
  "hasTrustDialogAccepted",
  "hasCompletedProjectOnboarding",
  "allowedTools",
  "mcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "dontCrawlDirectory",
];

// Which MCP servers each ACCOUNT still has to authorize. Claude records this
// per config dir, so it is readable without touching a token — and it is the
// answer to "server X says not connected".
function codexMcpAuth(accountDir: string): Record<string, "connected" | "not-connected" | "unsupported" | "unknown"> {
  const binary = searchPath().map((entry) => join(entry, "codex")).find(existsSync);
  if (!binary) return {};
  try {
    const env = { ...process.env, CODEX_HOME: accountDir };
    const output = execFileSync(binary, ["mcp", "list", "--json"], { encoding: "utf8", timeout: 8_000, maxBuffer: 4 * 1024 * 1024, env });
    const rows = JSON.parse(output) as Array<{ name?: string; auth_status?: string }>;
    return Object.fromEntries(
      rows.flatMap((row) => {
        if (!row.name) return [];
        const raw = row.auth_status ?? "unknown";
        const state =
          raw === "not_logged_in"
            ? "not-connected"
            : raw === "unsupported"
              ? "unsupported"
              : /logged_in|authenticated|connected/i.test(raw)
                ? "connected"
                : "unknown";
        return [[row.name, state]];
      }),
    );
  } catch {
    return {};
  }
}

// Paseo 0.7 exposes every registered project, including projects with no
// active workspace. Prefer that catalog so the MCP inventory is not tied to
// guessed folder roots; retain the old scan for earlier hosts.
export async function discoverProjects(
  paseo: PluginHandlerContext["paseo"] | null,
): Promise<Array<{ name: string; path: string }>> {
  let projects: Array<{ name: string; path: string }> = [];
  const projectApi = (paseo as unknown as {
    projects?: { list(): Promise<{ entries?: Array<{ name?: string; path?: string }> } | Array<{ name?: string; path?: string }>> };
  } | null)?.projects;
  if (projectApi) {
    try {
      const result = await projectApi.list();
      const entries = Array.isArray(result) ? result : result.entries ?? [];
      projects = entries.flatMap((entry) => entry.path
        ? [{ name: entry.name || basename(entry.path), path: entry.path }]
        : []);
    } catch {
      // Fall through to the directory scan supported by older hosts.
    }
  }
  if (projects.length === 0) {
    const roots = [join(HOME, ".superset", "projects"), join(HOME, "projects"), join(HOME, "code")];
    for (const root of roots) {
      let entries: string[] = [];
      try {
        entries = readdirSync(root);
      } catch {
        continue;
      }
      projects.push(...entries.map((entry) => ({ name: entry, path: join(root, entry) })));
    }
  }
  return projects;
}

export async function handleMcpAuth(
  _input: Record<string, never> = {},
  context?: PluginHandlerContext,
) {
  const readNeeds = (dir: string): string[] => {
    const data = readJson(join(dir, "mcp-needs-auth-cache.json"));
    return data ? Object.keys(data) : [];
  };
  const countServers = (configPath: string): number => Object.keys(jsonMcpRead(configPath)).length;
  const accounts = [] as Array<{
    provider: "claude" | "codex";
    email: string;
    dir: string;
    isPrimary: boolean;
    definedServers: number;
    needsAuth: string[];
    authStatus: Record<string, "connected" | "not-connected" | "unsupported" | "unknown">;
  }>;
  const primaryEmail = claudeAccountEmail(HOME);
  if (primaryEmail) {
    const needsAuth = readNeeds(join(HOME, ".claude"));
    accounts.push({
      provider: "claude",
      email: primaryEmail,
      dir: join(HOME, ".claude"),
      isPrimary: true,
      definedServers: countServers(join(HOME, ".claude.json")),
      needsAuth,
      authStatus: Object.fromEntries(needsAuth.map((name) => [name, "not-connected" as const])),
    });
  }
  for (const slot of collectSlots()) {
    if (slot.provider !== "claude") continue;
    const needsAuth = readNeeds(slot.dir);
    accounts.push({
      provider: "claude",
      email: slot.email,
      dir: slot.dir,
      isPrimary: false,
      definedServers: countServers(join(slot.dir, ".claude.json")),
      needsAuth,
      authStatus: Object.fromEntries(needsAuth.map((name) => [name, "not-connected" as const])),
    });
  }
  const primaryCodexDir = join(HOME, ".codex");
  const primaryCodexEmail = codexAccountEmail(primaryCodexDir);
  if (primaryCodexEmail) {
    accounts.push({
      provider: "codex",
      email: primaryCodexEmail,
      dir: primaryCodexDir,
      isPrimary: true,
      definedServers: tomlMcpNames(join(primaryCodexDir, "config.toml")).length,
      needsAuth: [],
      authStatus: codexMcpAuth(primaryCodexDir),
    });
  }
  for (const slot of collectSlots()) {
    if (slot.provider !== "codex" || !slot.loggedIn) continue;
    accounts.push({
      provider: "codex",
      // The destination is keyed by the slot name. The Agents tab separately
      // flags a slot whose authenticated email does not match that name.
      email: slot.email,
      dir: slot.dir,
      isPrimary: false,
      definedServers: tomlMcpNames(join(slot.dir, "config.toml")).length,
      needsAuth: [],
      authStatus: codexMcpAuth(slot.dir),
    });
  }
  const projectServers: Array<{ project: string; name: string }> = [];
  const projects = await discoverProjects(context?.paseo ?? null);
  const seenProjectServers = new Set<string>();
  for (const project of projects) {
    const file = join(project.path, ".mcp.json");
    if (!existsSync(file)) continue;
    for (const name of Object.keys(jsonMcpRead(file))) {
      const key = `${project.name}\0${name}`;
      if (seenProjectServers.has(key)) continue;
      seenProjectServers.add(key);
      projectServers.push({ project: project.name, name });
    }
  }
  projectServers.sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
  return { accounts, projectServers };
}

/** Resolve project MCP state from Paseo's live workspace registry, never a client path. */
export async function handleMcpWorkspace(
  { workspaceId }: { workspaceId: string },
  { paseo }: PluginHandlerContext,
) {
  const result = await paseo.workspaces.list();
  const entries = (result as {
    entries: Array<{
      id: string;
      name: string;
      workspaceDirectory?: string;
      projectRootPath: string;
    }>;
  }).entries;
  const workspace = entries.find((entry) => entry.id === workspaceId);
  if (!workspace) throw new Error("This Paseo workspace no longer exists.");

  const directory = workspace.workspaceDirectory || workspace.projectRootPath;
  const candidates = [...new Set([directory, workspace.projectRootPath].filter(Boolean))];
  const configPath = candidates.map((candidate) => join(candidate, ".mcp.json")).find(existsSync) ?? "";
  const definitions = configPath ? jsonMcpRead(configPath) : {};
  const servers = Object.entries(definitions)
    .map(([name, def]) => {
      const hasInline = hasInlineCredentials(def);
      return {
        name,
        transport: def.command ? ("stdio" as const) : def.url ? ("http" as const) : ("unknown" as const),
        detail: redactDetail(def).slice(0, 80),
        authStyle: hasInline ? ("inline-credentials" as const) : ("oauth-or-none" as const),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const { accounts } = await handleMcpAuth({}, { paseo });
  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      directory,
      projectRootPath: workspace.projectRootPath,
    },
    configPath,
    servers,
    accounts,
  };
}

export async function handleMcpSync(): Promise<{ ok: boolean; log: string }> {
  const logs: string[] = [];
  const slots = collectSlots();
  const primary = readJson(join(HOME, ".claude.json"));
  if (primary) {
    const mcp = (primary.mcpServers as Record<string, unknown> | undefined) ?? {};
    const projects = (primary.projects as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const slot of slots.filter((entry) => entry.provider === "claude")) {
      const path = join(slot.dir, ".claude.json");
      const config = existsSync(path) ? readJson(path) : {};
      if (config === null) {
        logs.push(`claude · ${slot.email}: SKIPPED — ${path} exists but is not valid JSON`);
        continue;
      }
      // Union, not replace: a server that exists only in this account (or an
      // auth header edited per account) must survive a sync.
      const slotServers = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
      config.mcpServers = { ...mcp, ...slotServers };
      const slotProjects = (config.projects as Record<string, Record<string, unknown>> | undefined) ?? {};
      config.projects = slotProjects;
      let trusted = 0;
      for (const [projectPath, entry] of Object.entries(projects)) {
        if (!entry?.hasTrustDialogAccepted) continue;
        trusted += 1;
        const target = slotProjects[projectPath] ?? {};
        slotProjects[projectPath] = target;
        for (const field of SYNC_PROJECT_FIELDS) {
          if (field in entry) target[field] = entry[field];
        }
      }
      backupFile(path);
      writeJsonAtomic(path, config);
      logs.push(`claude · ${slot.email}: ${Object.keys(mcp).length} MCP servers, ${trusted} trusted projects`);
    }
  }
  const codexPrimary = join(HOME, ".codex", "config.toml");
  if (existsSync(codexPrimary)) {
    // Copy only the MCP blocks the slot is missing, never the whole file — the
    // slot's own model/approval settings and per-account servers stay put.
    // One read of the primary file; per-name re-reads made this ~28 reads of it.
    let primaryText = "";
    try {
      primaryText = readFileSync(codexPrimary, "utf8");
    } catch {
      primaryText = "";
    }
    const primaryDefs: Array<[string, McpDef]> = [];
    for (const name of tomlMcpNamesFromText(primaryText)) {
      const def = tomlMcpReadOneFromText(primaryText, name);
      if (def) primaryDefs.push([name, def]);
    }
    for (const slot of slots.filter((entry) => entry.provider === "codex")) {
      const path = join(slot.dir, "config.toml");
      try {
        let text = tomlReadForWrite(path);
        const existing = new Set(tomlMcpNamesFromText(text));
        let added = 0;
        for (const [name, def] of primaryDefs) {
          if (existing.has(name)) continue; // never clobber a per-account definition
          text = tomlApply(text, name, def);
          added += 1;
        }
        backupFile(path);
        writeTextAtomic(path, text);
        logs.push(`codex · ${slot.email}: ${added} MCP server(s) added, ${existing.size} kept as-is`);
      } catch (error) {
        logs.push(`codex · ${slot.email}: SKIPPED — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (logs.length === 0) return { ok: true, log: "no account slots to sync yet" };
  logs.push("==> MCP definitions and project trust only — OAuth grants never copied");
  return { ok: true, log: logs.join("\n") };
}
