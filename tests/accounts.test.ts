import assert from "node:assert/strict";
import test from "node:test";
import { claudeGrantsFrom, claudeStates, claudeStoredGrants, codexCliState, loginCommand, codexStatesFromGrants, codexStoredGrants, mergeCodexStates, parseCodexMcpList } from "../shared/accounts";
import { plainError } from "../shared/errors";
import { backoffMs, clockTime } from "../shared/schedule";

const NOW = Date.UTC(2026, 8, 23, 4, 0, 0);
const HOUR = 3_600_000;

test("Codex auth_status values map the way Codex serializes them (o_auth is connected)", () => {
  assert.equal(codexCliState("o_auth"), "connected");
  assert.equal(codexCliState("not_logged_in"), "not-connected");
  assert.equal(codexCliState("unsupported"), "unsupported");
  assert.equal(codexCliState("bearer_token"), "unknown");
  assert.equal(codexCliState("unknown"), "unknown");
  assert.equal(codexCliState(undefined), "unknown");
});

test("codex mcp list --json output is read by name; anything else is refused", () => {
  const states = parseCodexMcpList(JSON.stringify([
    { name: "linear", auth_status: "o_auth" },
    { name: "notion", auth_status: "not_logged_in" },
    { auth_status: "o_auth" },
  ]));
  assert.deepEqual(states, { linear: "connected", notion: "not-connected" });
  assert.throws(() => parseCodexMcpList("WARNING: something"));
  assert.throws(() => parseCodexMcpList(JSON.stringify({ servers: [] })));
});

test("stored grants follow Codex's usable rule and keep no token", () => {
  const file = {
    "linear|a": { server_name: "linear", server_url: "https://l/mcp", client_id: "c", access_token: "secret-1", expires_at: NOW + HOUR },
    "notion|b": { server_name: "notion", server_url: "https://n/mcp", client_id: "c", access_token: "secret-2", expires_at: NOW - HOUR, refresh_token: "r", issuer: "https://n" },
    "attio|c": { server_name: "attio", server_url: "https://a/mcp", client_id: "c", access_token: "secret-3", expires_at: NOW - HOUR, refresh_token: "r" },
    "gone|d": { server_name: "gone", server_url: "https://g/mcp", client_id: "", access_token: "secret-4" },
    "exec:e": { server_name: "executor:x", server_url: "https://x/mcp", client_id: "c", access_token: "secret-5", executor_owned: true },
    "nexp|f": { server_name: "noexpiry", server_url: "https://ne/mcp", client_id: "c", access_token: "secret-6" },
  };
  const grants = codexStoredGrants(file, NOW);
  assert.deepEqual(
    grants.map((grant) => [grant.serverName, grant.usable]),
    [["linear", true], ["notion", true], ["attio", false], ["gone", false], ["noexpiry", true]],
  );
  assert.doesNotMatch(JSON.stringify(grants), /secret/);
  assert.deepEqual(codexStoredGrants(null, NOW), []);
  assert.deepEqual(codexStoredGrants([1, 2], NOW), []);
});

test("grant states cover only this account's HTTP OAuth servers with a matching URL", () => {
  const grants = [
    { serverName: "linear", serverUrl: "https://l/mcp", usable: true },
    { serverName: "notion", serverUrl: "https://n/mcp", usable: false },
    { serverName: "moved", serverUrl: "https://old/mcp", usable: true },
    { serverName: "static", serverUrl: "https://s/mcp", usable: true },
  ];
  const states = codexStatesFromGrants(grants, {
    linear: { url: "https://l/mcp" },
    notion: { url: "https://n/mcp" },
    moved: { url: "https://new/mcp" },
    static: { url: "https://s/mcp", headers: { Authorization: "Bearer x" } },
    envtoken: { url: "https://e/mcp", extra: ["bearer_token_env_var = \"TOKEN\""] },
    local: {},
  });
  assert.deepEqual(states, { linear: "connected", notion: "not-connected" });
});

test("the grant file overrides Codex's older answer, and fills in what Codex never said", () => {
  assert.deepEqual(
    mergeCodexStates({ linear: "not-connected", notion: "unsupported" }, { linear: "connected", attio: "connected" }),
    { linear: "connected", notion: "unsupported", attio: "connected" },
  );
});

test("backoff doubles per failure from the base and stops at the cap", () => {
  assert.equal(backoffMs(0, 60_000, 900_000), 60_000);
  assert.equal(backoffMs(1, 60_000, 900_000), 120_000);
  assert.equal(backoffMs(2, 60_000, 900_000), 240_000);
  assert.equal(backoffMs(4, 60_000, 900_000), 900_000);
  assert.equal(backoffMs(400, 60_000, 900_000), 900_000);
});

test("clockTime labels a time as HH:MM and never throws", () => {
  const iso = new Date(2026, 8, 23, 9, 5).toISOString();
  assert.equal(clockTime(iso), "09:05");
  assert.equal(clockTime(null), "earlier");
  assert.equal(clockTime("not a date"), "earlier");
});

test("errors reach the panel as plain sentences, never a bare 'failed'", () => {
  assert.match(plainError(new Error("Plugin RPC timed out: paseo-mcp.rpc")), /did not answer within 30 seconds/);
  assert.match(plainError(new Error("Plugin is not available: paseo-mcp")), /not running on this host/);
  assert.match(plainError(new Error("Plugin paseo-mcp does not contribute RPC paseo-mcp.auth")), /older version/);
  assert.match(plainError(new Error("fetch failed")), /Lost the connection/);
  assert.match(plainError(""), /gave no reason/);
  assert.equal(plainError(new Error("This Paseo workspace no longer exists.")), "This Paseo workspace no longer exists.");
  for (const message of ["Plugin RPC timed out: x", "fetch failed", ""]) assert.doesNotMatch(plainError(new Error(message)), /^failed$/i);
});

