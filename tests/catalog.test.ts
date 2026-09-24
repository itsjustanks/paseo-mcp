import assert from "node:assert/strict";
import test from "node:test";
import {
  CatalogEntrySchema,
  addedFor,
  buildAddedIndex,
  endpointKey,
  PACKAGE_WARNING,
  RELAY_WARNING,
  REGISTRY_PACKAGE_REASON,
  budgetImpact,
  cardMatches,
  classifyRegistryServer,
  curatedCard,
  entryFromDefinition,
  envVarNames,
  latestRegistryServers,
  looksLikeSecret,
  nameClash,
  namespaceDomain,
  parseTeamCatalogue,
  planInstall,
  registrableDomain,
  registryCard,
  searchSummary,
  validateEntry,
  type CatalogEntry,
} from "../shared/catalog";
import { CURATED_CATALOG } from "../shared/catalog-curated";

const remote = (url: string) => ({ url });
const known = new Map(CURATED_CATALOG.filter((entry) => entry.url).map((entry) => [entry.url!.replace(/\/+$/, "").toLowerCase(), entry.name]));

// ------------------------------------------------------------------- trust

test("trust: the registry examples found on 2026-09-24", () => {
  // The real vendor entry: Official only because the Recommended shelf checked that address.
  const supabase = classifyRegistryServer({ name: "com.supabase/mcp", remotes: [remote("https://mcp.supabase.com/mcp")], packages: 1 }, known);
  assert.equal(supabase.trust, "official");
  assert.match(supabase.note, /recommended Supabase/);
  assert.equal(supabase.warning, "");
  // From the registry alone it proves the publisher owns supabase.com, no more: Community.
  const supabaseAlone = classifyRegistryServer({ name: "com.supabase/mcp", remotes: [remote("https://mcp.supabase.com/mcp")], packages: 1 });
  assert.equal(supabaseAlone.trust, "community");
  assert.match(supabaseAlone.note, /owns supabase\.com, not who runs the service/);

  const linear = classifyRegistryServer({ name: "app.linear/linear", remotes: [remote("https://mcp.linear.app/mcp")], packages: 0 }, known);
  assert.equal(linear.trust, "official");
  assert.equal(classifyRegistryServer({ name: "app.linear/linear", remotes: [remote("https://mcp.linear.app/mcp")], packages: 0 }).trust, "community");

  // A third party that owns its own domain: its own server, not Supabase's. Never "Official".
  const waystation = classifyRegistryServer({ name: "ai.waystation/supabase", remotes: [remote("https://waystation.ai/supabase/mcp")], packages: 0 }, known);
  assert.equal(waystation.trust, "community");
  assert.match(waystation.note, /owns waystation\.ai, not who runs the service/);

  // Smithery proxies: the namespace owns smithery.ai, but that is a relay anyone publishes through.
  const smithery = classifyRegistryServer({ name: "ai.smithery/MisterSandFR-supabase-mcp-selfhosted", remotes: [remote("https://server.smithery.ai/@MisterSandFR/supabase-mcp-selfhosted/mcp")], packages: 0 });
  assert.equal(smithery.trust, "community");
  assert.equal(smithery.warning, RELAY_WARNING);
  assert.match(smithery.note, /smithery\.ai/);

  // app.vercel.* is any *.vercel.app site, not Vercel.
  for (const [name, url] of [
    ["app.vercel.agent-svg-registry/mcp", "https://agent-svg-registry.vercel.app/api/mcp"],
    ["app.vercel.stripecheckup/stripecheckup", "https://stripecheckup.vercel.app/api/mcp"],
    ["app.vercel.ora-x402-gateway/sensations-mergulho", "https://ywabnlhkmhbyewqhbsjm.supabase.co/functions/v1/sensations-mergulho"],
  ] as const) {
    const verdict = classifyRegistryServer({ name, remotes: [remote(url)], packages: 0 });
    assert.equal(verdict.trust, "community", name);
    assert.match(verdict.note, /\.vercel\.app, not who runs the service/, name);
  }

  // io.github.* on workers.dev: a GitHub account, not a domain.
  const workers = classifyRegistryServer({ name: "io.github.sadri-dridi/supabase-url-shape", remotes: [remote("https://agent-observatory-sensor.nolimit-observatory.workers.dev/s/supabase-url-shape/mcp")], packages: 0 });
  assert.equal(workers.trust, "community");
  assert.equal(workers.warning, RELAY_WARNING);
  assert.match(workers.note, /GitHub account sadri-dridi/);

  // A GitHub namespace on some other company's host.
  const mcpAi = classifyRegistryServer({ name: "io.github.mcp-dir/supabase-mcp", remotes: [remote("https://api.mcp.ai/p_supabase")], packages: 0 });
  assert.equal(mcpAi.trust, "community");

  // Published by one domain, served from another.
  const mismatch = classifyRegistryServer({ name: "com.example/thing", remotes: [remote("https://mcp.other.io/mcp")], packages: 0 });
  assert.equal(mismatch.trust, "community");
  assert.match(mismatch.note, /owns example\.com, not who runs the service/);
});

