import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readInjectionStore, writeInjectionEnabled } from "../server/enabled";
import { planInjection } from "../server/hooks";
import { INJECTION_DEFAULTS } from "../shared/settings";

const settings = { ...INJECTION_DEFAULTS, injectWorkspaceServers: true, providers: ["codex" as const] };
const defs = {
  jam: { type: "http", url: "https://mcp.jam.dev/mcp" },
  supabase: { command: "npx", args: ["-y", "@supabase/mcp-server"] },
};

test("a server turned off for the workspace is left out of injection and reported as skipped", () => {
  const { injected, skipped } = planInjection(defs, {}, settings, ["jam"]);
  assert.deepEqual(Object.keys(injected), ["supabase"]);
  assert.deepEqual(skipped, ["jam (off for this workspace)"]);
  // Nothing disabled: both go in, as before 0.7.0.
  assert.deepEqual(Object.keys(planInjection(defs, {}, settings).injected), ["jam", "supabase"]);
});

test("the store file is created on first write, keyed by directory, and read back", () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-mcp-store-"));
  const path = join(dir, "nested", "workspace-disabled.json");
  try {
    assert.deepEqual(readInjectionStore(path), { version: 1, disabled: {} });
    assert.deepEqual(writeInjectionEnabled(path, "/home/demo/p", "jam", false), { state: "disabled", changed: true });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 1, disabled: { "/home/demo/p": ["jam"] } });
    assert.deepEqual(writeInjectionEnabled(path, "/home/demo/p", "jam", false), { state: "disabled", changed: false });
    assert.deepEqual(writeInjectionEnabled(path, "/home/demo/p", "jam", true), { state: "enabled", changed: true });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 1, disabled: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
