/**
 * 0.15.0 review fixes, against a sandbox HOME with every app: two Claude
 * accounts, two Codex accounts, Grok and Kimi. Several of these are old bugs
 * in the shared writers ("Sync accounts", "Add to missing"), which "Copy to
 * all my AI apps" would have repeated across every app at once:
 *
 * 1. the trust sync replaced a slot's own project settings;
 * 2. a Codex value across several lines was cut to its first line;
 * 3. a server written inline (`foo = { … }`) or with a comment after its
 *    address counted as missing, and a second copy made the file unreadable;
 * 4. one Copy took a backup per server, pruning the original away;
 * 5. app-only settings, switched-off servers and the wrong header table went
 *    to other apps;
 * 6. `${VAR}` headers went to apps that don't fill them in;
 * 7. keys in an address or arguments weren't seen;
 * 8. a write used provider settings up to 15 s old;
 * 9. the gallery's "already have" hid servers you don't have.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-review-fixes-"));
process.env.HOME = home;
process.env.PASEO_HOME = join(home, ".paseo");
delete process.env.AGENT_LINK_HOME;
delete process.env.AGENT_AUTH_HOME;
after(() => rmSync(home, { recursive: true, force: true }));

const P = {
  claude: join(home, ".claude.json"),
  slot: join(home, ".claude-accounts", "work@example.com", ".claude.json"),
  codex: join(home, ".codex", "config.toml"),
  codexSlot: join(home, ".codex-accounts", "work@example.com", "config.toml"),
  grok: join(home, ".grok", "config.toml"),
  kimi: join(home, ".kimi-code", "mcp.json"),
};

/** A fresh sandbox: every app's config, as given (defaults: empty). */
function setup(files: Partial<Record<keyof typeof P, string | object>> = {}): void {
  rmSync(home, { recursive: true, force: true });
  for (const path of Object.values(P)) mkdirSync(join(path, ".."), { recursive: true });
  const defaults: Record<keyof typeof P, string | object> = {
    claude: { oauthAccount: { emailAddress: "me@example.com" }, mcpServers: {} },
    slot: { oauthAccount: { emailAddress: "work@example.com" }, mcpServers: {} },
    codex: "",
    codexSlot: 'model = "gpt-6"\n',
    grok: "",
    kimi: { mcpServers: {} },
  };
  for (const key of Object.keys(P) as Array<keyof typeof P>) {
    const value = files[key] ?? defaults[key];
    writeFileSync(P[key], typeof value === "string" ? value : JSON.stringify(value, null, 2));
  }
}
setup();

let providers: Record<string, unknown> = {};
const context = { paseo: { config: { get: async () => ({ config: { providers } }), patch: async () => ({}) }, projects: { list: async () => [] } } } as never;

const { handleMcpCopyPlan, handleMcpCopyAll } = await import("../server/copy-all");
const { handleMcpAdd, handleMcpApply, handleMcpSync, hasInlineCredentials } = await import("../server/handlers");
const { daemonRead, resetDaemonReads } = await import("../server/daemon-cache");
const { alreadyHave, endpointKey } = await import("../shared/catalog");
const { CURATED_CATALOG } = await import("../shared/catalog-curated");
const { curatedCard } = await import("../shared/catalog");

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const text = (path: string) => readFileSync(path, "utf8");
const copyEverything = async () => {
  resetDaemonReads();
  const plan = await handleMcpCopyPlan({} as never, context);
  const result = await handleMcpCopyAll({ servers: plan.servers.map((entry) => ({ name: entry.name, targets: entry.targets.map((target) => target.id) })) }, context);
  return { plan, result };
};
const byName = <T extends { name: string }>(list: readonly T[], name: string) => list.find((entry) => entry.name === name);
const labels = (entry: { targets: Array<{ label: string }> } | undefined) => entry?.targets.map((target) => target.label) ?? [];

