/**
 * 0.19.2, against a sandbox HOME (a real-app audit): Codex keeps a name with a
 * space quoted (`[mcp_servers."Acme: CRM"]`), so one connector was listed
 * twice and "missing" from each app; the Codex app's own tools
 * (`computer-use`, `node_repl`) counted as broken and were offered to Claude;
 * and the chip couldn't tell a connector a chat switched off from one it
 * loads. Here: one name across apps, built-ins marked and never copied, and
 * health scopes that say what a config switches off.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-ux0192-"));
process.env.HOME = home;
process.env.PASEO_HOME = join(home, ".paseo");
delete process.env.AGENT_LINK_HOME;
delete process.env.AGENT_AUTH_HOME;

const claudePath = join(home, ".claude.json");
const codexPath = join(home, ".codex", "config.toml");
// Unroutable on purpose: a probe to it is refused at once, and no real host is named.
const DEAD = "http://127.0.0.1:9/mcp";

const CODEX = [
  `[mcp_servers."Acme: CRM"]`,
  `url = "${DEAD}"`,
  "",
  `[mcp_servers."Acme: CRM".http_headers]`,
  `"X-Team" = "demo"`,
  "",
  "[mcp_servers.node_repl]",
  "args = []",
  `command = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl"`,
  "",
  "[mcp_servers.computer-use]",
  `command = "./Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient"`,
  `args = [ "mcp" ]`,
  "enabled = false",
  "",
  "[mcp_servers.jam]",
  `command = "jam-mcp-not-installed-anywhere"`,
  "enabled = false",
  "",
].join("\n");

function setup(): void {
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(
    claudePath,
    JSON.stringify({
      oauthAccount: { emailAddress: "me@example.com" },
      mcpServers: {
        "Acme: CRM": { type: "http", url: DEAD, headers: { "X-Team": "demo" } },
        pencil: { type: "stdio", command: "pencil-mcp-not-installed-anywhere" },
      },
      projects: { "/code/demo": { disabledMcpServers: ["pencil"] }, "/code/other": { disabledMcpServers: [] } },
    }),
  );
  writeFileSync(codexPath, CODEX);
}
setup();

const { handleMcpMatrix, tomlApply, destRead } = await import("../server/handlers");
const { handleMcpCopyPlan } = await import("../server/copy-all");
const { probeAll } = await import("../server/health");
const { resetDaemonReads } = await import("../server/daemon-cache");
const { chatAttention } = await import("../shared/attention");
const context = { paseo: { config: { get: async () => ({ config: { providers: {} } }), patch: async () => ({}) }, projects: { list: async () => [] } } } as never;
after(() => rmSync(home, { recursive: true, force: true }));

test("one connector, one name: Codex's quoted key and Claude's plain one are the same connector, in both apps", async () => {
  resetDaemonReads();
  setup();
  const matrix = await handleMcpMatrix({} as never, context);
  const names = matrix.servers.map((entry) => entry.name);
  assert.equal(names.filter((name) => name.includes("Acme")).length, 1, "listed once");
  assert.ok(!names.some((name) => name.startsWith('"')), "no quote marks kept");
  const acme = matrix.servers.find((entry) => entry.name === "Acme: CRM")!;
  assert.equal(acme.presentIn.length, 2, "in Claude and in Codex: not missing from either");
  // Codex's own definition is read under the plain name too, headers and all.
  const codex = matrix.destinations.find((dest) => dest.format === "toml-mcp")!;
  assert.deepEqual(destRead(codex)["Acme: CRM"]?.headers, { "X-Team": "demo" });
});

test("the quoted Codex block can be taken out by its plain name, and nothing else in the file moves", () => {
  const next = tomlApply(CODEX, "Acme: CRM", null, codexPath);
  assert.ok(!next.includes("Acme: CRM"), "the block and its header table are gone");
  assert.ok(next.includes("[mcp_servers.node_repl]") && next.includes("[mcp_servers.jam]"));
  // Writing a new one under a name that needs quotes is still refused, as before.
  assert.throws(() => tomlApply(CODEX, "New One", { url: DEAD }, codexPath), /not a valid TOML table name/);
});

test("tools the Codex app ships are marked, never copied to another app, and never checked as 'not installed'", async () => {
  resetDaemonReads();
  setup();
  const matrix = await handleMcpMatrix({} as never, context);
  const flag = (name: string) => matrix.servers.find((entry) => entry.name === name)?.builtIn ?? false;
  assert.equal(flag("node_repl"), true, "its program is inside the ChatGPT app");
  assert.equal(flag("computer-use"), true, "a name the Codex app adds");
  assert.equal(flag("jam"), false, "a user's own Codex connector");
  assert.equal(flag("Acme: CRM"), false);

  const plan = await handleMcpCopyPlan({} as never, context);
  const planned = plan.servers.map((entry) => entry.name);
  assert.ok(!planned.includes("node_repl") && !planned.includes("computer-use"), "not offered to Claude");
  assert.ok(!planned.includes("Acme: CRM"), "both apps have it already");
  assert.match(plan.excluded.find((entry) => entry.name === "node_repl")?.reason ?? "", /Comes with the Codex app/);

  const report = await probeAll(null, { startPathLookup: false });
  const node = report.results.find((entry) => entry.name === "node_repl")!;
  assert.equal(node.builtIn, true);
  assert.equal(node.status, "unknown");
  assert.doesNotMatch(node.note, /PATH/, "no raw 'not on PATH' error");
  const pencil = report.results.find((entry) => entry.name === "pencil")!;
  assert.equal(pencil.status, "binary-missing", "a user's own missing program is still reported");
});

test("health scopes say what a config switches off, so a chat that doesn't load a connector gets no chip for it", async () => {
  resetDaemonReads();
  setup();
  const report = await probeAll(null, { startPathLookup: false });
  const scope = (name: string) => report.results.find((entry) => entry.name === name)!.scopes[0]!;
  assert.deepEqual(scope("pencil").offIn, ["/code/demo"], "Claude's per-project disabledMcpServers");
  assert.equal(scope("jam").off, true, "Codex's enabled = false");
  assert.equal(scope("Acme: CRM").off, undefined);

  const claudeChat = (cwd: string) => chatAttention(report, [], { provider: "claude", cwd });
  assert.ok(claudeChat("/code/other").failing.includes("pencil"), "loaded in a project that leaves it on");
  assert.ok(!claudeChat("/code/demo").failing.includes("pencil"), "switched off in this chat's project");
  assert.ok(!chatAttention(report, [], { provider: "codex", cwd: "/code/demo" }).failing.includes("jam"), "switched off everywhere");
  assert.ok(!chatAttention(report, [], { provider: "codex", cwd: "/code/demo" }).failing.includes("node_repl"), "built in, never a problem");
  assert.ok(readFileSync(codexPath, "utf8") === CODEX, "reading changed nothing");
});
