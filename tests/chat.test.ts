/**
 * What a chat did with its MCP servers (0.14.0): tool names to servers for
 * Claude and Codex, used versus loaded, the "turn off unused" plan, auth-shaped
 * failures, and one sign-in card per server per chat, against the real host
 * module with a fake agent timeline.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import {
  SIGN_IN_KIND,
  authFailureServer,
  authShaped,
  cardedServers,
  claudeServerSlug,
  countCalls,
  planTurnOffUnused,
  serverForTool,
  signInCardsFor,
  usedLine,
  usedUnused,
} from "../shared/chat";
import type { AgentServer } from "../shared/contracts";

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-chat-"));
process.env.HOME = home;
process.env.PASEO_HOME = join(home, ".paseo");
mkdirSync(process.env.PASEO_HOME, { recursive: true });
after(() => rmSync(home, { recursive: true, force: true }));

const { markClientSeen, resetPresence } = await import("../server/presence");
const { onTurnEnded, resetChat } = await import("../server/chat");

// --------------------------------------------------------------- names

test("Claude names: mcp__<server>__<tool>, server names with underscores, and Claude's own spelling", () => {
  const known = ["supabase", "my_server", "my", "my.docs", "paseo"];
  assert.deepEqual(serverForTool("mcp__supabase__execute_sql", known), { server: "supabase", tool: "execute_sql", known: true });
  assert.deepEqual(serverForTool("mcp__my_server__list_items", known), { server: "my_server", tool: "list_items", known: true }, "the longest known name wins over 'my'");
  assert.deepEqual(serverForTool("mcp__my__list_items", known), { server: "my", tool: "list_items", known: true });
  assert.equal(claudeServerSlug("my.docs"), "my_docs");
  assert.deepEqual(serverForTool("mcp__my_docs__search", known), { server: "my.docs", tool: "search", known: true }, "Claude writes '.' as '_'");
  assert.deepEqual(serverForTool("mcp__paseo__list_agents", known), { server: "paseo", tool: "list_agents", known: true });
  assert.deepEqual(serverForTool("mcp__Supabase__execute_sql", known), { server: "supabase", tool: "execute_sql", known: true }, "case does not split a server in two");
  assert.deepEqual(serverForTool("mcp__unlisted__do_it", known), { server: "unlisted", tool: "do_it", known: false }, "an unknown server still counts, by its first part");
  assert.equal(serverForTool("mcp__broken", known), null);
  assert.equal(serverForTool("mcp__only__", known), null);
});

test("Codex names: <server>.<tool>, as the daemon's buildMcpToolName writes them", () => {
  const known = ["linear", "my_server", "acme.internal"];
  assert.deepEqual(serverForTool("linear.list_issues", known), { server: "linear", tool: "list_issues", known: true });
  assert.deepEqual(serverForTool("my_server.get_thing", known), { server: "my_server", tool: "get_thing", known: true });
  assert.deepEqual(serverForTool("acme.internal.lookup", known), { server: "acme.internal", tool: "lookup", known: true }, "a known dotted name first");
  assert.deepEqual(serverForTool("other.tool_name", known), { server: "other", tool: "tool_name", known: false });
});

test("built-in tools are not any server's", () => {
  for (const name of ["Bash", "Read", "web_search", "WebFetch", "shell", "Sub-agent", "", "  ", "a b.c d"]) assert.equal(serverForTool(name, ["bash", "read"]), null, name);
});

// ----------------------------------------------------------- used / unused

const call = (name: string, status = "completed", error: unknown = null) => ({ type: "tool_call", callId: name, name, status, error, detail: { type: "unknown", input: { secret: "arg" }, output: null } });

test("calls are counted per server and split from the servers loaded but never used", () => {
  const items = [
    call("mcp__supabase__execute_sql"),
    { type: "assistant_message", text: "mcp__linear__x is mentioned, not called" },
    call("mcp__supabase__list_tables"),
    call("linear.create_issue"),
    call("Bash"),
    call("mcp__supabase__execute_sql", "failed", "boom"),
    call("mcp__supabase__apply_migration", "running"),
  ];
  const calls = countCalls(items, ["supabase", "linear", "posthog"]);
  assert.deepEqual(calls, [
    { server: "supabase", calls: 4, known: true },
    { server: "linear", calls: 1, known: true },
  ]);
  assert.equal(usedLine(calls), "supabase ×4, linear ×1");
  const split = usedUnused(["supabase", "linear", "posthog", "jam", "paseo"], calls);
  assert.deepEqual(split.unused, ["posthog", "jam", "paseo"]);
});

// ------------------------------------------------------------ turn off plan

const server = (name: string, enabled: Partial<AgentServer["enabled"]>): Pick<AgentServer, "name" | "enabled"> => ({
  name,
  enabled: { state: "enabled", writable: true, lever: "disabledMcpServers", reason: "", ...enabled },
});

test("turning off the unused ones lists only servers with a switch for this provider that are on", () => {
  const plan = planTurnOffUnused(
    [
      server("supabase", {}),
      server("posthog", {}),
      server("jam", { lever: "mcpjsonServers", state: "undecided" }),
      server("already-off", { state: "disabled" }),
      server("codex-user", { writable: false, lever: "none" }),
      server("injected", { lever: "injection" }),
    ],
    [{ server: "supabase", calls: 2, known: true }],
  );
  assert.deepEqual(plan.off, ["posthog", "jam", "injected"], "used, already off and switchless servers are not changed");
  assert.deepEqual(plan.kept, [{ name: "codex-user", reason: "no per-workspace switch for this provider" }]);
  assert.deepEqual(planTurnOffUnused([server("a", {})], [{ server: "a", calls: 1, known: true }]).off, [], "nothing unused, nothing to do");
});

test("P3: a server an unknown call could belong to counts as used, in Claude's and Codex's spelling", () => {
  const servers = [server("ikit.attio", {}), server("linear", {}), server("supabase", {})];
  // With no known list at all, as after a failed server read.
  const claude = countCalls([call("mcp__ikit_attio__search_records"), call("mcp__supabase__execute_sql")], []);
  assert.ok(!planTurnOffUnused(servers, claude).off.includes("ikit.attio"), "mcp__ikit_attio__… is ikit.attio's");
  assert.deepEqual(planTurnOffUnused(servers, claude).off, ["linear"]);
  const codex = countCalls([call("ikit.attio.search_records")], []);
  assert.deepEqual(codex, [{ server: "ikit", calls: 1, known: false }], "Codex's name splits at the first dot");
  assert.ok(!planTurnOffUnused(servers, codex).off.includes("ikit.attio"), "ikit is a prefix of ikit.attio");
  assert.equal(usedUnused(["ikit.attio", "linear"], codex).unused.includes("ikit.attio"), false, "and the panel does not list it as unused");
  assert.deepEqual(planTurnOffUnused(servers, countCalls([call("mcp__lin__x")], [])).off, ["ikit.attio", "linear", "supabase"], "a prefix inside a word is not a match");
});

// ------------------------------------------------------------- auth failures

test("auth-shaped errors are recognised", () => {
  for (const text of [
    "HTTP 401",
    "Error: 401 Unauthorized",
    "MCP error -32001: Unauthorized",
    "invalid_token: the access token expired",
    "Invalid token",
    "linear needs authentication",
    "Server needs auth",
    "Authentication required",
    "request failed with status code 403",
    "403 Forbidden",
  ]) assert.equal(authShaped(text), true, text);
});

test("other failures are not", () => {
  for (const text of [
    "429 Too Many Requests",
    "getaddrinfo ENOTFOUND mcp.example.com",
    "Syntax error on line 401 of query.sql",
    "used 4013 tokens",
    "404 Not Found",
    "timeout after 10s",
    "permission denied",
    "Tool execution failed",
    "",
  ]) assert.equal(authShaped(text), false, text);
});

test("only a failed MCP call counts, and an error object is read as text", () => {
  const known = ["linear"];
  assert.equal(authFailureServer(call("mcp__linear__list", "failed", { message: "Unauthorized", status: 401 }), known), "linear");
  assert.equal(authFailureServer(call("linear.list", "failed", "HTTP 401"), known), "linear", "Codex form");
  assert.equal(authFailureServer(call("mcp__linear__list", "completed", "HTTP 401"), known), null, "not failed");
  assert.equal(authFailureServer(call("mcp__linear__list", "failed", "429 Too Many Requests"), known), null, "not auth");
  assert.equal(authFailureServer(call("Bash", "failed", "Unauthorized"), known), null, "not an MCP server's tool");
  assert.equal(authFailureServer({ type: "error", message: "Unauthorized" }, known), null);
});

test("P4: a card only for a server this agent knows", () => {
  const failed = call("mcp__not_configured_anywhere__x", "failed", "HTTP 401 Unauthorized");
  assert.equal(authFailureServer(failed, []), null);
  assert.equal(authFailureServer(failed, ["linear"]), null);
  assert.deepEqual(signInCardsFor([failed, call("other.tool", "failed", "Unauthorized")], ["linear"], new Set(), "claude"), []);
});

test("P4b/P4c: a tool name two known servers could own counts for both and gets no card", () => {
  const known = ["github", "github__enterprise"];
  const name = "mcp__github__enterprise__login";
  assert.deepEqual(serverForTool(name, known)?.owners, ["github__enterprise", "github"]);
  assert.deepEqual(signInCardsFor([call(name, "failed", "401 unauthorized")], known, new Set(), "claude"), [], "P4b: no card");
  assert.deepEqual(countCalls([call(name)], known), [
    { server: "github", calls: 1, known: true },
    { server: "github__enterprise", calls: 1, known: true },
  ], "P4c: used by both");
  assert.deepEqual(planTurnOffUnused([server("github", {}), server("github__enterprise", {})], countCalls([call(name)], known)).off, []);
  assert.deepEqual(countCalls([call("acme.internal.lookup")], ["acme", "acme.internal"]).map((entry) => entry.server), ["acme", "acme.internal"], "Codex form too");
  assert.equal(serverForTool("mcp__github__list_repos", known)?.owners, undefined, "one owner, no ambiguity");
});

test("one card per server, none for a server already carded, none for Paseo's own", () => {
  const items = [
    call("mcp__linear__a", "failed", "HTTP 401"),
    call("mcp__linear__b", "failed", "invalid_token"),
    call("mcp__notion__search", "failed", "Unauthorized"),
    call("mcp__paseo__list_agents", "failed", "Unauthorized"),
    call("mcp__jam__x", "failed", "timeout"),
  ];
  assert.deepEqual(signInCardsFor(items, ["linear", "notion", "paseo", "jam"], new Set(), "claude"), [
    { server: "linear", provider: "claude" },
    { server: "notion", provider: "claude" },
  ]);
  assert.deepEqual(signInCardsFor(items, ["linear", "notion"], new Set(["linear"]), "claude"), [{ server: "notion", provider: "claude" }]);
  const timeline = [
    { type: "plugin", pluginId: "paseo-mcp", kind: SIGN_IN_KIND, version: 1, data: { server: "linear", provider: "claude" } },
    { type: "plugin", pluginId: "someone-else", kind: SIGN_IN_KIND, version: 1, data: { server: "notion" } },
    { type: "plugin", pluginId: "paseo-mcp", kind: "other", version: 1, data: { server: "jam" } },
  ];
  assert.deepEqual([...cardedServers(timeline)], ["linear"]);
});

// ---------------------------------------------------- the host, end to end

type Appended = { agentId: string; item: Record<string, unknown> };

function fakePaseo(options: { history?: unknown[]; failRead?: boolean } = {}) {
  const appended: Appended[] = [];
  let reads = 0;
  const paseo = {
    agents: {
      ref: (agentId: string) => ({
        lastUsage: null,
        refresh: async () => null,
        timeline: {
          append: async (item: Record<string, unknown>) => {
            appended.push({ agentId, item });
            return { seq: appended.length, epoch: "e" };
          },
          refetch: async () => {
            reads += 1;
            if (options.failRead) throw new Error("daemon unreachable");
            const history = options.history ?? [];
            return { entries: history.map((item) => ({ item })), hasOlder: false, startCursor: null, agent: null };
          },
        },
      }),
    },
  } as never;
  return { paseo, appended, reads: () => reads };
}

const agent = { id: "agent-1", provider: "claude", cwd: join(home, "code") };
// The daemon's record of what each agent was started with: the servers a card may name.
function recordAgent(id: string, servers: string[]): void {
  const dir = join(home, ".paseo", "agents", agent.cwd.replace(/^\//, "").replace(/\//g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, config: { mcpServers: Object.fromEntries(servers.map((name) => [name, { type: "stdio", command: "node" }])) } }));
}
recordAgent("agent-1", ["linear", "supabase"]);
recordAgent("agent-2", ["linear", "supabase"]);
const failing = [
  call("mcp__linear__list_issues", "failed", { message: "HTTP 401 Unauthorized", url: "https://mcp.linear.app/mcp?token=SECRET" }),
  call("mcp__linear__get_issue", "failed", "invalid_token"),
  call("mcp__supabase__execute_sql", "failed", "relation does not exist"),
];

beforeEach(() => {
  resetChat();
  resetPresence();
  markClientSeen();
  rmSync(join(home, ".paseo", "plugin-settings"), { recursive: true, force: true });
});

test("a turn with a sign-in failure gets exactly one card per server, with names only", async () => {
  const fake = fakePaseo();
  await onTurnEnded({ agent, timeline: failing }, fake.paseo);
  assert.equal(fake.appended.length, 1, "linear once, supabase's failure is not auth");
  const [card] = fake.appended;
  assert.deepEqual(card!.item, { type: "plugin", id: `${SIGN_IN_KIND}:linear`, kind: SIGN_IN_KIND, version: 1, data: { server: "linear", provider: "claude" } });
  assert.doesNotMatch(JSON.stringify(fake.appended), /SECRET|401|invalid_token|https?:/, "no error text, URL or token");
  await onTurnEnded({ agent, timeline: failing }, fake.paseo);
  await onTurnEnded({ agent, timeline: [call("mcp__linear__x", "failed", "Unauthorized")] }, fake.paseo);
  assert.equal(fake.appended.length, 1, "never a second card for linear in this chat");
  await onTurnEnded({ agent: { ...agent, id: "agent-2" }, timeline: failing }, fake.paseo);
  assert.equal(fake.appended.length, 2, "another chat gets its own");
});

test("after a restart the timeline decides: a card already there is not added again", async () => {
  const history = [{ type: "plugin", pluginId: "paseo-mcp", kind: SIGN_IN_KIND, version: 1, data: { server: "linear", provider: "claude" } }];
  const fake = fakePaseo({ history });
  await onTurnEnded({ agent, timeline: failing }, fake.paseo);
  assert.equal(fake.appended.length, 0);
  assert.equal(fake.reads(), 1, "read once to seed");
  await onTurnEnded({ agent, timeline: failing }, fake.paseo);
  assert.equal(fake.reads(), 1, "and not again");
});

test("P4: no card from a turn for a server the agent was not started with", async () => {
  const fake = fakePaseo();
  assert.equal(await onTurnEnded({ agent, timeline: [call("mcp__not_configured_anywhere__x", "failed", "HTTP 401 Unauthorized")] }, fake.paseo), undefined);
  assert.equal(fake.appended.length, 0);
  assert.equal(fake.reads(), 0);
});

test("if the timeline cannot be read back, nothing is appended rather than risk a second card", async () => {
  const fake = fakePaseo({ failRead: true });
  await onTurnEnded({ agent, timeline: failing }, fake.paseo);
  assert.equal(fake.appended.length, 0);
});

test("no card for a turn without an auth failure, and no timeline read either", async () => {
  const fake = fakePaseo();
  assert.equal(onTurnEnded({ agent, timeline: [call("mcp__linear__x", "failed", "timeout"), call("Bash", "failed", "Unauthorized")] }, fake.paseo), undefined);
  assert.equal(fake.reads(), 0);
  assert.equal(fake.appended.length, 0);
});

test("the setting turns it off, and nothing happens while no app is connected", async () => {
  const dir = join(home, ".paseo", "plugin-settings", "paseo-mcp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "health.json"), JSON.stringify({ version: 1, values: { chatSignInNotices: false } }));
  const off = fakePaseo();
  assert.equal(onTurnEnded({ agent, timeline: failing }, off.paseo), undefined);
  assert.equal(off.appended.length, 0);

  rmSync(dir, { recursive: true, force: true });
  resetPresence();
  const away = fakePaseo();
  assert.equal(onTurnEnded({ agent, timeline: failing }, away.paseo), undefined);
  assert.equal(away.appended.length, 0);
});

test("a version 1 health document from 0.13 and earlier reads the new setting as on", async () => {
  const dir = join(home, ".paseo", "plugin-settings", "paseo-mcp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "health.json"), JSON.stringify({ version: 1, values: { backgroundChecks: true, intervalMinutes: 10, showComposerPill: true } }));
  const fake = fakePaseo();
  await onTurnEnded({ agent, timeline: failing }, fake.paseo);
  assert.equal(fake.appended.length, 1);
});
