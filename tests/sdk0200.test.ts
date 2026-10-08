/**
 * 0.20.0, Paseo's own plugin UI where it helps, and the review fixes:
 * - one redactor for everything a person sees, and CLI failures as a fixed
 *   sentence plus a redacted detail;
 * - copies through the app's clipboard; a rejected copy is a failed copy;
 * - toasts through one hook (the app's, or an inline line) that redacts;
 * - Remove asks in the app's dialog, or in the page on an app without one;
 *   each opening starts fresh, and Confirm acts once.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Destination } from "../shared/contracts";
import { clipboardCopier, createMessageStore, hostModal, toastHook, type ToastApi } from "../shared/host-features";
import { cliFailure, isSecretName, redactArgs, redactSecrets } from "../shared/redact";
import { JSON_EDIT_START, jsonDirty, jsonEditReducer, jsonToSave } from "../shared/json-edit";
import { openRemoveSession } from "../shared/remove-dialog";
import type { RemovePlan } from "../shared/servers";

const clientDir = join(import.meta.dirname, "..", "client");
const client = (file: string) => readFileSync(join(clientDir, file), "utf8");
const clientFiles = () => readdirSync(clientDir).filter((name) => /\.(tsx|ts)$/.test(name));

// ------------------------------------------------------------------ redactor

type CaseFile = { placeholders: Record<string, string[]>; cases: Array<{ name: string; input: string; expected: string }> };
const CASE_FILE = JSON.parse(readFileSync(join(import.meta.dirname, "..", "shared", "redact.cases.json"), "utf8")) as CaseFile;
/** Key-shaped values are stored as {{NAME}} plus fragments (GitHub push protection) and built here, at runtime. */
const fill = (text: string) => text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, name: string) => {
  const fragments = CASE_FILE.placeholders[name];
  assert.ok(fragments, `placeholder ${name} is defined`);
  return fragments.join("");
});
const CASES = CASE_FILE.cases.map((entry) => ({ name: entry.name, input: fill(entry.input), expected: fill(entry.expected) }));

test("the redactor meets every shared case (shared/redact.cases.json), the review's probes included", () => {
  assert.ok(CASES.length >= 40);
  for (const entry of CASES) assert.equal(redactSecrets(entry.input), entry.expected, entry.name);
  const names = CASES.map((entry) => entry.input);
  for (const probe of ["Authorization: bearer short-lived-credential", 'password="alpha beta"', 'args: ["--api-key", "short-lived-credential"]']) {
    assert.ok(names.includes(probe), `probe kept as a case: ${probe}`);
  }
});

