import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AuthState } from "../shared/accounts";
import { CLI_TTL_MS, codexAuthView, codexChecksSettled, resetCodexAuthForTests, setCodexRunnerForTests } from "../server/codex-auth";
import { forgetAllFiles } from "../server/files";

const SERVERS = { linear: { url: "https://l/mcp" }, notion: { url: "https://n/mcp" } };

function account(name: string) {
  const root = mkdtempSync(join(tmpdir(), "paseo-mcp-codex-"));
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), '[mcp_servers.linear]\nurl = "https://l/mcp"\n');
  return { dir, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** A stand-in for `codex mcp list`: counts runs, records overlap, answers or fails on demand. */
function fakeCodex(answer: () => Record<string, AuthState> | Error, delayMs = 5) {
  const calls: string[] = [];
  let running = 0;
  let maxRunning = 0;
  setCodexRunnerForTests(async (home) => {
    calls.push(home);
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((done) => setTimeout(done, delayMs));
    running -= 1;
    const result = answer();
    if (result instanceof Error) throw result;
    return result;
  });
  return { calls, maxRunning: () => maxRunning };
}

function fresh() {
  resetCodexAuthForTests();
  forgetAllFiles();
}

test("a read answers at once; Codex is asked once in the background and then reused", async () => {
  fresh();
  const { dir, done } = account("a@example.com");
  try {
    const codex = fakeCodex(() => ({ linear: "connected", notion: "not-connected" }));
    const first = codexAuthView(dir, SERVERS, { askCli: true });
    assert.deepEqual(first.states, {}, "nothing known yet, and the read did not wait for Codex");
    assert.equal(first.checking, true);
    await codexChecksSettled();
    const second = codexAuthView(dir, SERVERS, { askCli: true });
    assert.deepEqual(second.states, { linear: "connected", notion: "not-connected" });
    assert.equal(second.checking, false);
    assert.ok(second.asOf);
    for (let index = 0; index < 20; index += 1) codexAuthView(dir, SERVERS, { askCli: true });
    await codexChecksSettled();
    assert.equal(codex.calls.length, 1, "twenty more reads, no new Codex run");
  } finally {
    done();
  }
});

test("reads that do not show Codex state never start Codex", async () => {
  fresh();
  const { dir, done } = account("b@example.com");
  try {
    const codex = fakeCodex(() => ({}));
    for (let index = 0; index < 10; index += 1) codexAuthView(dir, SERVERS, { askCli: false });
    await codexChecksSettled();
    assert.equal(codex.calls.length, 0);
  } finally {
    done();
  }
});

test("a config change, an old answer, or Refresh asks again; nothing else does", async () => {
  fresh();
  const { dir, done } = account("c@example.com");
  try {
    const codex = fakeCodex(() => ({ linear: "connected" }));
    codexAuthView(dir, SERVERS, { askCli: true });
    await codexChecksSettled();
    assert.equal(codex.calls.length, 1);

    writeFileSync(join(dir, "config.toml"), '[mcp_servers.linear]\nurl = "https://l/mcp"\n\n[mcp_servers.notion]\nurl = "https://n/mcp"\n');
    codexAuthView(dir, SERVERS, { askCli: true });
    await codexChecksSettled();
    assert.equal(codex.calls.length, 2, "config.toml changed");

    codexAuthView(dir, SERVERS, { askCli: true, now: Date.now() + CLI_TTL_MS + 1000 });
    await codexChecksSettled();
    assert.equal(codex.calls.length, 3, "the answer outlived its TTL");

    codexAuthView(dir, SERVERS, { askCli: true, force: true });
    await codexChecksSettled();
    assert.equal(codex.calls.length, 4, "Refresh");
  } finally {
    done();
  }
});

test("a failed check keeps the last good answer, is not cached, and backs off", async () => {
  fresh();
  const { dir, done } = account("d@example.com");
  try {
    let fail = false;
    const codex = fakeCodex(() => (fail ? new Error("Codex took longer than 20 s") : { linear: "connected" }));
    codexAuthView(dir, SERVERS, { askCli: true });
    await codexChecksSettled();

    fail = true;
    codexAuthView(dir, SERVERS, { askCli: true, force: true });
    await codexChecksSettled();
    const after = codexAuthView(dir, SERVERS, { askCli: true });
    assert.deepEqual(after.states, { linear: "connected" }, "the failure did not wipe the known state");
    assert.equal(after.staleReason, "Codex took longer than 20 s");
    assert.ok(after.asOf, "labelled with when it was last good");

    // Inside the backoff window nothing is retried, even though the config
    // changed (which would normally ask again).
    writeFileSync(join(dir, "config.toml"), '[mcp_servers.linear]\nurl = "https://l/mcp"\nenabled = true\n');
    for (let index = 0; index < 5; index += 1) codexAuthView(dir, SERVERS, { askCli: true });
    await codexChecksSettled();
    assert.equal(codex.calls.length, 2);

    // After the backoff the next read retries, and a success clears the note.
    fail = false;
    codexAuthView(dir, SERVERS, { askCli: true, now: Date.now() + 2 * 60 * 60_000 });
    await codexChecksSettled();
    assert.equal(codex.calls.length, 3);
    const recovered = codexAuthView(dir, SERVERS, { askCli: false });
    assert.equal(recovered.staleReason, null);
  } finally {
    done();
  }
});

test("concurrent reads share one check per account, and accounts are checked one at a time", async () => {
  fresh();
  const one = account("e@example.com");
  const two = account("f@example.com");
  try {
    const codex = fakeCodex(() => ({ linear: "connected" }), 20);
    for (let index = 0; index < 10; index += 1) {
      codexAuthView(one.dir, SERVERS, { askCli: true });
      codexAuthView(two.dir, SERVERS, { askCli: true });
    }
    await codexChecksSettled();
    assert.equal(codex.calls.length, 2);
    assert.equal(codex.maxRunning(), 1, "never two Codex processes at once");
  } finally {
    one.done();
    two.done();
  }
});

test("a usable grant in .credentials.json reads as connected without asking Codex", async () => {
  fresh();
  const { dir, done } = account("g@example.com");
  try {
    const codex = fakeCodex(() => ({}));
    writeFileSync(
      join(dir, ".credentials.json"),
      JSON.stringify({ "linear|x": { server_name: "linear", server_url: "https://l/mcp", client_id: "c", access_token: "tok", expires_at: Date.now() + 3_600_000 } }),
    );
    const view = codexAuthView(dir, SERVERS, { askCli: false });
    assert.deepEqual(view.states, { linear: "connected" });
    assert.doesNotMatch(JSON.stringify(view), /tok"/);
    await codexChecksSettled();
    assert.equal(codex.calls.length, 0);
  } finally {
    done();
  }
});
