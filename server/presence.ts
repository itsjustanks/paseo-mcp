/**
 * Whether anyone is looking. Every RPC the app sends marks the moment; the
 * app's composer chip asks for the cached health once a minute while Paseo is
 * open, so "no RPC for WATCH_WINDOW_MS" means no app is connected and the
 * background passes can rest until one is.
 */

export const WATCH_WINDOW_MS = 15 * 60_000;

let lastSeen = 0;

export function markClientSeen(now = Date.now()): void {
  lastSeen = now;
}

export function clientSeenWithin(windowMs = WATCH_WINDOW_MS, now = Date.now()): boolean {
  return lastSeen > 0 && now - lastSeen < windowMs;
}

/** For tests. */
export function resetPresence(): void {
  lastSeen = 0;
}
