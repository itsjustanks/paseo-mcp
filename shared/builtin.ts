/**
 * Tools that come with the Codex app (0.19.2). The Codex (ChatGPT) desktop app
 * puts a few connectors of its own into `~/.codex/config.toml`, such as
 * `computer-use` and `node_repl`. Their programs live inside the app, so a
 * health check from here reads them as "not installed", and they make no
 * sense in Claude. They are labelled "Comes with the Codex app", left out of
 * every health count, every "Fix N" and "missing from some apps", and never
 * copied to another app.
 */

/** The names the Codex app adds today. */
export const CODEX_BUILT_IN_NAMES: ReadonlySet<string> = new Set(["computer-use", "node_repl"]);

/** A program inside the Codex or ChatGPT app bundle (`/Applications/ChatGPT.app/…`, `./Codex Computer Use.app/…`). */
const APP_BUNDLE = /(^|[\\/])(ChatGPT|Codex)[^\\/]*\.app([\\/]|$)/i;

export const BUILT_IN_LABEL = "Comes with the Codex app";

/**
 * True when a connector is one the Codex app ships: every app that has it is
 * Codex, and its name is one Codex adds or its program is inside the app.
 */
export function isCodexBuiltIn(name: string, def: { command?: string } | null | undefined, providers: readonly string[]): boolean {
  if (providers.length === 0 || providers.some((provider) => provider !== "codex")) return false;
  if (CODEX_BUILT_IN_NAMES.has(name)) return true;
  return Boolean(def?.command && APP_BUNDLE.test(def.command));
}

/** What the connector's page and card say about one, in place of a raw error. */
export const BUILT_IN_NOTE = "The Codex app adds this tool itself and runs it while Codex is open. There's nothing to fix or copy here.";
