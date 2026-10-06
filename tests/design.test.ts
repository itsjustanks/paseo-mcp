/**
 * The shared design standard (0.17.0), as the user reshaped it in 0.19.0: four
 * tabs with no intro block under the bar, plain words that say "connector",
 * Help as plain questions, the type scale has nothing below 13 px, and the
 * newer Paseo features are used only where the app has them, so a 0.9.1 app
 * behaves as before.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { ADDED_TO_ONE_APP, FEWER_IS_FASTER, HELP_QUESTIONS, HOW_IT_WORKS, HOW_TO_USE, PROJECTS_LINE, TABS_META, TAB_ORDER, WHAT_CONNECTORS_ARE, WHAT_IS, WORDS } from "../shared/guide";
import { externalUrlOpener, supportsNativeScreens } from "../shared/host-features";

const jargon = /\b(editor|definition|command|provider|stdio|HTTP|OAuth|endpoint|host|daemon|grant|gap|JSON|config)s?\b|\.mcp\.json/i;
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).filter(Boolean).length;

/** "server" on its own; "MCP server(s)" is allowed where a connector is explained. */
const loneServer = /(?<!MCP )\bservers?\b/i;
/** Help answers name the computer with {host}; it isn't the word "host". */
const filled = (text: string) => text.split("{host}").join("this computer");

test("four tabs, each a label and an icon, and no intro block under the bar (0.19.0)", () => {
  assert.deepEqual([...TAB_ORDER], ["overview", "servers", "projects", "guide"]);
  assert.deepEqual(TAB_ORDER.map((id) => TABS_META[id].label), ["Overview", "Connectors", "Projects", "Help"]);
  for (const id of Object.keys(TABS_META) as Array<keyof typeof TABS_META>) assert.ok(TABS_META[id].label && TABS_META[id].icon, id);
  const root = decodeURIComponent(new URL("../", import.meta.url).pathname);
  assert.doesNotMatch(readFileSync(`${root}client/navigation.tsx`, "utf8"), /export function TabIntro/, "the stacked intro block is gone");
  assert.doesNotMatch(readFileSync(`${root}client/mcp.tsx`, "utf8"), /<TabIntro\b/);
});

test("Help is plain questions: each folded answer is short, plain and says connector", () => {
  assert.ok(HELP_QUESTIONS.length >= 5 && HELP_QUESTIONS.length <= 9);
  assert.equal(new Set(HELP_QUESTIONS.map((item) => item.question)).size, HELP_QUESTIONS.length, "no question twice");
  for (const item of HELP_QUESTIONS) {
    assert.ok(item.answer.length >= 1 && item.answer.length <= 3, item.question);
    for (const text of [item.question, ...item.answer.map(filled), item.action?.label ?? ""]) {
      assert.doesNotMatch(text, jargon, text);
      assert.doesNotMatch(text, loneServer, text);
    }
    for (const line of item.answer) assert.ok(sentences(line) <= 3, line);
  }
});

test("the words say connector: the explainer, the tabs, the guide and the glossary", () => {
  assert.match(WHAT_CONNECTORS_ARE, /^Connectors are MCP servers/);
  for (const text of [WHAT_CONNECTORS_ARE, PROJECTS_LINE, ...WHAT_IS, ...HOW_IT_WORKS.flatMap((step) => [step.title, step.text]), ...HOW_TO_USE, FEWER_IS_FASTER.text, ADDED_TO_ONE_APP.title, ADDED_TO_ONE_APP.text, ...WORDS.flatMap((word) => [word.term, word.text])]) {
    assert.doesNotMatch(text, loneServer, text);
  }
});

test("the guide says it plainly: what it is, four steps, how to use it, and the words", () => {
  assert.ok(WHAT_IS.length >= 1 && WHAT_IS.reduce((count, line) => count + sentences(line), 0) <= 3, "two or three sentences");
  assert.equal(HOW_IT_WORKS.length, 4);
  assert.ok(HOW_TO_USE.length >= 3 && HOW_TO_USE.length <= 5);
  for (const text of [...WHAT_IS, ...HOW_IT_WORKS.flatMap((step) => [step.title, step.text]), ...HOW_TO_USE, FEWER_IS_FASTER.text, ADDED_TO_ONE_APP.title, ADDED_TO_ONE_APP.text]) {
    assert.doesNotMatch(text, jargon, text);
  }
  assert.ok(WORDS.length >= 6);
  assert.equal(new Set(WORDS.map((word) => word.term)).size, WORDS.length, "no term twice");
  for (const word of WORDS) assert.ok(sentences(word.text) <= 2, word.term);
});

