/**
 * Whether an agent's CLI defers MCP tool definitions ("tool search"), so a
 * long tool list costs little context, or loads every definition with the
 * first prompt. Pure: the host gathers the inputs, the budget reads the verdict.
 *
 * Claude Code (https://code.claude.com/docs/en/mcp#configure-tool-search and
 * https://code.claude.com/docs/en/env-vars, read 2026-09-24):
 *
 *  - Tool search is on by default: "MCP tools are deferred and discovered on
 *    demand."
 *  - "Claude Code disables it when `ANTHROPIC_BASE_URL` points to a
 *    non-first-party host". `ENABLE_TOOL_SEARCH` set explicitly overrides that
 *    fallback: `true`, `auto` and `auto:N` defer, `false` loads everything up
 *    front. `auto` is a threshold: tools load up front while their
 *    definitions total less than 10% of the context window; `auto:N` sets N%
 *    (0-100). N up to 10 counts as on here; a higher N is unknown.
 *  - A settings file's `env` "overwrites the same variable exported in your
 *    shell, and when more than one settings file sets a variable, the
 *    highest-precedence one applies" (settings-reference#env); local beats
 *    project beats user (https://code.claude.com/docs/en/settings#settings-precedence).
 *    An empty value cancels a shell export. Paseo's Claude sessions read all
 *    three (agent.js `CLAUDE_SETTING_SOURCES`).
 *  - `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`: "MCP tool search is disabled and
 *    all MCP tools load upfront, even when you set `ENABLE_TOOL_SEARCH`. On
 *    Claude Code v2.1.227 or later, managed settings can keep tool search on"
 *    (env-vars); for `ENABLE_TOOL_SEARCH`, "A value you set yourself is ignored
 *    when `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` is set". Through
 *    `ANTHROPIC_BASE_URL` the override keeps the tool-search beta header,
 *    `defer_loading` and `tool_reference`; on a cloud provider it has no
 *    effect (llm-gateway-protocol#disable-pre-release-capabilities).
 *  - No page names a managed key for that override (read 2026-09-24), so a
 *    managed `env.ENABLE_TOOL_SEARCH` is taken as it: the highest-precedence
 *    layer, and the only one the betas flag does not silence. The plugin
 *    cannot see the CLI version without starting it, so an "on" from managed
 *    settings under the betas flag names the v2.1.227 minimum instead.
 *  - Google Cloud's Agent Platform models earlier than Claude 4.5 and
 *    Microsoft Foundry deployments hosted on Azure load everything up front.
 *    The plugin cannot see the model or the deployment, so those are unknown.
 *
 * Codex (openai/codex#29486, merged 2026-06-22): MCP tools are deferred "when
 * `tool_search` and namespaced tools are supported", which depends on the
 * model (`model_info.supports_search_tool`). The plugin cannot see the model,
 * so Codex is unknown. No other CLI documents tool search, so they are off.
 *
 * Unknown and off both keep the full tool count in the budget; only on relaxes it.
 */

import { PASEO_BUILTIN_PROVIDERS } from "./paseo-tools";

export type ToolSearchState = "on" | "off" | "unknown";

/**
 * `reason` is a clause naming the deciding fact, for `toolSearchLine`; `cli`
 * the base CLI it was judged for ("" unknown). `managed` (0.11.2) is set when
 * managed settings decided it, so the panel names the file even for "on".
 */
export type ToolSearchVerdict = { state: ToolSearchState; reason: string; cli: string; managed?: boolean };

/** Where a variable came from, most specific last: the daemon, the provider entry, AI Router's session hook, Claude Code's settings files, managed settings. */
export type EnvSource = "daemon" | "provider" | "ai-router" | "settings" | "managed";

/** One settings file's `env`; `label` names the file in a reason ("~/.claude/settings.json"). */
export type SettingsEnv = { label: string; env: Record<string, string> };

export type ToolSearchInputs = {
  /** The provider's base CLI: claude, codex, copilot …; "" when not known. */
  base: string;
  /** The provider entry's `env` in the daemon config. */
  providerEnv?: Record<string, string> | null;
  /** The base provider's entry `env`, which a derived provider inherits (`inheritedEnv`). */
  baseEnv?: Record<string, string> | null;
  /** Claude Code's settings files' `env`, lowest precedence first: user, project, local. */
  settingsEnv?: ReadonlyArray<SettingsEnv> | null;
  /** Managed settings files' `env` in the order Claude Code merges them (`managed-settings.json`, then `managed-settings.d/*.json`); above everything. */
  managedEnv?: ReadonlyArray<SettingsEnv> | null;
  /** AI Router's `routeAgents`; it only reroutes the built-in `claude` provider (its own `ai-router` provider always is). */
  aiRouterRoutes?: boolean;
  /** The daemon's own environment (the plugin process inherits it). */
  daemonEnv?: Record<string, string | undefined> | null;
};