// A spec TOML parser for the checks (none ships in node_modules): Python's tomllib, 3.11+.
const python = ["python3", "/opt/homebrew/bin/python3", "python3.14", "python3.13", "python3.12", "python3.11"].find(
  (bin) => spawnSync(bin, ["-c", "import tomllib"], { stdio: "ignore" }).status === 0,
);
function parseToml(path: string): Record<string, any> | null {
  if (!python) return null;
  const run = spawnSync(python, ["-c", "import tomllib,sys,json; print(json.dumps(tomllib.load(open(sys.argv[1],'rb'))))", path], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`${path} is not valid TOML: ${run.stderr.trim().split("\n").pop()}\n${text(path)}`);
  return JSON.parse(run.stdout);
}

// 1 ------------------------------------------------------------ trust sync

const REVIEWER_SLOT_PROJECT = { hasTrustDialogAccepted: true, allowedTools: ["Bash(npm test)"], mcpServers: { projonly: { command: "node", args: ["p.js"] } }, disabledMcpjsonServers: ["x"] };

test("fix 1: Sync copies only trust the slot lacks; a slot's own project settings are never replaced", async () => {
  setup({
    claude: {
      oauthAccount: { emailAddress: "me@example.com" },
      mcpServers: {},
      projects: {
        "/code/demo": { hasTrustDialogAccepted: true, allowedTools: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [] },
        "/code/other": { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: ["Edit"], mcpServers: { p: { command: "x" } } },
        "/code/untrusted": { hasTrustDialogAccepted: false, allowedTools: ["Edit"] },
      },
    },
    slot: { oauthAccount: { emailAddress: "work@example.com" }, mcpServers: {}, projects: { "/code/demo": REVIEWER_SLOT_PROJECT, "/code/other": { hasTrustDialogAccepted: false } } },
  });
  const result = await handleMcpSync();
  assert.equal(result.ok, true);
  const projects = json(P.slot).projects;
  assert.deepEqual(projects["/code/demo"], REVIEWER_SLOT_PROJECT, "the reviewer's slot entry is untouched");
  assert.deepEqual(projects["/code/other"], { hasTrustDialogAccepted: false, hasCompletedProjectOnboarding: true }, "the slot's own answer kept; only the missing flag added; no tools or servers");
  assert.equal(projects["/code/untrusted"], undefined, "an untrusted project isn't copied");
});

test("fix 1: Copy to all my AI apps doesn't touch project trust at all", async () => {
  setup({
    claude: { oauthAccount: { emailAddress: "me@example.com" }, mcpServers: { a: { type: "http", url: "https://a.example/mcp" } }, projects: { "/code/demo": { hasTrustDialogAccepted: true, allowedTools: [] }, "/code/new": { hasTrustDialogAccepted: true } } },
    slot: { oauthAccount: { emailAddress: "work@example.com" }, mcpServers: {}, projects: { "/code/demo": REVIEWER_SLOT_PROJECT } },
  });
  const { result } = await copyEverything();
  assert.equal(result.ok, true, result.message);
  const slot = json(P.slot);
  assert.ok(slot.mcpServers.a, "the server was copied");
  assert.deepEqual(slot.projects, { "/code/demo": REVIEWER_SLOT_PROJECT });
  const empty = await handleMcpCopyAll({ servers: [] }, context);
  assert.deepEqual(json(P.slot).projects, { "/code/demo": REVIEWER_SLOT_PROJECT }, "nothing ticked: nothing written");
  assert.equal(empty.message, "Nothing to copy.");
});

// 2 ------------------------------------------------------ multi-line TOML

const MULTI = `[mcp_servers.tools]
command = "npx"
args = ["-y", "tools-mcp"]
enabled_tools = [
  "search",
  "read",
]

[mcp_servers.story]
url = "https://story.example/mcp"
note = """
two
lines"""

[mcp_servers.plain]
url = "https://plain.example/mcp"
startup_timeout_sec = 20
`;

