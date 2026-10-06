/**
 * What the Overview leads with: one verdict (the header pill) and one next
 * step, decided from the same facts in the same order so the two never
 * disagree. Before 0.9.0 they were two tables: the pill put a down server
 * first while the next step put gaps first, so "1 server down" sat above
 * "Apply 3 servers to the editors missing them". Pure so it can be tested.
 */
import type { ServerFilter } from "./servers";

export type OverviewFacts = {
  /** `error`: the first read failed; `loading`: nothing read yet; `ready`: there is data. */
  state: "error" | "loading" | "ready";
  /** The data on screen is from an earlier read: the latest refresh failed. "HH:MM", or null. */
  staleAt: string | null;
  hostLabel: string;
  servers: number;
  /** Down, or its command is not installed. */
  broken: number;
  /** Any other health result a user has to act on (warnings). */
  warnings: number;
  /** Servers at least one account still has to sign in to. */
  signIn: number;
  /** Servers missing from at least one editor. */
  gaps: number;
  /**
   * 0.19.2: the health check or the sign-in read isn't in yet. The verdict
   * says "Checking…" instead of an "All working" that turns into "4 not
   * working" a moment later.
   */
  checking?: boolean;
};

export type OverviewTone = "ok" | "attention" | "error" | "neutral";

export type OverviewTarget =
  | { section: "servers"; filter: ServerFilter }
  | { section: "transfer"; mode: "add" | "import" }
  /** Open Add a connector, the gallery (0.19.0). */
  | { section: "add" }
  | { section: "refresh" }
  /** Open "Copy to all my AI apps" (0.15.0). */
  | { section: "copy" };

export type OverviewStep = { title: string; detail: string; label: string; target: OverviewTarget };

type Problem = "broken" | "signIn" | "gaps" | "warnings";

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The first thing to fix, most urgent first: a connector that cannot run, then sign-in, then gaps, then warnings. */
function firstProblem(facts: OverviewFacts): Problem | null {
  if (facts.broken > 0) return "broken";
  if (facts.signIn > 0) return "signIn";
  if (facts.gaps > 0) return "gaps";
  if (facts.warnings > 0) return "warnings";
  return null;
}

/** The header pill: one tone and a few words. */
export function overviewVerdict(facts: OverviewFacts): { status: OverviewTone; label: string } {
  if (facts.state === "error") return { status: "error", label: "Can't reach Paseo" };
  if (facts.staleAt) return { status: "attention", label: `As of ${facts.staleAt}` };
  if (facts.state === "loading") return { status: "neutral", label: "Checking…" };
  if (facts.servers === 0) return { status: "neutral", label: "No connectors yet" };
  // A problem already known shows at once; "all working" waits for every read.
  if (facts.checking && firstProblem(facts) === null) return { status: "neutral", label: "Checking…" };
  switch (firstProblem(facts)) {
    case "broken":
      return { status: "error", label: `${facts.broken} not working` };
    case "signIn":
      return { status: "attention", label: `${facts.signIn} need sign-in` };
    case "gaps":
      return { status: "attention", label: `${facts.gaps} missing from some apps` };
    case "warnings":
      return { status: "attention", label: plural(facts.warnings, "warning") };
    default:
      return { status: "ok", label: "All working" };
  }
}

/** The Overview's first card: what to do next, and the button that does it. */
export function overviewNextStep(facts: OverviewFacts): OverviewStep {
  if (facts.state === "error") {
    return { title: "Couldn't reach Paseo", detail: "We couldn't read your AI apps' settings on this computer. Try again once Paseo is running.", label: "Try again", target: { section: "refresh" } };
  }
  if (facts.state === "loading") {
    return { title: "Reading your AI apps", detail: `Looking for Claude, Codex, Kimi and Grok on ${facts.hostLabel}. This takes a moment.`, label: "Refresh", target: { section: "refresh" } };
  }
  if (facts.servers === 0) {
    return { title: "Add your first connector", detail: "Pick an app from the gallery, like GitHub or Notion. It's added to every AI app you choose.", label: "Add a connector", target: { section: "add" } };
  }
  if (facts.checking && firstProblem(facts) === null) {
    return { title: "Checking your connectors…", detail: "Asking each one if it answers, and reading your sign-ins. This takes a moment.", label: "See your connectors", target: { section: "servers", filter: "all" } };
  }
  switch (firstProblem(facts)) {
    case "broken":
      return {
        title: facts.broken === 1 ? "Fix the connector that isn't working" : `Fix ${facts.broken} connectors that aren't working`,
        detail: facts.broken === 1 ? "Open it to see what's wrong. Your other connectors keep working." : "Open each one to see what's wrong. Your other connectors keep working.",
        label: "Show them",
        target: { section: "servers", filter: "issues" },
      };
    case "signIn":
      return { title: `Sign in to ${plural(facts.signIn, "connector")}`, detail: "Each AI app and account signs in once, in your browser. Open a connector and choose Connect.", label: "Show the ones that need sign-in", target: { section: "servers", filter: "sign-in" } };
    case "gaps":
      return { title: `Copy ${plural(facts.gaps, "connector")} to the apps missing them`, detail: "Add a connector once, and this puts it in every AI app that doesn't have it yet. You see exactly what changes first.", label: "Copy to all my AI apps", target: { section: "copy" } };
    case "warnings":
      return { title: `Check ${plural(facts.warnings, "connector")} with a warning`, detail: "A connector answered, but not cleanly. Open it to see what's wrong.", label: "Show them", target: { section: "servers", filter: "issues" } };
    default:
      return { title: "All set: your connectors are working", detail: "Your assistants can use them in any chat. Add another whenever you like.", label: "See your connectors", target: { section: "servers", filter: "all" } };
  }
}

// -------------------------------------------------------------------- words

/**
 * What this is, for someone who has never heard of MCP (0.15.0). Always on
 * top of Overview, with a longer version behind "Learn more".
 */
export const MCP_EXPLAINER =
  "Connectors let your AI assistants use the apps you already use, like Notion, Supabase or Linear, so an assistant can read and act in them. Add a connector once here, and every AI app on this computer can use it.";

export const MCP_LEARN_MORE: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "What a connector is",
    body: "An add-on for one app, also called an MCP server. It tells your AI assistant what it can do there, like \"search pages\" or \"create an issue\", and does it when asked.",
  },
  {
    title: "On the web, or on this computer",
    body: "Most connectors live on the web: you add them by a link and nothing is installed. Some run on this computer: a small program starts whenever an assistant needs it.",
  },
  {
    title: "Signing in",
    body: "Many connectors ask you to sign in once, in your browser, so the assistant can act as you. Each AI app and each account signs in on its own.",
  },
  {
    title: "Why fewer is faster",
    body: "At the start of every chat, each connector tells the assistant about all of its tools. That takes time and room, so keeping only the ones you use keeps your assistants quick.",
  },
];