test("trust: io.github.* counts as official only on an endpoint the Recommended shelf checked", () => {
  const github = classifyRegistryServer({ name: "io.github.github/github-mcp-server", remotes: [remote("https://api.githubcopilot.com/mcp/")], packages: 0 }, known);
  assert.equal(github.trust, "official");
  assert.match(github.note, /recommended GitHub/);
  const unknown = classifyRegistryServer({ name: "io.github.github/github-mcp-server", remotes: [remote("https://api.githubcopilot.com/mcp/")], packages: 0 });
  assert.equal(unknown.trust, "community");
});

test("trust: packages say they run code here", () => {
  const community = classifyRegistryServer({ name: "io.github.toolwright-adk/linear-bootstrap", remotes: [], packages: 1 });
  assert.equal(community.trust, "community");
  assert.equal(community.warning, PACKAGE_WARNING);
  const owned = classifyRegistryServer({ name: "com.supabase/mcp", remotes: [], packages: 1 });
  assert.equal(owned.trust, "community", "a package is never official: no address to check");
  assert.equal(owned.warning, PACKAGE_WARNING);
});

test("domains: registrable domain, namespaces", () => {
  assert.equal(registrableDomain("mcp.supabase.com"), "supabase.com");
  assert.equal(registrableDomain("api.example.co.uk"), "example.co.uk");
  assert.equal(namespaceDomain("app.vercel.foo"), "foo.vercel.app");
  assert.equal(namespaceDomain("com.supabase"), "supabase.com");
});

// ---------------------------------------------------------------- registry

const item = (name: string, version: string, isLatest: boolean, server: Record<string, unknown> = {}, publishedAt = "2025-09-18T00:00:00Z") => ({
  server: { name, version, description: `${name} server`, ...server },
  _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest, publishedAt } },
});

test("registry: latest only, one per name", () => {
  const body = {
    servers: [
      item("com.supabase/mcp", "0.12.0", false, { remotes: [{ type: "streamable-http", url: "https://mcp.supabase.com/mcp" }] }),
      item("com.supabase/mcp", "0.13.0", true, { remotes: [{ type: "streamable-http", url: "https://mcp.supabase.com/mcp" }] }),
      item("ai.smithery/pinion05-supabase-mcp-lite", "0.0.1", false),
      item("ai.smithery/pinion05-supabase-mcp-lite", "1.0.0", true),
      item("ai.smithery/pinion05-supabase-mcp-lite", "1.0.0", true, {}, "2024-01-01T00:00:00Z"),
      { server: { name: "gone/x" }, _meta: { "io.modelcontextprotocol.registry/official": { status: "deleted", isLatest: true } } },
    ],
  };
  const latest = latestRegistryServers(body);
  assert.deepEqual(latest.map((server) => `${server.name}@${server.version}`).sort(), ["ai.smithery/pinion05-supabase-mcp-lite@1.0.0", "com.supabase/mcp@0.13.0"]);
  assert.deepEqual(latestRegistryServers(null), []);
});

