/**
 * 0.15.0: calls back into the daemon on the panel's path (the project list and
 * the provider settings) go through one cache: a copy answers at once and is
 * refreshed in the background, one call at a time, the last good copy survives
 * a failure, and a write marks it out of date. The last test runs the real
 * `auth` and `catalog` handlers against a daemon that takes 8 s to answer.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-daemon-cache-"));
const project = join(home, "code", "demo");
mkdirSync(project, { recursive: true });
mkdirSync(join(home, ".codex"), { recursive: true });
writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@example.com" }, mcpServers: { docs: { type: "http", url: "https://docs.example.com/mcp" } }, projects: {} }));
writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { notion: { type: "http", url: "https://mcp.notion.com/mcp" } } }));
process.env.HOME = home;
process.env.PASEO_HOME = join(home, ".paseo");
delete process.env.AGENT_LINK_HOME;
delete process.env.AGENT_AUTH_HOME;

const { daemonRead, daemonReadCalls, resetDaemonReads, DAEMON_CACHE_TTL_MS } = await import("../server/daemon-cache");
const { handleMcpAuth } = await import("../server/handlers");
const { handleMcpCatalog, setCatalogFetch, resetCatalogCaches } = await import("../server/catalog");
const { handleMcpSetPaseoTools, resetPaseoToolsCache } = await import("../server/paseo-tools");

after(() => rmSync(home, { recursive: true, force: true }));

const paseo = {} as never;
const tick = () => new Promise((done) => setImmediate(done));

/** A loader whose answers the test hands out one by one. */
function manual<T>() {
  const waiting: Array<{ resolve: (value: T) => void; reject: (error: Error) => void }> = [];
  return {
    load: () => new Promise<T>((resolve, reject) => void waiting.push({ resolve, reject })),
    answer: (value: T) => waiting.shift()!.resolve(value),
    fail: (message: string) => waiting.shift()!.reject(new Error(message)),
    pending: () => waiting.length,
  };
}

test("single-flight: twenty first reads make one daemon call and share its answer", async () => {
  const daemon = manual<string[]>();
  const cache = daemonRead({ load: daemon.load });
  const reads = Array.from({ length: 20 }, () => cache.read(paseo));
  await tick();
  assert.equal(cache.calls(), 1);
  daemon.answer(["demo"]);
  for (const read of await Promise.all(reads)) assert.deepEqual(read, ["demo"]);
});

test("TTL: a copy answers without a call; an old copy answers at once and is refreshed once in the background", async () => {
  let clock = 1_000;
  const daemon = manual<string>();
  const cache = daemonRead({ load: daemon.load, now: () => clock, ttlMs: 15_000 });
  const first = cache.read(paseo);
  daemon.answer("v1");
  assert.equal(await first, "v1");

  clock += 14_999;
  assert.equal(await cache.read(paseo), "v1");
  assert.equal(cache.calls(), 1, "inside the TTL nothing reaches the daemon");

  clock += 1;
  assert.equal(await cache.read(paseo), "v1", "an old copy still answers at once");
  assert.equal(await cache.read(paseo), "v1");
  assert.equal(cache.calls(), 2, "one background refresh for both reads");
  daemon.answer("v2");
  await tick();
  assert.equal(await cache.read(paseo), "v2");
  assert.equal(cache.calls(), 2);
});

