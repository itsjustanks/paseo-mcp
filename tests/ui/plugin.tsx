/** Browser stand-in for @getpaseo/plugin: every MCP contract answered from fixtures. */
import React, { useCallback } from "react";
import { Text, View } from "react-native";
import { buildPaseoToolsPatch, paseoToolProviders, readDaemonToolsConfig, resolvePaseoTools } from "../../shared/paseo-tools";
import { toolSearch } from "../../shared/tool-search";
import { meterFor } from "../../shared/meter";
import { curatedCard, planInstall, registryCard, teamCard, budgetImpact, type CatalogCard } from "../../shared/catalog";
import { CURATED_CATALOG } from "../../shared/catalog-curated";
import { GALLERY_META, libraryCard, mergeGallery, parseLibrary } from "../../shared/library";
import { DEFAULT_LIBRARIES } from "../../shared/library-source";
export function defineRpc<T>(contract: T) { return contract; }
export function defineSettings<T>(definition: T) { return definition; }
const params = new URLSearchParams(location.search);
const empty = params.has("empty"), failed = params.has("error");
const calls: string[] = [];
const toasts: { message: string; variant: string }[] = [];
Object.assign(window, { __fixtureCalls: calls, __toasts: toasts });

const HOME = "/home/demo";
const destinations = [
  { id: `${HOME}/.claude.json`, label: "Claude · demo@example.com (primary)", provider: "claude", providerId: "claude", account: "demo@example.com", configPath: `${HOME}/.claude.json`, format: "json-mcp" },
  { id: `${HOME}/.codex/config.toml`, label: "Codex · demo@example.com (primary)", provider: "codex", providerId: "codex", account: "demo@example.com", configPath: `${HOME}/.codex/config.toml`, format: "toml-mcp" },
  { id: `${HOME}/.agent-link/claude/work/.claude.json`, label: "Claude · work@example.com (AgentLink)", provider: "claude", providerId: "claude-work", account: "work@example.com", configPath: `${HOME}/.agent-link/claude/work/.claude.json`, format: "json-mcp" },
  { id: `${HOME}/.kimi/mcp.json`, label: "Kimi", provider: "kimi", providerId: "kimi", account: "", configPath: `${HOME}/.kimi/mcp.json`, format: "json-mcp" },
];
const [claude, codex, work, kimi] = destinations.map((d) => d.id);
const servers = [
  { name: "heroui-pro", transport: "http", detail: "https://mcp.heroui.pro/mcp", authStyle: "inline-credentials", inlineCredentialsIn: [claude, codex], presentIn: [claude, codex, work, kimi] },
  { name: "jam", transport: "http", detail: "https://mcp.jam.dev/mcp", authStyle: "oauth-or-none", inlineCredentialsIn: [], presentIn: [claude, codex] },
  { name: "posthog", transport: "http", detail: "https://mcp.posthog.com/mcp", authStyle: "oauth-or-none", inlineCredentialsIn: [], presentIn: [claude] },
  { name: "playwright", transport: "stdio", detail: "npx @playwright/mcp@latest", authStyle: "oauth-or-none", inlineCredentialsIn: [], presentIn: [claude, codex, work, kimi] },
  { name: "supabase", transport: "stdio", detail: "npx -y @supabase/mcp-server", authStyle: "inline-credentials", inlineCredentialsIn: [work], presentIn: [claude, work] },
  { name: "linear", transport: "http", detail: "https://mcp.linear.app/mcp", authStyle: "oauth-or-none", inlineCredentialsIn: [], presentIn: [claude, codex, work, kimi] },
];
const userScope = { level: "user", label: "Claude · demo@example.com (primary)", configPath: `${HOME}/.claude.json` };
const projectScope = { level: "project", label: "data-glue", configPath: `${HOME}/projects/data-glue/.mcp.json` };
const health = [
  { name: "heroui-pro", status: "ok", note: "", scopes: [userScope] },
  { name: "jam", status: "auth-required", note: "HTTP 401 — OAuth server; sign in through your editor", scopes: [userScope, projectScope] },
  { name: "posthog", status: "auth-required", note: "HTTP 401 — OAuth server; sign in through your editor", scopes: [userScope] },
  { name: "playwright", status: "ok", note: "", scopes: [userScope] },
  { name: "supabase", status: "binary-missing", note: "npx could not resolve @supabase/mcp-server.", scopes: [projectScope] },
  { name: "linear", status: "ok", note: "", scopes: [userScope] },
];
const checkedAt = new Date().toISOString();
// ?healthy: every server answers, so the chip shows its cost.
if (params.has("healthy")) for (const entry of health) { entry.status = "ok"; entry.note = ""; }
const tool = (name: string, description: string, args: string[] = [], required: string[] = []) => ({ name, title: "", description, takesArguments: args.length > 0, arguments: args, required });
const tools = [
  { name: "heroui-pro", transport: "http", kind: "listed", note: "3 tools", serverInfo: { name: "@heroui-pro/react-mcp", version: "0.2.0" }, protocolVersion: "2025-06-18", definitionTokens: 3400, tools: [tool("list_components", "List every component from both packages."), tool("get_component_docs", "Full MDX documentation for components.", ["components", "context"], ["components"]), tool("get_css", "BEM CSS for Pro and OSS components.", ["components"])] },
  { name: "jam", transport: "http", kind: "auth-required", note: "sign in to list tools", serverInfo: null, protocolVersion: "", tools: [] },
  { name: "posthog", transport: "http", kind: "auth-required", note: "sign in to list tools", serverInfo: null, protocolVersion: "", tools: [] },
  { name: "playwright", transport: "stdio", kind: "stdio", note: "'npx' runs as a child process of the agent; its tools are only listed while it runs", serverInfo: null, protocolVersion: "", tools: [] },
  { name: "supabase", transport: "stdio", kind: "stdio", note: "'npx' runs as a child process of the agent; its tools are only listed while it runs", serverInfo: null, protocolVersion: "", tools: [] },
  { name: "linear", transport: "http", kind: "unavailable", note: "answered a web page, not MCP (HTTP 200); check the URL path", serverInfo: null, protocolVersion: "", tools: [] },
];
const accounts = [
  { provider: "claude", email: "demo@example.com", dir: `${HOME}/.claude`, isPrimary: true, definedServers: 6, needsAuth: ["jam", "posthog"], authStatus: { jam: "not-connected", posthog: "not-connected", linear: "connected" } },
  { provider: "codex", email: "demo@example.com", dir: `${HOME}/.codex`, isPrimary: true, definedServers: 4, needsAuth: ["jam"], authStatus: { jam: "not-connected", linear: "connected" } },
  { provider: "claude", email: "work@example.com", dir: `${HOME}/.agent-link/claude/work`, isPrimary: false, definedServers: 4, needsAuth: [], authStatus: { linear: "connected" } },
];
const projectServers = [
  { project: "data-glue", name: "supabase", path: `${HOME}/projects/data-glue/.mcp.json` },
  { project: "data-glue", name: "jam", path: `${HOME}/projects/data-glue/.mcp.json` },
  { project: "investorkit-context", name: "Attio Docs", path: `${HOME}/projects/investorkit-context/.mcp.json` },
  { project: "investorkit-context", name: "azure-devops", path: `${HOME}/projects/investorkit-context/.mcp.json` },
  { project: "unfold-mobile", name: "expo", path: `${HOME}/projects/unfold-mobile/.mcp.json` },
  { project: "unfold-mobile", name: "jam", path: `${HOME}/projects/unfold-mobile/.mcp.json` },
];
// ?heavy makes the primary Claude config carry 25 user-level servers, the
// configuration that produced "Prompt is too long" on a real host.
const heavy = params.has("heavy");
const profileServers = (ids: string[]) => servers.filter((s) => ids.some((id) => s.presentIn.includes(id))).map((s) => ({ name: s.name, transport: s.transport }));
const padded = (list: { name: string; transport: string }[]) => heavy ? [...list, ...Array.from({ length: 25 - list.length }, (_, i) => ({ name: `extra-${i + 1}`, transport: i % 5 === 0 ? "stdio" : "http" }))] : list;
const profile = {
  project: [{ name: "supabase", transport: "stdio" }, { name: "jam", transport: "http" }],
  projectConfigPath: `${HOME}/projects/data-glue/.mcp.json`,
  scopes: destinations.map((d) => ({
    id: d.id, label: d.label, provider: d.provider, providerId: d.providerId, configPath: d.configPath,
    servers: d.id === claude ? padded(profileServers([claude])) : profileServers([d.id]),
    local: d.id === claude ? [{ name: "zapier", transport: "http" }] : [],
  })),
};
const processes = params.has("no-procs")
  ? { available: false, reason: "process table not readable on win32" }
  : { available: true, checkedAt, observed: { agents: 2, processes: 6, rssKb: 333996, servers: [{ name: "playwright", processes: 4, rssKb: 210664 }, { name: "supabase", processes: 2, rssKb: 123332 }], unmatchable: [] } };
