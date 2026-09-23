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
  | { section: "refresh" };

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
  if (facts.state === "error") return { status: "error", label: "Host unavailable" };
  if (facts.staleAt) return { status: "attention", label: `As of ${facts.staleAt}` };
  if (facts.state === "loading") return { status: "neutral", label: "Connecting" };
  if (facts.servers === 0) return { status: "neutral", label: "No servers yet" };
  switch (firstProblem(facts)) {
    case "broken":
      return { status: "error", label: `${plural(facts.broken, "server")} down` };
    case "signIn":
      return { status: "attention", label: `${facts.signIn} need sign-in` };
    case "gaps":
      return { status: "attention", label: plural(facts.gaps, "gap") };
    case "warnings":
      return { status: "attention", label: plural(facts.warnings, "warning") };
    default:
      return { status: "ok", label: "All servers healthy" };
  }
}

/** The Overview's first card: what to do next, and the button that does it. */
export function overviewNextStep(facts: OverviewFacts): OverviewStep {
  if (facts.state === "error") {
    return { title: "Reconnect to the host", detail: "The MCP plugin could not read the editor configs on this host. Retry once the daemon is reachable.", label: "Retry", target: { section: "refresh" } };
  }
  if (facts.state === "loading") {
    return { title: "Reading editor configs", detail: `Looking for Claude, Codex, Kimi and Grok configs on ${facts.hostLabel}. This takes a moment.`, label: "Refresh", target: { section: "refresh" } };
  }
  if (facts.servers === 0) {
    return { title: "Add or import your first server", detail: "Paste the JSON block from a server's README, or type a URL or command. It is written to every editor you choose.", label: "Open Import & Export", target: { section: "transfer", mode: "import" } };
  }
  switch (firstProblem(facts)) {
    case "broken":
      return { title: `Fix ${plural(facts.broken, "unhealthy server")}`, detail: "A server is down or its command is not installed. Open it to read the health note and edit its definition.", label: "Show issues", target: { section: "servers", filter: "issues" } };
    case "signIn":
      return { title: `Sign in to ${plural(facts.signIn, "server")}`, detail: "OAuth grants are per account. Connect each one once from the server's card; the browser sign-in runs on the daemon host.", label: "Show servers needing sign-in", target: { section: "servers", filter: "sign-in" } };
    case "gaps":
      return { title: `Apply ${plural(facts.gaps, "server")} to the editors missing them`, detail: "A server defined in one editor is not yet in the others. Open a server and choose Add to missing to copy its definition across.", label: "Review gaps", target: { section: "servers", filter: "gaps" } };
    case "warnings":
      return { title: `Check ${plural(facts.warnings, "server")} with a warning`, detail: "A server answered, but not cleanly. Open it to read the health note.", label: "Show issues", target: { section: "servers", filter: "issues" } };
    default:
      return { title: "Ready", detail: `${plural(facts.servers, "server")} defined in every editor, with every account connected. Add another server or export a backup whenever you like.`, label: "Browse servers", target: { section: "servers", filter: "all" } };
  }
}
