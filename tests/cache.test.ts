import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { forgetAllFiles, forgetFile, PARSE_GRACE_MS, readJsonCached, readJsonCopy, readTextCached } from "../server/files";
import { keepLastGoodTools } from "../shared/tools";
import type { McpToolsReport } from "../shared/contracts";

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "paseo-mcp-cache-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a config is parsed once per change, and re-read when it changes", () => {
  forgetAllFiles();
  const { dir, done } = sandbox();
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { a: { url: "https://a" } } }));
    const first = readJsonCached(path);
    assert.equal(readJsonCached(path), first, "unchanged file: the same parse is handed back");
    writeFileSync(path, JSON.stringify({ mcpServers: { a: { url: "https://a" }, b: { url: "https://b" } } }));
    const second = readJsonCached(path) as { mcpServers: Record<string, unknown> };
    assert.notEqual(second, first);
    assert.deepEqual(Object.keys(second.mcpServers), ["a", "b"]);
  } finally {
    done();
  }
});

test("a file caught mid-write keeps its last good parse for a short grace, then reads as broken", () => {
  forgetAllFiles();
  const { dir, done } = sandbox();
  try {
    const path = join(dir, "claude.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { a: {} } }));
    const now = Date.now();
    const good = readJsonCached(path, now);
    writeFileSync(path, '{"mcpServers": {"a": {}, "b"');
    assert.equal(readJsonCached(path, now + 1000), good, "a half-written file does not empty the server list");
    assert.equal(readJsonCached(path, now + PARSE_GRACE_MS + 1), null, "a file that stays broken is reported as broken");
  } finally {
    done();
  }
});

test("copies are private, a missing file is null, and forgetFile drops the cache", () => {
  forgetAllFiles();
  const { dir, done } = sandbox();
  try {
    const path = join(dir, "c.json");
    writeFileSync(path, JSON.stringify({ list: [1] }));
    const copy = readJsonCopy<{ list: number[] }>(path)!;
    copy.list.push(2);
    assert.deepEqual((readJsonCached(path) as { list: number[] }).list, [1]);
    assert.equal(readJsonCached(join(dir, "missing.json")), null);
    assert.equal(readTextCached(join(dir, "missing.toml")), null);
    const before = readJsonCached(path);
    forgetFile(path);
    assert.notEqual(readJsonCached(path), before);
  } finally {
    done();
  }
});

function report(checkedAt: string, servers: McpToolsReport["servers"]): McpToolsReport {
  return { checkedAt, servers };
}

const listed = (name: string, count: number) => ({
  name,
  transport: "http" as const,
  kind: "listed" as const,
  note: `${count} tools`,
  tools: Array.from({ length: count }, (_, index) => ({ name: `t${index}`, title: "", description: "", takesArguments: false, arguments: [], required: [] })),
  serverInfo: null,
  protocolVersion: "",
});
const failed = (name: string, note: string, kind: "unavailable" | "auth-required" = "unavailable") => ({
  name,
  transport: "http" as const,
  kind,
  note,
  tools: [],
  serverInfo: null,
  protocolVersion: "",
});

test("a tool list survives a failed ask, marked with its time and the reason", () => {
  const earlier = report("2026-09-23T04:00:00.000Z", [listed("docs", 3), listed("search", 2)]);
  const next = report("2026-09-23T05:00:00.000Z", [failed("docs", "timeout after 5s"), listed("search", 4)]);
  const merged = keepLastGoodTools(earlier, next, () => true);
  assert.equal(merged.checkedAt, next.checkedAt);
  assert.equal(merged.servers[0]!.tools.length, 3);
  assert.deepEqual(merged.servers[0]!.stale, { reason: "timeout after 5s", asOf: earlier.checkedAt });
  assert.equal(merged.servers[1]!.tools.length, 4);
  assert.equal(merged.servers[1]!.stale, undefined);
  // A second failure keeps the original time, not the time of the first failure.
  const again = keepLastGoodTools(merged, report("2026-09-23T06:00:00.000Z", [failed("docs", "refused"), listed("search", 4)]), () => true);
  assert.equal(again.servers[0]!.stale?.asOf, earlier.checkedAt);
  assert.equal(again.servers[0]!.stale?.reason, "refused");
});

test("an edited definition, a sign-in wall or a first failure is shown as it is", () => {
  const earlier = report("2026-09-23T04:00:00.000Z", [listed("docs", 3), listed("crm", 5)]);
  const next = report("2026-09-23T05:00:00.000Z", [failed("docs", "timeout after 5s"), failed("crm", "sign in to list tools", "auth-required"), failed("new", "refused")]);
  const merged = keepLastGoodTools(earlier, next, (name) => name !== "docs");
  assert.equal(merged.servers[0]!.kind, "unavailable", "the URL changed, so the old list does not apply");
  assert.equal(merged.servers[1]!.kind, "auth-required");
  assert.equal(merged.servers[2]!.kind, "unavailable");
  assert.equal(keepLastGoodTools(null, next, () => true), next);
});