test("registry: a Smithery remote becomes a card with a masked key input and a warning", () => {
  const [server] = latestRegistryServers({
    servers: [
      item("ai.smithery/MisterSandFR-supabase-mcp-selfhosted", "1.14.1", true, {
        remotes: [{ type: "streamable-http", url: "https://server.smithery.ai/@MisterSandFR/supabase-mcp-selfhosted/mcp", headers: [{ name: "Authorization", description: "Bearer token for Smithery authentication", isRequired: true, isSecret: true, value: "Bearer {smithery_api_key}" }] }],
      }),
    ],
  });
  const card = registryCard(server!);
  assert.equal(card.trust, "community");
  assert.equal(card.warning, RELAY_WARNING);
  assert.equal(card.installable, true);
  assert.equal(card.entry.auth, "header");
  assert.deepEqual(card.entry.headers, { Authorization: "Bearer {smithery_api_key}" });
  assert.deepEqual(card.entry.inputs?.map((input) => [input.id, input.secret, input.required]), [["smithery_api_key", true, true]]);
});

test("registry: packages are shown, not added; what cannot be filled in is not installable", () => {
  const card = registryCard({ name: "com.supabase/mcp", version: "0.13.0", packages: [{ registryType: "npm", identifier: "@supabase/mcp-server-supabase", version: "0.13.0", transport: { type: "stdio" }, environmentVariables: [{ name: "SUPABASE_ACCESS_TOKEN", isSecret: true, isRequired: true }] }] });
  assert.equal(card.installable, false);
  assert.equal(card.blockedReason, REGISTRY_PACKAGE_REASON);
  assert.equal(card.warning, "Runs code on this server.");
  // Named only so "Added" can find it; no env, no inputs to fill.
  assert.equal(card.entry.command, "npx");
  assert.deepEqual(card.entry.args, ["@supabase/mcp-server-supabase"]);
  assert.equal(card.entry.env, undefined);
  const oci = registryCard({ name: "io.github.x/y", packages: [{ registryType: "oci", identifier: "ghcr.io/x/y" }] });
  assert.equal(oci.installable, false);
  assert.equal(oci.blockedReason, REGISTRY_PACKAGE_REASON);
  const args = registryCard({ name: "io.github.x/z", packages: [{ registryType: "npm", identifier: "z", packageArguments: [{ isRequired: true }] }] });
  assert.equal(args.installable, false);
  const templated = registryCard({ name: "com.example/t", remotes: [{ type: "streamable-http", url: "https://{tenant}.example.com/mcp" }] });
  assert.equal(templated.installable, false);
  const plainHttp = registryCard({ name: "com.example/h", remotes: [{ type: "streamable-http", url: "http://mcp.example.com/mcp" }] });
  assert.equal(plainHttp.installable, false);
  assert.match(plainHttp.blockedReason, /https/);
});

// ----------------------------------------------------------------- curated

test("curated: every entry is valid, https, cites the vendor, and carries no secret", () => {
  assert.ok(CURATED_CATALOG.length >= 25 && CURATED_CATALOG.length <= 40, `${CURATED_CATALOG.length} entries`);
  const ids = new Set<string>();
  for (const entry of CURATED_CATALOG) {
    assert.ok(CatalogEntrySchema.safeParse(entry).success, entry.id);
    assert.deepEqual(validateEntry(entry, "curated"), [], entry.id);
    assert.ok(!ids.has(entry.id), `duplicate ${entry.id}`);
    ids.add(entry.id);
    if (entry.transport === "http") assert.ok(entry.url?.startsWith("https://"), entry.id);
    assert.ok(entry.docs.startsWith("https://"), entry.id);
    for (const value of [...Object.values(entry.headers ?? {}), ...Object.values(entry.env ?? {})]) {
      assert.match(value, /\{[A-Z_]+\}/, `${entry.id}: every credential value is a placeholder`);
      assert.equal(looksLikeSecret(value), false, entry.id);
    }
  }
  // The user's own vendor servers are on the shelf.
  for (const host of ["mcp.supabase.com", "mcp.vercel.com", "mcp.zapier.com", "mcp.jam.dev", "mcp.gleap.io", "mcp.airtable.com", "mcp.customer.io", "mcp.notion.com", "mcp.heroui.pro", "relume-library-mcp.relume.io", "mcp.justcall.host"]) {
    assert.ok(CURATED_CATALOG.some((entry) => entry.url?.includes(host)), host);
  }
  assert.ok(CURATED_CATALOG.some((entry) => entry.args?.includes("@digitalocean/mcp@latest")));
});

