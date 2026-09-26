import assert from "node:assert/strict";
import test from "node:test";
import { COPY_ALL_EXPLAINER, COPY_ALL_LABEL } from "../shared/copy-all";
import { MCP_EXPLAINER, MCP_LEARN_MORE, overviewNextStep, overviewVerdict, type OverviewFacts } from "../shared/overview";

const calm: OverviewFacts = { state: "ready", staleAt: null, hostLabel: "paseo", servers: 6, broken: 0, warnings: 0, signIn: 0, gaps: 0 };

test("a calm host: the pill says all working and the next step is All set", () => {
  assert.deepEqual(overviewVerdict(calm), { status: "ok", label: "All working" });
  const step = overviewNextStep(calm);
  assert.equal(step.title, "All set");
  assert.deepEqual(step.target, { section: "servers", filter: "all" });
});

test("the pill and the next step name the same problem, most urgent first", () => {
  // The fixture that looked wrong before 0.9.0: a server down, two need sign-in, three gaps.
  const busy: OverviewFacts = { ...calm, broken: 1, signIn: 2, gaps: 3, warnings: 1 };
  assert.deepEqual(overviewVerdict(busy), { status: "error", label: "1 not working" });
  assert.equal(overviewNextStep(busy).title, "Fix the server that isn't working");
  assert.equal(overviewNextStep(busy).detail, "One server isn't working. Open it to see what's wrong and fix it.");
  assert.deepEqual(overviewNextStep(busy).target, { section: "servers", filter: "issues" });

  const signIn = { ...busy, broken: 0 };
  assert.deepEqual(overviewVerdict(signIn), { status: "attention", label: "2 need sign-in" });
  assert.deepEqual(overviewNextStep(signIn).target, { section: "servers", filter: "sign-in" });

  const gaps = { ...signIn, signIn: 0 };
  assert.deepEqual(overviewVerdict(gaps), { status: "attention", label: "3 missing from some apps" });
  assert.equal(overviewNextStep(gaps).title, "Copy 3 servers to the apps missing them");
  // 0.15.0: the gaps step opens "Copy to all my AI apps" directly.
  assert.equal(overviewNextStep(gaps).label, "Copy to all my AI apps");
  assert.deepEqual(overviewNextStep(gaps).target, { section: "copy" });

  const warnings = { ...gaps, gaps: 0 };
  assert.deepEqual(overviewVerdict(warnings), { status: "attention", label: "1 warning" });
  assert.deepEqual(overviewNextStep(warnings).target, { section: "servers", filter: "issues" });
});

test("counts read naturally in the singular and the plural", () => {
  assert.equal(overviewVerdict({ ...calm, broken: 2 }).label, "2 not working");
  assert.equal(overviewNextStep({ ...calm, broken: 2 }).title, "Fix 2 servers that aren't working");
  assert.equal(overviewVerdict({ ...calm, gaps: 1 }).label, "1 missing from some apps");
  assert.equal(overviewNextStep({ ...calm, signIn: 1 }).title, "Sign in to 1 server");
});

test("before there is data: connecting, unavailable, or a stale read says so", () => {
  const loading = { ...calm, state: "loading" as const };
  assert.deepEqual(overviewVerdict(loading), { status: "neutral", label: "Connecting" });
  assert.deepEqual(overviewNextStep(loading).target, { section: "refresh" });
  assert.match(overviewNextStep(loading).detail, /on paseo/);

  const error = { ...calm, state: "error" as const };
  assert.deepEqual(overviewVerdict(error), { status: "error", label: "Can't reach Paseo" });
  assert.equal(overviewNextStep(error).label, "Try again");

  // A failed refresh keeps the earlier read: the pill says how old it is; the step still acts on it.
  const stale = { ...calm, staleAt: "14:05", gaps: 2 };
  assert.deepEqual(overviewVerdict(stale), { status: "attention", label: "As of 14:05" });
  assert.deepEqual(overviewNextStep(stale).target, { section: "copy" });
});

test("no servers yet: the next step opens the import pane", () => {
  const empty = { ...calm, servers: 0 };
  assert.deepEqual(overviewVerdict(empty), { status: "neutral", label: "No servers yet" });
  assert.deepEqual(overviewNextStep(empty).target, { section: "transfer", mode: "import" });
});

test("plain words: no next step or pill uses the jargon a newcomer wouldn't know", () => {
  const cases: OverviewFacts[] = [
    calm,
    { ...calm, broken: 1 }, { ...calm, broken: 3 }, { ...calm, signIn: 2 }, { ...calm, gaps: 3 }, { ...calm, warnings: 1 },
    { ...calm, servers: 0 }, { ...calm, state: "loading" }, { ...calm, state: "error" },
  ];
  const jargon = /\b(editor|definition|command|provider|stdio|HTTP|OAuth|endpoint|host|daemon|grant|gap)s?\b|\.mcp\.json/i;
  for (const facts of cases) {
    const step = overviewNextStep(facts);
    for (const text of [step.title, step.detail, step.label, overviewVerdict(facts).label]) {
      assert.doesNotMatch(text, jargon, text);
    }
  }
  // The words a newcomer reads first: the explainer, Copy's explainer, and every Learn more item.
  for (const text of [MCP_EXPLAINER, COPY_ALL_EXPLAINER, COPY_ALL_LABEL, ...MCP_LEARN_MORE.flatMap((item) => [item.title, item.body])]) {
    assert.doesNotMatch(text, jargon, text);
  }
});
