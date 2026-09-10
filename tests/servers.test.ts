import assert from "node:assert/strict";
import test from "node:test";
import type { Destination, McpAuthAccount, McpHealth, McpServerRow } from "../shared/contracts";
import { accountsNeedingSignIn, projectFilesFor, removePlan, serverMatches, signInState } from "../shared/servers";

const HOME = "/home/demo";
const dest = (id: string, label: string, provider: string, account: string, format: "json-mcp" | "toml-mcp"): Destination => ({
  id, label, provider, providerId: provider, account, configPath: id, format,
});
const claude = dest(`${HOME}/.claude.json`, "Claude · demo@example.com (primary)", "claude", "demo@example.com", "json-mcp");
const codex = dest(`${HOME}/.codex/config.toml`, "Codex · demo@example.com (primary)", "codex", "demo@example.com", "toml-mcp");
const work = dest(`${HOME}/.agent-link/claude/work/.claude.json`, "Claude · work@example.com (AgentLink)", "claude", "work@example.com", "json-mcp");
const kimi = dest(`${HOME}/.kimi/mcp.json`, "Kimi", "kimi", "", "json-mcp");
const destinations = [claude, codex, work, kimi];

const server = (name: string, presentIn: string[], inlineCredentialsIn: string[] = []): McpServerRow => ({
  name, transport: "http", detail: "https://example.test/mcp", authStyle: inlineCredentialsIn.length ? "inline-credentials" : "oauth-or-none", inlineCredentialsIn, presentIn,
});

const account = (provider: "claude" | "codex", email: string, needsAuth: string[], authStatus: McpAuthAccount["authStatus"]): McpAuthAccount => ({
  provider, email, dir: `${HOME}/.${provider}`, isPrimary: true, definedServers: 3, needsAuth, authStatus,
});
const accounts = [
  account("claude", "demo@example.com", ["jam"], { jam: "not-connected", linear: "connected" }),
  account("codex", "demo@example.com", [], { linear: "connected", posthog: "unsupported" }),
];

test("sign-in state: any account waiting wins, then connected, then nothing to say", () => {
  assert.equal(signInState("jam", accounts), "needs");
  assert.equal(signInState("linear", accounts), "connected");
  assert.equal(signInState("posthog", accounts), "none");
  assert.equal(signInState("heroui-pro", accounts), "none");
  assert.equal(signInState("jam", []), "none");
  assert.deepEqual(accountsNeedingSignIn("jam", accounts).map((entry) => entry.email), ["demo@example.com"]);
  assert.deepEqual(accountsNeedingSignIn("linear", accounts), []);
});

test("filters: gaps by coverage, issues by health, sign-in by grants, search by name", () => {
  const jam = server("jam", [claude.id, codex.id]);
  const full = server("linear", destinations.map((entry) => entry.id));
  const down: McpHealth = { name: "jam", status: "down", note: "connection refused", scopes: [] };
  const ok: McpHealth = { name: "linear", status: "ok", note: "", scopes: [] };
  const base = { query: "", destinationCount: 4 };
  assert.equal(serverMatches(jam, { ...base, filter: "all", health: down, signIn: "needs" }), true);
  assert.equal(serverMatches(jam, { ...base, filter: "gaps", health: down, signIn: "needs" }), true);
  assert.equal(serverMatches(full, { ...base, filter: "gaps", health: ok, signIn: "none" }), false);
  assert.equal(serverMatches(jam, { ...base, filter: "issues", health: down, signIn: "needs" }), true);
  assert.equal(serverMatches(full, { ...base, filter: "issues", health: ok, signIn: "none" }), false);
  assert.equal(serverMatches(full, { ...base, filter: "issues", health: undefined, signIn: "none" }), false);
  assert.equal(serverMatches(jam, { ...base, filter: "sign-in", health: down, signIn: "needs" }), true);
  assert.equal(serverMatches(full, { ...base, filter: "sign-in", health: ok, signIn: "connected" }), false);
  assert.equal(serverMatches(jam, { ...base, filter: "all", query: "  JA", health: down, signIn: "needs" }), true);
  assert.equal(serverMatches(jam, { ...base, filter: "all", query: "linear", health: down, signIn: "needs" }), false);
});

test("remove plan for one editor names the file, counts one, and says who keeps it", () => {
  const plan = removePlan(server("jam", [claude.id, codex.id, work.id]), destinations, "one", codex.id);
  assert.ok(plan);
  assert.deepEqual(plan.targets, [codex.id]);
  assert.equal(plan.title, "Remove jam from Codex · demo@example.com (primary)?");
  assert.equal(plan.lines[0], "1 definition will be deleted, from Codex · demo@example.com (primary).");
  assert.equal(plan.lines[1], "The other 2 editors keep jam.");
  assert.match(plan.lines.at(-1)!, /no undo.*Export/i);
  assert.equal(plan.credentialCount, 0);
  assert.equal(plan.confirmLabel, "Remove from this editor");
});

