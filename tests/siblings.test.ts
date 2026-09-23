import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { forgetAllFiles } from "../server/files";
import { readSettingsDocument, settingsPath } from "../server/settings";
import { handleMcpSiblings, pluginInstalled, pluginListed, siblingRecordPaths } from "../server/siblings";
import { PROMO_DEFAULTS, promoSettings } from "../shared/settings";
import { AI_ROUTER } from "../shared/siblings";

function home() {
  const dir = mkdtempSync(join(tmpdir(), "paseo-mcp-siblings-"));
  mkdirSync(join(dir, "plugins"), { recursive: true });
  const paths = siblingRecordPaths(dir);
  return {
    dir,
    sources: (value: unknown) => writeFileSync(paths.sources, typeof value === "string" ? value : JSON.stringify(value)),
    config: (value: unknown) => writeFileSync(paths.config, typeof value === "string" ? value : JSON.stringify(value)),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ------------------------------------------------------------ installed check

test("a git or npm install is found by its key in plugins/sources.json", () => {
  forgetAllFiles();
  const h = home();
  try {
    h.sources({ "paseo-mcp": { kind: "git" }, "ai-router": { kind: "git", url: "https://github.com/itsjustanks/paseo-plugin-ai-router.git" } });
    assert.equal(pluginInstalled("ai-router", h.dir), true);
    assert.equal(pluginInstalled("shared-browser", h.dir), false);
  } finally {
    h.done();
  }
});

test("a directory install, which sources.json does not list, is found in config.json plugins", () => {
  forgetAllFiles();
  const h = home();
  try {
    // What a Mac with AI Router installed from a folder looked like: sources.json `{}`.
    h.sources({});
    h.config({ pluginsEnabled: true, plugins: { "ai-router": { source: "directory", path: "/src/ai-router/apps/paseo", enabled: false } } });
    assert.equal(pluginInstalled("ai-router", h.dir), true, "installed but disabled still counts");
  } finally {
    h.done();
  }
});

test("missing, broken or oddly shaped records read as not installed", () => {
  forgetAllFiles();
  const h = home();
  try {
    assert.equal(pluginInstalled("ai-router", h.dir), false, "no files at all");
    h.sources("{ not json");
    h.config({ plugins: ["ai-router"] });
    assert.equal(pluginInstalled("ai-router", h.dir), false);
    assert.equal(pluginListed("ai-router", ["ai-router"], null), false, "an array is not a record keyed by id");
    assert.equal(pluginListed("ai-router", { "ai-router-buildcheck": {} }, { plugins: { "paseo-mcp": {} } }), false, "a key that only starts with the id does not count");
    assert.equal(pluginListed("toString", {}, {}), false, "inherited keys do not count");
  } finally {
    h.done();
  }
});

test("the answer follows the files: installing and removing flip it without a restart", () => {
  forgetAllFiles();
  const h = home();
  try {
    h.sources({ "paseo-mcp": {} });
    assert.equal(pluginInstalled("ai-router", h.dir), false);
    h.sources({ "paseo-mcp": {}, "ai-router": { kind: "git", ref: "main" } });
    assert.equal(pluginInstalled("ai-router", h.dir), true);
    h.sources({ "paseo-mcp": {} });
    assert.equal(pluginInstalled("ai-router", h.dir), false);
  } finally {
    h.done();
  }
});

test("the RPC reads $PASEO_HOME and answers for AI Router", () => {
  forgetAllFiles();
  const h = home();
  const before = process.env.PASEO_HOME;
  try {
    process.env.PASEO_HOME = h.dir;
    assert.deepEqual(handleMcpSiblings(), { aiRouter: { installed: false } });
    h.sources({ [AI_ROUTER.id]: { kind: "git" } });
    assert.deepEqual(handleMcpSiblings(), { aiRouter: { installed: true } });
  } finally {
    if (before === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = before;
    h.done();
  }
});

test("the card points at the public repo and its git install source", () => {
  assert.equal(AI_ROUTER.repoUrl, "https://github.com/itsjustanks/paseo-plugin-ai-router");
  assert.equal(AI_ROUTER.installSource, "git:https://github.com/itsjustanks/paseo-plugin-ai-router.git:apps/paseo");
});

// ---------------------------------------------------------------- Hide setting

test("the card shows by default, and Hide is kept in the plugin's promo settings file", () => {
  assert.equal(PROMO_DEFAULTS.hideAiRouter, false);
  assert.equal(promoSettings.scope, "host");
  const dir = mkdtempSync(join(tmpdir(), "paseo-mcp-promo-"));
  try {
    const path = join(dir, "promo.json");
    assert.deepEqual(readSettingsDocument(promoSettings, PROMO_DEFAULTS, path), { hideAiRouter: false }, "no file yet: shown");
    writeFileSync(path, JSON.stringify({ version: promoSettings.version, values: { hideAiRouter: true } }));
    assert.deepEqual(readSettingsDocument(promoSettings, PROMO_DEFAULTS, path), { hideAiRouter: true });
    writeFileSync(path, JSON.stringify({ version: promoSettings.version + 1, values: { hideAiRouter: true } }));
    assert.deepEqual(readSettingsDocument(promoSettings, PROMO_DEFAULTS, path), PROMO_DEFAULTS, "another schema version is not guessed at");
    writeFileSync(path, JSON.stringify({ version: promoSettings.version, values: { hideAiRouter: "yes" } }));
    assert.deepEqual(readSettingsDocument(promoSettings, PROMO_DEFAULTS, path), PROMO_DEFAULTS, "an invalid value falls back to showing the card");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.match(settingsPath(promoSettings.id), /plugin-settings[\\/]paseo-mcp[\\/]promo\.json$/);
});