// ---------------------------------------------------------- Claude (0.20.1)

test("Claude's stored connector sign-ins: a started-but-unfinished one is unusable, and no token is kept", () => {
  const file = {
    claudeAiOauth: { accessToken: "ACCOUNT-SECRET" },
    mcpOAuth: {
      "supercut|aaaa": { serverName: "supercut", serverUrl: "https://mcp.supercut.ai/mcp", accessToken: "", clientId: "c" },
      "linear|bbbb": { serverName: "linear", serverUrl: "https://mcp.linear.app/mcp", accessToken: "TOKEN-1" },
      "notion|cccc": { serverName: "notion", serverUrl: "https://mcp.notion.com/mcp", accessToken: "TOKEN-2", expiresAt: NOW - HOUR, refreshToken: "R" },
      "jam|dddd": { serverName: "jam", serverUrl: "https://mcp.jam.dev/mcp", accessToken: "TOKEN-3", expiresAt: NOW - HOUR },
      "plugin:posthog:posthog|eeee": { serverUrl: "https://mcp.posthog.com/mcp" },
      junk: "not an object",
    },
  };
  const grants = claudeStoredGrants(file, NOW);
  assert.deepEqual(grants, [
    { serverName: "supercut", serverUrl: "https://mcp.supercut.ai/mcp", usable: false },
    { serverName: "linear", serverUrl: "https://mcp.linear.app/mcp", usable: true },
    { serverName: "notion", serverUrl: "https://mcp.notion.com/mcp", usable: true },
    { serverName: "jam", serverUrl: "https://mcp.jam.dev/mcp", usable: false },
    { serverName: "plugin:posthog:posthog", serverUrl: "https://mcp.posthog.com/mcp", usable: false },
  ]);
  assert.doesNotMatch(JSON.stringify(grants), /SECRET|TOKEN|"R"/);
  assert.deepEqual(claudeStoredGrants(null, NOW), []);
  assert.deepEqual(claudeStoredGrants({ claudeAiOauth: {} }, NOW), [], "no mcpOAuth: nothing known");
});

test("Claude's states: its own list, its records, and connectors another app signs in to", () => {
  const servers = {
    supercut: { url: "https://mcp.supercut.ai/mcp" },
    linear: { url: "https://mcp.linear.app/mcp" },
    keyed: { url: "https://api.example.com/mcp", headers: { Authorization: "Bearer x" } },
    fresh: { url: "https://mcp.fresh.dev/mcp" },
    moved: { url: "https://new.example.com/mcp" },
    local: {},
  };
  const grants = [
    { serverName: "linear", serverUrl: "https://mcp.linear.app/mcp", usable: true },
    { serverName: "moved", serverUrl: "https://old.example.com/mcp", usable: true },
  ];
  const states = claudeStates({ grants, servers, needsAuth: ["sentry"], oauthElsewhere: new Set(["supercut", "keyed"]) });
  assert.deepEqual(states, {
    sentry: "not-connected", // Claude's own needs-sign-in list
    supercut: "not-connected", // Codex signs in to it, so Claude must too: this is the Ankit case
    linear: "connected",
    // keyed: a static key, no sign-in; fresh: nothing known; moved: a sign-in for another address; local: not on the web.
  });
  const signedIn = claudeStates({ grants: [{ serverName: "sentry", serverUrl: "", usable: true }], servers: { sentry: { url: "https://mcp.sentry.dev/mcp" } }, needsAuth: ["sentry"], oauthElsewhere: new Set() });
  assert.deepEqual(signedIn, { sentry: "connected" }, "a usable sign-in beats an older needs-sign-in note");
});

test("review fix: on macOS a missing credentials file means 'can't tell' (Keychain), elsewhere 'no sign-ins'", () => {
  assert.equal(claudeGrantsFrom({ file: null, exists: false, platform: "darwin", nowMs: NOW }), null);
  assert.deepEqual(claudeGrantsFrom({ file: null, exists: false, platform: "linux", nowMs: NOW }), []);
  const file = { mcpOAuth: { "a|1": { serverName: "a", serverUrl: "https://a/mcp", accessToken: "x" } } };
  assert.deepEqual(claudeGrantsFrom({ file, exists: true, platform: "darwin", nowMs: NOW }), [{ serverName: "a", serverUrl: "https://a/mcp", usable: true }]);
  // Can't read the store: only Claude's own list counts, nothing is inferred from Codex.
  const states = claudeStates({ grants: null, servers: { supercut: { url: "https://mcp.supercut.ai/mcp" } }, needsAuth: ["sentry"], oauthElsewhere: new Set(["supercut"]) });
  assert.deepEqual(states, { sentry: "not-connected" });
});

test("review fix: 'Sign in from a terminal' names the daemon's CLAUDE_CONFIG_DIR for the primary Claude", () => {
  const primary = { provider: "claude" as const, dir: "/home/paseo/.claude", isPrimary: true };
  assert.equal(loginCommand(primary, "supercut"), "claude mcp login 'supercut'", "unset: as before");
  assert.equal(loginCommand({ ...primary, configDirEnv: "/home/paseo/.claude" }, "supercut"), "CLAUDE_CONFIG_DIR='/home/paseo/.claude' claude mcp login 'supercut'");
  assert.equal(loginCommand({ provider: "claude", dir: "/x/work", isPrimary: false }, "a b"), "CLAUDE_CONFIG_DIR='/x/work' claude mcp login 'a b'");
  assert.equal(loginCommand({ provider: "codex", dir: "/h/.codex", isPrimary: true }, "jam", "/p/q"), "cd '/p/q' && codex mcp login 'jam'");
});