const good: CatalogEntry = {
  id: "acme",
  name: "Acme",
  publisher: "Acme",
  description: "",
  category: "developer",
  transport: "http",
  url: "https://mcp.acme.com/mcp",
  headers: { Authorization: "Bearer {ACME_TOKEN}" },
  inputs: [{ id: "ACME_TOKEN", label: "Token", secret: true, required: true }],
  auth: "header",
  docs: "https://acme.com/docs/mcp",
  verifiedAt: "2026-09-24",
};

test("validation: plain http, credentials in the URL, literal keys and loose placeholders are refused", () => {
  assert.deepEqual(validateEntry(good, "curated"), []);
  const bad = (patch: Partial<CatalogEntry>) => validateEntry({ ...good, ...patch }, "team");
  assert.match(bad({ url: "http://mcp.acme.com/mcp" }).join(), /https/);
  assert.match(bad({ url: "https://user:pass@mcp.acme.com/mcp" }).join(), /password/);
  assert.match(bad({ headers: { Authorization: "Bearer sk_" + "live_51Habcdefghijklmnop" }, inputs: [] }).join(), /literal key/);
  assert.match(bad({ headers: { Authorization: "Bearer abc123" }, inputs: [] }).join(), /literal key/);
  assert.match(bad({ url: "https://mcp.acme.com/mcp?api_key=abc123" }).join(), /literal key/);
  assert.match(bad({ url: "https://mcp.acme.com/a1b2c3d4e5f6g7h8i9j0k1l2m3n4/mcp" }).join(), /literal key/);
  assert.match(bad({ headers: { Authorization: "Bearer {OTHER}" } }).join(), /not in inputs/);
  assert.match(bad({ headers: {} }).join(), /never used/);
  assert.match(bad({ docs: "http://acme.com" }).join(), /docs/);
  assert.match(validateEntry({ ...good, docs: "" }, "curated").join(), /cite/);
  // A non-credential header may be literal.
  assert.deepEqual(bad({ headers: { Authorization: "Bearer {ACME_TOKEN}", "x-region": "eu" } }), []);
  // Command servers: args and env get the same treatment.
  const stdio: CatalogEntry = { ...good, transport: "stdio", url: undefined, headers: undefined, command: "npx", args: ["-y", "acme-mcp@1.0.0", "--api-key", "{ACME_TOKEN}"], auth: "none" };
  assert.deepEqual(validateEntry(stdio, "team"), []);
  assert.match(validateEntry({ ...stdio, args: ["-y", "acme-mcp@1.0.0", "--api-key", "hunter2"], inputs: [] }, "team").join(), /literal key/);
  assert.match(validateEntry({ ...stdio, args: ["-y", "acme-mcp@1.0.0", "--token=ghp_" + "abcdefghijklmnopqrstuvwxyz0123"], inputs: [] }, "team").join(), /literal key/);
  assert.match(validateEntry({ ...stdio, command: "npx -y acme" }, "team").join(), /arguments in args/);
});

// -------------------------------------------------------------------- team

