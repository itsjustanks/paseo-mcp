/**
 * The sibling plugin the Overview's card points to. AI Router shows the same
 * card the other way round, pointing here.
 */
export const AI_ROUTER = {
  /** The plugin id Paseo installs it under. */
  id: "ai-router",
  name: "AI Router",
  pitch: "One endpoint for every model — pair your Claude, Codex and other accounts once on an OmniRoute server, then switch models in any chat.",
  repoUrl: "https://github.com/itsjustanks/paseo-plugin-ai-router",
  installSource: "git:https://github.com/itsjustanks/paseo-plugin-ai-router.git:apps/paseo",
} as const;