test("the case file never holds a full key pattern: placeholders only, and every one is used", () => {
  const raw = readFileSync(join(import.meta.dirname, "..", "shared", "redact.cases.json"), "utf8");
  // The patterns themselves are built from fragments, so this file doesn't trip the same scanners.
  const prefixes = ["AK" + "IA[0-9A-Z]{16}", "AS" + "IA[0-9A-Z]{16}", "gh" + "p_[A-Za-z0-9]{20,}", "xo" + "x[baprs]-[A-Za-z0-9-]{6,}", "sk" + "_live_", "AI" + "za[0-9A-Za-z_-]{35}", "-----BEGIN [A-Z ]*" + "PRIVATE KEY-----", "ey" + "J[A-Za-z0-9_-]{8,}\\.ey" + "J", "sk-" + "ant-", "sk-" + "proj-"];
  for (const pattern of prefixes) assert.doesNotMatch(raw, new RegExp(pattern), pattern);
  const used = new Set(CASE_FILE.cases.flatMap((entry) => [...`${entry.input}\n${entry.expected}`.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((match) => match[1])));
  assert.deepEqual([...used].sort(), Object.keys(CASE_FILE.placeholders).sort());
  assert.ok(CASES.some((entry) => entry.input.startsWith("using " + "sk-" + "ant-")), "the loader builds the real shapes back");
});

test("redacting valid JSON keeps it valid JSON", () => {
  for (const entry of CASES) {
    let parsed = true;
    try { JSON.parse(entry.input); } catch { parsed = false; }
    if (parsed) assert.doesNotThrow(() => JSON.parse(entry.expected), entry.name);
  }
  const sample = JSON.stringify({ args: ["--api-key", "x y"], env: { GITHUB_TOKEN: "abc" }, headers: { Authorization: "•••cdef", "X-Api-Key": "k" } }, null, 2);
  assert.doesNotThrow(() => JSON.parse(redactSecrets(sample)), redactSecrets(sample));
});

test("no secret survives the cases: every hidden value is gone from the output", () => {
  const leaks: Array<[string, string]> = [
    ["Authorization: bearer short-lived-credential", "short-lived-credential"],
    ['password="alpha beta"', "beta"],
    ['args: ["--api-key", "short-lived-credential"]', "short-lived-credential"],
    ["npx server --token=abc --bearer xyz", "xyz"],
    ["GITHUB_TOKEN=ghx-short node server.js", "ghx-short"],
    ["api_key: plain yaml value", "yaml value"],
    ['Proxy-Authorization: Digest username="a", response="b"', 'response="b"'],
  ];
  for (const [input, secret] of leaks) assert.ok(!redactSecrets(input).includes(secret), `${input} -> ${redactSecrets(input)}`);
});

test("secret names are whole names: tokenizer, monkey, keyboard and author stay visible", () => {
  for (const name of ["token", "secret", "password", "passwd", "api_key", "apikey", "api-key", "apiKey", "auth", "authorization", "bearer", "client_secret", "access_token", "refresh_token", "private_key", "GITHUB_TOKEN", "STRIPE_SECRET", "x-api-key", '"Authorization"']) {
    assert.equal(isSecretName(name), true, name);
  }
  for (const name of ["tokenizer", "monkey", "keyboard", "author", "authority", "oauth", "secretary", "tokens_used", "url", "command"]) {
    assert.equal(isSecretName(name), false, name);
  }
});

test("argument lists hide a secret flag's value by position, and FOO_TOKEN=value items", () => {
  assert.deepEqual(redactArgs(["--api-key", "short-lived-credential", "--port", "3000"]), ["--api-key", "•••", "--port", "3000"]);
  assert.deepEqual(redactArgs(["--token=abc", "--password", "p", "--secret", "s", "--auth", "a", "--bearer", "b"]), ["--token=•••", "--password", "•••", "--secret", "•••", "--auth", "•••", "--bearer", "•••"]);
  assert.deepEqual(redactArgs(["FOO_TOKEN=x", "MONKEY=1", "--tokenizer", "bpe"]), ["FOO_TOKEN=•••", "MONKEY=1", "--tokenizer", "bpe"]);
  assert.deepEqual(redactArgs(["--token", "--verbose"]), ["--token", "•••"], "the item after a secret flag is always its value (release review)");
  assert.deepEqual(redactArgs(["--token", "-fixtureSecret", "--port", "3000"]), ["--token", "•••", "--port", "3000"]);
});

test("a failed CLI step is a fixed sentence only: nothing the CLI printed", () => {
  assert.equal(cliFailure("Couldn't sign out of 'acme'", "claude mcp logout", 3), "Couldn't sign out of 'acme' (claude mcp logout stopped with code 3). Run it in a terminal to see why.");
  assert.equal(cliFailure("Sign-in for 'acme' didn't finish", "codex mcp login", null), "Sign-in for 'acme' didn't finish (codex mcp login didn't finish). Run it in a terminal to see why.");
});

// --------------------------------------------------------------- hand editor

test("the hand editor: Save is impossible from the masked view; Reveal, edit, Save sends only the revealed text", () => {
  let state = JSON_EDIT_START;
  assert.equal(jsonToSave(state), null, "masked: nothing to save");
  state = jsonEditReducer(state, { type: "edit", text: '{"url": "•••"}' });
  assert.equal(state.mode, "masked", "the masked view can't be edited");
  assert.equal(jsonToSave(state), null);

  state = jsonEditReducer(state, { type: "reveal-start" });
  state = jsonEditReducer(state, { type: "revealed", raw: '{"url": "https://h/mcp", "headers": {"Authorization": "Bearer real"}}' });
  assert.equal(state.mode, "raw");
  assert.equal(jsonDirty(state), false);
  state = jsonEditReducer(state, { type: "edit", text: '{"url": "https://h2/mcp", "headers": {"Authorization": "Bearer real"}}' });
  assert.equal(jsonDirty(state), true);
  assert.equal(jsonToSave(state), '{"url": "https://h2/mcp", "headers": {"Authorization": "Bearer real"}}', "the real values go to Save");
  state = jsonEditReducer(state, { type: "saved", text: jsonToSave(state) as string });
  assert.equal(jsonDirty(state), false);
});

test("the hand editor: Hide drops the revealed text, and a reveal that lands after Hide is ignored", () => {
  let state = jsonEditReducer(JSON_EDIT_START, { type: "reveal-start" });
  state = jsonEditReducer(state, { type: "revealed", raw: "real" });
  state = jsonEditReducer(state, { type: "hide" });
  assert.deepEqual(state, JSON_EDIT_START);
  assert.equal(jsonToSave(state), null);

  state = jsonEditReducer(JSON_EDIT_START, { type: "reveal-start" });
  state = jsonEditReducer(state, { type: "hide" });
  state = jsonEditReducer(state, { type: "revealed", raw: "late" });
  assert.deepEqual(state, JSON_EDIT_START, "too late: still masked");
  state = jsonEditReducer(jsonEditReducer(JSON_EDIT_START, { type: "reveal-start" }), { type: "reveal-failed", error: "Couldn't read this definition. Try again." });
  assert.equal(state.mode, "masked");
});

test("the editor component: the masked view has no input and no Save; the raw buffer lives only in its state", () => {
  const source = client("mcp.tsx");
  const editor = source.slice(source.indexOf("function JsonEditor("), source.indexOf("function DestinationEditor("));
  const masked = editor.slice(editor.indexOf('if (state.mode === "masked")'), editor.indexOf("const buffer = state.buffer;"));
  assert.match(masked, /<CodeBlock copy=\{false\}>/);
  assert.match(masked, /label="Reveal to edit"/);
  assert.doesNotMatch(masked, /<Field|label="Save"/, "nothing editable or savable while masked");
  assert.match(editor, /const json = jsonToSave\(state\);\s*if \(json === null\) return;/, "Save and checks send only the revealed buffer");
  assert.match(editor, /label="Hide keys"/);
});

// ----------------------------------------------------------------- clipboard

test("copies use the app's clipboard where it has one, the old one only without it; a refusal is a failed copy", async () => {
  const viaApp: string[] = [];
  const viaOld: string[] = [];
  const old = (text: string) => void viaOld.push(text);

  assert.equal(await clipboardCopier({ copyText: async (text: string) => void viaApp.push(text) }, old)("a"), true);
  assert.deepEqual([viaApp, viaOld], [["a"], []], "the app's clipboard, not the old one");

  assert.equal(await clipboardCopier({}, old)("b"), true, "an app without copyText keeps the old path");
  assert.equal(await clipboardCopier(null, old)("c"), true);
  assert.deepEqual(viaOld, ["b", "c"]);

  const refused = { copyText: async () => Promise.reject(new Error("denied")) };
  assert.equal(await clipboardCopier(refused, old)("d"), false, "rejected: failed, and the old path isn't tried behind the user's back");
  assert.deepEqual(viaOld, ["b", "c"]);
  assert.equal(await clipboardCopier({}, () => false)("e"), false, "the web's old path says false when it fails");
  assert.equal(await clipboardCopier({}, () => { throw new Error("gone"); })("f"), false);
});

test("one copy path: nothing outside ui.tsx touches React Native's Clipboard, and a failed copy says Couldn't copy", () => {
  for (const file of clientFiles().filter((name) => name !== "ui.tsx")) {
    assert.doesNotMatch(client(file), /Clipboard\.setString|\bClipboard\b.*from "react-native"/, file);
    assert.doesNotMatch(client(file), /No clipboard here/, file);
  }
});

// -------------------------------------------------------------------- toasts

const recorder = () => {
  const seen: Array<[string, string]> = [];
  const api: ToastApi = { show: (message, options) => void seen.push([options?.variant ?? "default", message]), error: (message) => void seen.push(["error", message]) };
  return { seen, hook: () => api };
};

test("toasts use the app's toast where it has one, an inline line otherwise, and are always redacted", () => {
  const app = recorder();
  const inline = recorder();
  const withApp = toastHook({ useToast: app.hook }, inline.hook, redactSecrets);
  withApp().error("claude mcp logout: token=abc123 refused");
  withApp().show("Copied.", { variant: "success" });
  assert.deepEqual(app.seen, [["error", "claude mcp logout: token=••• refused"], ["success", "Copied."]]);
  assert.deepEqual(inline.seen, [], "the inline hook is never called beside the app's");

  const without = toastHook({}, inline.hook, redactSecrets);
  without().show("Bearer abcdef1234567890 rejected", { variant: "warning" });
  assert.deepEqual(inline.seen, [["warning", "Bearer ••• rejected"]]);
});

test("the inline fallback keeps the latest three messages and drops each after its time", () => {
  const timers: Array<() => void> = [];
  const store = createMessageStore((run) => timers.push(run));
  let changes = 0;
  const stop = store.subscribe(() => (changes += 1));
  for (const word of ["one", "two", "three", "four"]) store.push(word, "success");
  assert.deepEqual(store.read().map((entry) => entry.message), ["two", "three", "four"]);
  timers[1]();
  assert.deepEqual(store.read().map((entry) => entry.message), ["three", "four"]);
  stop();
  const before = changes;
  timers[2]();
  assert.equal(changes, before, "an unsubscribed screen hears nothing");
});

test("every screen gets toasts from the one hook in ui.tsx, never straight from the app", () => {
  for (const file of clientFiles()) {
    assert.doesNotMatch(client(file), /import \{[^}]*\buseToast\b[^}]*\} from "@getpaseo\/plugin\/client\/react-native"/, file);
    assert.doesNotMatch(client(file), /HostRN\.useToast\(/, file);
  }
});

