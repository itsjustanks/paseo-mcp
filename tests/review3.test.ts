/**
 * 0.20.0, third review: editor diagnostics never quote a raw key, the Fields
 * form reveals into its own buffer, the redactor's multi-line and structural
 * gaps, and "From all apps and projects" naming Claude's own copies first.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Destination } from "../shared/contracts";
import { formatIssue, genericParserMessage } from "../shared/issues";
import { REVEAL_START, revealReducer, revealedValue, type RevealState } from "../shared/json-edit";
import { displayCommand, isSecretFlag, redactArgs, redactSecrets, redactValue } from "../shared/redact";
import { localRemoveCommand, removePlan } from "../shared/servers";

const client = (file: string) => readFileSync(join(import.meta.dirname, "..", "client", file), "utf8");

test("a diagnostic is where to look and the parser's words, redacted: never a copy of the line", () => {
  const source = '{\n  "credentials": {\n    "value": "hunter2-live"x\n  }\n}';
  const text = formatIssue(source, { line: 3, column: 27, message: "Expected ',' or '}' after property value" });
  assert.equal(text, "Line 3, column 27: Expected ',' or '}' after property value");
  assert.ok(!text.includes("hunter2-live"));
  assert.ok(!text.includes("\n"), "no excerpt line");
  // V8 sometimes quotes the input in its message; that is dropped too.
  assert.equal(genericParserMessage('Unexpected token \'x\', "    "value": "hunter2-live"x" is not valid JSON'), "Unexpected token 'x'");
  assert.equal(genericParserMessage("Expected ',' or '}' after property value in JSON at position 39 (line 3 column 20)"), "Expected ',' or '}' after property value");
  assert.equal(formatIssue("", { line: 0, column: 0, message: "token=abc123 refused" }), "token=••• refused", "other messages are redacted");
  const issues = client("mcp.tsx").slice(client("mcp.tsx").indexOf("function Issues("), client("mcp.tsx").indexOf("function Lines("));
  assert.match(issues, /\{formatIssue\(source, issue\)\}/, "Issues render (and Copy) only this text");
});

test("the Fields form: masked until Reveal; Hide drops the revealed values; a late reveal is ignored", () => {
  type Row = { command: string };
  let state: RevealState<Row> = REVEAL_START;
  assert.equal(revealedValue(state), null, "nothing to save while masked");
  state = revealReducer(state, { type: "revealed", value: { command: "too early" } });
  assert.equal(state.mode, "masked", "no reveal without asking");
  state = revealReducer(revealReducer(state, { type: "reveal-start" }), { type: "revealed", value: { command: "node server --api-key real" } });
  assert.deepEqual(revealedValue(state), { command: "node server --api-key real" });
  state = revealReducer(state, { type: "hide" });
  assert.equal(revealedValue(state), null);
  state = revealReducer(revealReducer(REVEAL_START, { type: "reveal-start" }), { type: "hide" });
  state = revealReducer(state, { type: "revealed", value: { command: "late" } });
  assert.equal(revealedValue(state), null, "a reveal after Hide stays hidden");
  const fields = client("mcp.tsx").slice(client("mcp.tsx").indexOf("function FieldsEditor("), client("mcp.tsx").indexOf("function FieldsForm("));
  assert.match(fields, /<CodeBlock copy=\{false\}>/);
  assert.match(fields, /label="Reveal to edit"/);
  assert.doesNotMatch(fields, /<Field |label="Save/, "nothing editable or savable while masked");
});

test("commands show with secret flags hidden: --api-key, --token=, -p unless a port", () => {
  assert.equal(displayCommand("node", ["server", "--api-key", "fixture-secret"]), "node server --api-key •••");
  assert.equal(displayCommand("server", ["-p", "hunter2", "--port", "3000"]), "server -p ••• --port 3000");
  assert.equal(displayCommand("server", ["-p", "3000"]), "server -p 3000");
  assert.equal(isSecretFlag("-p", "8080"), false);
  assert.equal(isSecretFlag("-p", "s3cret"), true);
  assert.equal(isSecretFlag("--pass", "x"), true);
  assert.equal(isSecretFlag("--passthrough", "x"), false);
  assert.deepEqual(redactArgs(["-p=pw", "-p", "443"]), ["-p=•••", "-p", "443"]);
});

test("structure: a secret key at any depth, and an object under a secret key, are hidden whole", () => {
  assert.deepEqual(redactValue({ oauth: { password: "secret", clientId: "abc" } }), { oauth: { password: "•••", clientId: "abc" } });
  assert.deepEqual(redactValue({ credentials: { user: "ann", nested: { v: 1 } } }), { credentials: { user: "•••", nested: { v: "•••" } } });
  assert.deepEqual(redactValue({ args: ["--token", "t", "-p", "3000"] }), { args: ["--token", "•••", "-p", "3000"] });
  assert.equal(redactSecrets('{"oauth":{"password":"secret"}}'), '{"oauth":{"password":"•••"}}');
});

test("multi-line: PEM blocks and TOML multiline strings under a secret key go whole, letters-only lines included", () => {
  // Built from fragments so the file never holds a full PEM header (GitHub push protection).
  const begin = "-----BEGIN " + "PRIVATE KEY-----";
  const end = "-----END " + "PRIVATE KEY-----";
  const pem = `private_key = """\n${begin}\nABCDEFGHIJKLMNOPQRSTUVWXYZabcdef\n${"MIIEvQIBADAN" + "BgkqhkiG9w0BAQEFAASC"}\n${end}\n"""`;
  const out = redactSecrets(pem);
  for (const line of ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "BEGIN PRIVATE KEY"]) assert.ok(!out.includes(line), out);
  assert.equal(redactSecrets("Basic dXNlcjpwYXNz"), "Basic •••");
  assert.equal(redactSecrets("Token expired"), "Token expired");
});

const dest = (id: string, label: string): Destination => ({ id, label, provider: "claude", providerId: "claude", account: "", configPath: id, format: "json-mcp" });
const claude = dest("/h/.claude.json", "Claude");

test("Claude's \"just for you\" copy is never removed here: the plan says it stays and gives the command", () => {
  const server = { name: "acme", presentIn: [claude.id], inlineCredentialsIn: [], localIn: [{ destId: claude.id, project: "/h/code/data-glue" }] };
  const everywhere = removePlan(server, [claude], "everywhere", undefined, [{ project: "data-glue", path: "/h/code/data-glue/.mcp.json" }]);
  assert.ok(everywhere);
  assert.equal(everywhere.confirmLabel, "Remove from 1 app and 1 project file", "promises only what it does");
  assert.ok(everywhere.lines.some((line) => line === `Claude Code's "just for you" copy in data-glue stays. Remove it in Claude Code with: claude mcp remove acme -s local`));
  assert.equal(removePlan({ ...server, presentIn: [] }, [claude], "everywhere"), null, "a just-for-you copy alone has nothing this plugin removes");
  assert.equal(localRemoveCommand("acme", "/h/code/data-glue"), "cd '/h/code/data-glue' && claude mcp remove acme -s local");
  assert.equal(localRemoveCommand("odd name"), "claude mcp remove 'odd name' -s local");
  const panel = client("mcp.tsx");
  assert.match(panel, /From all apps and project files \(/);
  assert.doesNotMatch(panel, /From all apps and projects \(/);
});