test("type: nothing below 13 px, and no raw size outside the TYPE scale", () => {
  const dir = decodeURIComponent(new URL("../client/", import.meta.url).pathname);
  for (const file of readdirSync(dir).filter((name) => /\.(tsx|ts)$/.test(name))) {
    const text = readFileSync(`${dir}${file}`, "utf8");
    for (const match of text.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)/g)) {
      assert.ok(Number(match[1]) >= 13, `${file}: fontSize ${match[1]}`);
      assert.equal(file, "ui.tsx", `${file}: a raw fontSize ${match[1]}; use TYPE`);
    }
  }
});

test("spacing: screens use the SPACE scale, never a raw number (only a -1 hairline overlap and 0)", () => {
  const dir = decodeURIComponent(new URL("../client/", import.meta.url).pathname);
  for (const file of readdirSync(dir).filter((name) => /\.(tsx|ts)$/.test(name) && name !== "ui.tsx")) {
    const text = readFileSync(`${dir}${file}`, "utf8");
    for (const match of text.matchAll(/\b(gap|rowGap|columnGap|padding[A-Za-z]*|margin[A-Za-z]*)(?:: ?|=\{)(-?\d+)/g)) {
      assert.ok(match[2] === "0" || match[2] === "-1", `${file}: ${match[1]} ${match[2]}; use SPACE`);
    }
  }
});

test("native screens only where the app has every part of them; a 0.9.1 app keeps the surface", () => {
  const fn = () => () => {};
  const paseo091 = { addSurface: fn, addSidebarItem: fn, openSurface: fn };
  const paseo011 = { ...paseo091, addScreen: fn, addSidebarHeaderItem: fn, openScreen: fn };
  const row = () => null;
  assert.equal(supportsNativeScreens(paseo091, undefined), false);
  assert.equal(supportsNativeScreens(paseo091, row), false);
  assert.equal(supportsNativeScreens(paseo011, row), true);
  assert.equal(supportsNativeScreens(paseo011, undefined), false, "no SidebarRow to draw it");
  assert.equal(supportsNativeScreens({ ...paseo011, openScreen: undefined }, row), false);
  assert.equal(supportsNativeScreens(null, row), false);
});

test("links open through the app's own opener where it has one (0.10+), else as before", async () => {
  assert.equal(externalUrlOpener({}), null);
  assert.equal(externalUrlOpener(null), null);
  assert.equal(externalUrlOpener({ openExternalUrl: "not a function" }), null);
  const opened: string[] = [];
  const opener = externalUrlOpener({ openExternalUrl: async (url: string) => void opened.push(url) });
  await opener?.("https://example.com");
  assert.deepEqual(opened, ["https://example.com"]);
});

test("the sidebar '+' opens the MCP page on Add a server, and a second press opens it again", async () => {
  const { addServerParams, addServerRequest } = await import("../shared/screen-params");
  const first = addServerParams(1000);
  const second = addServerParams(2000);
  assert.equal(addServerRequest(first), "1000");
  assert.notEqual(addServerRequest(first), addServerRequest(second), "each press is new");
  assert.equal(addServerRequest({}), null, "the plain sidebar row opens the page as it was");
  assert.equal(addServerRequest(undefined), null);
  assert.equal(addServerRequest({ add: "something-else" }), null);
});

test("the app calls the plugin Connectors: the sidebar row, the page and its panels all use the one name (0.19.0)", async () => {
  const { MCP_NAME, MCP_NAME_LOWER } = await import("../shared/guide");
  assert.equal(MCP_NAME, "Connectors");
  assert.equal(MCP_NAME_LOWER, "connectors");
  const root = decodeURIComponent(new URL("../", import.meta.url).pathname);
  const entry = readFileSync(`${root}index.client.tsx`, "utf8");
  assert.doesNotMatch(entry, /title: "MCP( servers| connections)?"/, "a title still says MCP on its own");
  assert.match(readFileSync(`${root}client/sidebar.tsx`, "utf8"), /label=\{MCP_NAME\}/);
  for (const file of ["client/mcp.tsx", "client/catalog.tsx", "client/budget.tsx", "server/catalog.ts"]) {
    assert.doesNotMatch(readFileSync(`${root}${file}`, "utf8"), /MCP connections|Open MCP management|title="MCP servers"|Connectors \(MCP\)|"Add by hand"|Import & Export|Guide & Setup/, file);
  }
});