test("team catalogue: good entries show, literal secrets are refused by id", () => {
  const text = JSON.stringify({
    entries: [
      { id: "n8n", name: "Team n8n", publisher: "InvestorKit", category: "automation", transport: "http", url: "https://n8n.example.ondigitalocean.app/mcp/abc", headers: { Authorization: "Bearer {N8N_TOKEN}" }, inputs: [{ id: "N8N_TOKEN", label: "n8n token" }], auth: "header" },
      { id: "leaky", name: "Leaky", transport: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc" }, auth: "header" },
      { id: "leaky-env", name: "Leaky env", transport: "stdio", command: "npx", args: ["x@1.0.0"], env: { API_KEY: "plaintext" }, auth: "env" },
      { id: "plain", name: "Plain http", transport: "http", url: "http://intranet/mcp", auth: "none" },
      { id: "n8n", name: "Duplicate", transport: "http", url: "https://mcp.example.com/mcp", auth: "oauth" },
      { name: "no id", transport: "http", url: "https://mcp.example.com/mcp", auth: "oauth" },
    ],
  });
  const parsed = parseTeamCatalogue(text);
  assert.equal(parsed.error, "");
  assert.deepEqual(parsed.entries.map((entry) => entry.id), ["n8n"]);
  assert.equal(parsed.entries[0]?.inputs?.[0]?.secret, true); // secret by default
  const reasons = Object.fromEntries(parsed.refused.map((entry) => [entry.id, entry.reason]));
  assert.match(reasons.leaky ?? "", /literal key/);
  assert.match(reasons["leaky-env"] ?? "", /literal key/);
  assert.match(reasons.plain ?? "", /https/);
  assert.match(reasons.n8n ?? "", /already uses this id/);
  assert.ok(reasons["#6"]);
  // No refused reason repeats the secret.
  assert.ok(!JSON.stringify(parsed.refused).includes("eyJhbGci"));
});

test("team catalogue: shapes and whole-file errors", () => {
  assert.equal(parseTeamCatalogue(JSON.stringify([good])).entries.length, 1);
  assert.match(parseTeamCatalogue("{nope").error, /not valid JSON/);
  assert.match(parseTeamCatalogue(JSON.stringify({ servers: [] })).error, /expected a list/);
  assert.match(parseTeamCatalogue("x".repeat(1024 * 1024 + 1)).error, /1 MB/);
});

// ----------------------------------------------------------------- install

test("install plan, user level: values fill the placeholders; the preview is masked", () => {
  const plan = planInstall(good, "user", { ACME_TOKEN: "tok_live_0123456789abcdef" });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.definition, { type: "http", url: "https://mcp.acme.com/mcp", headers: { Authorization: "Bearer tok_live_0123456789abcdef" } });
  assert.deepEqual(plan.masked.headers, { Authorization: "Bearer •••cdef" });
  assert.deepEqual(plan.envToSet, []);
  const missing = planInstall(good, "user", {});
  assert.equal(missing.ok, false);
  assert.match(missing.issues.join(), /Token is required/);
});