const sessions = [
  { key: `claude|${HOME}/.claude||jam`, server: "jam", account: "demo@example.com", provider: "claude", workspaceId: "", state: "waiting", url: "https://auth.jam.dev/authorize?client_id=demo&state=abc", callbackUrl: "http://localhost:53021/callback", browserOpened: true, expectsRedirect: true, message: "Waiting for the browser to return.", startedAt: Date.now() - 20_000 },
];
const definition = (name: string) => {
  const server = servers.find((s) => s.name === name)!;
  return server.transport === "http"
    ? { type: "http", url: server.detail, ...(server.inlineCredentialsIn.length ? { headers: { Authorization: "Bearer •••a1b2" } } : {}) }
    : { command: "npx", args: server.detail.split(" ").slice(1), ...(server.inlineCredentialsIn.length ? { env: { SUPABASE_ACCESS_TOKEN: "•••c3d4" } } : {}) };
};
const toml = (name: string, def: any) => def.url
  ? `[mcp_servers.${name}]\nurl = "${def.url}"${def.headers ? `\n[mcp_servers.${name}.http_headers]\nAuthorization = "${def.headers.Authorization}"` : ""}`
  : `[mcp_servers.${name}]\ncommand = "${def.command}"\nargs = ${JSON.stringify(def.args)}`;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Paseo's built-in tools. ?paseo-off: "Enable Paseo tools" off for the host;
// ?no-browser: browser tools off. The daemon config is held here and patched
// the way the daemon merges (records deep, arrays replaced).
const paseoConfig: any = (window as any).__paseoConfig ??= {
  mcp: { enabled: true, injectIntoAgents: !params.has("paseo-off") },
  browserTools: { enabled: !params.has("no-browser") },
  providers: { claude: { enabled: true }, codex: { enabled: true, paseoTools: { disabledTools: ["kill_agent", "archive_workspace"] } }, "claude-work": { extends: "claude", enabled: true }, pi: { enabled: false } },
};
const merge = (a: any, b: any): any => Object.fromEntries([...new Set([...Object.keys(a ?? {}), ...Object.keys(b)])].map((k) => [k, b[k] && typeof b[k] === "object" && !Array.isArray(b[k]) && a?.[k] && typeof a[k] === "object" ? merge(a[k], b[k]) : k in b ? b[k] : a[k]]));
// ?live: the list came from the daemon's own tools/list; ?host-version=0.10.2:
// the host runs another Paseo than the catalogue (shows the drift line).
const hostVersion = params.get("host-version") ?? "0.9.1";
const paseoState = () => ({
  ...resolvePaseoTools(readDaemonToolsConfig(paseoConfig), paseoToolProviders(readDaemonToolsConfig(paseoConfig))),
  checkedAt: new Date().toISOString(),
  source: params.has("live") ? "live" : "catalogue",
  hostVersion,
  liveNote: params.has("live") ? "" : "The daemon has a password, so its tool list needs a token only its agents get",
});
const paseoLoad = () => { const state = paseoState(); return { tools: Object.fromEntries(state.providers.map((p) => [p.id, p.tools])), blocker: state.blocker, asOf: state.asOf, source: state.source as "live" | "catalogue" }; };

