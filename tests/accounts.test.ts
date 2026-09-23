import assert from "node:assert/strict";
import test from "node:test";
import { codexCliState, codexStatesFromGrants, codexStoredGrants, mergeCodexStates, parseCodexMcpList } from "../shared/accounts";
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
