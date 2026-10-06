/** 0.19.1: the words of an attention-only chip, and which accounts' sign-ins count for which chats. */
import assert from "node:assert/strict";
import test from "node:test";
import { attentionLabel, hostNeedsAttention } from "../shared/attention";
import type { McpAuthAccount } from "../shared/contracts";
import { signInNeeds } from "../server/health";

test("the chip's words: singular and plural, failing first, nothing when calm", () => {
  assert.equal(attentionLabel({ failing: [], signIn: [] }), null);
  assert.equal(attentionLabel({ failing: ["a"], signIn: [] }), "1 broken");
  assert.equal(attentionLabel({ failing: ["a", "b"], signIn: [] }), "2 broken");
  assert.equal(attentionLabel({ failing: [], signIn: ["a"] }), "1 needs sign-in");
  assert.equal(attentionLabel({ failing: [], signIn: ["a", "b"] }), "2 need sign-in");
  assert.equal(attentionLabel({ failing: ["a"], signIn: ["b", "c"] }), "1 broken", "broken leads; the panel lists the sign-ins");
});

test("the sidebar dot: failing wins; a sign-in no Paseo provider uses doesn't count", () => {
  const down = { checkedAt: "", results: [{ name: "a", status: "down" as const, note: "", scopes: [] }] };
  assert.equal(hostNeedsAttention(down, [{ name: "b", providerIds: ["claude"] }]), "failing");
  assert.equal(hostNeedsAttention(null, [{ name: "b", providerIds: ["claude"] }]), "sign-in");
  assert.equal(hostNeedsAttention(null, [{ name: "b", providerIds: [] }]), null, "an unwired slot's sign-in");
  assert.equal(hostNeedsAttention(null, null), null);
});

const account = (provider: "claude" | "codex", isPrimary: boolean, extra: Partial<McpAuthAccount> = {}): McpAuthAccount => ({
  provider,
  email: `${provider}@example.com`,
  dir: provider === "claude" ? (isPrimary ? "/home/demo/.claude" : "/slots/claude-work") : "/home/demo/.codex",
  isPrimary,
  definedServers: 3,
  needsAuth: [],
  authStatus: {},
  ...extra,
});

test("sign-in needs come from Claude's needs-auth list and Codex's not-connected states, before any health pass", () => {
  const needs = signInNeeds([
    account("claude", true, { needsAuth: ["jam"] }),
    account("codex", true, { authStatus: { linear: "not-connected", notion: "connected", box: "unknown" } }),
    account("claude", false, { needsAuth: ["jam", "posthog"] }),
  ]);
  // Before this run's first pass only primary accounts are known to belong to a provider.
  assert.deepEqual(needs, [
    { name: "jam", providerIds: ["claude"] },
    { name: "linear", providerIds: ["codex"] },
    { name: "posthog", providerIds: [] },
  ]);
});
