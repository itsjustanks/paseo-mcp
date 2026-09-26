import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { isPaseoOwnServer, placeLabel, sameDefinition, type CopyPlanServer, type CopyResult } from "../shared/copy-all";
import type { Destination } from "../shared/contracts";
import type { Dialect } from "../shared/mcpjson";
import {
  buildDestinations,
  destNamesAll,
  destRead,
  destReadOne,
  destWriteMany,
  DIALECTS,
  dialectOf,
  hasInlineCredentials,
  jsonSafeDef,
  readJson,
  tomlString,
  type McpDef,
} from "./handlers";

/**
 * "Copy to all my AI apps" (0.15.0) on the host. The plan is every gap: each
 * user-level server, and each app and account on this host that doesn't have
 * it BY NAME (in any form the file writes it; never by whether this app could
 * read the definition). Only what can be copied exactly is copied: between
 * two accounts of one app the entry goes as it is; between apps only the
 * settings every app shares, and anything else (an app-only setting, a server
 * switched off, a `${…}` the other app wouldn't fill in the same way) is
 * skipped with the reason. Each file is written once per Copy (one backup),
 * add-only: the write re-reads the file and refuses a name it already has.
 * Every write is read back. Project `.mcp.json` servers aren't read here, and
 * Paseo's own server is left out.
 */

type Source = { dest: Destination; def: McpDef };
type Plan = CopyPlanServer & { source: Source; perTarget: Map<string, McpDef> };

