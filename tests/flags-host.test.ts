/**
 * 0.20.0 final gate: a secret flag after a boolean flag in a command string
 * (`--verbose --api-key X`) was skipped, because one match spanned both
 * flags. Words are now checked one by one. The repro, through the views a
 * person sees with keys hidden.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-flags-"));
process.env.HOME = home;
process.env.PASEO_HOME = join(home, ".paseo");
delete process.env.AGENT_LINK_HOME;
delete process.env.AGENT_AUTH_HOME;
after(() => rmSync(home, { recursive: true, force: true }));
writeFileSync(
  join(home, ".claude.json"),
  JSON.stringify({ oauthAccount: { emailAddress: "me@example.com" }, mcpServers: { fixture: { command: "sh", args: ["-c", "exec fixture-server --verbose --api-key -fixtureSecret"] } } }),
);
const context = { paseo: { config: { get: async () => ({ config: { providers: {} } }), patch: async () => ({}) }, projects: { list: async () => [] } } } as never;
const { handleMcpDefAll } = await import("../server/handlers");
const { handleMcpRawGet } = await import("../server/mcpjson");
const { redactSecrets } = await import("../shared/redact");

test("the repro: hidden JSON, the saved-config preview and the Fields command never show -fixtureSecret", async () => {
  const raw = (await handleMcpRawGet({ name: "fixture", reveal: false }, context)).rows.find((row) => row.found);
  assert.ok(raw);
  assert.ok(!raw.json.includes("fixtureSecret"), raw.json);
  assert.ok(!raw.nativePreview.includes("fixtureSecret"), raw.nativePreview);
  assert.match(raw.json, /--verbose --api-key •••/);
  const fields = (await handleMcpDefAll({ name: "fixture", reveal: false }, context)).rows.find((row) => row.found);
  assert.ok(fields);
  assert.equal(fields.command, "sh -c exec fixture-server --verbose --api-key •••");
  const revealed = (await handleMcpDefAll({ name: "fixture", reveal: true }, context)).rows.find((row) => row.found);
  assert.match(revealed?.command ?? "", /--api-key -fixtureSecret$/, "Reveal still shows the real value");
});

test("the variants: every secret value hidden in place, everything else (ports, spacing, quotes) kept", () => {
  assert.equal(redactSecrets("--verbose --api-key X"), "--verbose --api-key •••");
  assert.equal(redactSecrets('-v --token "a b"'), '-v --token "•••"');
  assert.equal(redactSecrets("--quiet --password=-x"), "--quiet --password=•••");
  assert.equal(redactSecrets("cmd --debug --secret 'y z' --port 3000"), "cmd --debug --secret '•••' --port 3000");
  assert.equal(redactSecrets("cmd  --verbose   --token  t2"), "cmd  --verbose   --token  •••", "spacing kept");
  assert.equal(redactSecrets("server -p 3000 --verbose -p hunter2"), "server -p 3000 --verbose -p •••");
});