// Tool search per provider, from the real resolver. Default: Claude Code's
// default (on). ?routed: AI Router routes claude agents (off);
// ?proxy: every Claude provider behind a custom ANTHROPIC_BASE_URL (off);
// ?no-tool-search: a 0.10 host that sends no verdict. ?managed: managed
// settings keep it on under AI Router's betas flag (use with ?routed).
// ?plugin-servers: the agent panel's agent has two servers other plugins added.
const toolSearchFor = (id: string, base: string) =>
  toolSearch(id, {
    base,
    aiRouterRoutes: params.has("routed"),
    daemonEnv: params.has("proxy") ? { ANTHROPIC_BASE_URL: "https://gateway.example.com" } : {},
    managedEnv: params.has("managed") ? [{ label: "Managed settings (/etc/claude-code/managed-settings.json)", env: { ENABLE_TOOL_SEARCH: "true" } }] : [],
  });
const toolSearchMap = () => params.has("no-tool-search") ? undefined : Object.fromEntries(destinations.map((d) => [d.providerId, toolSearchFor(d.providerId, d.provider)]));

// ?cold: a host that just started with nothing saved; cached reads say
// `checking` for 6 s, then answer. ?restored: the reports were saved before
// the plugin restarted and are shown "as of" their time.
const coldUntil = Date.now() + 6000;
const cold = () => params.has("cold") && Date.now() < coldUntil;
const restored = params.has("restored") ? { reason: "saved before the plugin restarted", asOf: checkedAt } : undefined;
const restoredTools = () => (restored ? tools.map((t: any) => (t.kind === "listed" ? { ...t, stale: { ...restored, restored: true } } : t)) : tools);

