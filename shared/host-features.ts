/**
 * Newer Paseo features this plugin uses only where the app has them (0.17.0,
 * the shared design standard §5). The plugin builds against the 0.8 SDK and
 * still loads on 0.9.1, so each feature is detected at runtime, here, purely,
 * and the caller falls back to what it did before.
 */

type Fn = (...args: never[]) => unknown;
const isFn = (value: unknown): value is Fn => typeof value === "function";

/**
 * Paseo 0.11: a full screen plus a native sidebar row. All four parts must be
 * there (adding a screen, adding a sidebar row, opening a screen, and the
 * app's SidebarRow to draw it); otherwise the old surface and sidebar item.
 */
export function supportsNativeScreens(client: unknown, sidebarRow: unknown): boolean {
  const candidate = (client ?? {}) as Record<string, unknown>;
  return isFn(candidate.addScreen) && isFn(candidate.addSidebarHeaderItem) && isFn(candidate.openScreen) && Boolean(sidebarRow);
}

/** Paseo 0.10: `openExternalUrl` on the plugin client module, which opens the system browser. Null on older apps. */
export function externalUrlOpener(clientModule: unknown): ((url: string) => Promise<void>) | null {
  const candidate = (clientModule ?? {}) as { openExternalUrl?: unknown };
  return isFn(candidate.openExternalUrl) ? (candidate.openExternalUrl as (url: string) => Promise<void>) : null;
}
