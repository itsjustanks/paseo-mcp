/**
 * 0.15.0: the Servers tab as a gallery of the servers you have (filters,
 * search, descriptions, which apps have each), and the Add gallery hiding the
 * ones you already have.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { alreadyHave, alreadyHaveLine, curatedCard, hiddenLine, hideAdded, ownedFromRow, type CatalogCard, type OwnedServer } from "../shared/catalog";
import { CURATED_CATALOG } from "../shared/catalog-curated";
import type { Destination, McpAuthAccount, McpHealth, McpServerRow } from "../shared/contracts";
import { COPY_ALL_EXPLAINER, COPY_ALL_LABEL } from "../shared/copy-all";
import { MCP_EXPLAINER, MCP_LEARN_MORE } from "../shared/overview";
import { appsLine, healthPlainWord, joinWords, serverDescription, serverGallery, signInLine, SERVER_FILTERS } from "../shared/servers";

const HOME = "/home/demo";
const dest = (id: string, provider: string, account: string): Destination => ({
  id, label: id, provider, providerId: provider, account, configPath: id, format: provider === "codex" ? "toml-mcp" : "json-mcp",
});
const claude = dest(`${HOME}/.claude.json`, "claude", "demo@example.com");
const codex = dest(`${HOME}/.codex/config.toml`, "codex", "demo@example.com");
const work = dest(`${HOME}/.agent-link/claude/work/.claude.json`, "claude", "work@example.com");
const kimi = dest(`${HOME}/.kimi/mcp.json`, "kimi", "");
const destinations = [claude, codex, work, kimi];
const all = destinations.map((entry) => entry.id);

const row = (name: string, detail: string, presentIn: string[], inlineCredentialsIn: string[] = []): McpServerRow => ({
  name,
  transport: detail.startsWith("http") ? "http" : "stdio",
  detail,
  authStyle: inlineCredentialsIn.length ? "inline-credentials" : "oauth-or-none",
  inlineCredentialsIn,
  presentIn,
});
const servers = [
  row("linear", "https://mcp.linear.app/mcp", all),
  row("jam", "https://mcp.jam.dev/mcp", [claude.id, codex.id]),
  row("playwright", "npx @playwright/mcp@latest", all),
  row("supabase", "npx -y @supabase/mcp-server", [claude.id, work.id], [work.id]),
  row("acme", "https://tools.acme.example/mcp?key=…", [claude.id]),
];
const check = (name: string, status: McpHealth["status"], note = ""): [string, McpHealth] => [name, { name, status, note, scopes: [] }];
const health = new Map<string, McpHealth>([
  check("linear", "ok"),
  check("jam", "auth-required", "HTTP 401"),
  check("playwright", "ok"),
  check("supabase", "binary-missing", "npx could not resolve it"),
  check("acme", "down", "HTTP 500"),
]);
const account = (provider: "claude" | "codex", email: string, needsAuth: string[], authStatus: McpAuthAccount["authStatus"]): McpAuthAccount => ({
  provider, email, dir: `${HOME}/.${provider}`, isPrimary: true, definedServers: 3, needsAuth, authStatus,
});
const accounts = [
  account("claude", "demo@example.com", ["jam"], { jam: "not-connected", linear: "connected" }),
  account("codex", "demo@example.com", ["jam"], { jam: "not-connected", linear: "connected" }),
];
const known = CURATED_CATALOG.map((entry) => ({ url: entry.url, command: entry.command, args: entry.args, description: entry.description }));
const galleryFor = (filter: (typeof SERVER_FILTERS)[number]["value"], query = "") =>
  serverGallery({ servers, destinations, health, accounts, authRead: true, known, filter, query });

test("gallery: the pills are the existing filters under plain names, each with its count", () => {
  assert.deepEqual(SERVER_FILTERS.map((entry) => [entry.value, entry.label]), [
    ["all", "All"],
    ["issues", "Needs attention"],
    ["sign-in", "Needs sign-in"],
    ["gaps", "Missing from some apps"],
  ]);
  const { counts, total, cards } = galleryFor("all");
  assert.equal(total, 5);
  assert.deepEqual(counts, { all: 5, issues: 2, "sign-in": 1, gaps: 3 });
  assert.deepEqual(cards.map((card) => card.name), ["acme", "jam", "linear", "playwright", "supabase"], "name order");
});

test("gallery: each filter keeps the servers its pill counted", () => {
  assert.deepEqual(galleryFor("issues").cards.map((card) => card.name), ["acme", "supabase"]);
  assert.deepEqual(galleryFor("sign-in").cards.map((card) => card.name), ["jam"]);
  assert.deepEqual(galleryFor("gaps").cards.map((card) => card.name), ["acme", "jam", "supabase"]);
  // Counts don't depend on the filter or the search in use.
  assert.deepEqual(galleryFor("gaps", "zzz").counts, galleryFor("all").counts);
});

test("gallery: search reads the name and the description, every word, any case", () => {
  assert.deepEqual(galleryFor("all", "LIN").cards.map((card) => card.name), ["linear"]);
  assert.deepEqual(galleryFor("all", "browser").cards.map((card) => card.name), ["playwright"], "from the catalogue description");
  assert.deepEqual(galleryFor("all", "acme.example").cards.map((card) => card.name), ["acme"], "from the host in the fallback");
  assert.deepEqual(galleryFor("all", "this computer").cards.map((card) => card.name), ["supabase"]);
  assert.deepEqual(galleryFor("all", "issues cycles").cards.map((card) => card.name), ["linear"]);
  assert.deepEqual(galleryFor("issues", "linear").cards, [], "filter and search together");
});

test("description: the catalogue's line when the endpoint is a known one, else where it runs", () => {
  const linear = CURATED_CATALOG.find((entry) => entry.id === "linear")!;
  const playwright = CURATED_CATALOG.find((entry) => entry.id === "playwright")!;
  assert.equal(serverDescription(row("linear", "https://mcp.linear.app/mcp", []), known), linear.description);
  // The same server at its other transport, with a trailing slash or a query.
  assert.equal(serverDescription(row("lin", "https://mcp.linear.app/sse", []), known), linear.description);
  assert.equal(serverDescription(row("lin", "https://MCP.linear.app/mcp/?…", []), known), linear.description);
  // A package at another version is still the same package.
  assert.equal(serverDescription(row("pw", "npx @playwright/mcp@0.0.41", []), known), playwright.description);
  // Unknown: a remote says its host, a command says it runs here.
  assert.equal(serverDescription(row("acme", "https://www.tools.acme.example/mcp?key=…", []), known), "Your server at tools.acme.example");
  assert.equal(serverDescription(row("mine", "node ./server.js", []), known), "Runs on this computer");
  assert.equal(serverDescription(row("mine", "npx -y @supabase/mcp-server", []), known), "Runs on this computer");
  assert.equal(serverDescription({ transport: "http", detail: "not a url" }, known), "Your own server on the web");
  assert.equal(serverDescription({ transport: "unknown", detail: "" }, known), "Runs on this computer");
  assert.equal(serverDescription(row("linear", "https://mcp.linear.app/mcp", []), []), "Your server at mcp.linear.app", "no catalogue, no match");
});

test("apps line: which apps have it and which don't, by app, with accounts when an app has several", () => {
  assert.deepEqual(appsLine(all, destinations), { line: "In Claude, Codex and Kimi", missing: 0 });
  assert.deepEqual(appsLine([claude.id, codex.id], destinations), { line: "In Claude and Codex · missing in 1 Claude account and Kimi", missing: 2 });
  assert.deepEqual(appsLine([claude.id, work.id], destinations), { line: "In Claude · missing in Codex and Kimi", missing: 2 });
  assert.deepEqual(appsLine([], destinations), { line: "In none of your apps · missing in Claude, Codex and Kimi", missing: 4 });
  assert.equal(joinWords([]), "");
  assert.equal(joinWords(["A"]), "A");
  assert.equal(joinWords(["A", "B", "C"]), "A, B and C");
});

test("card words: health in a word or two, sign-in in plain words", () => {
  const cards = new Map(galleryFor("all").cards.map((card) => [card.name, card]));
  assert.equal(cards.get("linear")?.healthWord, "Working");
  assert.equal(cards.get("acme")?.healthWord, "Not working");
  assert.equal(cards.get("supabase")?.healthWord, "Not installed");
  assert.equal(healthPlainWord(undefined), "Not checked yet");
  assert.equal(healthPlainWord("warn"), "Warning");
  assert.equal(cards.get("jam")?.signInText, "2 accounts need to sign in");
  assert.equal(cards.get("linear")?.signInText, "Signed in");
  assert.equal(cards.get("supabase")?.signInText, "Uses a saved key");
  assert.equal(cards.get("playwright")?.signInText, "No sign-in needed");
  assert.equal(signInLine(servers[4]!, "none", 0, false), "Checking sign-in…", "before the sign-in state is read, it doesn't claim none is needed");
  assert.equal(signInLine(servers[1]!, "needs", 1, true), "Needs you to sign in");
  assert.equal(cards.get("jam")?.apps, "In Claude and Codex · missing in 1 Claude account and Kimi");
  assert.equal(cards.get("jam")?.missing, 2);
});

// ------------------------------------------------------------------ Add gallery

const cards: CatalogCard[] = CURATED_CATALOG.slice(0, 14).map(curatedCard);
const added = { label: "in 1 of 4 editors", name: "x", editors: [claude.id], projects: [] };
const withAdded = cards.map((card, index) => (index < 12 ? { ...card, added } : card));

test("Add gallery: cards you already have are hidden by default, and counted", () => {
  const { shown, hidden } = hideAdded(withAdded, false);
  assert.equal(hidden, 12);
  assert.equal(shown.length, 2);
  assert.ok(shown.every((card) => !card.added));
  assert.equal(hiddenLine(hidden), "12 you already have are hidden.");
  assert.equal(hiddenLine(1), "1 you already have is hidden.");
  assert.equal(hiddenLine(0), "");
});

test("Add gallery: the toggle shows them again, with their Added state, and hides nothing", () => {
  const { shown, hidden } = hideAdded(withAdded, true);
  assert.equal(hidden, 0);
  assert.equal(shown.length, 14);
  assert.equal(shown.filter((card) => card.added).length, 12);
  assert.deepEqual(shown.map((card) => card.key), withAdded.map((card) => card.key), "same order");
  // Nothing added: nothing hidden either way.
  assert.deepEqual(hideAdded(cards, false), { shown: cards, hidden: 0 });
});

test("words: the explainer and Copy say it plainly", () => {
  assert.ok(MCP_EXPLAINER.split(". ").length <= 3, "two or three sentences");
  assert.deepEqual(MCP_LEARN_MORE.map((item) => item.title), ["What a server is", "On the web, or on this computer", "Signing in", "Why fewer is faster"]);
  assert.equal(COPY_ALL_LABEL, "Copy to all my AI apps");
  assert.equal(COPY_ALL_EXPLAINER, "Add a server once, and this copies it to every AI app and account on this computer that doesn't have it yet. Nothing is removed or replaced. A server that only one app understands is left for you to copy by hand. Sign-ins aren't copied: each app signs in on its own.");
  for (const text of [MCP_EXPLAINER, COPY_ALL_EXPLAINER, COPY_ALL_LABEL, ...MCP_LEARN_MORE.map((item) => item.body)]) {
    assert.doesNotMatch(text, /\b(OAuth|stdio|HTTP|JSON|definition|slot|AgentLink|grant|editor|provider|endpoint)s?\b/i, text);
  }
});

// ------------------------------------------------------ "already have" rules

const card = (id: string) => curatedCard(CURATED_CATALOG.find((entry) => entry.id === id)!);
const have = (id: string, owned: OwnedServer[]) => alreadyHave(card(id), owned);

test("already have: the same endpoint, including the other transport and a query", () => {
  assert.deepEqual(have("linear", [{ name: "work-tracker", url: "https://mcp.linear.app/sse?token=abc" }]), { name: "work-tracker", how: "endpoint" });
  assert.equal(have("linear", [{ name: "x", url: "https://mcp.jam.dev/mcp" }]), null);
  // The host's own Added match counts first.
  const added = { ...card("linear"), added: { label: "in 1 of 4 editors", name: "linear", editors: ["a"], projects: [] } };
  assert.deepEqual(alreadyHave(added, []), { name: "linear", how: "added" });
});

test("already have: any server on the same host, whatever its path (a personal token in it, say)", () => {
  assert.deepEqual(have("zapier", [{ name: "automations", url: "https://mcp.zapier.com/api/mcp/s/Zm9vYmFyMTIz/mcp" }]), { name: "automations", how: "host" });
  assert.deepEqual(have("stripe", [{ name: "pay", url: "https://www.MCP.stripe.com/v1/other" }]), { name: "pay", how: "host" }, "case and www don't matter");
  // Another host at the same company is not the same server: Cloudflare's three stay apart.
  assert.equal(have("cloudflare-docs", [{ name: "cf", url: "https://bindings.mcp.cloudflare.com/sse" }]), null);
  assert.equal(have("zapier", [{ name: "z", url: "https://zapier.example.com/mcp" }]), null);
});

test("already have: the same package, any version", () => {
  assert.deepEqual(have("playwright", [{ name: "browser", command: "npx", args: ["-y", "@playwright/mcp@0.0.41"] }]), { name: "browser", how: "package" });
  assert.deepEqual(have("playwright", [ownedFromRow({ name: "pw", transport: "stdio", detail: "npx @playwright/mcp@latest --headless" })]), { name: "pw", how: "package" });
  assert.equal(have("playwright", [{ name: "other", command: "npx", args: ["@acme/mcp"] }]), null);
});

test("already have: a server named exactly after the card, any case, ignoring an -mcp ending and a prefix two of yours share (ikit-)", () => {
  const ikitOther = { name: "ikit-docs", command: "node" };
  assert.deepEqual(have("notion", [{ name: "ikit-notion", url: "https://notion-proxy.internal.example/mcp" }, ikitOther]), { name: "ikit-notion", how: "name" });
  assert.equal(have("notion", [{ name: "ikit-notion", url: "https://notion-proxy.internal.example/mcp" }]), null, "a prefix only one server has isn't one you use");
  assert.deepEqual(have("notion", [{ name: "Notion", command: "node", args: ["notion.js"] }]), { name: "Notion", how: "name" });
  assert.deepEqual(have("notion", [{ name: "notion_mcp", command: "node" }]), { name: "notion_mcp", how: "name" });
  assert.deepEqual(have("heroui-pro", [{ name: "team-heroui-pro", command: "node" }, { name: "team-wiki", command: "node" }]), { name: "team-heroui-pro", how: "name" }, "by the card's id");
  assert.deepEqual(have("cloudflare-docs", [{ name: "my-cloudflare-docs", command: "node" }, { name: "my-db", command: "node" }]), { name: "my-cloudflare-docs", how: "name" }, "by the card's name");
  // A name that only contains the card's name, or a prefix of it, is not the same.
  assert.equal(have("notion", [{ name: "notional", command: "node" }]), null);
  assert.equal(have("notion", [{ name: "notion-calendar-sync", command: "node" }]), null);
  assert.equal(have("jam", [{ name: "jamf", command: "node" }]), null);
});

test("already have: hidden by default, counted, and the toggle shows each with a line naming yours", () => {
  const cards = ["linear", "zapier", "notion", "playwright", "stripe"].map(card);
  const owned: OwnedServer[] = [
    ownedFromRow({ name: "ikit-notion", transport: "http", detail: "https://notion-proxy.internal.example/mcp" }),
    ownedFromRow({ name: "ikit-wiki", transport: "http", detail: "https://wiki.internal.example/mcp" }),
    ownedFromRow({ name: "automations", transport: "http", detail: "https://mcp.zapier.com/api/mcp/s/Zm9v/mcp?…" }),
    ownedFromRow({ name: "linear", transport: "http", detail: "https://mcp.linear.app/mcp" }),
  ];
  const owns = (entry: CatalogCard) => Boolean(alreadyHave(entry, owned));
  const hiddenView = hideAdded(cards, false, owns);
  assert.deepEqual(hiddenView.shown.map((entry) => entry.entry.id), ["playwright", "stripe"]);
  assert.equal(hiddenView.hidden, 3);
  assert.equal(hiddenLine(hiddenView.hidden), "3 you already have are hidden.");
  assert.equal(hideAdded(cards, true, owns).shown.length, 5);
  assert.equal(alreadyHaveLine(card("zapier"), { name: "automations" }), "You have a Zapier server already, called automations.");
  assert.equal(alreadyHaveLine(card("linear"), { name: "linear" }), "You have a Linear server already.");
  assert.equal(alreadyHaveLine(card("notion"), { name: "ikit-notion" }), "You have a Notion server already, called ikit-notion.");
});