// -------------------------------------------------------------------- remove

const dest = (id: string, label: string): Destination => ({ id, label, provider: id.includes("codex") ? "codex" : "claude", providerId: "", account: "", configPath: id, format: "json-mcp" });
const claude = dest("/h/.claude.json", "Claude");
const codex = dest("/h/.codex/config.toml", "Codex");
const destinations = [claude, codex];
const acme = { name: "acme", presentIn: [claude.id, codex.id], inlineCredentialsIn: [] };

test("the app's dialog where it has one; otherwise the confirm stays in the page", () => {
  const Modal = Object.assign(() => null, { Content: () => null });
  assert.equal(hostModal({ Modal }), Modal);
  assert.equal(hostModal({}), null);
  assert.equal(hostModal(null), null);
  assert.equal(hostModal({ Modal: "not a component" }), null);
  const source = client("mcp.tsx");
  assert.match(source, /const HostModal = hostModal<HostModalComponent>\(HostRN\);/, "chosen once, at load");
  assert.match(source, /if \(!HostModal\) \{[\s\S]*?<Notice tone="error">/, "the in-page confirm");
});

test("Confirm removes what the dialog shows, once: a double press removes once", () => {
  const removed: RemovePlan[] = [];
  const session = openRemoveSession({ server: acme, destinations, projectFiles: [], scope: "one", onRemove: (plan) => void removed.push(plan) });
  assert.equal(session.destId(), claude.id, "starts on the first app");
  session.select(codex.id);
  assert.deepEqual(session.plan()?.targets, [codex.id]);
  assert.equal(session.confirm(), true);
  assert.equal(session.confirm(), false, "the second press does nothing");
  assert.equal(removed.length, 1);
  assert.deepEqual(removed[0].targets, [codex.id], "what was shown is what is removed");
});

test("Cancel removes nothing, and the next opening starts fresh: no app left selected, Confirm armed again", () => {
  const removed: RemovePlan[] = [];
  const onRemove = (plan: RemovePlan) => void removed.push(plan);
  const first = openRemoveSession({ server: acme, destinations, projectFiles: [], scope: "one", onRemove });
  first.select(codex.id);
  // Cancel: the dialog drops its session without confirming.
  assert.equal(removed.length, 0);
  const second = openRemoveSession({ server: acme, destinations, projectFiles: [], scope: "one", onRemove });
  assert.equal(second.destId(), claude.id, "Codex isn't still selected");
  assert.equal(second.confirm(), true, "a new opening re-arms Confirm");
  assert.deepEqual(removed.map((plan) => plan.targets), [[claude.id]]);
});

test("an app the connector isn't in can't be picked, and an empty plan never removes", () => {
  const removed: RemovePlan[] = [];
  const session = openRemoveSession({ server: acme, destinations, projectFiles: [], scope: "one", onRemove: (plan) => void removed.push(plan) });
  session.select("/h/elsewhere.json");
  assert.equal(session.destId(), claude.id);
  const nowhere = openRemoveSession({ server: { ...acme, presentIn: [] }, destinations, projectFiles: [], scope: "all", onRemove: (plan) => void removed.push(plan) });
  assert.equal(nowhere.plan(), null);
  assert.equal(nowhere.confirm(), false);
  assert.equal(removed.length, 0);
});

test("the dialog is mounted per opening and keeps its session in a ref, so closing drops what it chose", () => {
  const source = client("mcp.tsx");
  const panel = source.slice(source.indexOf("function RemovePanel("), source.indexOf("// -------------------------------------------------------------------- surface"));
  assert.match(panel, /\) : \(\s*\/\/ Mounted per opening[^\n]*\n\s*<RemoveConfirm /, "rendered only while armed");
  assert.match(panel, /const session = useRef<RemoveSession \| null>\(null\);/);
  assert.match(panel, /onPress=\{\(\) => void current\.confirm\(\)\}/, "Confirm goes through the single-use session");
  assert.match(panel, /<HostModal\.Content>\s*<TokensProvider value=\{t\}>/, "a phone's sheet gets the tokens");
  assert.match(panel, /<HostModal title=\{`Remove \$\{server\.name\}\?`\}/, "a short title: the app cuts a long one");
});

test("a Copy button never offers a key: saved config only while keys are hidden, the sign-in link once", () => {
  const source = client("mcp.tsx");
  assert.match(source, /<CodeBlock copy=\{!revealed\}>\{rawRow\.nativePreview\}<\/CodeBlock>/);
  assert.match(source, /<CodeBlock copy=\{Boolean\(verdict\.preview\)\}>/);
  assert.match(source, /<CodeBlock copy=\{false\}>\{session\.url\}<\/CodeBlock>/, "the 'Copy link' button is the one way");
});