test("install plan, project: a secret becomes ${VAR} and is never written", () => {
  const plan = planInstall(good, "project", { ACME_TOKEN: "tok_live_0123456789abcdef" }, "curated");
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.definition, { type: "http", url: "https://mcp.acme.com/mcp", headers: { Authorization: "Bearer ${MCP_ACME_TOKEN}" } });
  assert.ok(!JSON.stringify(plan.definition).includes("tok_live"));
  assert.deepEqual(plan.envToSet, [{ name: "MCP_ACME_TOKEN", label: "Token" }]);
  assert.deepEqual(plan.masked, plan.definition, "a project preview is the file as written");
  // No value needed at all for a secret in project scope.
  assert.equal(planInstall(good, "project", {}).ok, true);

  // A non-secret input is written as typed; a secret stays a reference.
  const regional: CatalogEntry = {
    ...good,
    url: "https://{REGION}.acme.com/mcp",
    inputs: [...(good.inputs ?? []), { id: "REGION", label: "Region", secret: false, required: true }],
  };
  const both = planInstall(regional, "project", { REGION: "eu", ACME_TOKEN: "whatever" }, "curated");
  assert.equal(both.definition.url, "https://eu.acme.com/mcp");
  assert.equal(planInstall(regional, "project", {}, "curated").ok, false);

  // A public input holding a key: treated as secret, so the key stays out of the project file.
  const pathKey: CatalogEntry = { ...good, url: "https://mcp.acme.com/{WORKSPACE}/mcp", inputs: [...(good.inputs ?? []), { id: "WORKSPACE", label: "Workspace", secret: false, required: true }] };
  const leak = planInstall(pathKey, "project", { WORKSPACE: "sk_" + "live_51Habcdefghijklmnopqrstu" }, "curated");
  assert.ok(!JSON.stringify(leak.definition).includes("sk_live"));
  assert.equal(leak.definition.url, "https://mcp.acme.com/${MCP_ACME_WORKSPACE}/mcp");
  // The same at user level is fine (that is where keys belong), masked in the preview.
  const userKey = planInstall(pathKey, "user", { WORKSPACE: "sk_" + "live_51Habcdefghijklmnopqrstu", ACME_TOKEN: "t" }, "curated");
  assert.equal(userKey.ok, true);
  assert.ok(!JSON.stringify(userKey.masked).includes("sk_live"));
});

test("install plan: the plugin names every recommended variable MCP_<SERVER>_<INPUT>", () => {
  const input = (id: string) => ({ id, label: "k", secret: true, required: true });
  const names = (id: string, ids: string[]) => [...envVarNames({ id, inputs: ids.map(input) }, "curated").values()];
  assert.deepEqual(names("acme", ["api_key"]), ["MCP_ACME_API_KEY"]);
  assert.deepEqual(names("acme", ["ANTHROPIC_API_KEY"]), ["MCP_ACME_ANTHROPIC_API_KEY"]);
  assert.deepEqual(names("acme", ["NPM_TOKEN"]), ["MCP_ACME_NPM_TOKEN"]);
  // The server's name is not repeated, runs of odd characters collapse, and two inputs never share a name.
  assert.deepEqual(names("digitalocean", ["DIGITALOCEAN_API_TOKEN"]), ["MCP_DIGITALOCEAN_API_TOKEN"]);
  assert.deepEqual(names("my--odd__server", ["a__b"]), ["MCP_MY_ODD_SERVER_A_B"]);
  assert.deepEqual(names("acme", ["key", "KEY", "ACME_KEY"]), ["MCP_ACME_KEY", "MCP_ACME_KEY_2", "MCP_ACME_KEY_3"]);
});

test("install plan: an optional input left empty drops its header; stdio fills env", () => {
  const optional: CatalogEntry = { ...good, inputs: [{ id: "ACME_TOKEN", label: "Token", secret: true, required: false }] };
  const plan = planInstall(optional, "user", {});
  assert.equal(plan.ok, true);
  assert.equal(plan.definition.headers, undefined);
  const digitalocean = CURATED_CATALOG.find((entry) => entry.id === "digitalocean")!;
  const user = planInstall(digitalocean, "user", { DIGITALOCEAN_API_TOKEN: "dop_v1_0123456789abcdef0123" });
  assert.deepEqual(user.definition, { command: "npx", args: ["@digitalocean/mcp@latest"], env: { DIGITALOCEAN_API_TOKEN: "dop_v1_0123456789abcdef0123" } });
  assert.deepEqual(user.masked.env, { DIGITALOCEAN_API_TOKEN: "•••0123" });
  const project = planInstall(digitalocean, "project", {}, "curated");
  assert.deepEqual(project.definition.env, { DIGITALOCEAN_API_TOKEN: "${MCP_DIGITALOCEAN_API_TOKEN}" });
});

