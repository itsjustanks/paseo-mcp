/**
 * 0.20.0: every connector says where it is set up (the user: "with MCP should
 * easily distinguish user level MCPs vs project level", "especially when
 * opening in the workspace stuff"). Labels, sources, which copy wins, and
 * where Add starts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { whereLabel } from "../shared/attention";
import { loadFor, type WorkspaceProfile } from "../shared/budget";
import { EVERYWHERE, JUST_FOR_YOU, homeRelative, scopeLabel, scopeOrder, shadowLine, sourceLabel, startingScope, thisProject } from "../shared/scope";
import { alsoInProjects } from "../shared/servers";

test("two plain labels, and a third for Claude's just-for-you entries", () => {
  assert.equal(scopeLabel("user", "data-glue"), "Everywhere");
  assert.equal(scopeLabel("project", "data-glue"), "This project · data-glue");
  assert.equal(scopeLabel("local", "data-glue"), "This project, just for you");
  assert.equal(thisProject(""), "This project");
  assert.deepEqual(["user", "project", "local"].sort((a, b) => scopeOrder(a as never) - scopeOrder(b as never)), ["local", "project", "user"], "this project first, then everywhere");
  assert.equal(EVERYWHERE, "Everywhere");
  assert.equal(JUST_FOR_YOU, "This project, just for you");
});

test("sources in friendly form: no path on the row, home-relative in the detail", () => {
  assert.equal(sourceLabel("project", "/home/demo/code/project-hub/.mcp.json"), "project-hub · .mcp.json");
  assert.equal(sourceLabel("user", "/home/demo/.claude.json"), "Claude Code settings");
  assert.equal(sourceLabel("user", "/home/demo/.agent-link/claude/work/.claude.json"), "Claude Code settings");
  assert.equal(sourceLabel("user", "/home/demo/.codex/config.toml"), "Codex settings");
  assert.equal(sourceLabel("user", "/home/demo/.kimi/mcp.json"), "Kimi settings");
  assert.equal(sourceLabel("local", "/home/demo/.claude.json"), "Claude Code · just for you");
  for (const label of ["project-hub · .mcp.json", "Claude Code settings"]) assert.doesNotMatch(label, /\//);
  assert.equal(homeRelative("/home/demo/.claude.json", "/home/demo"), "~/.claude.json");
  assert.equal(homeRelative("/home/demo/code/x/.mcp.json", "/home/demo/"), "~/code/x/.mcp.json");
  assert.equal(homeRelative("/etc/x.json", "/home/demo"), "/etc/x.json");
  assert.equal(homeRelative("/home/demo2/x", "/home/demo"), "/home/demo2/x", "a neighbour's home is not home");
});

test("shadowing: one short line saying which copy is used here (Claude Code's documented order)", () => {
  assert.equal(shadowLine("project", ["user"], "claude"), "Also set up everywhere; this project's copy is used here.");
  assert.equal(shadowLine("local", ["project", "user"], "claude"), "Also set up in this project's .mcp.json and everywhere; your own copy is used here.");
  assert.equal(shadowLine("project", ["user"], "codex"), "Also set up everywhere, with the same name.", "no winner claimed without a documented rule");
  assert.equal(shadowLine("user", [], "claude"), "");
});

const profile: WorkspaceProfile = {
  project: [{ name: "acme", transport: "http" }, { name: "team", transport: "http" }],
  projectConfigPath: "/home/demo/code/data-glue/.mcp.json",
  scopes: [
    { id: "c", label: "Claude", provider: "claude", providerId: "claude", configPath: "/home/demo/.claude.json", servers: [{ name: "acme", transport: "http" }, { name: "docs", transport: "http" }], local: [{ name: "acme", transport: "http" }, { name: "solo", transport: "stdio" }] },
    { id: "x", label: "Codex", provider: "codex", providerId: "codex", configPath: "/home/demo/.codex/config.toml", servers: [{ name: "acme", transport: "http" }], local: [] },
  ],
};

test("which copy loads: local, then project, then user, each winner noting what it hides", () => {
  const claude = loadFor(profile, profile.scopes[0], null);
  const byName = Object.fromEntries(claude.servers.map((entry) => [entry.name, entry]));
  assert.equal(byName.acme.scope, "local");
  assert.deepEqual(byName.acme.shadows, ["project", "user"]);
  assert.equal(byName.team.scope, "project");
  assert.equal(byName.team.shadows, undefined);
  assert.equal(byName.docs.scope, "user");
  assert.equal(byName.solo.scope, "local");
});

test("Codex: the project's copy only counts when the plugin adds .mcp.json; then it notes the everywhere copy", () => {
  const plain = loadFor(profile, profile.scopes[1], { injectWorkspaceServers: false, providers: [] } as never);
  assert.deepEqual(plain.servers.map((entry) => [entry.name, entry.scope, entry.shadows ?? []]), [["acme", "user", []]]);
  const injected = loadFor(profile, profile.scopes[1], { injectWorkspaceServers: true, providers: ["codex"], skipInlineCredentialServers: false } as never);
  const acme = injected.servers.find((entry) => entry.name === "acme");
  assert.equal(acme?.scope, "project");
  assert.deepEqual(acme?.shadows, ["user"]);
});

test("the sidebar popover names each connector's scope", () => {
  assert.equal(whereLabel([{ level: "user", label: "Claude" }, { level: "project", label: "data-glue" }]), "Everywhere");
  assert.equal(whereLabel([{ level: "project", label: "data-glue" }]), "This project · data-glue");
  assert.equal(whereLabel([{ level: "project", label: "a" }, { level: "project", label: "b" }]), "2 projects");
});

test("Add starts on the scope being browsed, and only where the connector can go", () => {
  const base = { projectAllowed: true, added: false, missingApps: 2, missingProjects: 1 };
  assert.equal(startingScope({ ...base, browsing: "project" }), "project");
  assert.equal(startingScope({ ...base, browsing: "user" }), "user");
  assert.equal(startingScope({ ...base, browsing: "project", projectAllowed: false }), "user", "a connector that can't go in a project");
  assert.equal(startingScope({ ...base, browsing: null }), "user");
  assert.equal(startingScope({ browsing: null, projectAllowed: true, added: true, missingApps: 0, missingProjects: 1 }), "project", "the old rule when nothing is browsed");
});

test("a connector set up everywhere and in a project says so on its card", () => {
  assert.equal(alsoInProjects([]), "");
  assert.equal(alsoInProjects(["data-glue"]), "Also in data-glue · .mcp.json; Claude Code uses that project's own copy there.");
  assert.equal(alsoInProjects(["a", "b", "a"]), "Also in 2 projects' .mcp.json; Claude Code uses each project's own copy there.");
});
