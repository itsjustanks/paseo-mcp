import assert from "node:assert/strict";
import test from "node:test";
import { restoredTools } from "../server/report-cache";
import type { McpServerTools, McpToolsReport } from "../shared/contracts";
import { CHECKING_POLL_MS, backoffMs, cachedReadInterval, failureStreak } from "../shared/schedule";
import { keepLastGoodTools, LAST_GOOD_MAX_AGE_MS, youngEnough } from "../shared/tools";

type State = { errorUpdateCount: number; dataUpdatedAt: number; errorUpdatedAt: number };
const query = (state: State) => ({ state });

test("the failure streak counts errors since the last success, so the backoff grows", () => {
  // TanStack resets fetchFailureCount when each fetch starts; this must not.
  const q = query({ errorUpdateCount: 0, dataUpdatedAt: 100, errorUpdatedAt: 0 });
  assert.equal(failureStreak(q), 0);
  q.state = { errorUpdateCount: 1, dataUpdatedAt: 100, errorUpdatedAt: 200 };
  assert.equal(failureStreak(q), 1);
  q.state = { errorUpdateCount: 2, dataUpdatedAt: 100, errorUpdatedAt: 300 };
  assert.equal(failureStreak(q), 2);
  q.state = { errorUpdateCount: 3, dataUpdatedAt: 100, errorUpdatedAt: 400 };
  assert.equal(failureStreak(q), 3);
  assert.deepEqual([1, 2, 3].map((n) => backoffMs(n, 60_000, 15 * 60_000)), [120_000, 240_000, 480_000]);
  q.state = { errorUpdateCount: 3, dataUpdatedAt: 500, errorUpdatedAt: 400 };
  assert.equal(failureStreak(q), 0, "a success resets it");
  q.state = { errorUpdateCount: 4, dataUpdatedAt: 500, errorUpdatedAt: 600 };
  assert.equal(failureStreak(q), 1, "counted from the last success");
  assert.equal(failureStreak(query({ errorUpdateCount: 2, dataUpdatedAt: 0, errorUpdatedAt: 50 })), 2, "failing from the start");
});

test("a checking host is read every second, but only while reads succeed", () => {
  const checking = { report: null, checking: true };
  assert.equal(cachedReadInterval(checking, 0, 60_000, 900_000), CHECKING_POLL_MS);
  assert.equal(CHECKING_POLL_MS, 1000);
  // The reviewer's case: the first read said "checking", then the host went away.
  assert.equal(cachedReadInterval(checking, 1, 60_000, 900_000), 120_000, "back off instead of reading every second");
  assert.equal(cachedReadInterval(checking, 3, 60_000, 900_000), 480_000);
  assert.equal(cachedReadInterval({ report: { stale: { asOf: "x" } }, checking: true }, 0, 60_000, 900_000), CHECKING_POLL_MS, "a restored report is re-read until checked");
  assert.equal(cachedReadInterval({ report: {}, checking: true }, 0, 60_000, 900_000), 60_000, "a current report waits for the interval");
  assert.equal(cachedReadInterval({ report: {}, checking: false }, 0, 60_000, 900_000), 60_000);
});


const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-24T00:00:00Z");
const listed = (name: string, asOf?: string): McpServerTools => ({
  name, transport: "http", kind: "listed", note: "1 tools", serverInfo: null, protocolVersion: "",
  tools: [{ name: "t", title: "", description: "", takesArguments: false, arguments: [], required: [] }],
  ...(asOf ? { stale: { reason: "timeout", asOf } } : {}),
});
const unavailable = (name: string): McpServerTools => ({ name, transport: "http", kind: "unavailable", note: "timeout", tools: [], serverInfo: null, protocolVersion: "" });
const report = (servers: McpServerTools[], checkedAt: string): McpToolsReport => ({ servers, checkedAt });

test("a list that can no longer be read is kept for up to 7 days, then stops counting", () => {
  assert.equal(LAST_GOOD_MAX_AGE_MS, 7 * DAY);
  assert.equal(youngEnough(new Date(NOW - 6 * DAY).toISOString(), NOW), true);
  assert.equal(youngEnough(new Date(NOW - 8 * DAY).toISOString(), NOW), false);
  assert.equal(youngEnough("not a date", NOW), false);
  const recent = report([listed("a")], new Date(NOW - 2 * DAY).toISOString());
  assert.equal(keepLastGoodTools(recent, report([unavailable("a")], new Date(NOW).toISOString()), () => true, NOW).servers[0]!.kind, "listed");
  const old = report([listed("a", new Date(NOW - 9 * DAY).toISOString())], new Date(NOW - DAY).toISOString());
  assert.equal(keepLastGoodTools(old, report([unavailable("a")], new Date(NOW).toISOString()), () => true, NOW).servers[0]!.kind, "unavailable", "last really read 9 days ago");
});

test("a saved list older than 7 days is not restored after a restart", () => {
  const saved = report([listed("fresh"), listed("dead", new Date(NOW - 30 * DAY).toISOString()), unavailable("down")], new Date(NOW - DAY).toISOString());
  const names = restoredTools(saved, NOW).servers.map((entry) => entry.name);
  assert.deepEqual(names, ["fresh", "down"]);
});