test("name clash: never the same name, first free suggestion", () => {
  assert.deepEqual(nameClash("supabase", ["linear"]), { clash: false, suggestion: "supabase" });
  assert.deepEqual(nameClash("supabase", ["supabase"]), { clash: true, suggestion: "supabase-2" });
  assert.deepEqual(nameClash("supabase", ["supabase", "supabase-2", "supabase-3"]), { clash: true, suggestion: "supabase-4" });
});

// ------------------------------------------------------------ copy as entry

test("copy as catalogue entry: nothing stored goes into the text, and it passes team validation", () => {
  const http = entryFromDefinition(
    "heroui-pro",
    { url: "https://mcp.heroui.pro/mcp?token=abc123secretvalue", headers: { "x-heroui-personal-token": "hp_live_0123456789abcdefghij", Authorization: "Bearer zzz" } },
    { today: "2026-09-24", oauth: false },
  )!;
  const text = JSON.stringify(http);
  for (const secret of ["abc123secretvalue", "hp_live_0123456789abcdefghij", "zzz"]) assert.ok(!text.includes(secret), secret);
  assert.equal(http.headers?.Authorization, "Bearer {AUTHORIZATION}");
  assert.equal(http.auth, "header");
  assert.equal(http.publisher, "heroui.pro");
  assert.deepEqual(validateEntry(http, "team"), []);

  const stdio = entryFromDefinition("do", { command: "npx", args: ["@digitalocean/mcp@1.3.0", "--api-key", "dop_v1_abcdef0123456789abcdef"], env: { DIGITALOCEAN_API_TOKEN: "dop_v1_abcdef0123456789abcdef", REGION: "syd1" } }, { today: "2026-09-24", oauth: false })!;
  assert.ok(!JSON.stringify(stdio).includes("dop_v1"));
  assert.ok(!JSON.stringify(stdio).includes("syd1"));
  assert.deepEqual(validateEntry(stdio, "team"), []);

  const oauth = entryFromDefinition("linear", { url: "https://mcp.linear.app/mcp" }, { today: "2026-09-24", oauth: true })!;
  assert.equal(oauth.auth, "oauth");
  assert.deepEqual(validateEntry(oauth, "team"), []);
});

// ------------------------------------------------------------------ search

test("search: words across name, publisher and description; the empty-state line says what was searched", () => {
  const cards = CURATED_CATALOG.map(curatedCard);
  assert.ok(cards.some((card) => cardMatches(card, "jira", "all")));
  assert.equal(cards.filter((card) => cardMatches(card, "", "design")).length, 3);
  assert.equal(
    searchSummary({ query: "jira", recommended: 31, team: 0, registrySearched: true, shown: [] }),
    "Searched the registry and 31 recommended servers for 'jira': 0 official, 0 community.",
  );
  const community = registryCard({ name: "io.github.x/jira", remotes: [{ type: "streamable-http", url: "https://jira-x.vercel.app/mcp" }] });
  assert.equal(
    searchSummary({ query: "jira", recommended: 31, team: 4, registrySearched: true, shown: [community, community, community] }),
    "Searched the registry, 31 recommended servers and 4 team servers for 'jira': 0 official, 0 team, 3 community.",
  );
});

test("budget line names the tier", () => {
  assert.match(budgetImpact("user", 3, "Claude"), /^Adds 1 server to every workspace for Claude; an agent there would load 3 user-level servers\.$/);
  assert.match(budgetImpact("user", 9, "Claude"), /getting heavy/);
  assert.match(budgetImpact("project", 17, "demo's .mcp.json"), /over budget/);
});

