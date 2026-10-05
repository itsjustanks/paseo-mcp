/**
 * "Needs setup" (0.16.0), the pure part: a library's `setup` read like any
 * other untrusted text, per-org addresses that can't leave the vendor's host,
 * shown-only setups that can't be installed, and a bring-your-own-app plan
 * per AI app with the secret in none of it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CatalogCardSchema, curatedCard, mcpCatalogPlan, planInstall, validateEntry, type CatalogEntry } from "../shared/catalog";
import { DEFAULT_LIBRARY_URL, GALLERY_V01_URL, currentLibrarySources } from "../shared/library-source";
import { GALLERY_META, libraryCard, parseLibrary } from "../shared/library";
import {
  CLAUDE_CALLBACK_PORT,
  byoOauthDefinition,
  byoVendor,
  claudeRedirectUri,
  fillOrgTemplate,
  orgTemplateProblem,
  parseSetup,
  planByoOauth,
  setupTargetSupport,
  isStillToFill,
  stepLinks,
} from "../shared/setup";

const GUIDE = "https://developers.google.com/workspace/guides/configure-mcp-servers";
const gmailSetup = {
  kind: "byo-oauth",
  reason: "Google only lets in a sign-in app you create.",
  guideUrl: GUIDE,
  steps: ["Create a project: https://console.cloud.google.com/projectcreate", "Create a Web application client."],
  redirectHint: "Authorized redirect URIs",
  clients: ["claude"],
  scopes: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
};
const gmailRemote = { url: "https://gmailmcp.googleapis.com/mcp/v1", transport: "http" as const };
const zendeskSetup = { kind: "per-org", reason: "It needs your subdomain.", guideUrl: "https://www.zendesk.com/marketplace/apps/support/1191848/mcp-server/", urlTemplate: "https://{subdomain}.zendesk.com/api/mcp", label: "Your Zendesk subdomain" };
const zendeskRemote = { url: "https://{subdomain}.zendesk.com/api/mcp", transport: "http" as const };

const item = (name: string, url: string, setup: unknown, extra: Record<string, unknown> = {}) => ({
  server: { name, description: `${name} server`, version: "1.0.0", remotes: [{ type: "streamable-http", url, ...extra }] },
  _meta: { [GALLERY_META]: { displayName: name, category: "productivity", auth: "oauth", docsUrl: GUIDE, verifiedAt: "2026-09-28", setup } },
});
const cardsOf = (servers: unknown[]) => {
  const parsed = parseLibrary(JSON.stringify({ servers, metadata: { count: servers.length } }));
  return { parsed, cards: parsed.items.map((entry) => libraryCard(entry, { id: "mcp-gallery", name: "MCP Gallery", label: "test" })) };
};

test("setup: a good one is read, cleaned and kept", () => {
  const read = parseSetup(gmailSetup, gmailRemote);
  assert.equal(read.problem, "");
  assert.equal(read.setup?.kind, "byo-oauth");
  assert.deepEqual(read.setup?.clients, ["claude"]);
  assert.deepEqual(stepLinks(read.setup?.steps?.[0] ?? ""), ["https://console.cloud.google.com/projectcreate"]);
});

test("setup: hostile text is cleaned; a key, ${…} or a non-https guide is refused", () => {
  const cleaned = parseSetup({ ...gmailSetup, reason: "Needs‮ setup\n\tnow​", steps: ["Step\u0000 one", "   "] }, gmailRemote);
  assert.equal(cleaned.setup?.reason, "Needs setup now");
  assert.deepEqual(cleaned.setup?.steps, ["Step one"]);
  for (const guideUrl of ["http://example.com/guide", "javascript:alert(1)", "https://user:pw@example.com/", "https://${HOST}/x", "file:///etc/passwd", "https://localhost/x"]) {
    const read = parseSetup({ ...gmailSetup, guideUrl }, gmailRemote);
    assert.equal(read.setup, null, guideUrl);
    assert.match(read.problem, /guideUrl/, guideUrl);
  }
  assert.equal(parseSetup({ ...gmailSetup, reason: "Use ${GITHUB_TOKEN}" }, gmailRemote).setup, null);
  assert.equal(parseSetup({ ...gmailSetup, steps: ["Paste " + "sk_" + "live_51Habcdefghijklmnopqrstu"] }, gmailRemote).setup, null);
  assert.equal(parseSetup({ ...gmailSetup, reason: "x".repeat(201) }, gmailRemote).setup, null, "over the cap");
  assert.equal(parseSetup({ ...gmailSetup, kind: "anything" }, gmailRemote).setup, null);
  assert.equal(parseSetup({ ...gmailSetup, clients: ["claude", "cursor"] }, gmailRemote).setup, null, "only known apps");
  assert.equal(parseSetup({ ...gmailSetup, scopes: "a b\"c" }, gmailRemote).setup, null);
  assert.equal(parseSetup({ ...gmailSetup, urlTemplate: "https://{org}.example.com" }, gmailRemote).setup, null, "fields only where their kind uses them");
  assert.equal(parseSetup({ ...gmailSetup, clients: undefined }, gmailRemote).setup, null, "byo-oauth names its apps");
  assert.equal(parseSetup(gmailSetup, { ...gmailRemote, headers: { Authorization: "Bearer {T}" } }).setup, null, "byo-oauth has no headers");
});

test("setup: a per-org template can't be pointed at another host", () => {
  assert.equal(orgTemplateProblem("https://{subdomain}.zendesk.com/api/mcp"), "");
  assert.equal(orgTemplateProblem("https://mcp.example.com/orgs/{org}/mcp"), "");
  for (const template of [
    "https://{subdomain}evil.com/api/mcp",
    "https://evil.com/{subdomain}.zendesk.com/api/mcp",
    "https://evil.com?x={subdomain}",
    "https://{subdomain}.com/mcp",
    "https://{subdomain}.co.uk/mcp",
    "https://{subdomain}.zendesk.com:8443/api/mcp",
    "https://x@{subdomain}.zendesk.com/api/mcp",
    "http://{subdomain}.zendesk.com/api/mcp",
    "https://{subdomain}.{org}.zendesk.com/mcp",
    "https://{tenant}.zendesk.com/mcp",
    "https://www.{subdomain}.zendesk.com/mcp",
  ]) {
    assert.notEqual(orgTemplateProblem(template), "", template);
  }
  assert.equal(parseSetup({ ...zendeskSetup, urlTemplate: "https://{subdomain}.zendesk.com/other" }, zendeskRemote).setup, null, "the template is the server's own address");
});

test("per-org: only a plain subdomain fills the address, and the host stays the vendor's", () => {
  const template = "https://{subdomain}.zendesk.com/api/mcp";
  assert.deepEqual(fillOrgTemplate(template, "acme-support"), { url: "https://acme-support.zendesk.com/api/mcp", problem: "" });
  for (const value of ["evil.com", "evil.com/x", "acme.evil", "a@b", "x:1", "ACME", "-acme", "acme-", "аcme", "%2e", "a b", "a".repeat(64), "", "acme#", "acme?x", "..", "a\u0000b"]) {
    const filled = fillOrgTemplate(template, value);
    assert.equal(filled.url, "", JSON.stringify(value));
    assert.notEqual(filled.problem, "", JSON.stringify(value));
  }
  const pathTemplate = "https://mcp.example.com/orgs/{org}/mcp";
  assert.equal(fillOrgTemplate(pathTemplate, "acme").url, "https://mcp.example.com/orgs/acme/mcp");
  assert.equal(fillOrgTemplate(pathTemplate, "..").url, "");
});

test("per-org: planned at both scopes with the value written as typed, never a ${VAR}", () => {
  const { cards } = cardsOf([item("com.zendesk/mcp", "https://{subdomain}.zendesk.com/api/mcp", zendeskSetup, { variables: { subdomain: { description: "Subdomain", isRequired: true, isSecret: true } } })]);
  const card = cards[0]!;
  assert.equal(card.installable, true);
  assert.deepEqual(card.entry.inputs, [{ id: "subdomain", label: "Your Zendesk subdomain", secret: false, required: true, hint: undefined }]);
  for (const scope of ["user", "project"] as const) {
    const plan = planInstall(card.entry, scope, { subdomain: "acme" }, "team");
    assert.deepEqual(plan.issues, [], scope);
    assert.equal(plan.definition.url, "https://acme.zendesk.com/api/mcp", scope);
    assert.deepEqual(plan.envToSet, [], scope);
  }
  for (const subdomain of ["evil.com/x?", "evil.com#", "", "a.b"]) {
    const plan = planInstall(card.entry, "user", { subdomain }, "team");
    assert.equal(plan.ok, false, subdomain);
    assert.ok(!JSON.stringify([plan.definition, plan.masked]).includes("evil"), "the preview never shows the address it would have made");
  }
});

test("approved-clients and admin: shown with the reason, never installable", () => {
  const { cards } = cardsOf([
    item("com.slack/mcp", "https://mcp.slack.com/mcp", { kind: "approved-clients", reason: "Slack only lets its approved apps connect.", guideUrl: "https://docs.slack.dev/ai/slack-mcp-server/" }),
    item("com.box/mcp", "https://mcp.box.com", { kind: "admin", reason: "A Box admin has to turn it on.", guideUrl: "https://developer.box.com/guides/box-mcp/remote/" }),
    item("com.dropbox/mcp", "https://mcp.dropbox.com/mcp", { kind: "approved-clients", reason: "Only a trusted list of apps.", guideUrl: "https://help.dropbox.com/integrations/connect-dropbox-mcp-server", clients: ["claude", "codex"] }),
  ]);
  const [slack, box, dropbox] = cards;
  assert.equal(slack?.installable, false);
  assert.equal(slack?.blockedReason, "Slack only lets its approved apps connect.");
  assert.equal(box?.installable, false);
  assert.equal(dropbox?.installable, true, "approved apps the plugin can write to are offered");
  for (const card of [slack!, box!]) assert.equal(planInstall(card.entry, "user", {}, "team").ok, false);
  for (const card of cards) assert.ok(CatalogCardSchema.safeParse(card).success);
  const kimi = { provider: "kimi", format: "json-mcp", configPath: "/h/.kimi-code/mcp.json" };
  const codex = { provider: "codex", format: "toml-mcp", configPath: "/h/.codex/config.toml" };
  assert.equal(setupTargetSupport(dropbox?.entry.setup, codex).ok, true);
  assert.equal(setupTargetSupport(dropbox?.entry.setup, kimi).ok, false);
});

test("a setup that doesn't check out blocks the card instead of passing as one click", () => {
  const { cards, parsed } = cardsOf([item("com.google/gmail", "https://gmailmcp.googleapis.com/mcp/v1", { ...gmailSetup, guideUrl: "http://evil.example/guide" })]);
  assert.equal(parsed.refused.length, 0);
  assert.equal(cards[0]?.installable, false);
  assert.match(cards[0]?.blockedReason ?? "", /setup notes can't be used/);
  assert.equal(cards[0]?.entry.setup, undefined);
});

test("curated and team entries can carry a setup, under the same rules", () => {
  const entry: CatalogEntry = {
    id: "box",
    name: "Box",
    publisher: "Box",
    description: "Box files.",
    category: "productivity",
    transport: "http",
    url: "https://mcp.box.com",
    auth: "oauth",
    docs: "https://developer.box.com/guides/box-mcp/remote/",
    verifiedAt: "2026-09-28",
    setup: { kind: "admin", reason: "A Box admin has to turn it on.", guideUrl: "https://developer.box.com/guides/box-mcp/remote/" },
  };
  assert.deepEqual(validateEntry(entry, "curated"), []);
  const card = curatedCard(entry);
  assert.equal(card.installable, false);
  assert.equal(card.blockedReason, "A Box admin has to turn it on.");
  assert.match(validateEntry({ ...entry, setup: { ...entry.setup!, guideUrl: "http://x.example" } }, "curated").join(" "), /guideUrl/);
  const team = parseLibrary(JSON.stringify([{ ...entry, verifiedAt: "" }]));
  assert.equal(team.items[0]?.blockedReason, "A Box admin has to turn it on.");
});

test("byo-oauth: planned per app, Claude Code's exact shape, the secret in none of it", () => {
  const { cards } = cardsOf([item("com.google/gmail", "https://gmailmcp.googleapis.com/mcp/v1", gmailSetup)]);
  const card = cards[0]!;
  assert.equal(card.installable, true);
  assert.equal(planInstall(card.entry, "user", {}, "team").ok, false, "never through the plain install");
  const secret = "GOCSPX" + "-abcdefghijklmnopqrstuvwxyz12";
  const targets = [
    { id: "/h/.claude.json", label: "Claude", provider: "claude", format: "json-mcp", configPath: "/h/.claude.json" },
    { id: "/h/.codex/config.toml", label: "Codex", provider: "codex", format: "toml-mcp", configPath: "/h/.codex/config.toml" },
    { id: "/h/.kimi-code/mcp.json", label: "Kimi Code", provider: "kimi", format: "json-mcp", configPath: "/h/.kimi-code/mcp.json" },
  ];
  const plan = planByoOauth(card.entry, targets, { clientId: " 123-abc.apps.googleusercontent.com ", clientSecret: secret });
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.supported.map((target) => target.label), ["Claude"]);
  assert.deepEqual(plan.skipped.map((entry) => entry.label), ["Codex", "Kimi Code"]);
  assert.match(plan.skipped[0]?.reason ?? "", /no place for a client secret/);
  assert.deepEqual(plan.definition, {
    type: "http",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
    oauth: { clientId: "123-abc.apps.googleusercontent.com", callbackPort: CLAUDE_CALLBACK_PORT, scopes: gmailSetup.scopes },
  });
  assert.equal(plan.redirectUri, `http://localhost:${CLAUDE_CALLBACK_PORT}/callback`);
  assert.equal(claudeRedirectUri(), plan.redirectUri);
  assert.ok(!JSON.stringify(plan).includes(secret));
  assert.ok(!JSON.stringify(byoOauthDefinition(card.entry, "id")).includes("secret"));

  const missing = planByoOauth(card.entry, targets.slice(1), { clientId: "id with space", clientSecret: "" });
  assert.ok(missing.issues.some((issue) => /client ID/.test(issue)));
  assert.ok(missing.issues.some((issue) => /client secret/.test(issue)));
  assert.ok(missing.issues.some((issue) => /None of the apps/.test(issue)));
  const leaky = planByoOauth(card.entry, targets, { clientId: "id", clientSecret: "two\nlines" });
  assert.ok(!JSON.stringify(leaky).includes("two\nlines"));
});

// ----------------------------------------------- review of 0.16.0 (2026-09-28)

test("byo-oauth: only a vendor this plugin ships, at its own MCP host, with every link on its own sites", () => {
  const read = (url: string, setup: Record<string, unknown> = gmailSetup) => parseSetup(setup, { url, transport: "http" });
  assert.equal(read(gmailRemote.url).problem, "");
  assert.equal(byoVendor(gmailRemote.url)?.vendor, "Google");
  assert.equal(read("https://mcp.hubspot.com", { ...gmailSetup, guideUrl: "https://developers.hubspot.com/mcp", steps: [] }).problem, "");
  assert.equal(read("https://mcp.zoom.us/mcp/zoom/streamable", { ...gmailSetup, guideUrl: "https://developers.zoom.us/docs/mcp/", steps: ["Make an app: https://marketplace.zoom.us/develop/create"] }).problem, "");
  for (const url of [
    "https://gmail-mcp.evil.example/mcp/v1",
    "https://storage.googleapis.com/bucket/mcp",
    "https://bucket.storage.googleapis.com/mcp",
    "https://gmailmcp.googleapis.com.evil.example/mcp/v1",
    "https://gmailmcp.googleapis.com:8443/mcp/v1",
    "https://mcp.hubspot.com.evil.example",
  ]) {
    assert.match(read(url).problem, /vendor/, url);
    assert.equal(byoVendor(url), null, url);
  }
  // Google's server, but the guide or a step sends the user somewhere else.
  assert.match(read(gmailRemote.url, { ...gmailSetup, guideUrl: "https://evil.example/guide" }).problem, /Google's own sites/);
  assert.match(read(gmailRemote.url, { ...gmailSetup, steps: ["Paste it here: https://console.cloud.google.com.evil.example/x"] }).problem, /Google's own sites/);
  assert.match(read(gmailRemote.url, { ...gmailSetup, steps: ["Paste it here: https://sites.google.com/view/x"] }).problem, /Google's own sites/);
  assert.match(read(gmailRemote.url, { ...gmailSetup, steps: ["Paste it at http://evil.example/x"] }).problem, /Google's own sites/);
  // A library can't add a vendor: its card is blocked, never one click, never a secret field.
  const { cards } = cardsOf([item("com.google/gmail", "https://gmail-mcp.evil.example/mcp/v1", gmailSetup)]);
  assert.equal(cards[0]?.installable, false);
  assert.match(cards[0]?.blockedReason ?? "", /setup notes can't be used/);
  assert.equal(cards[0]?.entry.setup, undefined);
  // The same rule for curated and team entries.
  const team = parseLibrary(JSON.stringify([{ id: "gmail", name: "Gmail", publisher: "Google", description: "Mail.", category: "productivity", transport: "http", url: "https://gmail-mcp.evil.example/mcp/v1", auth: "oauth", docs: GUIDE, setup: gmailSetup }]));
  assert.equal(team.items.length, 0);
  assert.match(team.refused[0]?.reason ?? "", /vendor's own server/);
});

test("per-org: a shared hosting domain can't stand in for the vendor's", () => {
  for (const template of ["https://{subdomain}.github.io/mcp", "https://{subdomain}.vercel.app/mcp", "https://{org}.pages.dev/mcp", "https://{subdomain}.co.uk/mcp"]) {
    assert.notEqual(orgTemplateProblem(template), "", template);
  }
  assert.match(orgTemplateProblem("https://{subdomain}.github.io/mcp"), /shared/);
  assert.equal(orgTemplateProblem("https://{subdomain}.zendesk.com/api/mcp"), "");
  assert.equal(orgTemplateProblem("https://api.example.com/{org}/mcp"), "");
});

test("byo-oauth: the plan call never carries the secret, only whether one was typed", () => {
  const SECRET = "GOCSPX" + "-planplanplanplanplanplan1234";
  const parsed = mcpCatalogPlan.input.parse({ key: "k", scope: "user", name: "gmail", oauthClient: { clientId: "id", clientSecret: SECRET, hasSecret: true } });
  assert.ok(!JSON.stringify(parsed).includes(SECRET), "the plan contract drops a secret");
  assert.equal(parsed.oauthClient?.hasSecret, true);
  const { cards } = cardsOf([item("com.google/gmail", gmailRemote.url, gmailSetup)]);
  const target = [{ id: "/h/.claude.json", label: "Claude", provider: "claude", format: "json-mcp", configPath: "/h/.claude.json" }];
  assert.deepEqual(planByoOauth(cards[0]!.entry, target, { clientId: "id", hasSecret: true }).issues, []);
  assert.ok(planByoOauth(cards[0]!.entry, target, { clientId: "id", hasSecret: false }).issues.includes("Paste the client secret."));
});

test("the gallery file with setups is v0.2; a saved v0.1 address reads as v0.2, other libraries untouched", () => {
  assert.match(DEFAULT_LIBRARY_URL, /\/v0\.2\/servers\.json$/);
  assert.match(GALLERY_V01_URL, /\/v0\.1\/servers\.json$/);
  const saved = [
    { id: "mcp-gallery", name: "MCP Gallery", source: GALLERY_V01_URL, format: "json" as const, enabled: true, headerName: "" },
    { id: "mine", name: "Mine", source: "https://example.com/v0.1/servers.json", format: "json" as const, enabled: true, headerName: "" },
    { id: "copy", name: "Copy", source: GALLERY_V01_URL, format: "auto" as const, enabled: false, headerName: "" },
  ];
  const read = currentLibrarySources(saved);
  assert.deepEqual(read.map((library) => library.source), [DEFAULT_LIBRARY_URL, "https://example.com/v0.1/servers.json", DEFAULT_LIBRARY_URL]);
  assert.equal(read[2]?.enabled, false);
  assert.equal(saved[0]?.source, GALLERY_V01_URL, "the saved list is not changed in place");
});

test("byo-oauth: hidden characters can't split a link past the check; any-case links, reason, redirect hint and docs count too", () => {
  const read = (setup: Record<string, unknown>, docs?: string) => parseSetup(setup, { url: gmailRemote.url, transport: "http", ...(docs ? { docs } : {}) });
  assert.match(read({ ...gmailSetup, steps: ["Open HTTPS://evil.example/x"] }).problem, /Google's own sites/);
  assert.match(read({ ...gmailSetup, reason: "Make a client at https://evil.example/x first." }).problem, /Google's own sites/);
  assert.match(read({ ...gmailSetup, redirectHint: "https://evil.example/x" }).problem, /Google's own sites/);
  assert.match(read(gmailSetup, "https://evil.example/docs").problem, /Google's own sites/);
  assert.equal(read(gmailSetup, GUIDE).problem, "");
  // A team entry is checked on its cleaned text: U+FEFF or \v inside a host doesn't hide the rest of it.
  for (const joiner of ["\ufeff", "\v"]) {
    const team = parseLibrary(JSON.stringify([{ id: "gmail", name: "Gmail", publisher: "Google", description: "Mail.", category: "productivity", transport: "http", url: gmailRemote.url, auth: "oauth", docs: GUIDE, setup: { ...gmailSetup, steps: [`Sign in: https://console.cloud.google.com${joiner}.evil.example/x`] } }]));
    assert.equal(team.items.length, 0, JSON.stringify(joiner));
    assert.match(team.refused[0]?.reason ?? "", /Google's own sites/);
  }
});

test("the sheet tells an empty box from a real problem: only real problems are red", () => {
  for (const issue of ["Paste the client ID.", "Paste the client secret.", "Pick at least one app.", "Pick one of the registered projects.", "Your Zendesk subdomain is required"]) {
    assert.equal(isStillToFill(issue), true, issue);
  }
  for (const issue of ["The client ID holds a space or a character a client ID never has.", "The client secret must be one line with no spaces.", "That would point the server at another site.", "None of the apps you picked can take a sign-in app you registered. Claude Code can."]) {
    assert.equal(isStillToFill(issue), false, issue);
  }
});

// ------------------------------------------------ 0.18.3: Meta Ads, an app ID and no secret

const metaSetup = {
  kind: "byo-oauth",
  reason: "Claude Code signs in to Meta Ads with your own Meta app; only its App ID is needed, no secret.",
  guideUrl: "https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-get-started",
  steps: ["Create a developer app: https://developers.facebook.com/apps", "Add the use case Create & manage ads with ads MCP server."],
  redirectHint: "Valid OAuth Redirect URIs",
  clients: ["claude"],
  secretless: true,
};
const metaRemote = { url: "https://mcp.facebook.com/ads", transport: "http" as const };

test("Meta Ads: Meta is a known vendor at mcp.facebook.com, and secretless is only for byo-oauth", () => {
  assert.equal(parseSetup(metaSetup, metaRemote).problem, "");
  assert.equal(byoVendor(metaRemote.url)?.vendor, "Meta");
  assert.match(parseSetup({ ...metaSetup, steps: ["Paste it at https://facebook.com.evil.example/x"] }, metaRemote).problem, /Meta's own sites/);
  assert.match(parseSetup({ ...zendeskSetup, secretless: true }, zendeskRemote).problem, /secretless is only for byo-oauth/);
});

test("Meta Ads: the plan needs the App ID only; no secret is asked for or kept", () => {
  const meta = item("com.facebook/ads", metaRemote.url, metaSetup);
  meta._meta[GALLERY_META].docsUrl = metaSetup.guideUrl; // Meta's own docs, as the vendor check requires
  const { cards } = cardsOf([meta]);
  const card = cards[0]!;
  assert.equal(card.installable, true);
  const target = [{ id: "/h/.claude.json", label: "Claude", provider: "claude", format: "json-mcp", configPath: "/h/.claude.json" }];
  const plan = planByoOauth(card.entry, target, { clientId: "1234567890123456", hasSecret: false });
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.definition, { type: "http", url: metaRemote.url, oauth: { clientId: "1234567890123456", callbackPort: CLAUDE_CALLBACK_PORT } });
  assert.ok(plan.notes.some((note) => /no client secret/i.test(note)));
  assert.ok(!plan.notes.some((note) => /secure store/.test(note)), "nothing about storing a secret");
  assert.ok(planByoOauth(card.entry, target, { clientId: "", hasSecret: false }).issues.includes("Paste the App ID."));
});
