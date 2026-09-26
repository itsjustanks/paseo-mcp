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
};

export type OverviewTone = "ok" | "attention" | "error" | "neutral";

export type OverviewTarget =
  | { section: "servers"; filter: ServerFilter }
  | { section: "transfer"; mode: "add" | "import" }
  | { section: "refresh" }
  /** Open "Copy to all my AI apps" (0.15.0). */
  | { section: "copy" };

export type OverviewStep = { title: string; detail: string; label: string; target: OverviewTarget };

type Problem = "broken" | "signIn" | "gaps" | "warnings";

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The first thing to fix, most urgent first: a server that cannot run, then sign-in, then gaps, then warnings. */
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
  if (facts.state === "loading") return { status: "neutral", label: "Connecting" };
  if (facts.servers === 0) return { status: "neutral", label: "No servers yet" };
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
    return { title: "Add your first server", detail: "Paste the setup text from a server's instructions, or type its web address. It's added to every AI app you choose.", label: "Add a server", target: { section: "transfer", mode: "import" } };
  }
  switch (firstProblem(facts)) {
    case "broken":
      return {
        title: facts.broken === 1 ? "Fix the server that isn't working" : `Fix ${facts.broken} servers that aren't working`,
        detail: facts.broken === 1 ? "One server isn't working. Open it to see what's wrong and fix it." : `${facts.broken} servers aren't working. Open each one to see what's wrong and fix it.`,
        label: "Show them",
        target: { section: "servers", filter: "issues" },
      };
    case "signIn":
      return { title: `Sign in to ${plural(facts.signIn, "server")}`, detail: "Each AI app and account signs in once, in your browser. Open a server and choose Connect.", label: "Show servers that need sign-in", target: { section: "servers", filter: "sign-in" } };
    case "gaps":
      return { title: `Copy ${plural(facts.gaps, "server")} to the apps missing them`, detail: "Some servers are in one AI app but not another. Copy them everywhere in one go; you'll see exactly what changes first.", label: "Copy to all my AI apps", target: { section: "copy" } };
    case "warnings":
      return { title: `Check ${plural(facts.warnings, "server")} with a warning`, detail: "A server answered, but not cleanly. Open it to see what's wrong.", label: "Show them", target: { section: "servers", filter: "issues" } };
    default:
      return { title: "All set", detail: `${plural(facts.servers, "server")}, in every AI app, all working and signed in. Add another whenever you like.`, label: "Browse servers", target: { section: "servers", filter: "all" } };
  }
}

// -------------------------------------------------------------------- words

/**
 * What this is, for someone who has never heard of MCP (0.15.0). Always on
 * top of Overview, with a longer version behind "Learn more".
 */
export const MCP_EXPLAINER =
  "MCP servers connect your AI assistants to the apps you already use, like Notion, Supabase or Linear, so an assistant can read and act in them. Add a server once here, and every AI app on this computer can use it.";

export const MCP_LEARN_MORE: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "What a server is",
    body: "A small connector for one app. It tells your AI assistant what it can do there, like \"search pages\" or \"create an issue\", and does it when asked.",
  },
  {
    title: "On the web, or on this computer",
    body: "Some servers live on the web: you add them by their web address and nothing is installed. Others run on this computer: a small program starts whenever an assistant needs it.",
  },
  {
    title: "Signing in",
    body: "Many servers ask you to sign in once, in your browser, so the assistant can act as you. Each AI app and each account signs in on its own.",
  },
  {
    title: "Why fewer is faster",
    body: "At the start of every chat, each server tells the assistant about all of its tools. That takes time and room, so keeping only the servers you use keeps your assistants quick.",
  },
];