test("secret sniffing: keys are caught, paths and host names are not", () => {
  for (const secret of ["sk_" + "live_51Habcdefghijklmnop", "ghp_" + "abcdefghijklmnopqrstuvwxyz0123", "a1b2c3d4e5f6g7h8i9j0k1l2m3n4", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc", "dop_v1_0123456789abcdef0123"]) {
    assert.equal(looksLikeSecret(secret), true, secret);
  }
  for (const plain of ["/@pinion05/supabase-mcp-lite/mcp", "agent-observatory-sensor.nolimit-observatory.workers.dev", "https://github.com/upstash/context7", "relume-library-mcp.relume.io", "Bearer ", "@playwright/mcp@latest"]) {
    assert.equal(looksLikeSecret(plain), false, plain);
  }
});

// ------------------------------------------------------------------- added

test("added: matched on the endpoint, not the name", () => {
  // One server whatever it is called, with or without a trailing slash, query, credentials, or /mcp vs /sse.
  const notion = endpointKey({ url: "https://mcp.notion.com/mcp" });
  assert.equal(notion, "url:mcp.notion.com");
  for (const url of ["https://mcp.notion.com/mcp/", "https://MCP.Notion.com/sse", "https://u:p@mcp.notion.com/mcp?token=x#y", "https://mcp.notion.com"]) {
    assert.equal(endpointKey({ url }), notion, url);
  }
  // Different paths on one host are different servers (a relay hosts many).
  assert.notEqual(endpointKey({ url: "https://server.smithery.ai/@a/one/mcp" }), endpointKey({ url: "https://server.smithery.ai/@a/two/mcp" }));
  // Packages: the name without its version, whichever runner.
  assert.equal(endpointKey({ command: "npx", args: ["-y", "@playwright/mcp@latest"] }), "pkg:npm:@playwright/mcp");
  assert.equal(endpointKey({ command: "/usr/local/bin/npx", args: ["@playwright/mcp@0.0.40", "--headless"] }), "pkg:npm:@playwright/mcp");
  assert.equal(endpointKey({ command: "uvx", args: ["mcp-server-fetch==1.2.0"] }), "pkg:pypi:mcp-server-fetch");
  // Nothing to match on: an address with parts to fill in, another command.
  assert.equal(endpointKey({ url: "https://{REGION}.acme.com/mcp" }), "");
  assert.equal(endpointKey({ command: "node", args: ["server.js"] }), "");

  const index = buildAddedIndex([
    { place: { kind: "editor", id: "/h/.claude.json", label: "Claude" }, defs: { "ikit-notion": { url: "https://mcp.notion.com/sse" }, playwright: { command: "npx", args: ["@playwright/mcp@latest"] } } },
    { place: { kind: "editor", id: "/h/.codex/config.toml", label: "Codex" }, defs: { notion: { url: "https://mcp.notion.com/mcp" } } },
    { place: { kind: "editor", id: "/h/.kimi/mcp.json", label: "Kimi" }, defs: {} },
    { place: { kind: "project", id: "/code/data-glue", label: "data-glue" }, defs: { n: { url: "https://mcp.notion.com/mcp/" } } },
  ]);
  const card = (id: string) => CURATED_CATALOG.find((entry) => entry.id === id)!;
  const notionAdded = addedFor(card("notion"), index, 3);
  assert.deepEqual(notionAdded, {
    label: "in 2 of 3 editors and data-glue",
    name: "ikit-notion",
    editors: ["/h/.claude.json", "/h/.codex/config.toml"],
    projects: ["/code/data-glue"],
  });
  assert.equal(addedFor(card("playwright"), index, 3)?.label, "in 1 of 3 editors");
  assert.equal(addedFor(card("linear"), index, 3), undefined);
  // One editor: named. Projects only: named.
  const solo = buildAddedIndex([{ place: { kind: "editor", id: "c", label: "Claude" }, defs: { x: { url: "https://mcp.linear.app/mcp" } } }]);
  assert.equal(addedFor(card("linear"), solo, 1)?.label, "in Claude");
  const projects = buildAddedIndex([
    { place: { kind: "project", id: "/a", label: "data-glue" }, defs: { l: { url: "https://mcp.linear.app/mcp" } } },
    { place: { kind: "project", id: "/b", label: "portal" }, defs: { l: { url: "https://mcp.linear.app/mcp" } } },
  ]);
  assert.equal(addedFor(card("linear"), projects, 4)?.label, "in data-glue and portal");
});
