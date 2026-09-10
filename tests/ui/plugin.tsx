/** Browser stand-in for @getpaseo/plugin: every MCP contract answered from fixtures. */
import React, { useCallback } from "react";
import { Text, View } from "react-native";
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
const tool = (name: string, description: string, args: string[] = [], required: string[] = []) => ({ name, title: "", description, takesArguments: args.length > 0, arguments: args, required });
const tools = [
  { name: "heroui-pro", transport: "http", kind: "listed", note: "3 tools", serverInfo: { name: "@heroui-pro/react-mcp", version: "0.2.0" }, protocolVersion: "2025-06-18", tools: [tool("list_components", "List every component from both packages."), tool("get_component_docs", "Full MDX documentation for components.", ["components", "context"], ["components"]), tool("get_css", "BEM CSS for Pro and OSS components.", ["components"])] },
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

async function call(contract: any, input: any) {
  const name = String(contract.name).replace("paseo-mcp.", "");
  calls.push(name);
  await delay(120);
  if (failed && (name === "matrix" || name === "auth")) throw new Error("Fictional daemon unreachable. Retry the connection.");
  switch (name) {
    case "matrix": return { destinations, servers: empty ? [] : servers };
    case "health": return { results: empty ? [] : health, checkedAt };
    case "health-cached": return { report: { results: empty ? [] : health, checkedAt }, backgroundChecks: true, intervalMinutes: 10, showComposerPill: true, nextCheckAt: checkedAt };
    case "tools": case "tools-cached": {
      const report = { servers: empty ? [] : tools, checkedAt };
      return name === "tools" ? report : { report, inFlight: false };
    }
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
    case "workspace": return { workspace: { id: "ws-1", name: "data-glue", directory: `${HOME}/projects/data-glue`, projectRootPath: `${HOME}/projects/data-glue` }, configPath: `${HOME}/projects/data-glue/.mcp.json`, servers: [{ name: "supabase", transport: "stdio", detail: "npx -y @supabase/mcp-server", authStyle: "inline-credentials" }, { name: "jam", transport: "http", detail: "https://mcp.jam.dev/mcp", authStyle: "oauth-or-none" }], accounts, profile, injection: { injectWorkspaceServers: !params.has("inject-off"), providers: ["codex"], skipInlineCredentialServers: true }, processes };
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
        if (scope === "project") return { state: off ? "disabled" : "enabled", writable: true, lever: "injection", reason: off ? "Left out of injection for this workspace only. The .mcp.json entry is untouched; other workspaces are not affected." : "Added from this workspace's .mcp.json by injection when an agent starts. Turn it off to leave it out here only." };
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
      return { directory: `${HOME}/projects/data-glue`, scope: { id: scopeId, label: destinations.find((d) => d.id === scopeId)!.label, provider: claudeP ? "claude" : "codex", providerId: provider, configPath: scopeId }, projectIncluded: true, projectNote: "", servers: rows, account: accounts.find((a) => a.provider === (claudeP ? "claude" : "codex")) ?? null };
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
    default: throw new Error(`Fixture has no answer for ${name}`);
  }
}
export function useRpc(contract: any) { return useCallback((input: unknown) => call(contract, input), [contract]); }
export function useWorkspace<T>(_id: string, select: (workspace: { name: string; directory: string }) => T): T { return select({ name: "data-glue", directory: `${HOME}/projects/data-glue` }); }
export function useAgent<T>(_id: string, select: (agent: { provider: string; model: string | null }) => T): T { return select({ provider: params.get("provider") ?? "codex", model: "gpt-5-codex" }); }
const settingsValues: Record<string, unknown> = { injectWorkspaceServers: !params.has("inject-off"), providers: ["codex"], skipInlineCredentialServers: true, backgroundChecks: true, intervalMinutes: 10, showComposerPill: true };
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
export const Icon = ({ name, size = 16, color }: { name: string; size?: number; color?: string }) => <Text style={{ fontSize: size - 4, color, fontWeight: "700" }} accessibilityLabel={name}>{name.replace(/[a-z]/g, "").slice(0, 2)}</Text>;
export const Modal = Object.assign(({ children, open, title }: any) => open ? <View role="dialog" aria-label={title} style={{ position: "absolute", inset: 0, zIndex: 100, backgroundColor: "rgba(0,0,0,0.7)", alignItems: "center", justifyContent: "center" }}><View style={{ maxWidth: 520, padding: 20, backgroundColor: "#1a2029" }}><Text style={{ color: "#eef1f6", fontSize: 18 }}>{title}</Text>{children}</View></View> : null, { Content: ({ children }: any) => <View>{children}</View> });
export function useToast() {
  return {
    show(message: string, options?: { variant?: string }) { toasts.push({ message, variant: options?.variant ?? "default" }); console.info("[toast]", options?.variant ?? "default", message); },
    error(message: string) { toasts.push({ message, variant: "error" }); console.error("[toast] error", message); },
  };
}