// Add from catalogue. ?team shows a team shelf with one refused entry; the
// registry answers "supabase" and "jira" from real 2026-09-24 examples.
const registryFixtures: Record<string, any[]> = {
  supabase: [
    { name: "ai.smithery/MisterSandFR-supabase-mcp-selfhosted", version: "1.14.1", description: "Manage Supabase projects end to end across database, auth, storage, realtime, and migrations.", remotes: [{ type: "streamable-http", url: "https://server.smithery.ai/@MisterSandFR/supabase-mcp-selfhosted/mcp", headers: [{ name: "Authorization", isRequired: true, isSecret: true, value: "Bearer {smithery_api_key}", description: "Smithery API key" }] }] },
    { name: "ai.waystation/supabase", version: "0.3.1", description: "Connect to your Supabase database to query data and schemas.", remotes: [{ type: "streamable-http", url: "https://waystation.ai/supabase/mcp" }] },
    { name: "io.github.sadri-dridi/supabase-url-shape", version: "1.0.0", description: "Checks the shape of Supabase URLs.", remotes: [{ type: "streamable-http", url: "https://agent-observatory-sensor.nolimit-observatory.workers.dev/s/supabase-url-shape/mcp" }] },
    { name: "io.github.mcp-dir/supabase-mcp", version: "0.1.0", description: "Supabase through mcp.ai.", remotes: [{ type: "streamable-http", url: "https://api.mcp.ai/p_supabase" }] },
  ],
  jira: [
    { name: "io.github.acme/jira-helper", version: "0.2.0", description: "Search and update Jira issues.", packages: [{ registryType: "npm", identifier: "jira-helper-mcp", version: "0.2.0", transport: { type: "stdio" }, environmentVariables: [{ name: "JIRA_API_TOKEN", isSecret: true, isRequired: true }] }] },
    { name: "app.vercel.jira-bridge/jira", version: "1.0.0", description: "A Jira bridge on vercel.app.", remotes: [{ type: "streamable-http", url: "https://jira-bridge.vercel.app/api/mcp" }] },
    { name: "ai.smithery/someone-jira", version: "1.0.0", description: "Jira through Smithery.", remotes: [{ type: "streamable-http", url: "https://server.smithery.ai/@someone/jira/mcp", headers: [{ name: "Authorization", isRequired: true, isSecret: true, value: "Bearer {smithery_api_key}" }] }] },
  ],
};
const teamEntries = [
  { id: "ikit-n8n", name: "Team n8n", publisher: "InvestorKit", description: "Our workflows as tools.", category: "automation", transport: "http", url: "https://n8n.example.ondigitalocean.app/mcp/team", headers: { Authorization: "Bearer {N8N_TOKEN}" }, inputs: [{ id: "N8N_TOKEN", label: "n8n token", secret: true, required: true }], auth: "header", docs: "", verifiedAt: "2026-09-24" },
  { id: "ikit-metabase", name: "Metabase", publisher: "InvestorKit", description: "Questions and dashboards from our warehouse.", category: "data", transport: "http", url: "https://data.example.app/mcp", headers: { "x-api-key": "{METABASE_KEY}" }, inputs: [{ id: "METABASE_KEY", label: "Metabase key", secret: true, required: true }], auth: "header", docs: "", verifiedAt: "2026-09-24" },
] as any[];
// ?gallery: the default library answers with three servers (Notion replaces its
// recommended card, a token server, a pinned npm package); without it the
// library answers 404, as it does until itsjustanks/mcp-gallery is published.
// ?registry turns the MCP Registry library on.
const galleryDoc = {
  servers: [
    { server: { name: "com.notion/mcp", description: "Pages, databases and comments in your Notion workspace.", version: "1.0.0", remotes: [{ type: "streamable-http", url: "https://mcp.notion.com/mcp" }] }, _meta: { [GALLERY_META]: { id: "notion", displayName: "Notion", category: "productivity", auth: "oauth", publisher: "Notion", iconUrl: "https://www.notion.so/images/favicon.ico", docsUrl: "https://developers.notion.com/docs/get-started-with-mcp", verifiedAt: "2026-09-24" } } },
    { server: { name: "com.acme/mcp", description: "Acme orders and invoices.", version: "2.1.0", remotes: [{ type: "streamable-http", url: "https://mcp.acme.example/mcp", headers: [{ name: "Authorization", value: "Bearer {ACME_TOKEN}", isRequired: true, isSecret: true, variables: { ACME_TOKEN: { description: "Acme API token", isRequired: true, isSecret: true } } }] }] }, _meta: { [GALLERY_META]: { displayName: "Acme", category: "payments", auth: "token", publisher: "Acme" } } },
    { server: { name: "io.github.microsoft/playwright-mcp", description: "Drive a browser: open pages, click, type and read.", version: "0.0.41", packages: [{ registryType: "npm", identifier: "@playwright/mcp", version: "0.0.41", transport: { type: "stdio" } }] }, _meta: { [GALLERY_META]: { id: "playwright-pinned", displayName: "Playwright (pinned)", category: "developer", auth: "none", publisher: "Microsoft" } } },
    { server: { name: "com.leaky/mcp", description: "Refused: a literal key in a header.", version: "1.0.0", remotes: [{ type: "streamable-http", url: "https://mcp.leaky.example/mcp", headers: [{ name: "Authorization", value: "Bearer sk_" + "live_51Habcdefghijklmnopqrstu" }] }] } },
  ],
  metadata: { count: 4 },
};
const galleryParse = parseLibrary(JSON.stringify(galleryDoc));
const catalogCards = (query: string): CatalogCard[] => {
  const known = new Map(CURATED_CATALOG.filter((e) => e.url).map((e) => [e.url!.replace(/\/+$/, "").toLowerCase(), e.name]));
  const libraries: CatalogCard[][] = [];
  if (params.has("gallery")) libraries.push(galleryParse.items.map((item) => libraryCard(item, { id: "mcp-gallery", name: "MCP Gallery", label: "raw.githubusercontent.com…/v0.1/servers.json" })));
  if (params.has("team")) libraries.push(teamEntries.map((e) => ({ ...teamCard(e, "raw.githubusercontent.com/…/mcp-catalogue.json"), library: { id: "team", name: "Team" } })));
  const q = query.trim().toLowerCase();
  const registry = params.has("registry") && q.length >= 2 ? Object.entries(registryFixtures).filter(([k]) => k.includes(q) || q.includes(k)).flatMap(([, list]) => list.map((server) => ({ ...registryCard(server, known), library: { id: "mcp-registry", name: "MCP Registry" } }))) : [];
  return mergeGallery(CURATED_CATALOG.map(curatedCard), libraries, registry);
};
const libraryStates = (query: string) => {
  const searching = params.has("registry") && query.trim().length >= 2;
  return [
    { id: "mcp-gallery", name: "MCP Gallery", source: DEFAULT_LIBRARIES[0]!.source, kind: "json", enabled: true, headerName: "", state: params.has("gallery") ? "ready" : "error", count: params.has("gallery") ? galleryParse.items.length : 0, refused: params.has("gallery") ? galleryParse.refused : [], fetchedAt: params.has("gallery") ? checkedAt : null, note: params.has("gallery") ? "" : "Could not read the MCP Gallery library: answered HTTP 404: nothing is published at that address (yet). The recommended servers shipped with the plugin are shown instead." },
    { id: "mcp-registry", name: "MCP Registry", source: "https://registry.modelcontextprotocol.io", kind: "registry", enabled: params.has("registry"), headerName: "", state: !params.has("registry") ? "off" : searching ? "ready" : "idle", count: searching ? 4 : 0, refused: [], fetchedAt: searching ? checkedAt : null, note: "" },
    ...(params.has("team") ? [{ id: "team", name: "Team", source: "https://raw.githubusercontent.com/you/devstack/main/mcp-catalogue.json", kind: "json", enabled: true, headerName: "Authorization", state: "ready", count: 2, refused: [{ id: "ikit-attio", reason: "header Authorization holds what looks like a literal key; use a {PLACEHOLDER} the user fills in" }], fetchedAt: checkedAt, note: "" }] : []),
  ];
};
const catalogProjects = [
  { name: "data-glue", path: `${HOME}/projects/data-glue`, servers: 2 },
  { name: "unfold-mobile", path: `${HOME}/projects/unfold-mobile`, servers: 2 },
];
const catalogPlan = (input: any) => {
  const card = catalogCards("supabase jira").concat(catalogCards("jira")).find((c) => c.key === input.key) ?? catalogCards("").find((c) => c.key === input.key)!;
  const plan = planInstall(card.entry, input.scope, input.values ?? {}, card.shelf === "recommended" ? "curated" : card.shelf === "registry" ? "registry" : "team");
  const taken = input.scope === "user" ? servers.filter((s) => input.targets.some((t: string) => s.presentIn.includes(t))).map((s) => s.name) : ["supabase", "jam"];
  const clash = taken.includes(input.name) ? { files: input.scope === "user" ? input.targets.map((t: string) => destinations.find((d) => d.id === t)?.label ?? t) : [`${input.projectPath}/.mcp.json`], suggestion: `${input.name}-2` } : null;
  const previews = input.scope === "user"
    ? input.targets.map((t: string) => { const d = destinations.find((x) => x.id === t)!; const { type: _t, ...rest } = plan.masked as any; return { file: d.configPath, label: d.label, text: d.format === "toml-mcp" ? `[mcp_servers.${input.name}]\n${rest.url ? `url = "${rest.url}"` : `command = "${rest.command}"\nargs = ${JSON.stringify(rest.args ?? [])}`}${rest.headers ? `\n[mcp_servers.${input.name}.http_headers]\n${Object.entries(rest.headers).map(([k, v]) => `${k} = "${v}"`).join("\n")}` : ""}${rest.env ? `\n[mcp_servers.${input.name}.env]\n${Object.entries(rest.env).map(([k, v]) => `${k} = "${v}"`).join("\n")}` : ""}` : JSON.stringify({ mcpServers: { [input.name]: plan.masked } }, null, 2) }; })
    : [{ file: `${input.projectPath}/.mcp.json`, label: "data-glue · .mcp.json", text: JSON.stringify({ mcpServers: { [input.name]: plan.masked } }, null, 2) }];
  const notes = [
    ...(card.entry.auth === "oauth" ? ["After adding, sign in with Connect OAuth."] : []),
    ...(card.warning ? [card.warning] : []),
    ...(input.scope === "project" ? [".mcp.json is usually in git: the change shows in git status, and everyone who pulls it gets this server.", ...(plan.envToSet.length ? [`The key is not written into the file. It says \${${plan.envToSet[0]!.name}} instead, which Claude Code fills in from its environment when it loads the file. Set ${plan.envToSet.map((e) => e.name).join(", ")} where Claude Code starts: for Paseo agents, the daemon's environment or the provider's env in Paseo's settings.`] : []), "Claude Code asks once before it uses a new project server; approve it at launch or in the workspace's MCP connections tab."] : []),
  ];
  const issues = [...plan.issues, ...(input.scope === "user" && input.targets.length === 0 ? ["Pick at least one editor."] : [])];
  return { card, plan, ok: issues.length === 0 && !clash, issues, clash, previews, envToSet: plan.envToSet, notes, budget: input.scope === "user" ? budgetImpact("user", 7, "Claude · demo@example.com (primary) and 2 more") : budgetImpact("project", 9, "data-glue's .mcp.json") };
};

