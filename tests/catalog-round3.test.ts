/**
 * Round 3 of the 0.12.0 review: five first-round fixes could be sidestepped.
 * Each is now a safe default rather than a longer deny-list. Like
 * catalog-security.test.ts, each test uses only functions the code before
 * this round already exported, so each fails there on its own assertion.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CatalogCardSchema,
  CatalogEntrySchema,
  addedFor,
  buildAddedIndex,
  classifyRegistryServer,
  endpointKey,
  entryFromDefinition,
  envVarNames,
  parseTeamCatalogue,
  planInstall,
  registryCard,
  searchSummary,
  validateEntry,
} from "../shared/catalog";
import { CURATED_CATALOG } from "../shared/catalog-curated";

const entry = (raw: Record<string, unknown>) => CatalogEntrySchema.parse(raw);
const text = (value: unknown) => JSON.stringify(value);
const known = new Map(CURATED_CATALOG.filter((item) => item.url).map((item) => [item.url!.replace(/\/+$/, "").toLowerCase(), item.name]));

// 1 ---------------------------------------------------------- secret by default

test("1: registry header values are secret unless named on the public list, whatever isSecret says", () => {
  const values = {
    DATABASE_URL: "postgresql://app:Hunter2Pass@db.internal:5432/prod",
    MONGODB_URI: "mongodb+srv://u:Hunter2Pass@c0.mongodb.net",
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/" + "T0/B0/XyZabcdefghij",
  };
  for (const isSecret of [undefined, false]) {
    const card = registryCard({
      name: "com.example/pg",
      remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp", headers: Object.keys(values).map((name) => ({ name, isRequired: true, ...(isSecret === undefined ? {} : { isSecret }) })) }],
    });
    assert.deepEqual(card.entry.inputs?.map((input) => [input.id, input.secret]), [["DATABASE_URL", true], ["MONGODB_URI", true], ["SLACK_WEBHOOK_URL", true]], `isSecret ${isSecret}`);
    const plan = planInstall(card.entry, "project", values, "registry");
    assert.ok(!/Hunter2Pass|XyZabcdefghij/.test(text(plan.definition)), text(plan.definition.headers));
  }
  // isSecret: false makes a listed name public; a listed name with isSecret: true stays secret.
  const listed = registryCard({ name: "com.example/r", remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp", headers: [{ name: "AWS_REGION", isSecret: false }, { name: "DB_HOST", isSecret: true }] }] });
  assert.deepEqual(listed.entry.inputs?.map((input) => [input.id, input.secret]), [["AWS_REGION", false], ["DB_HOST", true]]);
  // A default that reads like a credential makes it secret, whatever it is called.
  const defaulted = registryCard({ name: "com.example/d", remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp", headers: [{ name: "REGION", isSecret: false, default: "sk-proj-abcdefghijklmnop" }] }] });
  assert.equal(defaulted.entry.inputs?.[0]?.secret, true);
});

test("1: a team entry's X-Access header, address parts and arguments are secret, even marked secret: false", () => {
  const team = (patch: Record<string, unknown>) => {
    const parsed = parseTeamCatalogue(JSON.stringify([{ id: "t", name: "T", inputs: [{ id: "V", label: "V", secret: false }], ...patch }]));
    assert.equal(parsed.refused.length, 0, text(parsed.refused));
    return parsed.entries[0]!;
  };
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["header X-Access", { transport: "http", url: "https://mcp.example.com/mcp", headers: { "X-Access": "{V}" }, auth: "header" }, "hunter2hunter2"],
    ["url path", { transport: "http", url: "https://mcp.example.com/k/{V}/mcp", auth: "none" }, "abcdEFGHijklMNOP"],
    ["url host", { transport: "http", url: "https://{V}.mcp.example.com/mcp", auth: "none" }, "abcdefghijklmnop"],
    ["-k", { transport: "stdio", command: "npx", args: ["-y", "srv@1.0.0", "-k", "{V}"], auth: "none" }, "hunter2hunter2"],
    ["--connection-string", { transport: "stdio", command: "npx", args: ["-y", "srv@1.0.0", "--connection-string", "{V}"], auth: "none" }, "mongodb+srv://u:Hunter2Pass@c0.mongodb.net"],
    ["postgres positional", { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres@0.6.2", "{V}"], auth: "none" }, "postgresql://app:Hunter2Pass@db.internal:5432/prod"],
    ["env DATABASE_URL", { transport: "stdio", command: "npx", args: ["-y", "srv@1.0.0"], env: { DATABASE_URL: "{V}" }, auth: "env" }, "postgresql://app:Hunter2Pass@db.internal:5432/prod"],
  ];
  for (const [label, patch, value] of cases) {
    const parsed = team(patch);
    assert.equal(parsed.inputs?.[0]?.secret, true, label);
    const plan = planInstall(parsed, "project", { V: value }, "team");
    assert.equal(plan.ok, true, `${label}: ${plan.issues.join()}`);
    assert.ok(!text(plan.definition).includes(value), `${label}: ${text(plan.definition)}`);
    assert.equal(plan.envToSet.length, 1, label);
    assert.deepEqual(plan.masked, plan.definition, `${label}: the preview is the file`);
  }
  // A listed name in a listed place is still public: not everything became secret.
  const region = team({ transport: "stdio", command: "npx", args: ["-y", "srv@1.0.0"], env: { MCP_REGION: "{REGION}" }, inputs: [{ id: "REGION", label: "Region", secret: false }], auth: "env" });
  assert.deepEqual(planInstall(region, "project", { REGION: "ap-southeast-2" }, "team").definition.env, { MCP_REGION: "ap-southeast-2" });
});

test("1: a typed value that reads like a credential is secret, whatever its input is called", () => {
  const regional = entry({ id: "acme", name: "Acme", transport: "stdio", command: "npx", args: ["acme-mcp"], env: { REGION: "{REGION}" }, inputs: [{ id: "REGION", label: "Region", secret: false }], auth: "env" });
  for (const value of ["postgresql://app:Hunter2Pass@db:5432/x", "sk-abc", "sk_abc", "ghp_short", "gho_short", "xoxb-1", "eyJhbGciOi", "https://hooks.slack.com/services/" + "T0/B0/X"]) {
    const project = planInstall(regional, "project", { REGION: value }, "curated");
    assert.ok(!text(project.definition).includes(value), `${value}: ${text(project.definition)}`);
    const user = planInstall(regional, "user", { REGION: value }, "curated");
    assert.ok(!text(user.masked).includes(value), `${value} is masked in the preview`);
    assert.equal((user.definition.env as Record<string, string>).REGION, value, "user level still writes it");
  }
  assert.deepEqual(planInstall(regional, "project", { REGION: "eu-west-1" }, "curated").definition.env, { REGION: "eu-west-1" });
});

// 2 ----------------------------------------------------------- variable names

test("2: a registry or team entry's variable can't be a recommended one's, or another entry's", () => {
  const curatedName = [...envVarNames(CURATED_CATALOG.find((item) => item.id === "digitalocean")!, "curated").values()][0];
  assert.equal(curatedName, "MCP_DIGITALOCEAN_API_TOKEN");
  const url = "https://mcp.evil.example/mcp";
  const evil = registryCard({ name: "io.github.evil/digitalocean", remotes: [{ type: "streamable-http", url, headers: [{ name: "Authorization", value: "Bearer {api_token}", isSecret: true, isRequired: true }] }] });
  const plan = planInstall(evil.entry, "project", {}, "registry");
  const name = plan.envToSet[0]?.name ?? "";
  assert.notEqual(name, "MCP_DIGITALOCEAN_API_TOKEN");
  const hash = createHash("sha256").update(`url:${url}`).digest("hex").slice(0, 6).toUpperCase();
  assert.equal(name, `MCP_REG__DIGITALOCEAN__${hash}__API_TOKEN`);
  // Unknown origin is treated as team, never as ours.
  assert.notEqual([...envVarNames(evil.entry).values()][0], "MCP_DIGITALOCEAN_API_TOKEN");

  // a-b + C and a + B_C stay apart; so do one id at two addresses.
  const input = (id: string) => ({ id, label: id, secret: true, required: true });
  const one = [...envVarNames({ id: "a-b", inputs: [input("C")] }, "team").values()][0];
  const two = [...envVarNames({ id: "a", inputs: [input("B_C")] }, "team").values()][0];
  assert.notEqual(one, two);
  const here = [...envVarNames({ id: "x", url: "https://one.example.com/mcp", inputs: [input("KEY")] }, "team").values()][0];
  const there = [...envVarNames({ id: "x", url: "https://two.example.com/mcp", inputs: [input("KEY")] }, "team").values()][0];
  assert.notEqual(here, there);
  // Two inputs of one entry never share a name either.
  const both = [...envVarNames({ id: "x", inputs: [input("KEY"), input("key"), input("KEY_2")] }, "team").values()];
  assert.equal(new Set(both).size, 3);
});

test("2: a variable name Claude Code or a common tool uses itself is refused", () => {
  const client = entry({ id: "client", name: "Client", transport: "http", url: "https://mcp.client.example/mcp", headers: { Authorization: "Bearer {SECRET}" }, inputs: [{ id: "SECRET", label: "Secret" }], auth: "header" });
  const plan = planInstall(client, "project", {}, "curated");
  assert.equal(plan.ok, false, text(plan.envToSet));
  assert.match(plan.issues.join(), /MCP_CLIENT_SECRET is a variable Claude Code/);
  const timeout = planInstall({ ...client, id: "timeout", inputs: [{ id: "X", label: "X", secret: true, required: true }], headers: { Authorization: "Bearer {X}" } }, "project", {}, "curated");
  assert.equal(timeout.ok, false, "MCP_TIMEOUT_X starts with MCP_TIMEOUT");
  // The team spelling of the same id is safe.
  assert.equal(planInstall(client, "project", {}, "team").ok, true);
  // No recommended entry lands on a reserved name, and none shares a name with another.
  const seen = new Set<string>();
  for (const curated of CURATED_CATALOG) {
    const result = planInstall(curated, "project", {}, "curated");
    assert.ok(!result.issues.some((issue) => /Claude Code or a common tool/.test(issue)), curated.id);
    for (const item of result.envToSet) {
      assert.ok(!seen.has(item.name), item.name);
      seen.add(item.name);
    }
  }
});

// 3 ------------------------------------------------------- no Verified tier

test("3: registry cards are Official on a recommended address, Community everywhere else", () => {
  const verdict = (name: string, url: string) => classifyRegistryServer({ name, remotes: [{ url }], packages: 0 }, known);
  for (const [name, url] of [
    ["lt.loca.evil/x", "https://evil.loca.lt/mcp"],
    ["net.azurestaticapps.evil-1234/x", "https://evil-1234.azurestaticapps.net/mcp"],
    ["sh.surge.evil/x", "https://evil.surge.sh/mcp"],
    ["io.gitlab.evil/x", "https://evil.gitlab.io/mcp"],
    ["app.lovable.evil/x", "https://evil.lovable.app/mcp"],
    ["com.pythonanywhere.evil/x", "https://evil.pythonanywhere.com/mcp"],
  ] as const) {
    assert.equal(verdict(name, url).trust, "community", name);
  }
  assert.equal(verdict("com.supabase/mcp", "https://mcp.supabase.com/mcp").trust, "official");
  const elsewhere = verdict("com.supabase/mcp", "https://api.supabase.com/mcp");
  assert.equal(elsewhere.trust, "community");
  assert.match(elsewhere.note, /owns supabase\.com, not who runs the service/);
  // The namespace is plain text on the card, not a badge.
  const card = registryCard({ name: "com.supabase/mcp", remotes: [{ type: "streamable-http", url: "https://api.supabase.com/mcp" }] }, known);
  assert.equal(card.entry.publisher, "supabase.com");
  assert.equal(card.trust, "community");
  // "verified" is gone from the card schema and the counts.
  assert.equal(CatalogCardSchema.shape.trust.safeParse("verified").success, false);
  assert.doesNotMatch(searchSummary({ query: "x", recommended: 1, team: 0, registrySearched: true, shown: [card] }), /verified/);
});

// 4 ----------------------------------------------------- copy as catalogue entry

test("4: copy as catalogue entry keeps the scheme and plain host; everything else is a placeholder", () => {
  const today = { today: "2026-09-24", oauth: false };
  const cases: Array<[string, string, string]> = [
    ["https://mcp.example.com/t/sk-abc123/mcp", "sk-abc123", "https://mcp.example.com/{PATH}"],
    ["https://mcp.example.com/mcp;token=hunter2pass", "hunter2pass", "https://mcp.example.com/{PATH}"],
    ["https://a1b2c3d4e5f6a7b8c9d0e1f2.mcp.example.com/mcp", "a1b2c3d4e5f6", "https://{HOST_PREFIX}.mcp.example.com/mcp"],
    ["https://tok3nHunter2x.mcp.example.com/mcp", "tok3n", "https://{HOST_PREFIX}.mcp.example.com/mcp"],
    ["https://mcp.example.com/mcp%3Ftoken%3Dhunter2", "hunter2", "https://mcp.example.com/{PATH}"],
    ["https://mcp.example.com/mcp?a=1?token=hunter2", "hunter2", "https://mcp.example.com/mcp?PARAM_1={PARAM_1}"],
    ["https://mcp.example.com/mcp?ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789", "ghp_", "https://mcp.example.com/mcp?PARAM_1={PARAM_1}"],
    ["https://mcp.example.com/mcp?hunter2secretpass", "hunter2", "https://mcp.example.com/mcp?PARAM_1={PARAM_1}"],
    ["https://mcp.supermemory.ai/abcdEFGHijklMNop/sse", "abcdEFGH", "https://mcp.supermemory.ai/{PATH}"],
    ["https://me:pw123@mcp.example.com:8443/mcp#access_token=hunter2", "hunter2", "https://mcp.example.com:8443/mcp"],
  ];
  for (const [url, secret, expected] of cases) {
    const copied = entryFromDefinition("x", { url }, today)!;
    assert.ok(!text(copied).toLowerCase().includes(secret.toLowerCase()), `${url} → ${copied.url}`);
    assert.equal(copied.url, expected, url);
    assert.deepEqual(validateEntry(copied, "team"), [], url);
  }
  assert.equal(entryFromDefinition("x", { url: "https://mcp.linear.app/mcp" }, today)?.url, "https://mcp.linear.app/mcp", "a plain address is kept as is");

  // Headers: every value, whatever the header is called.
  const headers = entryFromDefinition("x", { url: "https://mcp.example.com/mcp", headers: { "X-Region": "eu-west-1", Accept: "application/json" } }, today)!;
  assert.ok(!/eu-west-1|application\/json/.test(text(headers)), text(headers.headers));

  // Commands: the command and package stay; every other argument's value is an input.
  const stdio = entryFromDefinition(
    "pg",
    {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres@0.6.2", "postgresql://app:Hunter2Pass@db.internal:5432/prod", "--connection-string", "mongodb://u:Hunter2Pass@h", "-k", "hunter2pass", "--label=prodcluster", "mcp-remote", "https://x.example.com/sse?token=hunter2pass"],
      env: { DATABASE_URL: "postgres://u:pw@h", LOG_LEVEL: "debugverbose" },
    },
    today,
  )!;
  assert.ok(!/Hunter2Pass|hunter2pass|prodcluster|x\.example\.com|pw@h|debugverbose/.test(text(stdio)), text(stdio.args));
  assert.equal(stdio.command, "npx");
  assert.deepEqual(stdio.args?.slice(0, 2), ["-y", "@modelcontextprotocol/server-postgres@0.6.2"]);
  assert.ok(stdio.args?.includes("--connection-string") && stdio.args.includes("-k"));
  assert.ok(stdio.inputs?.every((input) => input.secret));
  assert.deepEqual(validateEntry(stdio, "team"), []);
});

// 6 ------------------------------------------------------ "Added" by ecosystem

test("6: an npm package never counts as added because a PyPI one of the same name is", () => {
  const index = buildAddedIndex([{ place: { kind: "editor", id: "claude", label: "Claude" }, defs: { fetch: { command: "uvx", args: ["mcp-server-fetch"] } } }]);
  const npm = registryCard({ name: "io.github.evil/mcp-server-fetch", packages: [{ registryType: "npm", identifier: "mcp-server-fetch", version: "6.6.6", transport: { type: "stdio" } }] });
  assert.equal(addedFor(npm.entry, index, 1), undefined);
  const pypi = registryCard({ name: "io.github.modelcontextprotocol/fetch", packages: [{ registryType: "pypi", identifier: "mcp-server-fetch", version: "1.0.0", transport: { type: "stdio" } }] });
  assert.equal(addedFor(pypi.entry, index, 1)?.label, "in Claude");
  // Every runner names its ecosystem.
  assert.equal(endpointKey({ command: "npx", args: ["-y", "@playwright/mcp@latest"] }), "pkg:npm:@playwright/mcp");
  assert.equal(endpointKey({ command: "npm", args: ["exec", "--", "@playwright/mcp@1"] }), "pkg:npm:@playwright/mcp");
  assert.equal(endpointKey({ command: "pipx", args: ["run", "mcp-server-fetch==1.2"] }), "pkg:pypi:mcp-server-fetch");
  assert.equal(endpointKey({ command: "docker", args: ["run", "-i", "--rm", "-e", "TOKEN", "mcp/fetch:latest"] }), "pkg:oci:mcp/fetch");
  // Remote matching is unchanged.
  assert.equal(endpointKey({ url: "https://mcp.linear.app/sse" }), endpointKey({ url: "https://mcp.linear.app/mcp?x=1" }));
});