/** The settings every app shares; anything else in a definition belongs to the app it came from. */
const SHARED_KEYS = new Set(["command", "args", "env", "url", "headers", "type", "extra", "headerTable", "tables", "partial"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The copy to use: the first JSON config with a complete copy (the one the editors' own writes are most faithful to), else the first TOML one. */
function sourceOf(destinations: Destination[], defs: Map<string, Record<string, McpDef>>, name: string): Source | null {
  let found: Source | null = null;
  for (const dest of destinations) {
    const def = defs.get(dest.id)?.[name];
    if (!def || def.partial) continue;
    if (!found) found = { dest, def };
    if (dest.format === "json-mcp") return { dest, def };
  }
  return found;
}

/** Why a server that some app has can't be copied from any of them. */
function unreadableReason(destinations: Destination[], defs: Map<string, Record<string, McpDef>>, name: string): string {
  const partial = destinations.map((dest) => defs.get(dest.id)?.[name]?.partial).find(Boolean);
  return `copy this one by hand: ${partial ?? "this app couldn't read all of its settings"}`;
}

/** A Claude `${X}` header, in Codex's own words (developers.openai.com/codex/mcp): `bearer_token_env_var` names the variable sent as `Authorization: Bearer …`; `env_http_headers` maps a header name to the variable holding its value. */
function codexHeaders(headers: Record<string, string>): { headers: Record<string, string>; extra: string[]; envHeaders: Record<string, string> } | { reason: string } {
  const out = { headers: {} as Record<string, string>, extra: [] as string[], envHeaders: {} as Record<string, string> };
  for (const [key, value] of Object.entries(headers)) {
    const bearer = /^Bearer \$\{([^}]*)\}$/.exec(value);
    const whole = /^\$\{([^}]*)\}$/.exec(value);
    if (key.toLowerCase() === "authorization" && bearer && ENV_NAME.test(bearer[1] ?? "") && out.extra.length === 0) {
      out.extra.push(`bearer_token_env_var = ${tomlString(bearer[1] ?? "")}`);
    } else if (whole && ENV_NAME.test(whole[1] ?? "")) {
      out.envHeaders[key] = whole[1] ?? "";
    } else if (value.includes("${")) {
      return { reason: `its ${key} header mixes text with a \${…} value, which Codex can't fill in` };
    } else {
      out.headers[key] = value;
    }
  }
  return out;
}

/**
 * The definition as the target app should get it, or why it can't be copied
 * exactly. Two accounts of one app: the entry as it is. Two apps: only the
 * shared settings, and nothing that means something else on the other side.
 */
export function translateFor(source: Source, name: string, target: Destination): { def: McpDef } | { reason: string } {
  const from = dialectOf(source.dest);
  const to: Dialect = dialectOf(target);
  const def = source.def;
  if (def.partial) return { reason: `copy this one by hand: ${def.partial}` };
  if (from === to) return { def };
  const app = DIALECTS[from].label;
  const other = DIALECTS[to].label;
  if (from === "claude-json") {
    const disabled = readJson(source.dest.configPath)?.disabledMcpServers;
    if (Array.isArray(disabled) && disabled.includes(name)) return { reason: `it's switched off in ${app}` };
  } else if ((def.extra ?? []).some((line) => /^enabled\s*=\s*false\b/.test(line.trim()))) {
    return { reason: `it's switched off in ${app}` };
  }
  const own = [
    ...Object.keys(def).filter((key) => !SHARED_KEYS.has(key)),
    ...(def.extra ?? []).filter((line) => !/^enabled\s*=\s*true\s*(#.*)?$/.test(line.trim())).map((line) => line.split("=")[0]?.trim() ?? line),
    ...(def.tables ?? []).map((table) => table.sub),
  ];
  if (own.length > 0) return { reason: `copy this one by hand: it uses ${own.length === 1 ? `a ${app}-only setting` : `${app}-only settings`} (${own.join(", ")})` };
  if (def.type !== undefined && def.type !== "http" && def.type !== "stdio") return { reason: `copy this one by hand: it uses a ${String(def.type)} connection, which ${other} may not` };

  const clean: McpDef = {};
  if (def.command !== undefined) clean.command = def.command;
  if (def.args !== undefined) clean.args = [...def.args];
  if (def.url !== undefined) clean.url = def.url;
  if (def.env && Object.keys(def.env).length > 0) clean.env = { ...def.env };
  if (def.headers && Object.keys(def.headers).length > 0) clean.headers = { ...def.headers };
  if (def.type !== undefined) clean.type = def.type;

  if (to === "codex-toml" && from === "claude-json" && clean.headers) {
    const translated = codexHeaders(clean.headers);
    if ("reason" in translated) return translated;
    if (Object.keys(translated.headers).length > 0) clean.headers = translated.headers;
    else delete clean.headers;
    if (translated.extra.length > 0) clean.extra = translated.extra;
    const envHeaders = Object.entries(translated.envHeaders);
    if (envHeaders.length > 0) clean.tables = [{ sub: "env_http_headers", lines: envHeaders.map(([key, variable]) => `${tomlString(key)} = ${tomlString(variable)}`) }];
  }
  const values = [clean.command ?? "", clean.url ?? "", ...(clean.args ?? []), ...Object.values(clean.env ?? {}), ...Object.values(clean.headers ?? {})];
  if (values.some((value) => value.includes("${"))) {
    return {
      reason:
        to === "codex-toml"
          ? "copy this one by hand: it fills in a ${…} value that Codex can't"
          : `copy this one by hand: it fills in a \${…} value, and ${other} may not do that the same way`,
    };
  }
  // `type` is JSON vocabulary: it travels between JSON apps, and TOML has no word for it.
  if (DIALECTS[to].format !== "json-mcp") delete clean.type;
  return { def: clean };
}

function planFrom(destinations: Destination[]): { servers: Plan[]; excluded: Array<{ name: string; reason: string }> } {
  const names = new Map(destinations.map((dest) => [dest.id, destNamesAll(dest)] as const));
  const defs = new Map(destinations.map((dest) => [dest.id, destRead(dest)] as const));
  const all = [...new Set([...names.values()].flatMap((entry) => [...entry]))].sort((a, b) => a.localeCompare(b));
  const servers: Plan[] = [];
  const excluded: Array<{ name: string; reason: string }> = [];
  for (const name of all) {
    const holders = destinations.filter((dest) => names.get(dest.id)?.has(name));
    const gaps = destinations.filter((dest) => !names.get(dest.id)?.has(name));
    const anyDef = holders.map((dest) => defs.get(dest.id)?.[name]).find(Boolean);
    if (anyDef && isPaseoOwnServer(name, anyDef)) {
      excluded.push({ name, reason: "Paseo's own tools: Paseo adds them to its agents itself." });
      continue;
    }
    if (gaps.length === 0) continue;
    const source = sourceOf(destinations, defs, name);
    if (!source) {
      excluded.push({ name, reason: unreadableReason(destinations, defs, name) });
      continue;
    }
    const perTarget = new Map<string, McpDef>();
    const blocked: Array<{ label: string; reason: string }> = [];
    for (const dest of gaps) {
      const translated = translateFor(source, name, dest);
      if ("def" in translated) perTarget.set(dest.id, translated.def);
      else blocked.push({ label: placeLabel(dest), reason: translated.reason });
    }
    if (perTarget.size === 0) {
      excluded.push({ name, reason: [...new Set(blocked.map((entry) => entry.reason))].join("; ") });
      continue;
    }
    const differs = holders.some((dest) => {
      const there = defs.get(dest.id)?.[name];
      return !there || !sameDefinition(there, source.def);
    });
    servers.push({
      name,
      from: placeLabel(source.dest),
      targets: gaps.filter((dest) => perTarget.has(dest.id)).map((dest) => ({ id: dest.id, label: placeLabel(dest) })),
      savedKey: hasInlineCredentials(source.def),
      ...(blocked.length > 0 ? { blocked } : {}),
      ...(differs ? { note: `Your apps have different versions of it; this copies the one in ${placeLabel(source.dest)}.` } : {}),
      source,
      perTarget,
    });
  }
  return { servers, excluded };
}

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : item,
  );

/** The file, read again, says what was meant: every field for JSON; for TOML the shared fields, the carried lines and subtables, and the header table the app reads. */
function readsBack(dest: Destination, name: string, written: McpDef): boolean {
  const there = destReadOne(dest, name);
  if (!there) return false;
  const dialect = dialectOf(dest);
  if (dest.format === "json-mcp") return stable(there) === stable(jsonSafeDef(written, dialect === "claude-json" ? "claude-json" : "other"));
  if (there.partial || !sameDefinition(there, written)) return false;
  if (stable(there.extra ?? []) !== stable(written.extra ?? []) || stable(there.tables ?? []) !== stable(written.tables ?? [])) return false;
  return !written.headers || there.headerTable === DIALECTS[dialect].headerKey;
}

export async function handleMcpCopyPlan(_input: Record<string, never>, context: PluginHandlerContext) {
  const { servers, excluded } = planFrom(await buildDestinations(context.paseo));
  return { servers: servers.map(({ source: _source, perTarget: _perTarget, ...entry }) => entry), excluded };
}

export async function handleMcpCopyAll(
  { servers: chosen }: { servers: Array<{ name: string; targets: string[] }> },
  context: PluginHandlerContext,
) {
  // A write: the provider settings are read fresh, and the plan is worked out
  // again from the files as they are now (the preview may be minutes old).
  const destinations = await buildDestinations(context.paseo, { fresh: true });
  const { servers, excluded } = planFrom(destinations);
  const plan = new Map(servers.map((entry) => [entry.name, entry]));
  const results: CopyResult[] = [];
  const queue = new Map<string, Array<{ name: string; def: McpDef; result: CopyResult }>>();
  for (const pick of chosen) {
    const entry = plan.get(pick.name);
    const result: CopyResult = { name: pick.name, from: entry?.from ?? "", written: [], skipped: [] };
    results.push(result);
    for (const id of pick.targets) {
      const dest = destinations.find((candidate) => candidate.id === id);
      if (!dest) {
        result.skipped.push({ label: id, reason: "this app or account is switched off in Paseo, or isn't on this computer any more" });
        continue;
      }
      const label = placeLabel(dest);
      const def = entry?.perTarget.get(id);
      if (entry && def) {
        const list = queue.get(id) ?? [];
        list.push({ name: pick.name, def, result });
        queue.set(id, list);
        continue;
      }
      const blocked = entry?.blocked?.find((line) => line.label === label);
      if (blocked) {
        result.skipped.push(blocked);
        continue;
      }
      // Not a gap any more: something by that name is there now. Never overwritten.
      if (destNamesAll(dest).has(pick.name)) {
        const there = destReadOne(dest, pick.name);
        const same = there && entry && sameDefinition(there, entry.source.def);
        result.skipped.push({ label, reason: same ? "it already has it" : `it already has a different server called ${pick.name}; left as it is` });
        continue;
      }
      const why = excluded.find((line) => line.name === pick.name)?.reason;
      result.skipped.push({ label, reason: why ?? "no app has this server any more" });
    }
    if (!entry && pick.targets.length === 0) result.skipped.push({ label: pick.name, reason: "every app already has it" });
  }

  // One write per file, with one backup first, add-only; then each server is read back.
  for (const dest of destinations) {
    const entries = queue.get(dest.id);
    if (!entries) continue;
    const label = placeLabel(dest);
    let refused: Map<string, string>;
    try {
      refused = destWriteMany(
        dest,
        entries.map(({ name, def }) => ({ name, def })),
        { onlyIfAbsent: true, headerTable: dest.format === "toml-mcp" ? DIALECTS[dialectOf(dest)].headerKey : undefined },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      for (const { result } of entries) result.skipped.push({ label, reason });
      continue;
    }
    for (const { name, def, result } of entries) {
      const reason = refused.get(name);
      if (reason) result.skipped.push({ label, reason });
      else if (readsBack(dest, name, def)) result.written.push(label);
      else result.skipped.push({ label, reason: "written, but reading it back didn't match; the file's backup is beside it" });
    }
  }
  const written = results.reduce((sum, entry) => sum + entry.written.length, 0);
  const skipped = results.reduce((sum, entry) => sum + entry.skipped.length, 0);
  return {
    ok: skipped === 0,
    message: written > 0 || skipped > 0 ? `Copied to ${written} place${written === 1 ? "" : "s"}${skipped > 0 ? `; ${skipped} skipped` : ""}. Backups were saved first.` : "Nothing to copy.",
    results,
  };
}