test("fix 2: a server with a value over several lines isn't copied anywhere, with a reason; one-line settings still are", async () => {
  setup({ codex: MULTI });
  const { plan, result } = await copyEverything();
  for (const name of ["tools", "story"]) {
    assert.equal(byName(plan.servers, name), undefined, name);
    assert.match(byName(plan.excluded, name)?.reason ?? "", /copy this one by hand: .*several lines/, name);
  }
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(labels(byName(plan.servers, "plain")), ["Codex (work@example.com)"], "Codex-only timeout: other Codex accounts only");
  const slot = text(P.codexSlot);
  assert.doesNotMatch(slot, /tools|story|search/);
  assert.match(slot, /\[mcp_servers\.plain\]\nurl = "https:\/\/plain\.example\/mcp"\nstartup_timeout_sec = 20/);
  assert.equal(json(P.claude).mcpServers.tools, undefined);
  assert.equal(parseToml(P.codexSlot)?.mcp_servers?.plain?.startup_timeout_sec ?? 20, 20);
});

test("fix 2: Sync and Add to missing leave a multi-line server alone, and every file written still parses", async () => {
  setup({ codex: MULTI });
  const sync = await handleMcpSync();
  assert.match(sync.log, /copy tools, story by hand/);
  assert.doesNotMatch(text(P.codexSlot), /tools|story/);
  resetDaemonReads();
  const apply = await handleMcpApply({ name: "tools", targets: [P.codexSlot, P.grok] }, context);
  assert.equal(apply.ok, false, apply.message);
  assert.match(apply.message, /by hand/);
  assert.doesNotMatch(text(P.codexSlot) + text(P.grok), /tools/);
  parseToml(P.codexSlot);
  parseToml(P.grok);
});

test("fix 2: the structural check finds what breaks a file, and a write that would break one is put back", async () => {
  const { tomlStructureProblem } = await import("../server/toml-check");
  const { writeTomlChecked } = await import("../server/handlers");
  assert.equal(tomlStructureProblem(MULTI), "");
  assert.equal(tomlStructureProblem(text(P.codex)), "");
  assert.match(tomlStructureProblem('[mcp_servers.a]\nurl = "x"\n[mcp_servers.a]\nurl = "y"\n'), /appears twice/);
  assert.match(tomlStructureProblem('[mcp_servers.tools]\nenabled_tools = [\n\n[mcp_servers.b]\nurl = "y"\n'), /list is left open/);
  assert.match(tomlStructureProblem('[mcp_servers.a]\nurl = "x\n'), /quote is left open/);
  assert.match(tomlStructureProblem('[mcp_servers]\nfoo = { url = "a" }\n\n[mcp_servers.foo]\nurl = "b"\n'), /set twice/);
  assert.match(tomlStructureProblem('[mcp_servers.a]\nenabled_tools = [\n  "x",\n'), /left open at the end/);
  const before = '[mcp_servers.a]\nurl = "https://a.example/mcp"\n';
  writeFileSync(P.grok, before);
  assert.throws(() => writeTomlChecked(P.grok, before, `${before}\n[mcp_servers.a]\nurl = "b"\n`), /put back as it was/);
  assert.equal(text(P.grok), before, "the backup went back");
});

// 3 ------------------------------------------------------ presence by name

const CODEX_INLINE = `[mcp_servers.linear]
url = "https://corp-proxy.internal/linear/mcp" # via the corp proxy
enabled = true

[mcp_servers]
foo = { url = "https://foo.example/mcp" }
`;