/** AI Router's Claude-based provider id (its shared/logic.ts `AI_ROUTER_PROVIDER_ID`). */
export const AI_ROUTER_PROVIDER_ID = "ai-router";

export const TOOL_SEARCH_VARS = [
  "ANTHROPIC_BASE_URL",
  "ENABLE_TOOL_SEARCH",
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
] as const;

type Var = (typeof TOOL_SEARCH_VARS)[number];

type Resolved = Partial<Record<Var, { value: string; source: EnvSource; label: string }>>;

/**
 * The env Claude Code runs with. Paseo launches it with the daemon's env, then
 * the base entry's and the provider entry's (provider-registry.js
 * `mergeRuntimeSettings`), then AI Router's session hook; Claude Code then
 * writes its settings files' `env` over that, user, project, local, and
 * managed settings last ("Managed settings have the highest precedence").
 */
export function effectiveEnv(providerId: string, inputs: ToolSearchInputs): Resolved {
  const out: Resolved = {};
  const layer = (env: Record<string, string | undefined> | null | undefined, source: EnvSource, label: string) => {
    for (const name of TOOL_SEARCH_VARS) {
      const value = env?.[name];
      if (typeof value !== "string") continue;
      if (value.trim() !== "") out[name] = { value: value.trim(), source, label };
      // An empty value in a settings file cancels a shell export (settings-reference#env).
      else if (source === "settings" || source === "managed") delete out[name];
    }
  };
  layer(inputs.daemonEnv, "daemon", "The daemon's environment");
  layer(inputs.baseEnv, "provider", `The ${inputs.base} provider`);
  layer(inputs.providerEnv, "provider", `The ${providerId} provider`);
  // AI Router's session hook (shared/logic.ts routeSession, ROUTED_CLAUDE_ENV)
  // sets both on every session it routes.
  if (routedByAiRouter(providerId, inputs)) {
    layer({ ANTHROPIC_BASE_URL: "ai-router", CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, "ai-router", "AI Router");
  }
  for (const file of inputs.settingsEnv ?? []) layer(file.env, "settings", file.label);
  for (const file of inputs.managedEnv ?? []) layer(file.env, "managed", file.label);
  return out;
}

/** A variable in the env Paseo launches the CLI with (daemon, base entry, provider entry), before any settings file. */
export function launchValue(name: string, inputs: Pick<ToolSearchInputs, "daemonEnv" | "baseEnv" | "providerEnv">): string | undefined {
  for (const env of [inputs.providerEnv, inputs.baseEnv, inputs.daemonEnv]) {
    const value = env?.[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** AI Router's session hook rewrites the built-in claude while `routeAgents` is on, and its own provider always. */
function routedByAiRouter(providerId: string, inputs: ToolSearchInputs): boolean {
  return (providerId === "claude" && Boolean(inputs.aiRouterRoutes)) || providerId === AI_ROUTER_PROVIDER_ID;
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

/** Anthropic's own API host; anything else is a "non-first-party host" in Claude Code's words. */
export function isFirstPartyBaseUrl(value: string): boolean {
  try {
    return new URL(value).hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value.slice(0, 40);
  }
}

const CLI_LABELS: Record<string, string> = { acp: "An ACP agent", codex: "Codex", copilot: "Copilot", opencode: "OpenCode", pi: "Pi", omp: "omp", kimi: "Kimi Code", grok: "Grok" };

/** The verdict for one Paseo provider id. */
export function toolSearch(providerId: string, inputs: ToolSearchInputs): ToolSearchVerdict {
  const cli = inputs.base;
  const verdict = (state: ToolSearchState, reason: string): ToolSearchVerdict => ({ state, reason, cli });
  if (!cli) return verdict("unknown", `The plugin does not know which CLI the ${providerId || "unwired"} provider runs`);
  if (cli === "codex") {
    return verdict("unknown", "Codex defers MCP tools only when its model supports tool search, and the plugin cannot see the model");
  }
  if (cli !== "claude") return verdict("off", `${CLI_LABELS[cli] ?? cli} has no documented tool search`);

  const env = effectiveEnv(providerId, inputs);
  const managed = managedVerdict(env, cli);
  if (managed) return managed;
  const betas = env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS;
  const url = env.ANTHROPIC_BASE_URL;
  const custom = url && (url.source === "ai-router" || !isFirstPartyBaseUrl(url.value)) ? url : undefined;
  const explicit = env.ENABLE_TOOL_SEARCH?.value.toLowerCase();
  const threshold = autoThreshold(explicit);
  const forcedOn = explicit === "true" || threshold === "on";

  const routed = custom?.source === "ai-router" || betas?.source === "ai-router";
  if (routed) return verdict("off", AI_ROUTER_REASON);
  if (betas && truthy(betas.value)) return verdict("off", `${betas.label} sets CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`);
  if (explicit === "false") return verdict("off", `${env.ENABLE_TOOL_SEARCH!.label} sets ENABLE_TOOL_SEARCH=false`);
  if (threshold !== null && threshold !== "on") {
    return verdict("unknown", `${env.ENABLE_TOOL_SEARCH!.label} sets ENABLE_TOOL_SEARCH=${env.ENABLE_TOOL_SEARCH!.value}, ${threshold}`);
  }
  if (custom && !forcedOn) return verdict("off", `${custom.label} sets a custom ANTHROPIC_BASE_URL (${hostOf(custom.value)})`);
  const cloud = cloudProvider(env);
  if (cloud) return verdict("unknown", cloud);
  return forcedOn
    ? verdict("on", `ENABLE_TOOL_SEARCH=${env.ENABLE_TOOL_SEARCH!.value} is set`)
    : verdict("on", "Claude Code's default");
}

/** Foundry and Agent Platform keep some deployments and models off whatever is set; the clause saying so, or null. */
function cloudProvider(env: Resolved): string | null {
  if (truthy(env.CLAUDE_CODE_USE_FOUNDRY?.value)) return "Claude Code runs on Microsoft Foundry, where a deployment hosted on Azure turns tool search off";
  if (truthy(env.CLAUDE_CODE_USE_VERTEX?.value)) return "Claude Code runs on Google Cloud's Agent Platform, where models before Claude 4.5 have no tool search";
  return null;
}

/** Claude Code set to run on a cloud provider (https://code.claude.com/docs/en/env-vars). */
function onCloudProvider(env: Resolved): boolean {
  return (
    truthy(env.CLAUDE_CODE_USE_BEDROCK?.value) ||
    truthy(env.CLAUDE_CODE_USE_MANTLE?.value) ||
    truthy(env.CLAUDE_CODE_USE_ANTHROPIC_AWS?.value) ||
    truthy(env.CLAUDE_CODE_USE_VERTEX?.value) ||
    truthy(env.CLAUDE_CODE_USE_FOUNDRY?.value)
  );
}

/** The first Claude Code release where managed settings keep tool search on under the betas flag. */
export const MANAGED_OVERRIDE_MIN_VERSION = "2.1.227";

/**
 * A managed `ENABLE_TOOL_SEARCH` decides before anything below it, the betas
 * flag and AI Router's routing included. Null when managed settings do not set
 * a documented value, so the ordinary rules apply.
 */
function managedVerdict(env: Resolved, cli: string): ToolSearchVerdict | null {
  const set = env.ENABLE_TOOL_SEARCH;
  if (set?.source !== "managed") return null;
  const value = set.value.toLowerCase();
  const threshold = autoThreshold(value);
  const verdict = (state: ToolSearchState, reason: string): ToolSearchVerdict => ({ state, reason, cli, managed: true });
  if (value === "false") return verdict("off", `${set.label} set ENABLE_TOOL_SEARCH=false`);
  if (threshold !== null && threshold !== "on") return verdict("unknown", `${set.label} set ENABLE_TOOL_SEARCH=${set.value}, ${threshold}`);
  if (value !== "true" && threshold !== "on") return null;
  const betas = env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS;
  const underBetas = betas !== undefined && (betas.source === "ai-router" || truthy(betas.value));
  // "On a cloud provider … the override has no effect" (llm-gateway-protocol):
  // under the betas flag that leaves tool search off, which the ordinary rules say.
  if (underBetas && onCloudProvider(env)) return null;
  const cloud = cloudProvider(env);
  if (cloud) return verdict("unknown", cloud);
  return verdict(
    "on",
    underBetas
      ? `${set.label} keep tool search on, even with CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS set (this needs Claude Code v${MANAGED_OVERRIDE_MIN_VERSION} or later)`
      : `${set.label} keep tool search on`,
  );
}

export const AI_ROUTER_REASON = "AI Router re-routes this provider through OmniRoute (custom ANTHROPIC_BASE_URL) whenever its endpoint is up";

/** The threshold `auto` uses, and the highest `auto:N` counted as on. */
const AUTO_DEFAULT_PERCENT = 10;

/**
 * `auto` and `auto:N`: "on" for a threshold of 10% or less, a clause saying
 * why not otherwise, null when the value is not a threshold at all.
 */
function autoThreshold(explicit: string | undefined): string | null {
  if (explicit === "auto") return "on";
  if (!explicit?.startsWith("auto:")) return null;
  const raw = explicit.slice("auto:".length);
  const percent = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(percent >= 0 && percent <= 100)) return "which is not a threshold Claude Code documents (auto:0 to auto:100)";
  if (percent <= AUTO_DEFAULT_PERCENT) return "on";
  return `which defers tools only once they fill ${percent}% of the context window`;
}

export const TOOL_SEARCH_ON_LINE = "Claude Code's tool search is on: tool definitions load up front only while they fit in 10% of the context window, and on demand past that.";

/** The "on" line; managed settings are named in front of it, since that verdict turns on a file most users never see. */
export function toolSearchOnLine(verdict: ToolSearchVerdict): string {
  return verdict.managed ? `${verdict.reason}. ${TOOL_SEARCH_ON_LINE}` : TOOL_SEARCH_ON_LINE;
}

/** The one line the budget panel shows for a verdict, with the load's tool estimate. */
export function toolSearchLine(verdict: ToolSearchVerdict, tools: number): string {
  if (verdict.state === "on") return toolSearchOnLine(verdict);
  const all = `all ${tools} tool ${tools === 1 ? "definition loads" : "definitions load"} with the first prompt`;
  if (verdict.state === "unknown") return `${verdict.reason}, so this counts as if ${all}.`;
  if (verdict.cli === "claude") return `${verdict.reason}, so Claude Code's tool search is off and ${all}.`;
  return `${verdict.reason}, so ${all}.`;
}

// ------------------------------------------------------------ AI Router settings

/**
 * AI Router's `routeAgents` from its settings file
 * (`$PASEO_HOME/plugin-settings/ai-router/routing.json`, envelope
 * `{ version, values: { routeAgents } }`). Missing, unreadable, malformed or
 * a version other than 1 means not routed, the same default AI Router reads.
 */
export function aiRouterRoutesAgents(parsed: unknown): boolean {
  const envelope = parsed as { version?: unknown; values?: { routeAgents?: unknown } } | null;
  // AI Router's parseRoutingEnvelope: any other version reads as its defaults (routeAgents off).
  if (envelope?.version !== AI_ROUTER_SETTINGS_VERSION) return false;
  const values = envelope.values;
  return Boolean(values && typeof values === "object" && values.routeAgents === true);
}

/** AI Router's `ROUTING_SETTINGS_VERSION`. */
const AI_ROUTER_SETTINGS_VERSION = 1;

/** Base CLI and env per provider entry, from `paseo.config.get()` (flattened or nested `providers`). */
export type ProviderLaunch = Record<string, { extends?: string; env: Record<string, string> }>;

export function readProviderLaunch(config: unknown): ProviderLaunch {
  const root = (config && typeof config === "object" ? config : {}) as { providers?: unknown; agents?: { providers?: unknown } };
  const raw = root.providers ?? root.agents?.providers;
  const out: ProviderLaunch = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = (value && typeof value === "object" ? value : {}) as { extends?: unknown; env?: unknown };
    const env: Record<string, string> = {};
    if (entry.env && typeof entry.env === "object") {
      for (const [key, v] of Object.entries(entry.env as Record<string, unknown>)) if (typeof v === "string") env[key] = v;
    }
    out[id] = { ...(typeof entry.extends === "string" ? { extends: entry.extends } : {}), env };
  }
  return out;
}

/**
 * The base entry's `env` a derived provider starts with under its own
 * (provider-registry.js `addDerivedProviders`, `mergeRuntimeSettings`:
 * `{ ...base.env, ...own.env }`). `extends` is a built-in or `acp`, so there
 * is no chain; `acp` has no entry to inherit from.
 */
export function inheritedEnv(providerId: string, launch: ProviderLaunch): Record<string, string> | undefined {
  const base = launch[providerId]?.extends;
  if (!base || base === providerId || !(PASEO_BUILTIN_PROVIDERS as readonly string[]).includes(base)) return undefined;
  return launch[base]?.env;
}

/**
 * A provider id's base CLI: the entry's `extends`, the id itself for a
 * built-in or a known editor CLI, else what the caller knows from the editor
 * list (`fallback`), else "".
 */
export function baseCli(providerId: string, launch: ProviderLaunch, fallback = ""): string {
  const own = launch[providerId]?.extends;
  if (own) return own;
  if (["claude", "codex", "copilot", "opencode", "pi", "omp", "kimi", "grok"].includes(providerId)) return providerId;
  return fallback;
}
