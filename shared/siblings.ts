/**
 * The sibling plugin the Overview's card points to. AI Router shows the same
 * card the other way round, pointing here.
 */
export const AI_ROUTER = {
  /** The plugin id Paseo installs it under. */
  id: "ai-router",
  name: "AI Router",
  /** The quiet line's half-sentence (0.18.0). */
  short: "use all your team's AI accounts through one connection, in any chat.",
  pitch: "One connection for all your team's AI accounts: sign in to Claude, Codex and the rest once on a shared router, then use any of their models in any chat.",
  repoUrl: "https://github.com/itsjustanks/paseo-plugin-ai-router",
  installSource: "git:https://github.com/itsjustanks/paseo-plugin-ai-router.git:apps/paseo",
} as const;
