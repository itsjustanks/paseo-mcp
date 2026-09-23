/**
 * Timing rules shared by the host's background passes and the client's polls.
 * Pure so the backoff can be unit-tested.
 */

/**
 * Delay before the next attempt after `failures` consecutive failures: the
 * base delay doubled per failure, capped. Zero failures means the normal
 * `base` cadence.
 */
export function backoffMs(failures: number, baseMs: number, capMs: number): number {
  if (failures <= 0) return baseMs;
  return Math.min(capMs, baseMs * 2 ** Math.min(failures, 16));
}

/** "14:05" for an ISO time, the way a stale answer is labelled. */
export function clockTime(iso: string | null | undefined): string {
  if (!iso) return "earlier";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "earlier";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
