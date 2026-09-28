/**
 * "Needs setup" (0.16.0) against a sandbox HOME: a bring-your-own-app server
 * goes into Claude Code through `claude mcp add-json --client-secret` (a fake
 * `claude` here that writes the config and a fake secure store as Claude Code
 * does), the secret only ever in that child's environment; Codex is skipped
 * with the reason; a per-org address is filled and checked; approved-only
 * and admin servers are never written.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-setup-"));
const project = join(home, "code", "demo");
mkdirSync(project, { recursive: true });
mkdirSync(join(home, ".codex"), { recursive: true });
mkdirSync(join(home, ".local", "bin"), { recursive: true });
const claudeFile = join(home, ".claude.json");
const codexFile = join(home, ".codex", "config.toml");
writeFileSync(claudeFile, JSON.stringify({ oauthAccount: { emailAddress: "me@example.com" }, mcpServers: { docs: { type: "http", url: "https://docs.example.com/mcp" } }, projects: {} }, null, 2));
const codexBefore = 'model = "gpt-5"\n\n[mcp_servers.docs]\nurl = "https://docs.example.com/mcp"\n';
writeFileSync(codexFile, codexBefore);

// What Claude Code does for `mcp add-json --client-secret`: the entry into the
// config, the secret (read from MCP_CLIENT_SECRET) into its store. It logs its
// arguments, and the secret it got, for the test to check.
const argvLog = join(home, "claude-argv.log");
const envLog = join(home, "claude-env.log");
const store = join(home, ".claude", ".credentials.json");
writeFileSync(
  join(home, ".local", "bin", "claude"),
  `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
(function main() {
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
fs.appendFileSync(${JSON.stringify(envLog)}, (process.env.MCP_CLIENT_SECRET || "") + "\\n");
if (args[0] !== "mcp" || args[1] !== "add-json") process.exit(2);
if (process.env.FAKE_CLAUDE_DELAY_MS) { const until = Date.now() + Number(process.env.FAKE_CLAUDE_DELAY_MS); while (Date.now() < until); }
const positional = args.slice(2).filter((arg, index, all) => !arg.startsWith("--") && all[index - 1] !== "--scope");
const [name, json] = positional;
const dir = process.env.CLAUDE_CONFIG_DIR;
const file = dir ? path.join(dir, ".claude.json") : path.join(process.env.HOME, ".claude.json");
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
if (config.mcpServers && config.mcpServers[name]) { console.error("MCP server " + name + " already exists in user config"); process.exit(1); }
config.mcpServers = { ...(config.mcpServers || {}), [name]: JSON.parse(json) };
fs.writeFileSync(file, JSON.stringify(config, null, 2));
// Claude Code writes the config before it stores the secret: a kill in between leaves the entry without it.
if (process.env.FAKE_CLAUDE_MODE === "hang") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); return; }
if (process.env.FAKE_CLAUDE_MODE === "nostore") { console.error("Warning: the client secret could not be stored"); process.exit(0); }
fs.mkdirSync(path.dirname(${JSON.stringify(store)}), { recursive: true });
const saved = fs.existsSync(${JSON.stringify(store)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(store)}, "utf8")) : {};
saved.mcpOAuthClientConfig = { ...(saved.mcpOAuthClientConfig || {}), [name + "|hash"]: { clientSecret: process.env.MCP_CLIENT_SECRET } };
fs.writeFileSync(${JSON.stringify(store)}, JSON.stringify(saved));
console.log("Added http MCP server " + name + " to user config");
})();
`,
);
chmodSync(join(home, ".local", "bin", "claude"), 0o755);

// A library file with one of each kind, as the gallery lists them.
const META = "io.github.itsjustanks/mcp-gallery";
const GW = "https://developers.google.com/workspace/guides/configure-mcp-servers";
const scopes = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose";
const entry = (name: string, url: string, setup: unknown, variables?: unknown) => ({
  server: { name, description: `${name}.`, version: "1.0.0", remotes: [{ type: "streamable-http", url, ...(variables ? { variables } : {}) }] },
  _meta: { [META]: { displayName: name, category: "productivity", auth: "oauth", docsUrl: GW, verifiedAt: "2026-09-28", setup } },
});
const libraryFile = join(home, "gallery.json");
writeFileSync(
  libraryFile,
  JSON.stringify({
    servers: [
      entry("com.box/mcp", "https://mcp.box.com", { kind: "admin", reason: "A Box admin has to turn it on.", guideUrl: "https://developer.box.com/guides/box-mcp/remote/" }),
      entry("com.google/gmail", "https://gmailmcp.googleapis.com/mcp/v1", { kind: "byo-oauth", reason: "Google only lets in your own sign-in app.", guideUrl: GW, steps: ["Create a client."], redirectHint: "Authorized redirect URIs", clients: ["claude"], scopes }),
      entry("com.google/gmail-lookalike", "https://gmail-mcp.evil.example/mcp/v1", { kind: "byo-oauth", reason: "Google only lets in your own sign-in app.", guideUrl: GW, steps: ["Create a client."], clients: ["claude"] }),
      entry("com.slack/mcp", "https://mcp.slack.com/mcp", { kind: "approved-clients", reason: "Slack only lets its approved apps connect.", guideUrl: "https://docs.slack.dev/ai/slack-mcp-server/" }),
      entry("com.zendesk/mcp", "https://{subdomain}.zendesk.com/api/mcp", { kind: "per-org", reason: "It needs your subdomain.", guideUrl: "https://www.zendesk.com/marketplace/apps/support/1191848/mcp-server/", urlTemplate: "https://{subdomain}.zendesk.com/api/mcp", label: "Your Zendesk subdomain" }, { subdomain: { description: "Subdomain", isRequired: true, isSecret: false } }),
    ],
    metadata: { count: 5 },
  }),
);

process.env.HOME = home;
process.env.PASEO_HOME = join(home, ".paseo");
process.env.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
delete process.env.MCP_CLIENT_SECRET;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.AGENT_LINK_HOME;
delete process.env.AGENT_AUTH_HOME;
mkdirSync(join(home, ".paseo", "plugin-settings", "paseo-mcp"), { recursive: true });
writeFileSync(
  join(home, ".paseo", "plugin-settings", "paseo-mcp", "catalog.json"),
  JSON.stringify({ version: 2, values: { libraries: [{ id: "test-gallery", name: "Test gallery", source: libraryFile, format: "json" }] } }),
);
after(() => rmSync(home, { recursive: true, force: true }));

// Everything the plugin logs while these run, to check the secret is never in it.
const logged: string[] = [];
for (const method of ["log", "info", "warn", "error", "debug"] as const) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
    original(...args);
  };
}

const { handleMcpCatalog, handleMcpCatalogInstall, handleMcpCatalogPlan, catalogSettled, readCatalogSettings, setCatalogFetch } = await import("../server/catalog");
const { setByoTimeouts } = await import("../server/byo-oauth");
const { resetDaemonReads } = await import("../server/daemon-cache");
const { DEFAULT_LIBRARY_URL, GALLERY_V01_URL } = await import("../shared/library-source");
setCatalogFetch(async () => new Response("", { status: 401 }));
let providers: Record<string, unknown> = {};
const paseo = {
  config: { get: async () => ({ config: { providers } }), patch: async () => ({}) },
  projects: { list: async () => [{ name: "demo", path: project }] },
} as never;
const context = { paseo } as never;

const SECRET = "GOCSPX" + "-9f8e7d6c5b4a3z2y1x0wvutsrq";
const CLIENT_ID = "123456789012-abcdefghij.apps.googleusercontent.com";

async function cards() {
  await handleMcpCatalog({}, context);
  await catalogSettled();
  return (await handleMcpCatalog({}, context)).cards;
}

test("the gallery shows each kind: byo and per-org can be set up, approved-only and admin can't", async () => {
  const list = await cards();
  const byKey = (name: string) => list.find((card) => card.key === `library:test-gallery:${name}`);
  assert.equal(byKey("com.google/gmail")?.installable, true);
  assert.equal(byKey("com.zendesk/mcp")?.installable, true);
  assert.equal(byKey("com.slack/mcp")?.installable, false);
  assert.equal(byKey("com.box/mcp")?.installable, false);
  assert.equal(byKey("com.box/mcp")?.entry.setup?.guideUrl, "https://developer.box.com/guides/box-mcp/remote/");
});

test("byo-oauth: Claude gets the client through its own add, the secret only in its environment; Codex is skipped", async () => {
  await cards();
  const input = {
    key: "library:test-gallery:com.google/gmail",
    scope: "user" as const,
    targets: [claudeFile, codexFile],
    projectPath: "",
    name: "gmail",
    values: {},
    oauthClient: { clientId: CLIENT_ID, hasSecret: true },
  };
  const plan = await handleMcpCatalogPlan(input, context);
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.ok, true);
  assert.equal(plan.redirectUri, "http://localhost:33418/callback");
  assert.deepEqual(plan.previews.map((preview) => preview.file), [claudeFile]);
  assert.ok(plan.notes.some((note) => /Skipped Codex .*no place for a client secret/.test(note)));
  assert.ok(!JSON.stringify(plan).includes(SECRET), "the plan never holds the secret");

  const result = await handleMcpCatalogInstall({ ...input, oauthClient: { clientId: CLIENT_ID, clientSecret: SECRET }, planHash: plan.planHash }, context);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.written, ["Claude · me@example.com (primary)"]);
  assert.ok(result.skipped.some((line) => /^Codex .*no place for a client secret/.test(line)));
  assert.equal(result.oauth, true);
  assert.ok(!JSON.stringify(result).includes(SECRET), "the answer never holds the secret");

  // Read back: exactly Claude Code's shape, no secret in any config file.
  const config = JSON.parse(readFileSync(claudeFile, "utf8"));
  assert.deepEqual(config.mcpServers.gmail, { type: "http", url: "https://gmailmcp.googleapis.com/mcp/v1", oauth: { clientId: CLIENT_ID, callbackPort: 33418, scopes } });
  assert.deepEqual(config.mcpServers.docs, { type: "http", url: "https://docs.example.com/mcp" }, "the rest of the file is kept");
  assert.ok(!readFileSync(claudeFile, "utf8").includes(SECRET));
  assert.equal(readFileSync(codexFile, "utf8"), codexBefore, "Codex untouched");
  assert.ok(readdirSync(home).some((file) => file.startsWith(".claude.json.bak-paseo-mcp-")), "backed up first");

  // The secret went to Claude Code's store through its environment, never its arguments.
  assert.equal(JSON.parse(readFileSync(store, "utf8")).mcpOAuthClientConfig["gmail|hash"].clientSecret, SECRET);
  assert.ok(readFileSync(envLog, "utf8").includes(SECRET));
  const argv = readFileSync(argvLog, "utf8");
  assert.ok(!argv.includes(SECRET), "never in argv");
  assert.deepEqual(JSON.parse(argv.trim().split("\n")[0]!).slice(0, 7), ["mcp", "add-json", "--scope", "user", "--client-secret", "--", "gmail"]);
  assert.ok(!logged.join("\n").includes(SECRET), "never logged");
});

test("byo-oauth: added again under the same name is refused before Claude Code runs", async () => {
  const runs = readFileSync(argvLog, "utf8").trim().split("\n").length;
  const input = { key: "library:test-gallery:com.google/gmail", scope: "user" as const, targets: [claudeFile], projectPath: "", name: "gmail", values: {}, oauthClient: { clientId: CLIENT_ID, clientSecret: SECRET } };
  const plan = await handleMcpCatalogPlan(input, context);
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.clash?.files, ["Claude · me@example.com (primary)"]);
  const result = await handleMcpCatalogInstall({ ...input, planHash: plan.planHash }, context);
  assert.equal(result.ok, false);
  assert.equal(readFileSync(argvLog, "utf8").trim().split("\n").length, runs);
  assert.ok(!JSON.stringify([plan, result]).includes(SECRET));
});

test("byo-oauth: never into a project file, and a missing secret is asked for", async () => {
  const project = await handleMcpCatalogPlan({ key: "library:test-gallery:com.google/gmail", scope: "project", targets: [], projectPath: join(home, "code", "demo"), name: "gmail-2", values: {}, oauthClient: { clientId: CLIENT_ID, clientSecret: SECRET } }, context);
  assert.equal(project.ok, false);
  assert.ok(project.issues.some((issue) => /project's file/.test(issue)));
  assert.ok(!JSON.stringify(project).includes(SECRET));
  const empty = await handleMcpCatalogPlan({ key: "library:test-gallery:com.google/gmail", scope: "user", targets: [claudeFile], projectPath: "", name: "gmail-2", values: {}, oauthClient: { clientId: CLIENT_ID, hasSecret: false } }, context);
  assert.ok(empty.issues.includes("Paste the client secret."));
});

test("per-org: the subdomain fills the address in every app; one that would leave the vendor's host is refused", async () => {
  const input = { key: "library:test-gallery:com.zendesk/mcp", scope: "user" as const, targets: [claudeFile, codexFile], projectPath: "", name: "zendesk", values: { subdomain: "acme" } };
  const plan = await handleMcpCatalogPlan(input, context);
  assert.deepEqual(plan.issues, []);
  const result = await handleMcpCatalogInstall({ ...input, planHash: plan.planHash }, context);
  assert.equal(result.ok, true, result.message);
  assert.equal(JSON.parse(readFileSync(claudeFile, "utf8")).mcpServers.zendesk.url, "https://acme.zendesk.com/api/mcp");
  assert.match(readFileSync(codexFile, "utf8"), /\[mcp_servers\.zendesk\]\nurl = "https:\/\/acme\.zendesk\.com\/api\/mcp"/);

  for (const subdomain of ["evil.com/x?", "evil.com#", "ACME"]) {
    const hostile = { ...input, name: "zendesk-2", values: { subdomain } };
    const refused = await handleMcpCatalogPlan(hostile, context);
    assert.equal(refused.ok, false, subdomain);
    const tried = await handleMcpCatalogInstall({ ...hostile, planHash: refused.planHash }, context);
    assert.equal(tried.ok, false, subdomain);
  }
  assert.ok(!("zendesk-2" in JSON.parse(readFileSync(claudeFile, "utf8")).mcpServers));
});

test("approved-only and admin servers are never written, with the vendor's reason", async () => {
  for (const [key, reason] of [["com.slack/mcp", /approved apps/], ["com.box/mcp", /Box admin/]] as const) {
    const input = { key: `library:test-gallery:${key}`, scope: "user" as const, targets: [claudeFile], projectPath: "", name: key.split(/[./]/)[1]!, values: {} };
    const plan = await handleMcpCatalogPlan(input, context);
    assert.equal(plan.ok, false);
    assert.match(plan.issues.join(" "), reason);
    const result = await handleMcpCatalogInstall({ ...input, planHash: plan.planHash }, context);
    assert.equal(result.ok, false);
  }
  const servers = JSON.parse(readFileSync(claudeFile, "utf8")).mcpServers;
  assert.ok(!("slack" in servers) && !("box" in servers));
  assert.ok(existsSync(store));
});

// ----------------------------------------------- review of 0.16.0 (2026-09-28)

const byoInput = (name: string, targets: string[], key = "library:test-gallery:com.google/gmail") => ({ key, scope: "user" as const, targets, projectPath: "", name, values: {} });
async function byoInstall(name: string, targets: string[], key?: string) {
  const input = byoInput(name, targets, key);
  const plan = await handleMcpCatalogPlan({ ...input, oauthClient: { clientId: CLIENT_ID, hasSecret: true } }, context);
  const result = await handleMcpCatalogInstall({ ...input, oauthClient: { clientId: CLIENT_ID, clientSecret: SECRET }, planHash: plan.planHash }, context);
  assert.ok(!JSON.stringify([plan, result]).includes(SECRET));
  return { plan, result };
}
const runsSoFar = () => (existsSync(argvLog) ? readFileSync(argvLog, "utf8").trim().split("\n").length : 0);
const claudeServers = (file = claudeFile) => JSON.parse(readFileSync(file, "utf8")).mcpServers ?? {};

test("a library's look-alike Gmail at another host is blocked: no secret field, no plan, Claude Code never runs", async () => {
  const card = (await cards()).find((candidate) => candidate.key === "library:test-gallery:com.google/gmail-lookalike");
  assert.equal(card?.installable, false);
  assert.equal(card?.entry.setup, undefined);
  const runs = runsSoFar();
  const { plan, result } = await byoInstall("gmail-evil", [claudeFile], "library:test-gallery:com.google/gmail-lookalike");
  assert.equal(plan.ok, false);
  assert.equal(result.ok, false);
  assert.equal(runsSoFar(), runs);
  assert.ok(!("gmail-evil" in claudeServers()));
});

test("a name that starts with - goes after --, so Claude Code reads it as the name", async () => {
  const { result } = await byoInstall("-h", [claudeFile]);
  assert.equal(result.ok, true, result.message);
  const argv = JSON.parse(readFileSync(argvLog, "utf8").trim().split("\n").at(-1)!) as string[];
  assert.equal(argv[argv.indexOf("-h") - 1], "--");
  assert.ok("-h" in claudeServers());
});

test("an account kept at ~/.claude is written there, not into the primary ~/.claude.json", async () => {
  const dotDir = join(home, ".claude");
  mkdirSync(dotDir, { recursive: true });
  const dotFile = join(dotDir, ".claude.json");
  writeFileSync(dotFile, JSON.stringify({ oauthAccount: { emailAddress: "work@example.com" }, mcpServers: {} }, null, 2));
  providers = { "claude-dot": { extends: "claude", env: { CLAUDE_CONFIG_DIR: dotDir } } };
  resetDaemonReads();
  try {
    const { plan, result } = await byoInstall("gmail-dot", [dotFile]);
    assert.deepEqual(plan.previews.map((preview) => preview.file), [dotFile]);
    assert.equal(result.ok, true, result.message);
    assert.ok("gmail-dot" in claudeServers(dotFile), "in the account's own file");
    assert.ok(!("gmail-dot" in claudeServers()), "not in the primary file");
  } finally {
    providers = {};
    resetDaemonReads();
  }
});

test("a Claude Code that hangs is killed, and the half-added server is taken out again", async () => {
  setByoTimeouts({ termMs: 300, killMs: 300 });
  process.env.FAKE_CLAUDE_MODE = "hang";
  try {
    const started = Date.now();
    const { result } = await byoInstall("gmail-hang", [claudeFile]);
    assert.ok(Date.now() - started < 10_000, "not left pending");
    assert.equal(result.ok, false);
    assert.match(result.message, /taken out again/);
    assert.ok(!("gmail-hang" in claudeServers()), "no server left without its secret");
    // A retry is not refused as a clash.
    delete process.env.FAKE_CLAUDE_MODE;
    const again = await byoInstall("gmail-hang", [claudeFile]);
    assert.equal(again.result.ok, true, again.result.message);
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
    setByoTimeouts(null);
  }
});

test("a secret Claude Code could not store: the server is taken out again, not left unable to sign in", async () => {
  process.env.FAKE_CLAUDE_MODE = "nostore";
  try {
    const { result } = await byoInstall("gmail-nostore", [claudeFile]);
    assert.equal(result.ok, false);
    assert.match(result.message, /could not store the client secret/);
    assert.match(result.message, /taken out again/);
    assert.ok(!("gmail-nostore" in claudeServers()));
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
  }
});

test("a saved v0.1 gallery address is read as v0.2", () => {
  const file = join(home, ".paseo", "plugin-settings", "paseo-mcp", "catalog.json");
  const before = readFileSync(file, "utf8");
  try {
    writeFileSync(file, JSON.stringify({ version: 2, values: { libraries: [{ id: "mcp-gallery", name: "MCP Gallery", source: GALLERY_V01_URL, format: "json" }] } }));
    assert.equal(readCatalogSettings().libraries[0]?.source, DEFAULT_LIBRARY_URL);
  } finally {
    writeFileSync(file, before);
  }
});

test("two installs of one server into one account at once: the second waits, is refused, and leaves the first's entry", async () => {
  process.env.FAKE_CLAUDE_DELAY_MS = "400";
  try {
    const [a, b] = await Promise.all([byoInstall("grace", [claudeFile]), byoInstall("grace", [claudeFile])]);
    assert.equal([a.result.ok, b.result.ok].filter(Boolean).length, 1, `${a.result.message} / ${b.result.message}`);
    assert.ok("grace" in claudeServers(), "the first one's server is still there");
  } finally {
    delete process.env.FAKE_CLAUDE_DELAY_MS;
  }
});

test("an install that skips the contract with hasSecret and no secret is refused before Claude Code runs", async () => {
  const runs = runsSoFar();
  const input = byoInput("gmail-nosecret", [claudeFile]);
  const plan = await handleMcpCatalogPlan({ ...input, oauthClient: { clientId: CLIENT_ID, hasSecret: true } }, context);
  assert.equal(plan.ok, true);
  const result = await handleMcpCatalogInstall({ ...input, oauthClient: { clientId: CLIENT_ID, hasSecret: true }, planHash: plan.planHash } as never, context);
  assert.equal(result.ok, false);
  assert.match(result.message, /client secret/);
  assert.equal(runsSoFar(), runs);
});