async function call(contract: any, input: any) {
  const name = String(contract.name).replace("paseo-mcp.", "");
  calls.push(name);
  await delay(120);
  if (failed && (name === "matrix" || name === "auth")) throw new Error("Fictional daemon unreachable. Retry the connection.");
  switch (name) {
    case "matrix": return { destinations, servers: empty ? [] : servers };
    case "health": return { results: empty ? [] : health, checkedAt };
    case "health-cached": return { report: cold() ? null : { results: empty ? [] : health, checkedAt, stale: restored }, backgroundChecks: true, intervalMinutes: 10, showComposerPill: true, nextCheckAt: checkedAt, checking: cold() };
    case "tools": return { servers: empty ? [] : tools, checkedAt };
    case "tools-cached": return { report: cold() ? null : { servers: empty ? [] : restoredTools(), checkedAt, stale: restored }, inFlight: cold(), checking: cold() };
    case "auth": return { accounts, projectServers: empty ? [] : projectServers };
    case "login-status": return { sessions, daemonIsLocal: true, hostname: "paseo" };
    case "raw-get": {
      const server = servers.find((s) => s.name === input.name)!;
      return { containsSecrets: server.inlineCredentialsIn.length > 0, rows: destinations.map((d) => {
        const found = server.presentIn.includes(d.id); const def = definition(input.name);
        const json = JSON.stringify(def, null, 2);
        return { destId: d.id, destLabel: d.label, dialect: d.format === "toml-mcp" ? "codex-toml" : d.provider === "kimi" ? "kimi-json" : "claude-json", found, json: found ? json : "", masked: !input.reveal && server.inlineCredentialsIn.includes(d.id), nativePreview: found ? (d.format === "toml-mcp" ? toml(input.name, def) : json) : "" };
      }) };
    }
    case "def-all": {
      const server = servers.find((s) => s.name === input.name)!;
      return { rows: destinations.map((d) => ({ destId: d.id, found: server.presentIn.includes(d.id), kind: server.transport === "http" ? "http" : "stdio", command: server.transport === "stdio" ? server.detail : "", url: server.transport === "http" ? server.detail : "", kvLines: server.inlineCredentialsIn.includes(d.id) ? "Authorization=Bearer •••a1b2" : "" })) };
    }
    case "raw-put": return { ok: true, issues: [], warnings: [], preview: input.json, dropped: [], message: input.dryRun ? "Checked clean." : "Written." };
    case "import-parse": {
      if (!input.blob.trim().startsWith("{")) return { servers: [], normalisations: [], issues: [{ line: 1, column: 1, code: "json-syntax", message: "Expected an object." }] };
      return { servers: [{ name: "example", json: input.blob, kind: "http", summary: "https://example.com/mcp", hasPlaceholders: input.blob.includes("<") ? ["API_KEY"] : [] }], normalisations: input.blob.includes("```") ? ["Removed a code fence."] : [], issues: [] };
    }
    case "import-apply": return { ok: true, written: input.servers.map((s: any) => `${s.name} → ${input.targets.length} editors`), skipped: [], issues: [], message: `Imported ${input.servers.length} servers.` };
    case "export": return { text: JSON.stringify({ mcpServers: Object.fromEntries(servers.map((s) => [s.name, definition(s.name)])) }, null, 2), filename: input.scope === "all" ? "mcp-export.json" : `${input.name}.json`, containsSecrets: Boolean(input.reveal) };
    case "export-file": return { ok: true, path: `${HOME}/Downloads/${input.filename}`, message: `Saved to ${HOME}/Downloads/${input.filename}.` };
    case "workspace": return { workspace: { id: "ws-1", name: "data-glue", directory: `${HOME}/projects/data-glue`, projectRootPath: `${HOME}/projects/data-glue` }, configPath: `${HOME}/projects/data-glue/.mcp.json`, servers: [{ name: "supabase", transport: "stdio", detail: "npx -y @supabase/mcp-server", authStyle: "inline-credentials" }, { name: "jam", transport: "http", detail: "https://mcp.jam.dev/mcp", authStyle: "oauth-or-none" }], accounts, profile, injection: { injectWorkspaceServers: !params.has("inject-off"), providers: ["codex"], skipInlineCredentialServers: true }, processes, paseoTools: paseoLoad(), toolSearch: toolSearchMap() };
    case "agent-servers": {
      const provider = params.get("provider") ?? "codex";
      const claudeP = provider !== "codex";
      const disabledHere = (window as any).__disabled ??= new Set<string>(params.has("off") ? ["posthog"] : []);
      const verdict = (scope: string, name: string) => {
        const off = disabledHere.has(name);
        if (claudeP) {
          if (scope === "project") return { state: off ? "disabled" : "enabled", writable: true, lever: "mcpjsonServers", reason: "Governed by this directory's .mcp.json approval list in ~/.claude.json." };
          if (scope === "local") return { state: off ? "disabled" : "enabled", writable: true, lever: "disabledMcpServers", reason: "Claude Code's per-directory (local) server for this workspace." };
          return { state: off ? "disabled" : "enabled", writable: true, lever: "disabledMcpServers", reason: off ? "Off for this workspace only. The user-level definition is untouched and other workspaces still load it." : "User-level server, loaded in every workspace. Turn it off here to skip it for this workspace only." };
        }
        if (scope === "project") return { state: off ? "disabled" : "enabled", writable: true, lever: "injection", reason: off ? "Not added from .mcp.json in this workspace only. The .mcp.json entry is untouched; other workspaces are not affected." : "Added from this workspace's .mcp.json by this plugin when an agent starts. Turn it off to leave it out here only." };
        return { state: "enabled", writable: false, lever: "none", reason: "Codex reads config.toml on top of what Paseo passes it, so nothing per workspace can turn this off: enabled = false in config.toml turns it off everywhere. Use Servers to remove it, or edit config.toml." };
      };
      const scopeId = claudeP ? claude : codex;
      const userList = servers.filter((s) => s.presentIn.includes(scopeId));
      const rows = [
        ...(claudeP ? [{ name: "zapier", transport: "http", detail: "https://mcp.zapier.com/api/mcp/…", scope: "local", configPath: scopeId, inlineCredentials: true }] : []),
        { name: "supabase", transport: "stdio", detail: "npx -y @supabase/mcp-server", scope: "project", configPath: profile.projectConfigPath, inlineCredentials: true },
        { name: "jam", transport: "http", detail: "https://mcp.jam.dev/mcp", scope: "project", configPath: profile.projectConfigPath, inlineCredentials: false },
        ...userList.filter((s) => !["jam", "supabase"].includes(s.name)).map((s) => ({ name: s.name, transport: s.transport, detail: s.detail, scope: "user", configPath: scopeId, inlineCredentials: s.inlineCredentialsIn.includes(scopeId) })),
      ].map((row) => ({ ...row, enabled: verdict(row.scope, row.name) }));
      return { directory: `${HOME}/projects/data-glue`, scope: { id: scopeId, label: destinations.find((d) => d.id === scopeId)!.label, provider: claudeP ? "claude" : "codex", providerId: provider, configPath: scopeId }, projectIncluded: true, projectNote: "", servers: rows, account: accounts.find((a) => a.provider === (claudeP ? "claude" : "codex")) ?? null, paseoTools: (() => { const load = paseoLoad(); return { tools: load.tools[provider] ?? 0, blocker: load.blocker, asOf: load.asOf, source: load.source }; })(), toolSearch: toolSearchMap()?.[provider], ...(input.agentId && params.has("plugin-servers") ? { pluginServers: [{ name: "shared-browser", transport: "stdio", note: "runs on demand" }, { name: "linear-remote", transport: "http", tools: 23, note: "23 tools" }] } : {}) };
    }
    // 0.14.0: the context meter from the real estimator over the agent-servers
    // fixture, with its tool-search verdict (Claude: on, so deferred; ?routed: off). ?no-usage: the agent has not reported
    // its context use. ?quiet-chat: no MCP calls in this chat yet. ?long-chat: the read
    // stopped at the cap. ?stale-chat: the last read failed.
    case "agent-chat": {
      const data: any = await call({ name: "paseo-mcp.agent-servers" }, input);
      calls.pop();
      const known = new Map(tools.map((t: any) => [t.name, { listed: t.kind === "listed", tools: t.tools.length, ...(t.definitionTokens ? { definitionTokens: t.definitionTokens } : {}) }]));
      const servers = data.servers.filter((s: any) => s.enabled.state !== "disabled");
      const meter = meterFor({ servers, added: data.pluginServers, known: known as any, paseoTools: data.paseoTools?.tools ?? 0, toolSearch: data.toolSearch });
      const loaded = [...servers.map((s: any) => s.name), ...(data.pluginServers ?? []).map((s: any) => s.name), ...((data.paseoTools?.tools ?? 0) > 0 ? ["paseo"] : [])];
      const chatCalls = params.has("quiet-chat") ? [] : [{ server: "supabase", calls: 4, known: true }, { server: "linear", calls: 1, known: true }];
      return {
        checking: false,
        meter,
        usage: input.chat && !params.has("no-usage") ? { usedTokens: 360_000, maxTokens: 1_000_000 } : null,
        chat: input.chat ? { scanned: params.has("long-chat") ? 2000 : 1843, truncated: params.has("long-chat"), complete: !params.has("long-chat"), calls: chatCalls, loaded, asOf: checkedAt } : null,
        stale: Boolean(input.chat) && params.has("stale-chat"),
        ...(input.chat && params.has("stale-chat") ? { failedAt: checkedAt } : {}),
      };
    }
    // Review fix: the host decides; ?plan-changed: the chat moved on since the review.
    case "turn-off-unused": {
      if (params.has("plan-changed")) return { ok: false, refused: "changed", message: "The chat changed since you reviewed this list; review again.", done: [], failed: [], plan: { off: [], kept: [] } };
      const disabledHere = (window as any).__disabled ??= new Set<string>();
      for (const name of input.expected) disabledHere.add(name);
      return { ok: true, message: `Off for this workspace: ${input.expected.join(", ")}. New sessions start without them.`, done: input.expected, failed: [], plan: { off: input.expected, kept: [] } };
    }
    case "set-enabled": {
      const disabledHere = (window as any).__disabled ??= new Set<string>();
      if (input.enabled) disabledHere.delete(input.name); else disabledHere.add(input.name);
      return { ok: true, state: input.enabled ? "enabled" : "disabled", message: `${input.name} ${input.enabled ? "on" : "off"} for this workspace only (backup saved). Takes effect when a new agent session starts; a running agent keeps the servers it started with.` };
    }
    case "sync": return { ok: true, log: "Copied 6 server definitions into 1 AgentLink slot.\nTrusted projects: 3 copied.\nOAuth grants: untouched." };
    case "login": return { ok: true, session: { ...sessions[0], server: input.server, account: input.account, provider: input.provider, workspaceId: input.workspaceId ?? "" }, message: `Sign-in started for ${input.server}.` };
    case "login-complete": return { ok: true, message: "Connection finished." };
    case "login-cancel": return { ok: true, message: "Sign-in cancelled." };
    case "logout": return { ok: true, message: `Signed out of ${input.server}.` };
    case "add": return { ok: true, message: `Added ${input.name} to ${input.targets.length} editors.` };
    case "apply": return { ok: true, message: `Copied ${input.name} to ${input.targets.length} editors.` };
    case "remove": {
      const removed = [...(input.targets ?? []).map((id: string) => destinations.find((d) => d.id === id)?.label ?? id), ...(input.projectFiles ?? [])];
      return { ok: removed.length > 0, message: `removed '${input.name}' from: ${removed.join(", ")} (backups saved).`, removed, skipped: [] };
    }
    case "rename": return { ok: true, message: `Renamed ${input.name} to ${input.newName}.` };
    case "edit-one": return { ok: true, message: `Saved ${input.name}.` };
    // ?ai-router: the daemon already has AI Router, so the Overview card shows "Installed".
    case "siblings": return { aiRouter: { installed: params.has("ai-router") } };
    case "paseo-tools": return paseoState();
    case "set-paseo-tools": {
      const patch = buildPaseoToolsPatch(readDaemonToolsConfig(paseoConfig), input);
      if (patch) Object.assign(paseoConfig, merge(paseoConfig, patch));
      return { ok: true, message: patch ? "Saved. Agents started from now on get it; a running agent keeps the tools it started with." : "Already set that way; nothing was written.", state: paseoState() };
    }
    case "catalog": return {
      // ?added: Notion reads as already added (as ikit-notion) in one of the fixture editors and data-glue.
      cards: catalogCards(input.query ?? "").map((card) => (params.has("added") && card.key === "recommended:notion" ? { ...card, added: { label: `in 1 of ${destinations.length} editors and data-glue`, name: "ikit-notion", editors: [destinations[0]?.id ?? ""], projects: [catalogProjects[0]?.path ?? ""] } } : card)),
      team: params.has("team") ? { source: "https://raw.githubusercontent.com/you/devstack/main/mcp-catalogue.json", state: "ready", count: 2, refused: [{ id: "ikit-attio", reason: "header Authorization holds what looks like a literal key; use a {PLACEHOLDER} the user fills in" }], fetchedAt: checkedAt, note: "" } : { source: "", state: "off", count: 0, refused: [], fetchedAt: null, note: "" },
      registry: params.has("registry") && (input.query ?? "").trim().length >= 2 ? { query: input.query.trim(), state: "ready", fetchedAt: checkedAt, note: "", count: 4 } : { query: "", state: "idle", fetchedAt: null, note: "", count: 0 },
      libraries: libraryStates(input.query ?? ""),
      projects: catalogProjects,
    };
    case "catalog-plan": { const { card: _c, plan: _p, ...out } = catalogPlan(input); return out; }
    case "catalog-install": {
      const planned = catalogPlan(input);
      if (!planned.ok) return { ok: false, message: planned.clash ? `A server called '${input.name}' is already in ${planned.clash.files.join(", ")}. Nothing was written. Use '${planned.clash.suggestion}' instead, or skip it.` : planned.issues[0], written: [], skipped: [], health: null, oauth: false, envToSet: planned.envToSet, budget: planned.budget };
      return { ok: true, message: `Added '${input.name}' to ${input.scope === "user" ? `${input.targets.length} places` : `${input.projectPath}/.mcp.json`} (backups saved).`, written: input.scope === "user" ? input.targets.map((t: string) => destinations.find((d) => d.id === t)?.label ?? t) : [`${input.projectPath}/.mcp.json`], skipped: [], health: planned.card.entry.auth === "oauth" ? { status: "auth-required", note: "HTTP 401 — OAuth server; sign in through your editor" } : { status: "ok", note: "" }, oauth: planned.card.entry.auth === "oauth", envToSet: planned.envToSet, budget: planned.budget };
    }
    case "catalog-team-auth": {
      if (input.action === "set") teamAuthSet = Boolean(input.value);
      if (input.action === "clear") teamAuthSet = false;
      return { set: teamAuthSet, origin: teamAuthSet ? "https://raw.githubusercontent.com" : "" };
    }
    case "catalog-entry": return { ok: true, json: JSON.stringify({ id: input.name, name: input.name, publisher: "", transport: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer {AUTHORIZATION}" }, inputs: [{ id: "AUTHORIZATION", label: "Authorization", secret: true, required: true }], auth: "header", docs: "", verifiedAt: "2026-09-24" }, null, 2), message: "No stored value is in this text: every header and env value is a {PLACEHOLDER}." };
    default: throw new Error(`Fixture has no answer for ${name}`);
  }
}
export function useRpc(contract: any) { return useCallback((input: unknown) => call(contract, input), [contract]); }
export function useWorkspace<T>(_id: string, select: (workspace: { name: string; directory: string }) => T): T { return select({ name: "data-glue", directory: `${HOME}/projects/data-glue` }); }
export function useAgent<T>(id: string, select: (agent: { id: string; workspaceId: string; provider: string; model: string | null }) => T): T { return select({ id, workspaceId: "ws-1", provider: params.get("provider") ?? "codex", model: params.get("provider") === "claude" ? "claude-opus-5-5" : "gpt-5-codex" }); }
const settingsValues: Record<string, unknown> = { injectWorkspaceServers: !params.has("inject-off"), providers: ["codex"], skipInlineCredentialServers: true, backgroundChecks: true, intervalMinutes: 10, showComposerPill: true, chatSignInNotices: true, hideAiRouter: params.has("promo-hidden"), libraries: [
  { ...DEFAULT_LIBRARIES[0]! },
  { ...DEFAULT_LIBRARIES[1]!, enabled: params.has("registry") },
  ...(params.has("team") ? [{ id: "team", name: "Team", source: "https://raw.githubusercontent.com/you/devstack/main/mcp-catalogue.json", format: "json", enabled: true, headerName: "Authorization" }] : []),
] };
let teamAuthSet = params.has("team");
export function useSettings(_definition: unknown) {
  return { status: "ready" as const, values: settingsValues, revision: "fixture", saving: false, saveError: null, async save(values: Record<string, unknown>) { Object.assign(settingsValues, values); return true; }, async reset() { return true; }, async reload() {} };
}
// Minimal stand-ins for @getpaseo/plugin/client/ui so the settings screen builds in the preview.
const row = (label: string, hint?: string, children?: React.ReactNode) => <View style={{ padding: 12, gap: 4 }}><Text style={{ fontWeight: "600" }}>{label}</Text>{hint ? <Text style={{ opacity: 0.7 }}>{hint}</Text> : null}{children}</View>;
export const SettingsSection = ({ title, children }: any) => <View style={{ gap: 8, padding: 12 }}><Text style={{ fontSize: 16, fontWeight: "700" }}>{title}</Text>{children}</View>;
export const SettingsGroup = SettingsSection;
export const SettingsCard = ({ children }: any) => <View style={{ borderWidth: 1, borderColor: "#8884", borderRadius: 8 }}>{children}</View>;
export const SettingsRow = ({ label, hint, children }: any) => row(label, hint, children);
export const SettingsSwitch = ({ label, hint, value, onValueChange }: any) => row(label, hint, <Text onPress={() => onValueChange(!value)}>{value ? "On" : "Off"}</Text>);
export const SettingsSelect = ({ label, hint, value, options, onValueChange }: any) => row(label, hint, <View style={{ flexDirection: "row", gap: 8 }}>{options.map((o: any) => <Text key={o.value} onPress={() => onValueChange(o.value)} style={{ fontWeight: o.value === value ? "700" : "400" }}>{o.label}</Text>)}</View>);
export const SettingsInput = ({ label, hint }: any) => row(label, hint);
export const SettingsAction = ({ label, actionLabel, onPress }: any) => row(label, undefined, <Text onPress={onPress}>{actionLabel}</Text>);
// ?no-icons: an app that hands plugins no Icon component, so the tab bar's label fallback shows.
export const Icon = params.has("no-icons") ? undefined : ({ name, size = 16, color }: { name: string; size?: number; color?: string }) => <Text style={{ fontSize: size - 4, color, fontWeight: "700" }} accessibilityLabel={name}>{name.replace(/[a-z]/g, "").slice(0, 2)}</Text>;
export const Modal = Object.assign(({ children, open, title }: any) => open ? <View role="dialog" aria-label={title} style={{ position: "absolute", inset: 0, zIndex: 100, backgroundColor: "rgba(0,0,0,0.7)", alignItems: "center", justifyContent: "center" }}><View style={{ maxWidth: 520, padding: 20, backgroundColor: "#1a2029" }}><Text style={{ color: "#eef1f6", fontSize: 18 }}>{title}</Text>{children}</View></View> : null, { Content: ({ children }: any) => <View>{children}</View> });
export function useToast() {
  return {
    show(message: string, options?: { variant?: string }) { toasts.push({ message, variant: options?.variant ?? "default" }); console.info("[toast]", options?.variant ?? "default", message); },
    error(message: string) { toasts.push({ message, variant: "error" }); console.error("[toast] error", message); },
  };
}
