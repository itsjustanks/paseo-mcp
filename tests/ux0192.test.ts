/**
 * 0.19.2 (a real-app UX audit), the pure parts: name normalisation, built-in
 * Codex tools, which chats get a chip, the loading words, and the screen's
 * title and params.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { attentionLabel, chatAttention, chatIsLive, claudeOffIn, hostAttentionNames, hostNeedsAttention, tomlSwitchedOff, LIVE_CHAT_WINDOW_MS } from "../shared/attention";
import { isCodexBuiltIn } from "../shared/builtin";
import { chipAgentFrom, createChipRegistry, type ChipFace } from "../shared/chips";
import { resultNeedsAttention, type McpHealthReport } from "../shared/contracts";
import { normaliseConnectorName, tomlKeyPattern } from "../shared/names";
import { overviewNextStep, overviewVerdict, type OverviewFacts } from "../shared/overview";
import { filterParams, filterRequest, screenTitle, tabFromParams } from "../shared/screen-params";
import { tomlMcpNamesFromText, tomlMcpReadOneFromText } from "../server/handlers";

// ------------------------------------------------------------------ names

test("names: quote marks and spaces off, so one connector matches across apps", () => {
  assert.equal(normaliseConnectorName('"Acme: CRM"'), "Acme: CRM");
  assert.equal(normaliseConnectorName("'Acme: CRM'"), "Acme: CRM");
  assert.equal(normaliseConnectorName('  "Acme: CRM"  '), "Acme: CRM");
  assert.equal(normaliseConnectorName(' " spaced " '), "spaced");
  assert.equal(normaliseConnectorName('"a \\"b\\""'), 'a "b"', "a TOML basic string's escapes");
  assert.equal(normaliseConnectorName("linear"), "linear");
  assert.equal(normaliseConnectorName('"'), '"', "a lone quote mark is a name, not quotes");
});

test("names: Codex headers read without quotes, in every form, and the block is found by the plain name", () => {
  const text = ['[mcp_servers."Acme: CRM"]', 'url = "https://example.com/mcp"', "", "[ mcp_servers . 'Lit Name' ]", 'command = "x"', "", "[mcp_servers.plain]", 'url = "https://example.com/p"', "", '[mcp_servers."dotted.name"]', 'url = "https://example.com/d"'].join("\n");
  assert.deepEqual(tomlMcpNamesFromText(text), ["Acme: CRM", "Lit Name", "plain", "dotted.name"]);
  assert.equal(tomlMcpReadOneFromText(text, "Acme: CRM")?.url, "https://example.com/mcp");
  assert.equal(tomlMcpReadOneFromText(text, "dotted.name")?.url, "https://example.com/d");
  assert.equal(tomlMcpReadOneFromText(text, "plain")?.url, "https://example.com/p");
  assert.ok(new RegExp(`^${tomlKeyPattern("Acme: CRM")}$`).test('"Acme: CRM"'));
  assert.ok(new RegExp(`^${tomlKeyPattern("a.b")}$`).test('"a.b"'));
  assert.ok(!new RegExp(`^${tomlKeyPattern("a.b")}$`).test("aXb"), "a dot in a name is a dot, not any character");
});

// --------------------------------------------------------------- built-ins

test("built-in Codex tools: only in Codex, and a name the app adds or a program inside the app", () => {
  assert.equal(isCodexBuiltIn("computer-use", { command: "./Codex Computer Use.app/x" }, ["codex"]), true);
  assert.equal(isCodexBuiltIn("node_repl", { command: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl" }, ["codex"]), true);
  assert.equal(isCodexBuiltIn("something-new", { command: "/Applications/Codex.app/Contents/MacOS/tool" }, ["codex", "codex"]), true, "a program inside the Codex app");
  assert.equal(isCodexBuiltIn("node_repl", { command: "node" }, ["claude", "codex"]), false, "the user put it in Claude too: theirs");
  assert.equal(isCodexBuiltIn("my-tool", { command: "/usr/local/bin/my-tool" }, ["codex"]), false);
  assert.equal(isCodexBuiltIn("computer-use", null, []), false, "in no app");
});

test("built-in Codex tools never count as a problem: not in the dot, not in a chat's chip", () => {
  const report: McpHealthReport = {
    checkedAt: "",
    results: [{ name: "node_repl", status: "binary-missing", note: "", scopes: [{ level: "user", label: "Codex", configPath: "/c", providerId: "codex" }], builtIn: true }],
  };
  assert.equal(resultNeedsAttention(report.results[0]!), false);
  assert.equal(resultNeedsAttention({ status: "binary-missing" }), true);
  assert.equal(hostNeedsAttention(report, []), null);
  assert.deepEqual(chatAttention(report, [], { provider: "codex", cwd: "/p" }).failing, []);
  assert.deepEqual(hostAttentionNames(report, []), { failing: [], signIn: [] });
});

// ------------------------------------------------------------------- chip

const scope = (extra: Record<string, unknown> = {}) => ({ level: "user" as const, label: "Claude", configPath: "/h/.claude.json", providerId: "claude", ...extra });
const down = (name: string, extra: Record<string, unknown> = {}) => ({ name, status: "down" as const, note: "", scopes: [scope(extra)] });

test("the chip counts only what this chat loads: not a connector switched off here or everywhere", () => {
  const report: McpHealthReport = { checkedAt: "", results: [down("a"), down("b", { offIn: ["/code/demo/"] }), down("c", { off: true })] };
  assert.deepEqual(chatAttention(report, [], { provider: "claude", cwd: "/code/demo" }).failing, ["a"]);
  assert.deepEqual(chatAttention(report, [], { provider: "claude", cwd: "/code/other" }).failing, ["a", "b"]);
  assert.deepEqual(chatAttention(report, [], { provider: "codex", cwd: "/code/demo" }).failing, [], "another app's config");
  // A sign-in for a connector this chat doesn't load doesn't count either.
  const signIn = [{ name: "b", providerIds: ["claude"] }, { name: "z", providerIds: ["claude"] }];
  const known: McpHealthReport = { checkedAt: "", results: [{ ...down("b", { offIn: ["/code/demo"] }), status: "auth-required" }, { ...down("y"), status: "auth-required" }] };
  assert.deepEqual(chatAttention(known, [...signIn, { name: "y", providerIds: ["claude"] }], { provider: "claude", cwd: "/code/demo" }).signIn, ["y"], "b is off here; z is no config's (a Claude plugin's own), so the page can't show it");
  // The dot and its popover count the same way as the page: z isn't listed there, so it isn't counted here.
  assert.deepEqual(hostAttentionNames(known, [...signIn, { name: "y", providerIds: ["claude"] }]).signIn, ["b", "y"]);
  assert.equal(hostNeedsAttention(known, [{ name: "z", providerIds: ["claude"] }]), null);
});

test("the chip's words fit the composer: short, and never cut off", () => {
  // The app gives the chip's text about 110 px at 12 px: "2 connectors failing" was cut to "2 connectors faili…".
  for (const label of [attentionLabel({ failing: ["a", "b"], signIn: [] }), attentionLabel({ failing: Array(12).fill("x"), signIn: [] }), attentionLabel({ failing: [], signIn: Array(12).fill("x") })]) {
    assert.ok(label && label.length <= 15, `${label} is short`);
  }
});

test("the chip reads the chat's last activity from what the app sends: updatedAt on Paseo 0.11's list", () => {
  assert.equal(chipAgentFrom({ id: "a", workspaceId: "w", provider: "claude", status: "idle", updatedAt: "2026-09-15T03:03:00.185Z" })?.lastActivityAt, "2026-09-15T03:03:00.185Z");
  assert.equal(chipAgentFrom({ id: "a", workspaceId: "w", status: "idle", lastActivityAt: "2026-10-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" })?.lastActivityAt, "2026-10-01T00:00:00Z");
});

test("old finished chats get no chip; a running chat or a recent one does", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(chatIsLive({ status: "running", lastActivityAt: ago(30 * 86_400_000) }, now), true);
  assert.equal(chatIsLive({ status: "initializing" }, now), true);
  assert.equal(chatIsLive({ status: "idle", lastActivityAt: ago(5 * 60_000) }, now), true);
  assert.equal(chatIsLive({ status: "idle", lastActivityAt: ago(LIVE_CHAT_WINDOW_MS + 1) }, now), false);
  assert.equal(chatIsLive({ status: "error", lastActivityAt: ago(21 * 86_400_000) }, now), false, "three weeks old");
  assert.equal(chatIsLive({ status: "closed" }, now), false);
  assert.equal(chatIsLive({ status: "idle" }, now), true, "an older app that doesn't say when: as before");
});

test("the registry: an old chat loses its chip, and gets it back when it runs again", async () => {
  let clock = Date.parse("2026-10-06T12:00:00Z");
  const shown = new Map<string, ChipFace>();
  const report: McpHealthReport = { checkedAt: "", results: [down("a")] };
  const registry = createChipRegistry({
    addChip: (agent, face) => {
      shown.set(agent.id, face);
      return { update: (next) => void shown.set(agent.id, next), remove: () => void shown.delete(agent.id) };
    },
    readHealth: async () => ({ wanted: true, report, signIn: [] }),
    schedule: () => null,
    cancel: () => undefined,
    pollMs: 60_000,
    maxPollMs: 60_000,
    now: () => clock,
  });
  const old = { id: "old", workspaceId: "w", provider: "claude", cwd: "/p", status: "idle", lastActivityAt: "2026-09-15T08:00:00Z" };
  const fresh = { id: "fresh", workspaceId: "w", provider: "claude", cwd: "/p", status: "idle", lastActivityAt: "2026-10-06T11:55:00Z" };
  registry.replaceAll([old, fresh]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...shown.keys()], ["fresh"]);
  assert.deepEqual(shown.get("fresh"), { label: "1 broken", icon: "Plug" });
  registry.upsert({ ...old, status: "running", lastActivityAt: "2026-10-06T12:00:00Z" });
  assert.ok(shown.has("old"), "it ran again");
  clock += 2 * LIVE_CHAT_WINDOW_MS;
  registry.upsert({ ...fresh });
  assert.ok(!shown.has("fresh"), "finished more than an hour ago");
  registry.stop();
});

test("what a config switches off: Claude's per-project list and Codex's enabled = false", () => {
  assert.deepEqual(claudeOffIn({ "/a": { disabledMcpServers: ["x", "y"] }, "/b": { disabledMcpServers: ["y"] }, "/c": {} }, "x"), ["/a"]);
  assert.deepEqual(claudeOffIn(null, "x"), []);
  assert.deepEqual(claudeOffIn([], "x"), []);
  assert.equal(tomlSwitchedOff({ extra: ["enabled = false"] }), true);
  assert.equal(tomlSwitchedOff({ extra: ["enabled=false # for now"] }), true);
  assert.equal(tomlSwitchedOff({ extra: ["enabled = true"] }), false);
  assert.equal(tomlSwitchedOff(null), false);
});

// ---------------------------------------------------------------- loading

const ready: OverviewFacts = { state: "ready", staleAt: null, hostLabel: "demo", servers: 5, broken: 0, warnings: 0, signIn: 0, gaps: 0 };

test("loading: 'Checking…' until every read is in, never an 'All working' that changes a moment later", () => {
  assert.deepEqual(overviewVerdict({ ...ready, state: "loading" }), { status: "neutral", label: "Checking…" });
  assert.deepEqual(overviewVerdict({ ...ready, checking: true }), { status: "neutral", label: "Checking…" });
  assert.match(overviewNextStep({ ...ready, checking: true }).title, /^Checking/);
  // A problem already known shows at once, even while the rest is checked.
  assert.equal(overviewVerdict({ ...ready, checking: true, broken: 2 }).label, "2 not working");
  assert.deepEqual(overviewVerdict(ready), { status: "ok", label: "All working" });
});

// ---------------------------------------------------------------- screen

test("the window title follows the tab, and the dot's popover opens Connectors on a filter", () => {
  const labels = { overview: "Overview", servers: "Your connectors", projects: "Projects", guide: "Help" };
  assert.equal(screenTitle("Connectors", labels, {}), "Connectors");
  assert.equal(screenTitle("Connectors", labels, { tab: "guide" }), "Connectors · Help");
  assert.equal(screenTitle("Connectors", labels, { tab: "overview" }), "Connectors");
  assert.equal(screenTitle("Connectors", labels, { add: "server", at: "1" }), "Connectors · Add a connector");
  assert.equal(screenTitle("Connectors", labels, filterParams("issues", 5)), "Connectors · Your connectors");
  assert.equal(tabFromParams({ tab: "nonsense" }), null);
  assert.deepEqual(filterRequest(filterParams("sign-in", 7)), { filter: "sign-in", at: "7" });
  assert.equal(filterRequest({ filter: "everything" }), null);
});
