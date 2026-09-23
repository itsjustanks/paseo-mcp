import assert from "node:assert/strict";
import test from "node:test";
import { overviewNextStep, overviewVerdict, type OverviewFacts } from "../shared/overview";

const calm: OverviewFacts = { state: "ready", staleAt: null, hostLabel: "paseo", servers: 6, broken: 0, warnings: 0, signIn: 0, gaps: 0 };

test("a calm host: the pill says healthy and the next step is Ready", () => {
  assert.deepEqual(overviewVerdict(calm), { status: "ok", label: "All servers healthy" });
  const step = overviewNextStep(calm);
  assert.equal(step.title, "Ready");
  assert.deepEqual(step.target, { section: "servers", filter: "all" });
});

test("the pill and the next step name the same problem, most urgent first", () => {
  // The fixture that looked wrong before 0.9.0: a server down, two need sign-in, three gaps.
  const busy: OverviewFacts = { ...calm, broken: 1, signIn: 2, gaps: 3, warnings: 1 };
  assert.deepEqual(overviewVerdict(busy), { status: "error", label: "1 server down" });
  assert.equal(overviewNextStep(busy).title, "Fix 1 unhealthy server");
  assert.deepEqual(overviewNextStep(busy).target, { section: "servers", filter: "issues" });

  const signIn = { ...busy, broken: 0 };
  assert.deepEqual(overviewVerdict(signIn), { status: "attention", label: "2 need sign-in" });
  assert.deepEqual(overviewNextStep(signIn).target, { section: "servers", filter: "sign-in" });

  const gaps = { ...signIn, signIn: 0 };
  assert.deepEqual(overviewVerdict(gaps), { status: "attention", label: "3 gaps" });
  assert.equal(overviewNextStep(gaps).title, "Apply 3 servers to the editors missing them");
  assert.deepEqual(overviewNextStep(gaps).target, { section: "servers", filter: "gaps" });

  const warnings = { ...gaps, gaps: 0 };
  assert.deepEqual(overviewVerdict(warnings), { status: "attention", label: "1 warning" });
  assert.deepEqual(overviewNextStep(warnings).target, { section: "servers", filter: "issues" });
});

test("counts read naturally in the singular and the plural", () => {
  assert.equal(overviewVerdict({ ...calm, broken: 2 }).label, "2 servers down");
  assert.equal(overviewNextStep({ ...calm, broken: 2 }).title, "Fix 2 unhealthy servers");
  assert.equal(overviewVerdict({ ...calm, gaps: 1 }).label, "1 gap");
  assert.equal(overviewNextStep({ ...calm, signIn: 1 }).title, "Sign in to 1 server");
});

test("before there is data: connecting, unavailable, or a stale read says so", () => {
  const loading = { ...calm, state: "loading" as const };
  assert.deepEqual(overviewVerdict(loading), { status: "neutral", label: "Connecting" });
  assert.deepEqual(overviewNextStep(loading).target, { section: "refresh" });
  assert.match(overviewNextStep(loading).detail, /on paseo/);

  const error = { ...calm, state: "error" as const };
  assert.deepEqual(overviewVerdict(error), { status: "error", label: "Host unavailable" });
  assert.equal(overviewNextStep(error).label, "Retry");

  // A failed refresh keeps the earlier read: the pill says how old it is; the step still acts on it.
  const stale = { ...calm, staleAt: "14:05", gaps: 2 };
  assert.deepEqual(overviewVerdict(stale), { status: "attention", label: "As of 14:05" });
  assert.deepEqual(overviewNextStep(stale).target, { section: "servers", filter: "gaps" });
});

test("no servers yet: the next step opens the import pane", () => {
  const empty = { ...calm, servers: 0 };
  assert.deepEqual(overviewVerdict(empty), { status: "neutral", label: "No servers yet" });
  assert.deepEqual(overviewNextStep(empty).target, { section: "transfer", mode: "import" });
});