test("last good copy: a failed refresh keeps it, and is not retried from a read until a TTL has passed", async () => {
  let clock = 0;
  const daemon = manual<string>();
  const cache = daemonRead({ load: daemon.load, now: () => clock, ttlMs: 15_000 });
  const first = cache.read(paseo);
  daemon.answer("good");
  await first;

  clock += 20_000;
  assert.equal(await cache.read(paseo), "good");
  daemon.fail("Paseo did not return its project list within 10 s");
  await tick();
  assert.equal(await cache.read(paseo), "good", "the failure keeps the last good copy");
  clock += 5_000;
  assert.equal(await cache.read(paseo), "good");
  assert.equal(cache.calls(), 2, "no retry from a read right after a failure");

  clock += 10_000;
  assert.equal(await cache.read(paseo), "good");
  assert.equal(cache.calls(), 3, "tried again once a TTL has passed");
  daemon.answer("better");
  await tick();
  assert.equal(await cache.read(paseo), "better");

  // A fresh read that fails answers with the copy instead of throwing.
  const fresh = cache.read(paseo, { fresh: true });
  daemon.fail("busy");
  assert.equal(await fresh, "better");
});

test("no copy yet: a failure is the caller's to handle", async () => {
  const daemon = manual<string>();
  const cache = daemonRead({ load: daemon.load });
  const first = cache.read(paseo);
  daemon.fail("unreachable");
  await assert.rejects(first, /unreachable/);
});

test("invalidate: the very next read waits for a new answer, never the old copy; a call from before the write is never taken as fresh", async () => {
  let clock = 0;
  const daemon = manual<string>();
  const cache = daemonRead({ load: daemon.load, now: () => clock, ttlMs: 15_000 });
  const first = cache.read(paseo);
  daemon.answer("before");
  await first;

  cache.invalidate();
  const next = cache.read(paseo);
  assert.equal(cache.calls(), 2, "a new call, though the copy is inside the TTL");
  daemon.answer("after");
  assert.equal(await next, "after", "the read right after invalidate() is the new answer");
  assert.equal(await cache.read(paseo), "after");

  // A failed call after invalidate: the old copy is still better than nothing.
  cache.invalidate();
  const failing = cache.read(paseo);
  daemon.fail("daemon busy");
  assert.equal(await failing, "after");

  // A write while a call is in flight: a fresh read starts its own call, and
  // the older call finishing last does not overwrite the newer answer.
  clock += 20_000;
  void cache.read(paseo); // a refresh, in flight
  assert.equal(cache.calls(), 4);
  cache.invalidate();
  const fresh = cache.read(paseo, { fresh: true });
  assert.equal(cache.calls(), 5, "the fresh read does not join the call from before the write");
  daemon.answer("read before the write"); // call 4
  daemon.answer("read after the write"); // call 5
  assert.equal(await fresh, "read after the write");
  await tick();
  assert.equal(await cache.read(paseo), "read after the write");
});

test("markOld (Refresh pressed): the next read refreshes in the background and joins a call already running", async () => {
  let clock = 0;
  const daemon = manual<string>();
  const cache = daemonRead({ load: daemon.load, now: () => clock, ttlMs: 15_000 });
  const first = cache.read(paseo);
  daemon.answer("v1");
  await first;
  cache.markOld();
  assert.equal(await cache.read(paseo), "v1");
  assert.equal(cache.calls(), 2);
  cache.markOld();
  assert.equal(await cache.read(paseo), "v1");
  assert.equal(cache.calls(), 2, "pressing twice while a call runs is still one call");
  daemon.answer("v2");
  await tick();
  assert.equal(await cache.read(paseo), "v2");
});

test("reset forgets the copy, and a call in flight at reset is not kept", async () => {
  const daemon = manual<string>();
  const cache = daemonRead({ load: daemon.load });
  const first = cache.read(paseo);
  cache.reset();
  daemon.answer("old");
  assert.equal(await first, "old");
  const second = cache.read(paseo);
  assert.equal(cache.calls(), 2, "nothing was kept from before the reset");
  daemon.answer("new");
  assert.equal(await second, "new");
});

