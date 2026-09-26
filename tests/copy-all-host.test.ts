/**
 * 0.15.0 "Copy to all my AI apps", against a sandbox HOME with a Claude
 * config, a Codex config (TOML), a Kimi config and a second Claude account:
 * the plan is every gap across apps and accounts, a server can be left out,
 * a name that turns up with a different definition is skipped, nothing is
 * removed, a partial failure is reported per server and app, and every
 * written file reads back.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-copy-all-"));
process.env.HOME = home;
process.env.PASEO_HOME = join(home, ".paseo");
delete process.env.AGENT_LINK_HOME;
delete process.env.AGENT_AUTH_HOME;

const claudePath = join(home, ".claude.json");
const codexPath = join(home, ".codex", "config.toml");
const kimiPath = join(home, ".kimi-code", "mcp.json");
const slotDir = join(home, ".claude-accounts", "work@example.com");
const slotPath = join(slotDir, ".claude.json");

const KEY = "Bearer acme-live-0123456789";

/** A fresh sandbox: each test starts from the same four files. */
function setup(): void {
  for (const dir of [join(home, ".codex"), join(home, ".kimi-code"), slotDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(
    claudePath,
    JSON.stringify({
      oauthAccount: { emailAddress: "me@example.com" },
      mcpServers: {
        linear: { type: "http", url: "https://mcp.linear.app/mcp" },
        acme: { type: "http", url: "https://mcp.acme.example/mcp", headers: { Authorization: KEY } },
        local: { type: "stdio", command: "node", args: ["./server.js"] },
        paseo: { type: "http", url: "http://127.0.0.1:6767/mcp/agents" },
      },
      projects: { "/code/demo": { hasTrustDialogAccepted: true, allowedTools: ["Edit"] } },
    }),
  );
  writeFileSync(codexPath, '[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"\n\n[mcp_servers.jam]\nurl = "https://mcp.jam.dev/mcp"\nenabled = true\n');
  writeFileSync(kimiPath, JSON.stringify({ mcpServers: {} }));
  writeFileSync(slotPath, JSON.stringify({ oauthAccount: { emailAddress: "work@example.com" }, mcpServers: { mine: { type: "http", url: "https://mine.example/mcp" } }, projects: {} }));
}
setup();

const { handleMcpCopyPlan, handleMcpCopyAll } = await import("../server/copy-all");
const { resetDaemonReads } = await import("../server/daemon-cache");
const context = { paseo: { config: { get: async () => ({ config: { providers: {} } }), patch: async () => ({}) }, projects: { list: async () => [] } } } as never;
after(() => rmSync(home, { recursive: true, force: true }));

const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as { mcpServers: Record<string, Record<string, unknown>>; projects?: Record<string, Record<string, unknown>> };
const everything = async () => {
  const plan = await handleMcpCopyPlan({} as never, context);
  return { plan, all: plan.servers.map((entry) => ({ name: entry.name, targets: entry.targets.map((target) => target.id) })) };
};

test("the plan: every gap, across apps and accounts, from the best copy; Paseo's own server left out", async () => {
  resetDaemonReads();
  setup();
  const { plan } = await handleMcpCopyPlan({} as never, context).then((value) => ({ plan: value }));
  const byName = new Map(plan.servers.map((entry) => [entry.name, entry]));
  assert.deepEqual([...byName.keys()], ["acme", "jam", "linear", "local", "mine"]);
  assert.deepEqual(byName.get("linear")?.targets.map((target) => target.label), ["Kimi", "Claude (work@example.com)"]);
  assert.deepEqual(byName.get("acme")?.targets.map((target) => target.label), ["Codex", "Kimi", "Claude (work@example.com)"]);
  assert.equal(byName.get("acme")?.savedKey, true, "carries its saved key");
  assert.equal(byName.get("linear")?.savedKey, false);
  assert.equal(byName.get("acme")?.from, "Claude (me@example.com)");
  // Only Codex has jam: Claude, Kimi and the other Claude account get it, from Codex.
  assert.equal(byName.get("jam")?.from, "Codex");
  assert.deepEqual(byName.get("jam")?.targets.map((target) => target.label), ["Claude (me@example.com)", "Kimi", "Claude (work@example.com)"]);
  // Only the second Claude account has mine: every other app gets it.
  assert.deepEqual(byName.get("mine")?.targets.map((target) => target.label), ["Claude (me@example.com)", "Codex", "Kimi"]);
  assert.deepEqual(plan.excluded.map((entry) => entry.name), ["paseo"]);
  assert.ok(!JSON.stringify(plan).includes("acme-live"), "no saved key in the plan");
});

test("copy: written everywhere it was missing, read back in each file's own format, nothing removed; project trust not touched", async () => {
  resetDaemonReads();
  setup();
  const before = { claude: json(claudePath), slot: json(slotPath), codex: readFileSync(codexPath, "utf8") };
  const { all } = await everything();
  const result = await handleMcpCopyAll({ servers: all }, context);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(Object.fromEntries(result.results.map((entry) => [entry.name, entry.written.length])), { acme: 3, jam: 3, linear: 2, local: 3, mine: 3 });
  assert.ok(result.results.every((entry) => entry.skipped.length === 0));

  const codex = readFileSync(codexPath, "utf8");
  assert.match(codex, /\[mcp_servers\.acme\]\nurl = "https:\/\/mcp\.acme\.example\/mcp"/);
  assert.match(codex, /\[mcp_servers\.acme\.http_headers\]\n"?Authorization"? = "Bearer acme-live-0123456789"/, "Codex's own header table, with the key");
  assert.match(codex, /\[mcp_servers\.local\]\ncommand = "node"\nargs = \["\.\/server\.js"\]/);
  assert.ok(codex.startsWith(before.codex.trimEnd()), "Codex's own servers kept as they were, first in the file");
  const kimi = json(kimiPath).mcpServers;
  assert.deepEqual(Object.keys(kimi).sort(), ["acme", "jam", "linear", "local", "mine"]);
  assert.deepEqual(kimi.acme?.headers, { Authorization: KEY });
  assert.equal(kimi.jam?.url, "https://mcp.jam.dev/mcp");
  const claude = json(claudePath).mcpServers;
  assert.equal(claude.jam?.type, "http", "Claude's entry gets the type it needs");
  assert.equal(claude.mine?.url, "https://mine.example/mcp");
  const slot = json(slotPath);
  assert.deepEqual(Object.keys(slot.mcpServers).sort(), ["acme", "jam", "linear", "local", "mine"], "paseo not copied");

  // Nothing removed or changed: every server that was in a file is still there, the same.
  for (const [name, def] of Object.entries(before.claude.mcpServers)) assert.deepEqual(claude[name], def, `Claude's ${name}`);
  for (const [name, def] of Object.entries(before.slot.mcpServers)) assert.deepEqual(slot.mcpServers[name], def, `the other account's ${name}`);
  // Copy is servers only: the other account's projects are left exactly as they were.
  assert.deepEqual(slot.projects, {});
  assert.equal("trust" in result, false);

  // Run again: nothing left to copy.
  const again = await everything();
  assert.deepEqual(again.plan.servers, []);
});

test("leave one out: an unticked server isn't written anywhere", async () => {
  resetDaemonReads();
  setup();
  const { all } = await everything();
  const result = await handleMcpCopyAll({ servers: all.filter((entry) => entry.name !== "acme") }, context);
  assert.equal(result.ok, true);
  assert.ok(!result.results.some((entry) => entry.name === "acme"));
  assert.equal(json(kimiPath).mcpServers.acme, undefined);
  assert.doesNotMatch(readFileSync(codexPath, "utf8"), /acme/);
  assert.equal(json(slotPath).mcpServers.acme, undefined);
  assert.ok(json(kimiPath).mcpServers.linear, "the others still copied");
});

test("a name that turned up with a different definition since the preview is skipped, never overwritten", async () => {
  resetDaemonReads();
  setup();
  const { all } = await everything();
  // Between the preview and the copy, Kimi gets its own linear at another address, and the same jam as Codex.
  writeFileSync(kimiPath, JSON.stringify({ mcpServers: { linear: { url: "https://linear.internal.example/mcp" }, jam: { url: "https://mcp.jam.dev/mcp" } } }));
  const result = await handleMcpCopyAll({ servers: all }, context);
  const linear = result.results.find((entry) => entry.name === "linear")!;
  assert.deepEqual(linear.skipped, [{ label: "Kimi", reason: "it already has a different server called linear; left as it is" }]);
  assert.deepEqual(linear.written, ["Claude (work@example.com)"]);
  const jam = result.results.find((entry) => entry.name === "jam")!;
  assert.deepEqual(jam.skipped, [{ label: "Kimi", reason: "it already has it" }]);
  assert.equal(json(kimiPath).mcpServers.linear?.url, "https://linear.internal.example/mcp", "Kimi's own linear untouched");
  assert.equal(result.ok, false, "skips are reported");
});

test("a partial failure is reported per server and per app; the rest is still written", async () => {
  resetDaemonReads();
  setup();
  const { all } = await everything();
  writeFileSync(kimiPath, "{ this is not json");
  const result = await handleMcpCopyAll({ servers: all.filter((entry) => entry.name === "acme" || entry.name === "linear") }, context);
  assert.equal(result.ok, false);
  for (const entry of result.results) {
    assert.deepEqual(entry.skipped.map((skip) => skip.label), ["Kimi"], entry.name);
    assert.match(entry.skipped[0]!.reason, /not valid JSON/);
  }
  assert.deepEqual(result.results.find((entry) => entry.name === "acme")?.written, ["Codex", "Claude (work@example.com)"]);
  assert.equal(readFileSync(kimiPath, "utf8"), "{ this is not json", "the broken file is left alone");
  assert.match(result.message, /skipped/);
});