test("remove plan for all editors lists every file, counts them, and flags inline credentials", () => {
  const plan = removePlan(server("heroui-pro", [claude.id, codex.id, work.id, kimi.id], [claude.id, codex.id]), destinations, "all");
  assert.ok(plan);
  assert.deepEqual(plan.targets, destinations.map((entry) => entry.id));
  assert.equal(plan.title, "Remove heroui-pro from all 4 editors?");
  assert.equal(plan.lines[0], `4 editor definitions will be deleted: ${destinations.map((entry) => entry.label).join(", ")}.`);
  assert.equal(plan.credentialCount, 2);
  assert.equal(plan.lines[1], "2 of them carry credentials inside the definition; those are lost with them.");
  assert.equal(plan.confirmLabel, "Remove from 4 editors");
});

test("remove plan wording for a single definition that carries its own token", () => {
  const plan = removePlan(server("supabase", [work.id], [work.id]), destinations, "all");
  assert.ok(plan);
  assert.equal(plan.title, "Remove supabase from all 1 editor?");
  assert.equal(plan.lines[1], "It carries credentials inside the definition; those are lost with it.");
  // Scope one on the only editor says nothing about others keeping it.
  const one = removePlan(server("supabase", [work.id], [work.id]), destinations, "one", work.id);
  assert.ok(one);
  assert.equal(one.lines.length, 3);
  assert.equal(one.lines[1], "It carries credentials inside the definition; those are lost with it.");
});

test("remove plan is null when there is nothing to remove", () => {
  assert.equal(removePlan(server("ghost", []), destinations, "all"), null);
  assert.equal(removePlan(server("ghost", []), destinations, "everywhere"), null);
  assert.equal(removePlan(server("jam", [claude.id]), destinations, "one", codex.id), null);
  assert.equal(removePlan(server("jam", [claude.id]), destinations, "one"), null);
});

const projectServers = [
  { project: "data-glue", name: "jam", path: `${HOME}/projects/data-glue/.mcp.json` },
  { project: "unfold", name: "jam", path: `${HOME}/projects/unfold/.mcp.json` },
  { project: "unfold", name: "expo", path: `${HOME}/projects/unfold/.mcp.json` },
  { project: "legacy-host", name: "jam" }, // no path: an older host; cannot be a removal target
];

test("projectFilesFor keeps only the files that define the server and carry a path", () => {
  assert.deepEqual(projectFilesFor("jam", projectServers), [
    { project: "data-glue", path: `${HOME}/projects/data-glue/.mcp.json` },
    { project: "unfold", path: `${HOME}/projects/unfold/.mcp.json` },
  ]);
  assert.deepEqual(projectFilesFor("ghost", projectServers), []);
});

test("remove plan for everywhere names every project file, counts them, and warns about git status", () => {
  const files = projectFilesFor("jam", projectServers);
  const plan = removePlan(server("jam", [claude.id, codex.id]), destinations, "everywhere", undefined, files);
  assert.ok(plan);
  assert.equal(plan.title, "Remove jam from everywhere?");
  assert.deepEqual(plan.targets, [claude.id, codex.id]);
  assert.deepEqual(plan.projectFiles, [`${HOME}/projects/data-glue/.mcp.json`, `${HOME}/projects/unfold/.mcp.json`]);
  assert.equal(plan.lines[0], `2 editor definitions will be deleted: ${claude.label}, ${codex.label}.`);
  assert.match(plan.lines[1], /^2 project \.mcp\.json files will lose it too: .*data-glue\/\.mcp\.json, .*unfold\/\.mcp\.json\. .*git status/);
  assert.match(plan.lines.at(-1)!, /backed up.*no undo/i);
  assert.equal(plan.confirmLabel, "Remove from 2 editors and 2 project files");
  // Only in projects: still a plan, with no editor line.
  const only = removePlan(server("expo", []), destinations, "everywhere", undefined, projectFilesFor("expo", projectServers));
  assert.ok(only);
  assert.match(only.lines[0], /^1 project \.mcp\.json file will lose it too/);
  assert.equal(only.confirmLabel, "Remove from 1 project file");
  // Nothing in projects: says so instead of listing nothing.
  const none = removePlan(server("linear", [claude.id]), destinations, "everywhere", undefined, []);
  assert.ok(none);
  assert.equal(none.lines[1], "No project .mcp.json defines it, so only the editor configs change.");
  assert.equal(none.confirmLabel, "Remove from 1 editor");
});

test("remove plan for one or all editors warns when a project file would bring the server back", () => {
  const files = projectFilesFor("jam", projectServers);
  const all = removePlan(server("jam", [claude.id, codex.id]), destinations, "all", undefined, files);
  assert.ok(all);
  assert.deepEqual(all.projectFiles, []);
  assert.match(all.lines[1], /^2 project \.mcp\.json files still define it \(data-glue, unfold\); Claude Code reads those back.*Remove everywhere/);
  const one = removePlan(server("jam", [claude.id, codex.id]), destinations, "one", claude.id, files);
  assert.ok(one);
  assert.match(one.lines[1], /still define it/);
  assert.equal(one.lines[2], "The other 1 editor keeps jam.");
});