test("a slow daemon (8 s): auth and catalog wait once, then answer in under 50 ms, and writes invalidate", async () => {
  resetDaemonReads();
  resetCatalogCaches();
  resetPaseoToolsCache();
  // No network: every library reads as missing.
  setCatalogFetch((async () => new Response("not found", { status: 404 })) as typeof fetch);
  const SLOW_MS = 8_000;
  const slow = <T>(value: T) => new Promise<T>((done) => setTimeout(() => done(value), SLOW_MS));
  const daemonCalls = { projects: 0, config: 0 };
  const config: Record<string, unknown> = { providers: {}, mcp: { enabled: true, injectIntoAgents: true } };
  const slowPaseo = {
    config: {
      get: () => { daemonCalls.config += 1; return slow({ config }); },
      patch: async () => ({}),
    },
    projects: { list: () => { daemonCalls.projects += 1; return slow({ entries: [{ name: "demo", path: project }] }); } },
  };
  const context = { paseo: slowPaseo } as never;

  // The first reads wait for the daemon, together: one call for each list.
  const began = Date.now();
  const [auth, catalog] = await Promise.all([handleMcpAuth({}, context), handleMcpCatalog({ query: "" }, context)]);
  const firstMs = Date.now() - began;
  assert.ok(firstMs >= SLOW_MS - 50 && firstMs < SLOW_MS + 1_500, `first reads took ${firstMs} ms`);
  assert.deepEqual(auth.projectServers.map((entry) => entry.name), ["notion"]);
  assert.deepEqual(catalog.projects.map((entry) => entry.name), ["demo"]);
  assert.deepEqual(daemonCalls, { projects: 1, config: 1 });

  const timed = async <T>(run: () => Promise<T>) => {
    const start = performance.now();
    const value = await run();
    return { value, ms: performance.now() - start };
  };
  for (let index = 0; index < 5; index += 1) {
    const second = await timed(() => handleMcpAuth({}, context));
    assert.ok(second.ms < 50, `auth read ${index + 2} took ${second.ms.toFixed(1)} ms`);
    assert.deepEqual(second.value.projectServers.map((entry) => entry.name), ["notion"]);
    const again = await timed(() => handleMcpCatalog({ query: "" }, context));
    assert.ok(again.ms < 50, `catalog read ${index + 2} took ${again.ms.toFixed(1)} ms`);
    assert.equal(again.value.cards.find((card) => card.key === "recommended:notion")?.added?.projects[0], project, "Added still reads the project file");
  }
  assert.deepEqual(daemonCalls, { projects: 1, config: 1 }, "inside the TTL nothing reaches the daemon");
  assert.ok(DAEMON_CACHE_TTL_MS >= 10_000);

  // Refresh on sign-in re-reads the project list in the background; the read does not wait.
  const refreshed = await timed(() => handleMcpAuth({ refresh: true }, context));
  assert.ok(refreshed.ms < 50, `auth refresh took ${refreshed.ms.toFixed(1)} ms`);
  assert.equal(daemonCalls.projects, 2);
  // Refresh everything in the gallery re-reads both, in the background.
  const all = await timed(() => handleMcpCatalog({ query: "", refresh: "all" }, context));
  assert.ok(all.ms < 50, `catalog refresh took ${all.ms.toFixed(1)} ms`);
  assert.deepEqual(daemonCalls, { projects: 2, config: 2 }, "the project list was already being read again: still one call for it");

  // Changing Paseo's own tool settings (through a quick daemon) throws the provider settings out:
  // the next read waits for a new answer rather than returning the old one.
  let quickCalls = 0;
  const quick = { ...slowPaseo, config: { get: async () => { quickCalls += 1; return { config }; }, patch: async (patch: Record<string, unknown>) => { Object.assign(config, patch); return {}; } } };
  const written = await handleMcpSetPaseoTools({ injectIntoAgents: false }, { paseo: quick } as never);
  assert.equal(written.ok, true, written.message);
  const before = quickCalls;
  await handleMcpCatalog({ query: "" }, { paseo: quick } as never);
  assert.equal(quickCalls, before + 1, "the read after the write asked the daemon again, and waited for it");
  assert.ok(daemonReadCalls().config >= 3);
  resetDaemonReads();
});
