/**
 * Libraries (0.13.0), the pure part: a library document in the MCP Registry's
 * list shape read into catalogue entries, the rules each server must pass,
 * the settings migration from the 0.12.0 team catalogue, how an address is
 * read, and merging every library into one gallery.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CatalogCardSchema, catalogSettings, curatedCard, planInstall, registryCard, type CatalogCard } from "../shared/catalog";
import { CURATED_CATALOG } from "../shared/catalog-curated";
import { GALLERY_META, LIBRARY_PACKAGE_REASON, libraryCard, libraryItem, mergeGallery, nextCursorOf, parseLibrary, type LibraryItem } from "../shared/library";
import {
  DEFAULT_LIBRARIES,
  DEFAULT_LIBRARY_URL,
  LibrariesSchema,
  libraryIdFor,
  libraryLocation,
  migrateCatalogValues,
  registryListUrl,
} from "../shared/library-source";

const known = new Map(CURATED_CATALOG.filter((entry) => entry.url).map((entry) => [entry.url!.replace(/\/+$/, "").toLowerCase(), entry.name]));
const gallery = { id: "mcp-gallery", name: "MCP Gallery", label: "raw.githubusercontent.com/…/servers.json" };

const item = (server: Record<string, unknown>, meta?: Record<string, unknown>) => ({ server: { version: "1.0.0", description: `${server.name} server`, ...server }, ...(meta ? { _meta: { [GALLERY_META]: meta } } : {}) });
const doc = (...servers: unknown[]) => JSON.stringify({ servers, metadata: { count: servers.length } });
const only = (text: string): LibraryItem => {
  const parsed = parseLibrary(text);
  assert.equal(parsed.error, "");
  assert.equal(parsed.items.length, 1, JSON.stringify(parsed.refused));
  return parsed.items[0]!;
};

// ------------------------------------------------------------------ parsing

test("parse: a remote with a token header becomes an entry with a secret input, curation from _meta", () => {
  const read = only(
    doc(
      item(
        {
          name: "com.acme/mcp",
          remotes: [
            { type: "sse", url: "https://mcp.acme.example/sse" },
            {
              type: "streamable-http",
              url: "https://mcp.acme.example/mcp",
              headers: [{ name: "Authorization", value: "Bearer {ACME_TOKEN}", isRequired: true, isSecret: true, variables: { ACME_TOKEN: { description: "Acme API token", isRequired: true, isSecret: true } } }],
            },
          ],
        },
        { id: "acme", displayName: "Acme", category: "payments", auth: "token", publisher: "Acme Inc", iconUrl: "https://acme.example/icon.png", docsUrl: "https://acme.example/docs/mcp", verifiedAt: "2026-09-20T10:00:00Z" },
      ),
    ),
  );
  assert.equal(read.name, "com.acme/mcp");
  assert.equal(read.version, "1.0.0");
  assert.equal(read.blockedReason, "");
  const entry = read.entry;
  assert.deepEqual([entry.id, entry.name, entry.publisher, entry.category, entry.transport, entry.url, entry.auth], ["acme", "Acme", "Acme Inc", "payments", "http", "https://mcp.acme.example/mcp", "header"]);
  assert.deepEqual(entry.headers, { Authorization: "Bearer {ACME_TOKEN}" });
  assert.deepEqual(entry.inputs?.map((input) => [input.id, input.label, input.secret, input.required]), [["ACME_TOKEN", "Acme API token", true, true]]);
  assert.equal(entry.iconUrl, "https://acme.example/icon.png");
  assert.equal(entry.docs, "https://acme.example/docs/mcp");
  assert.equal(entry.verifiedAt, "2026-09-20");
});

test("parse: no curation falls back to server.json fields", () => {
  const read = only(doc(item({ name: "io.github.someone/weather-tool", title: "Weather", websiteUrl: "https://weather.example", icons: [{ src: "http://insecure.example/i.png" }, { src: "https://weather.example/i.png" }], remotes: [{ type: "streamable-http", url: "https://weather.example/mcp" }] })));
  assert.deepEqual([read.entry.id, read.entry.name, read.entry.publisher, read.entry.category, read.entry.auth], ["weather-tool", "Weather", "github.com/someone", "other", "unknown"]);
  assert.equal(read.entry.docs, "https://weather.example");
  assert.equal(read.entry.iconUrl, "https://weather.example/i.png", "only an https icon is kept");
});

test("parse: curation that does not fit is ignored field by field, never the whole server", () => {
  const read = only(doc(item({ name: "com.acme/mcp", remotes: [{ type: "streamable-http", url: "https://mcp.acme.example/mcp" }] }, { id: "not valid id!", category: "made-up", auth: "magic", iconUrl: "javascript:alert(1)", displayName: "Acme" })));
  assert.deepEqual([read.entry.id, read.entry.category, read.entry.auth, read.entry.name], ["acme", "other", "unknown", "Acme"], "com.acme/mcp is called acme, not mcp");
  assert.equal(read.entry.iconUrl, undefined);
});

test("parse: a stdio npm or PyPI package runs at its exact version; env and arguments become inputs", () => {
  const npm = only(
    doc(
      item({
        name: "io.github.acme/acme-cli",
        packages: [
          {
            registryType: "npm",
            identifier: "@acme/mcp",
            version: "1.4.2",
            transport: { type: "stdio" },
            environmentVariables: [{ name: "ACME_API_KEY", description: "API key", isRequired: true, isSecret: true }],
            packageArguments: [
              { type: "named", name: "--region", value: "{REGION}", variables: { REGION: { description: "Region", isSecret: false, isRequired: true } } },
              { type: "named", name: "--verbose" },
            ],
          },
        ],
      }),
    ),
  );
  assert.equal(npm.entry.command, "npx");
  assert.deepEqual(npm.entry.args, ["@acme/mcp@1.4.2", "--region={REGION}"]);
  assert.deepEqual(npm.entry.env, { ACME_API_KEY: "{ACME_API_KEY}" });
  assert.equal(npm.entry.auth, "env");
  // In a team-rules entry every argument placeholder is secret, whatever the library says.
  assert.deepEqual(npm.entry.inputs?.map((input) => [input.id, input.secret]), [["REGION", true], ["ACME_API_KEY", true]]);
  const pypi = only(doc(item({ name: "io.github.acme/acme-py", packages: [{ registryType: "pypi", identifier: "acme-mcp", version: "2.0.1", transport: { type: "stdio" } }] })));
  assert.deepEqual([pypi.entry.command, pypi.entry.args], ["uvx", ["acme-mcp==2.0.1"]]);
});

test("parse: a package the plugin can't start is shown, not added; one that breaks a rule is refused", () => {
  const oci = only(doc(item({ name: "io.github.acme/docker-only", packages: [{ registryType: "oci", identifier: "ghcr.io/acme/mcp:1.0.0", transport: { type: "stdio" } }] })));
  assert.equal(oci.blockedReason, LIBRARY_PACKAGE_REASON);
  const parsed = parseLibrary(
    doc(
      item({ name: "io.github.acme/latest", packages: [{ registryType: "npm", identifier: "acme-mcp", version: "latest", transport: { type: "stdio" } }] }),
      item({ name: "io.github.acme/range", packages: [{ registryType: "npm", identifier: "acme-mcp", version: "^1.0.0", transport: { type: "stdio" } }] }),
      item({ name: "io.github.acme/runner-flag", packages: [{ registryType: "npm", identifier: "acme-mcp", version: "1.0.0", transport: { type: "stdio" }, runtimeArguments: [{ type: "named", name: "--registry", value: "https://evil.example" }] }] }),
      item({ name: "io.github.acme/node-options", packages: [{ registryType: "npm", identifier: "acme-mcp", version: "1.0.0", transport: { type: "stdio" }, environmentVariables: [{ name: "NODE_OPTIONS", value: "--require /tmp/x.js" }] }] }),
    ),
  );
  assert.deepEqual(parsed.items, []);
  assert.deepEqual(
    parsed.refused.map((entry) => entry.id),
    ["io.github.acme/latest", "io.github.acme/range", "io.github.acme/runner-flag", "io.github.acme/node-options"],
  );
  assert.match(parsed.refused[0]!.reason, /exact version/);
  assert.match(parsed.refused[2]!.reason, /runner flag/);
  assert.match(parsed.refused[3]!.reason, /NODE_OPTIONS/);
});

// --------------------------------------------------------------- validation

test("validation: untrusted text never carries a key, plain http, a ${VAR} or a hidden character into the gallery", () => {
  const parsed = parseLibrary(
    doc(
      item({ name: "com.leaky/header", remotes: [{ type: "streamable-http", url: "https://mcp.leaky.example/mcp", headers: [{ name: "Authorization", value: "Bearer sk_" + "live_51Habcdefghijklmnopqrstu" }] }] }),
      item({ name: "com.leaky/query", remotes: [{ type: "streamable-http", url: "https://mcp.leaky.example/mcp?api_key=abc123" }] }),
      item({ name: "com.plain/http", remotes: [{ type: "streamable-http", url: "http://mcp.plain.example/mcp" }] }),
      item({ name: "com.env/ref", remotes: [{ type: "streamable-http", url: "https://mcp.env.example/mcp", headers: [{ name: "Authorization", value: "Bearer ${GITHUB_TOKEN}" }] }] }),
      item({ name: "com.user/pass", remotes: [{ type: "streamable-http", url: "https://me:pw@mcp.user.example/mcp" }] }),
      item({ name: "not a registry name", remotes: [{ type: "streamable-http", url: "https://x.example/mcp" }] }),
      { nope: true },
      item({ name: "com.ok/fine", description: "Fine‮ server <script>alert(1)</script>", remotes: [{ type: "streamable-http", url: "https://mcp.ok.example/mcp" }] }),
    ),
  );
  assert.deepEqual(parsed.items.map((entry) => entry.name), ["com.ok/fine"]);
  assert.equal(parsed.refused.length, 7);
  assert.ok(!JSON.stringify(parsed).includes("sk_live_51H"), "a refused key is never quoted back");
  const shown = parsed.items[0]!.entry.description;
  assert.ok(!shown.includes("‮"), "bidi controls are stripped");
  // Markup is plain text to React Native's <Text>; it is kept as text, never parsed.
  assert.match(shown, /<script>/);
  assert.equal(CatalogCardSchema.safeParse(libraryCard(parsed.items[0]!, gallery)).success, true);
});

test("validation: an isSecret: false on a credential input never makes it public", () => {
  const read = only(doc(item({ name: "com.acme/mcp", remotes: [{ type: "streamable-http", url: "https://mcp.acme.example/mcp", headers: [{ name: "X-Api-Key", value: "{KEY}", variables: { KEY: { isSecret: false, isRequired: true } } }] }] })));
  assert.equal(read.entry.inputs?.[0]?.secret, true);
  const plan = planInstall(read.entry, "project", { KEY: "abc" }, "team");
  assert.equal(plan.ok, true, plan.issues.join());
  assert.match(JSON.stringify(plan.definition), /\$\{MCP_TEAM__ACME__[0-9A-F]{6}__KEY\}/);
  assert.ok(!JSON.stringify(plan.definition).includes('"abc"'));
});

test("validation: size and count caps, errors that never quote the text", () => {
  assert.match(parseLibrary(" ".repeat(1024 * 1024 + 1)).error, /1 MB/);
  const bad = parseLibrary("OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz");
  assert.match(bad.error, /not valid JSON \(line 1\)/);
  assert.ok(!/OPENAI|sk-proj/.test(bad.error));
  assert.match(parseLibrary('{"hello": 1}').error, /servers/);
  const many = parseLibrary(doc(...Array.from({ length: 502 }, (_v, index) => item({ name: `com.bulk/s${index}`, remotes: [{ type: "streamable-http", url: `https://s${index}.bulk.example/mcp` }] }))));
  assert.equal(many.items.length, 500);
  assert.match(many.refused.at(-1)?.reason ?? "", /first 500/);
});

test("parse: a 0.12.0 team catalogue file still reads, by entry id", () => {
  const parsed = parseLibrary(JSON.stringify([{ id: "ikit-n8n", name: "n8n", transport: "http", url: "https://n8n.example.com/mcp", headers: { Authorization: "Bearer {N8N}" }, inputs: [{ id: "N8N", label: "Token" }], auth: "header" }]));
  assert.deepEqual(parsed.items.map((entry) => [entry.name, entry.entry.id]), [["ikit-n8n", "ikit-n8n"]]);
  const card = libraryCard(parsed.items[0]!, { id: "team", name: "Team", label: "team.json" });
  assert.deepEqual([card.key, card.shelf, card.trust], ["team:ikit-n8n", "team", "team"]);
});

// ---------------------------------------------------------------- pagination

test("pagination: registry list addresses and cursors", () => {
  assert.equal(registryListUrl("https://registry.modelcontextprotocol.io", "jira tools"), "https://registry.modelcontextprotocol.io/v0.1/servers?search=jira%20tools&version=latest&limit=100");
  assert.equal(registryListUrl("https://reg.example.com/base/", "x", 50, "abc=="), "https://reg.example.com/base/v0.1/servers?search=x&version=latest&limit=50&cursor=abc%3D%3D");
  assert.equal(nextCursorOf({ metadata: { nextCursor: "page-2" } }), "page-2");
  assert.equal(nextCursorOf({ metadata: {} }), "");
  assert.equal(nextCursorOf({ metadata: { nextCursor: "a\nb" } }), "", "a cursor with a line break is not followed");
  assert.equal(nextCursorOf(null), "");
});

// ------------------------------------------------------------------ sources

test("sources: https documents, registries, host files; http only on this machine", () => {
  assert.deepEqual(libraryLocation(DEFAULT_LIBRARY_URL), { kind: "json", url: DEFAULT_LIBRARY_URL });
  assert.deepEqual(libraryLocation("https://registry.modelcontextprotocol.io/"), { kind: "registry", base: "https://registry.modelcontextprotocol.io" });
  assert.deepEqual(libraryLocation("https://registry.modelcontextprotocol.io/v0.1/servers"), { kind: "registry", base: "https://registry.modelcontextprotocol.io" });
  assert.deepEqual(libraryLocation("https://api.example.com/catalogue", "json"), { kind: "json", url: "https://api.example.com/catalogue" });
  assert.deepEqual(libraryLocation("http://localhost:8080/servers.json"), { kind: "json", url: "http://localhost:8080/servers.json" });
  assert.deepEqual(libraryLocation("http://127.0.0.1:9000"), { kind: "registry", base: "http://127.0.0.1:9000" });
  assert.deepEqual(libraryLocation("~/private/servers.json"), { kind: "file", path: "~/private/servers.json" });
  assert.deepEqual(libraryLocation("/etc/mcp/servers.json"), { kind: "file", path: "/etc/mcp/servers.json" });
  for (const [source, reason] of [
    ["http://example.com/servers.json", /only https/],
    ["ftp://example.com/servers.json", /only https/],
    ["https://me:pw@example.com/servers.json", /credentials/],
    ["https://example.com/servers.json?token=abc", /key field/],
    ["https://example.com/servers.json?X-Amz-Signature=abc", /key field/],
    ["relative/servers.json", /absolute path/],
    ["", /no address/],
  ] as const) {
    const where = libraryLocation(source);
    assert.equal(where.kind, "invalid", source);
    assert.match((where as { reason: string }).reason, reason, source);
  }
});

// ------------------------------------------------------------------ settings

test("settings: version 2 defaults, the 0.12.0 team catalogue migrates to a library called Team", () => {
  assert.equal(catalogSettings.version, 2);
  const defaults = catalogSettings.schema.parse({});
  assert.deepEqual(defaults.libraries.map((library) => [library.id, library.enabled]), [["mcp-gallery", true], ["mcp-registry", false]]);
  assert.equal(defaults.libraries[0]?.source, DEFAULT_LIBRARY_URL);
  const migrated = catalogSettings.schema.parse(migrateCatalogValues({ teamSource: "https://team.example.com/catalogue", teamHeaderName: "Authorization" }, 1));
  assert.deepEqual(migrated.libraries.map((library) => library.id), ["team", "mcp-gallery", "mcp-registry"]);
  assert.deepEqual(migrated.libraries[0], { id: "team", name: "Team", source: "https://team.example.com/catalogue", format: "json", enabled: true, headerName: "Authorization" });
  assert.deepEqual(catalogSettings.schema.parse(migrateCatalogValues({ teamSource: "", teamHeaderName: "" }, 1)).libraries, DEFAULT_LIBRARIES);
  assert.equal(catalogSettings.migrate, migrateCatalogValues);
});

test("settings: duplicate ids and bad header names are refused; new ids never clash", () => {
  const library = { id: "acme", name: "Acme", source: "https://acme.example/servers.json" };
  assert.equal(LibrariesSchema.safeParse([library, library]).success, false);
  assert.equal(LibrariesSchema.safeParse([{ ...library, headerName: "X.Api" }]).success, false);
  assert.equal(LibrariesSchema.safeParse([{ ...library, headerName: "Authorization" }]).success, true);
  assert.equal(LibrariesSchema.safeParse(Array.from({ length: 21 }, (_v, index) => ({ ...library, id: `a${index}` }))).success, false);
  assert.equal(libraryIdFor("Acme Tools!", []), "acme-tools");
  assert.equal(libraryIdFor("Acme Tools", ["acme-tools", "acme-tools-2"]), "acme-tools-3");
  assert.equal(libraryIdFor("", []), "library");
});

// -------------------------------------------------------------------- merge

const libCard = (name: string, url: string, library = gallery, meta: Record<string, unknown> = {}) =>
  libraryCard(only(doc(item({ name, remotes: [{ type: "streamable-http", url }] }, meta))), library);

test("merge: the first library to list a server name wins; a library's exact copy of a recommended server shows as the recommended card", () => {
  const recommended = CURATED_CATALOG.map(curatedCard);
  const notion = libCard("com.notion/mcp", "https://mcp.notion.com/mcp", gallery, { id: "notion", displayName: "Notion (gallery)", auth: "oauth" });
  assert.equal(notion.trust, "library", "a library card is never Official by itself");
  const acme = libCard("com.acme/mcp", "https://mcp.acme.example/mcp");
  assert.equal(acme.trust, "library");
  const other = { id: "acme-private", name: "Acme private", label: "~/acme.json" };
  const acmeAgain = libCard("com.acme/mcp", "https://mcp.acme-other.example/mcp", other);
  const otherOnly = libCard("com.other/mcp", "https://mcp.other.example/mcp", other);

  const merged = mergeGallery(recommended, [[notion, acme], [acmeAgain, otherOnly]]);
  const keys = merged.map((card) => card.key);
  assert.ok(keys.includes("recommended:notion"), "the exact copy is shown as the recommended card");
  assert.ok(!keys.includes("library:mcp-gallery:com.notion/mcp"));
  assert.equal(merged.filter((card) => card.registryName === "com.acme/mcp").length, 1, "one card per server name");
  assert.equal(merged.find((card) => card.registryName === "com.acme/mcp")?.library?.id, "acme-private", "a library the user added outranks the default one");
  assert.ok(keys.includes("library:acme-private:com.other/mcp"));
  assert.equal(merged.length, recommended.length + 2);
  // With no library read (offline, or the default library not published), the recommended list stands.
  assert.deepEqual(mergeGallery(recommended, [[]]).map((card) => card.key), recommended.map((card) => card.key));
});

test("merge: a library card at another address never hides a recommended card, even with its id", () => {
  const recommended = CURATED_CATALOG.map(curatedCard);
  const fake = libCard("com.github.fake/mcp", "https://github-mcp.evil.example/mcp", gallery, { id: "github", displayName: "GitHub" });
  assert.equal(fake.trust, "library");
  const merged = mergeGallery(recommended, [[fake]]);
  assert.ok(merged.some((card) => card.key === "recommended:github"));
  assert.ok(merged.some((card) => card.key === "library:mcp-gallery:com.github.fake/mcp"));
});

test("merge: a registry result already shown by name or address is left out", () => {
  const recommended = CURATED_CATALOG.map(curatedCard);
  const acme = libCard("com.acme/mcp", "https://mcp.acme.example/mcp");
  const registry: CatalogCard[] = [
    registryCard({ name: "com.acme/mcp", remotes: [{ type: "streamable-http", url: "https://elsewhere.example/mcp" }] }, known),
    registryCard({ name: "com.linear/other", remotes: [{ type: "streamable-http", url: "https://mcp.linear.app/mcp" }] }, known),
    registryCard({ name: "ai.new/one", remotes: [{ type: "streamable-http", url: "https://new.example/mcp" }] }, known),
    registryCard({ name: "ai.new/one", remotes: [{ type: "streamable-http", url: "https://new2.example/mcp" }] }, known),
  ];
  const merged = mergeGallery(recommended, [[acme]], registry);
  assert.deepEqual(merged.filter((card) => card.shelf === "registry").map((card) => card.key), ["registry:ai.new/one"]);
});
