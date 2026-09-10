import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { removeFromProjectFile } from "../server/handlers";

/**
 * Removing a server from a project `.mcp.json`, against files in a temp
 * directory. No real project file is ever touched.
 */
function withFile<T>(content: string, run: (path: string, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "paseo-mcp-remove-"));
  const path = join(dir, ".mcp.json");
  writeFileSync(path, content);
  try {
    return run(path, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FILE = {
  $schema: "https://example.test/mcp.schema.json",
  mcpServers: {
    jam: { type: "http", url: "https://mcp.jam.dev/mcp" },
    supabase: { command: "npx", args: ["-y", "@supabase/mcp-server"], env: { SUPABASE_ACCESS_TOKEN: "sbp_secret" } },
  },
  somethingElse: { keep: true },
};

test("removing a server keeps every other key, backs the file up, and reads back clean", () => {
  withFile(JSON.stringify(FILE, null, 2), (path, dir) => {
    assert.equal(removeFromProjectFile(path, "jam"), "removed");
    const after = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(after, { $schema: FILE.$schema, mcpServers: { supabase: FILE.mcpServers.supabase }, somethingElse: { keep: true } });
    assert.ok(readdirSync(dir).some((file) => file.startsWith(".mcp.json.bak-paseo-mcp-")));
    assert.ok(!readdirSync(dir).some((file) => file.endsWith(".tmp-paseo-mcp")));
  });
});

test("the last server leaves an empty mcpServers object, never a deleted file", () => {
  withFile(JSON.stringify({ mcpServers: { jam: { type: "http", url: "https://mcp.jam.dev/mcp" } } }), (path) => {
    assert.equal(removeFromProjectFile(path, "jam"), "removed");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { mcpServers: {} });
  });
});

test("a server the file does not define is reported absent and the file is not written", () => {
  withFile(JSON.stringify(FILE, null, 2), (path, dir) => {
    const before = readFileSync(path, "utf8");
    assert.equal(removeFromProjectFile(path, "ghost"), "absent");
    assert.equal(readFileSync(path, "utf8"), before);
    assert.equal(readdirSync(dir).filter((file) => file.includes(".bak-")).length, 0);
  });
});

test("an unparseable or missing file is refused, not overwritten", () => {
  withFile("{ not json", (path) => {
    assert.throws(() => removeFromProjectFile(path, "jam"), /not valid JSON/);
    assert.equal(readFileSync(path, "utf8"), "{ not json");
    rmSync(path);
    assert.throws(() => removeFromProjectFile(path, "jam"), /does not exist/);
  });
});