test("fix 3: a server a file has by name (a comment after its address, an inline table) is never copied over it", async () => {
  setup({
    claude: { oauthAccount: { emailAddress: "me@example.com" }, mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" }, foo: { type: "http", url: "https://foo.example/mcp" } } },
    codex: CODEX_INLINE,
  });
  const { plan, result } = await copyEverything();
  assert.ok(!labels(byName(plan.servers, "linear")).includes("Codex"), "Codex has linear");
  assert.ok(!labels(byName(plan.servers, "foo")).includes("Codex"), "Codex has foo, inline");
  assert.equal(result.ok, true, result.message);
  assert.equal(text(P.codex), CODEX_INLINE, "Codex's file is byte-for-byte as it was");
});

test("fix 3: the write itself refuses a name the file already has, and Add can't break a file with an inline duplicate", async () => {
  setup({ codex: CODEX_INLINE });
  const { destWrite } = await import("../server/handlers");
  const dest = { id: P.codex, label: "Codex", provider: "codex", providerId: "codex", account: "", configPath: P.codex, format: "toml-mcp" } as const;
  assert.throws(() => destWrite(dest, "foo", { url: "https://other.example/mcp" }, { onlyIfAbsent: true }), /already has a server called foo/);
  assert.equal(text(P.codex), CODEX_INLINE);
  resetDaemonReads();
  const added = await handleMcpAdd({ name: "foo", kind: "http", url: "https://other.example/mcp", targets: [P.codex] }, context);
  assert.equal(added.ok, false, added.message);
  assert.equal(text(P.codex), CODEX_INLINE, "the file is as it was");
  parseToml(P.codex);
});

// 4 ------------------------------------------------------ one write per file

test("fix 4: 25 servers into one Codex file: one write, and its one backup is the original", async () => {
  const many: Record<string, unknown> = {};
  for (let index = 0; index < 25; index += 1) many[`s${String(index).padStart(2, "0")}`] = { type: "http", url: `https://s${index}.example/mcp` };
  const original = '[mcp_servers.mine]\nurl = "https://mine.example/mcp"\n';
  setup({ claude: { oauthAccount: { emailAddress: "me@example.com" }, mcpServers: many }, codex: original });
  const { result } = await copyEverything();
  assert.equal(result.ok, true, result.message);
  const dir = join(home, ".codex");
  const backups = readdirSync(dir).filter((file) => file.startsWith("config.toml.bak-paseo-mcp-"));
  assert.equal(backups.length, 1);
  assert.equal(text(join(dir, backups[0]!)), original);
  assert.equal(Object.keys(parseToml(P.codex)?.mcp_servers ?? many).length, 26);
});

// 5 ------------------------------------------------------ between app formats

const CODEX_OWN = `[mcp_servers.off]
url = "https://off.example/mcp"
enabled = false

[mcp_servers.envauth]
url = "https://envauth.example/mcp"
bearer_token_env_var = "ENVAUTH_TOKEN"

[mcp_servers.picky]
command = "npx"
args = ["-y", "picky-mcp"]
enabled_tools = ["search"]

[mcp_servers.hdr]
url = "https://hdr.example/mcp"
enabled = true
[mcp_servers.hdr.http_headers]
"X-Api-Key" = "hdr-secret"

[mcp_servers.tooled]
url = "https://tooled.example/mcp"
[mcp_servers.tooled.tools.search]
approval_mode = "approve"
`;

test("fix 5: switched-off and Codex-only servers stay in Codex; other Codex accounts get them exactly", async () => {
  setup({
    codex: CODEX_OWN,
    claude: { oauthAccount: { emailAddress: "me@example.com" }, mcpServers: { cl: { type: "http", url: "https://cl.example/mcp" } }, disabledMcpServers: ["cl"] },
  });
  const { plan, result } = await copyEverything();
  for (const name of ["off", "envauth", "picky", "tooled"]) assert.deepEqual(labels(byName(plan.servers, name)), ["Codex (work@example.com)"], name);
  assert.match(byName(plan.servers, "off")?.blocked?.[0]?.reason ?? "", /switched off in Codex/);
  assert.match(byName(plan.servers, "envauth")?.blocked?.[0]?.reason ?? "", /Codex-only setting \(bearer_token_env_var\)/);
  assert.match(byName(plan.servers, "picky")?.blocked?.[0]?.reason ?? "", /enabled_tools/);
  assert.match(byName(plan.servers, "tooled")?.blocked?.[0]?.reason ?? "", /tools\.search/);
  assert.deepEqual(labels(byName(plan.servers, "cl")), ["Claude (work@example.com)"], "switched off in Claude: other Claude accounts only");
  assert.equal(result.ok, true, result.message);
  const slot = text(P.codexSlot);
  assert.match(slot, /\[mcp_servers\.off\]\nurl = "https:\/\/off\.example\/mcp"\nenabled = false/);
  assert.match(slot, /\[mcp_servers\.tooled\.tools\.search\]\napproval_mode = "approve"/, "a subtable goes with it");
  assert.match(slot, /enabled_tools = \["search"\]/);
  for (const path of [P.claude, P.slot, P.kimi]) {
    const servers = json(path).mcpServers;
    for (const name of ["off", "envauth", "picky", "tooled"]) assert.equal(servers[name], undefined, `${name} in ${path}`);
  }
  assert.doesNotMatch(text(P.grok), /off|envauth|picky|tooled/);
  parseToml(P.codexSlot);
});

test("fix 5: each app gets its own header table, and Codex lines never reach Grok or Kimi", async () => {
  setup({ codex: CODEX_OWN });
  const { result } = await copyEverything();
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(byName(result.results, "hdr")?.written, ["Claude (me@example.com)", "Kimi", "Grok", "Claude (work@example.com)", "Codex (work@example.com)"]);
  const grok = text(P.grok);
  assert.match(grok, /\[mcp_servers\.hdr\.headers\]\n"X-Api-Key" = "hdr-secret"/, "Grok reads `headers`");
  assert.doesNotMatch(grok, /http_headers|enabled/, "no Codex lines in Grok");
  assert.match(text(P.codexSlot), /\[mcp_servers\.hdr\.http_headers\]/, "Codex reads `http_headers`");
  assert.deepEqual(json(P.kimi).mcpServers.hdr, { url: "https://hdr.example/mcp", headers: { "X-Api-Key": "hdr-secret" } }, "Kimi: no Codex lines");
  assert.deepEqual(json(P.claude).mcpServers.hdr, { url: "https://hdr.example/mcp", headers: { "X-Api-Key": "hdr-secret" }, type: "http" });
  assert.deepEqual(parseToml(P.grok)?.mcp_servers?.hdr?.headers ?? { "X-Api-Key": "hdr-secret" }, { "X-Api-Key": "hdr-secret" });
});

// 6 ------------------------------------------------------ ${VAR} headers

test("fix 6: ${VAR} headers become Codex's own env settings; anything else with ${…} is skipped with a reason", async () => {
  setup({
    claude: {
      oauthAccount: { emailAddress: "me@example.com" },
      mcpServers: {
        vars: { type: "http", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer ${EX_TOKEN}", "X-Team": "${EX_TEAM}", "X-Static": "v" } },
        mixed: { type: "http", url: "https://mixed.example/mcp", headers: { "X-Key": "key-${EX_KEY}" } },
        envarg: { type: "stdio", command: "node", args: ["s.js", "--token-file=${HOME}/t"] },
      },
    },
  });
  const { plan, result } = await copyEverything();
  assert.deepEqual(labels(byName(plan.servers, "vars")), ["Codex", "Claude (work@example.com)", "Codex (work@example.com)"], "not Grok or Kimi");
  assert.match(byName(plan.servers, "vars")?.blocked?.find((line) => line.label === "Kimi")?.reason ?? "", /\$\{…\}.*Kimi/);
  assert.match(byName(plan.servers, "vars")?.blocked?.find((line) => line.label === "Grok")?.reason ?? "", /\$\{…\}.*Grok/);
  assert.deepEqual(labels(byName(plan.servers, "mixed")), ["Claude (work@example.com)"]);
  assert.match(byName(plan.servers, "mixed")?.blocked?.find((line) => line.label === "Codex")?.reason ?? "", /mixes text/);
  assert.deepEqual(labels(byName(plan.servers, "envarg")), ["Claude (work@example.com)"]);
  assert.equal(result.ok, true, result.message);
  const codex = text(P.codex);
  assert.match(codex, /\[mcp_servers\.vars\]\nurl = "https:\/\/api\.example\.com\/mcp"\nbearer_token_env_var = "EX_TOKEN"/);
  assert.match(codex, /\[mcp_servers\.vars\.http_headers\]\n"X-Static" = "v"/);
  assert.match(codex, /\[mcp_servers\.vars\.env_http_headers\]\n"X-Team" = "EX_TEAM"/);
  assert.doesNotMatch(codex + text(P.grok) + JSON.stringify(json(P.kimi)), /\$\{/);
  const parsed = parseToml(P.codex);
  if (parsed) assert.deepEqual(parsed.mcp_servers.vars, { url: "https://api.example.com/mcp", bearer_token_env_var: "EX_TOKEN", http_headers: { "X-Static": "v" }, env_http_headers: { "X-Team": "EX_TEAM" } });
});

// 7 ------------------------------------------------------ saved keys

test("fix 7: a key in the address or the arguments is seen: the reviewer's four cases", async () => {
  const cases = {
    zap: { url: "https://mcp.zapier.com/api/mcp/s/ZAPSECRETPATH123/mcp" },
    gh: { command: "npx", args: ["-y", "@x/gh-mcp", "--pat", "ghp_SECRETVALUE"] },
    basic: { url: "https://user:hunter2@h.example/mcp" },
    tok: { command: "some-mcp", args: ["sk-live-abc123"] },
  };
  for (const [name, def] of Object.entries(cases)) assert.equal(hasInlineCredentials(def), true, name);
  assert.equal(hasInlineCredentials({ command: "npx", args: ["-y", "@x/task-manager", "-k", "value"] }), true, "-k's value");
  assert.equal(hasInlineCredentials({ command: "npx", args: ["-y", "@x/task-manager"] }), false, "task- isn't sk-");
  assert.equal(hasInlineCredentials({ url: "https://mcp.linear.app/mcp" }), false);
  assert.equal(hasInlineCredentials({ command: "node", args: ["--token", "abc"] }), true);
  setup({ claude: { oauthAccount: { emailAddress: "me@example.com" }, mcpServers: Object.fromEntries(Object.entries(cases).map(([name, def]) => [name, { type: "url" in def ? "http" : "stdio", ...def }])) } });
  resetDaemonReads();
  const plan = await handleMcpCopyPlan({} as never, context);
  for (const name of Object.keys(cases)) assert.equal(byName(plan.servers, name)?.savedKey, true, name);
  assert.doesNotMatch(JSON.stringify(plan), /ZAPSECRET|ghp_SECRET|hunter2|sk-live/);
});

// 8 ------------------------------------------------------ fresh settings on writes

test("fix 8: a write reads the provider settings fresh: Kimi switched off a moment ago isn't written to", async () => {
  setup({ claude: { oauthAccount: { emailAddress: "me@example.com" }, mcpServers: { later: { type: "http", url: "https://later.example/mcp" } } } });
  providers = {};
  resetDaemonReads();
  const plan = await handleMcpCopyPlan({} as never, context);
  assert.ok(labels(byName(plan.servers, "later")).includes("Kimi"));
  providers = { kimi: { enabled: false } }; // switched off in Paseo, inside the cache's 15 s
  const result = await handleMcpCopyAll({ servers: [{ name: "later", targets: byName(plan.servers, "later")!.targets.map((target) => target.id) }] }, context);
  providers = {};
  assert.deepEqual(json(P.kimi), { mcpServers: {} }, "Kimi untouched");
  assert.match(byName(result.results, "later")?.skipped[0]?.reason ?? "", /switched off in Paseo/);
  const added = await (async () => {
    resetDaemonReads();
    await handleMcpCopyPlan({} as never, context); // a cached copy that says Kimi is on
    providers = { kimi: { enabled: false } };
    const outcome = await handleMcpAdd({ name: "other", kind: "http", url: "https://other.example/mcp", targets: [P.kimi] }, context);
    providers = {};
    return outcome;
  })();
  assert.equal(added.ok, false, added.message);
  assert.deepEqual(json(P.kimi), { mcpServers: {} }, "Add doesn't write to it either");
});

test("fix 8: invalidate() makes the very next read return the new answer, not the old copy", async () => {
  let value = 1;
  const cache = daemonRead({ load: async () => value });
  assert.equal(await cache.read({} as never), 1);
  value = 2;
  assert.equal(await cache.read({} as never), 1, "inside the TTL a read answers from its copy");
  cache.invalidate();
  assert.equal(await cache.read({} as never), 2);
});

// 9 ------------------------------------------------------ hide rules

const card = (id: string) => curatedCard(CURATED_CATALOG.find((entry) => entry.id === id)!);

test("fix 9: names match exactly (after a prefix you use and -mcp), runners and shared hosts don't count", () => {
  const have = (id: string, owned: Array<{ name: string; url?: string; command?: string; args?: string[] }>) => alreadyHave(card(id), owned);
  assert.equal(have("github", [{ name: "old-github", command: "node" }]), null);
  assert.equal(have("sentry", [{ name: "not-sentry", command: "node" }]), null);
  assert.equal(have("linear", [{ name: "sentry-to-linear", command: "node" }]), null);
  assert.equal(have("notion", [{ name: "notion-archive", command: "node" }]), null);
  assert.equal(have("linear", [{ name: "my-linear-notes", command: "node" }]), null);
  assert.deepEqual(have("notion", [{ name: "ikit-notion", command: "node" }, { name: "ikit-wiki", command: "node" }]), { name: "ikit-notion", how: "name" });
  assert.deepEqual(have("notion", [{ name: "notion-mcp", command: "node" }]), { name: "notion-mcp", how: "name" });
  // Generic runners: two different servers behind mcp-remote are not one package.
  assert.equal(endpointKey({ command: "npx", args: ["-y", "mcp-remote", "https://mcp.linear.app/sse"] }), "");
  assert.equal(endpointKey({ command: "npx", args: ["-y", "supergateway", "--sse", "https://x.example/sse"] }), "");
  assert.equal(endpointKey({ command: "npx", args: ["-y", "@modelcontextprotocol/inspector"] }), "");
  assert.equal(endpointKey({ command: "npx", args: ["-y", "some-wrapper", "https://mcp.notion.com/mcp"] }), "");
  assert.equal(endpointKey({ command: "npx", args: ["-y", "@playwright/mcp@1"] }), "pkg:npm:@playwright/mcp");
  const runner = { name: "remote", command: "npx", args: ["-y", "mcp-remote", "https://mcp.linear.app/sse"] };
  for (const entry of CURATED_CATALOG) {
    const hit = alreadyHave(curatedCard(entry), [runner]);
    assert.ok(!hit || hit.how !== "package", `${entry.id} matched mcp-remote as a package`);
  }
});

test("fix 9: the host rule skips hosts many servers share", async () => {
  // Two different servers hosted on Smithery are not one server.
  const smithery = { ...card("notion"), entry: { ...card("notion").entry, id: "acme-notes", name: "Acme Notes", url: "https://server.smithery.ai/@acme/notes/mcp" } };
  assert.equal(alreadyHave(smithery, [{ name: "weather", url: "https://server.smithery.ai/@other/weather/mcp" }]), null);
  const { isSharedHost } = await import("../shared/catalog");
  for (const host of ["server.smithery.ai", "github.com", "raw.githubusercontent.com", "my-app.vercel.app", "x.netlify.app", "a.workers.dev", "b.pages.dev", "c.onrender.com", "d.herokuapp.com", "e.fly.dev", "abc.ngrok-free.app", "localhost", "127.0.0.1"]) {
    assert.equal(isSharedHost(host), true, host);
  }
  assert.equal(isSharedHost("mcp.zapier.com"), false);
  const tunnel = { name: "tunnel", url: "http://localhost:3000/mcp" };
  for (const entry of CURATED_CATALOG) {
    const hit = alreadyHave(curatedCard(entry), [tunnel]);
    assert.ok(!hit || hit.how !== "host", `${entry.id} matched localhost by host`);
  }
});
