/**
 * Timing rules shared by the host's background passes and the client's polls.
 * Pure so the backoff can be unit-tested.
 */

/**
 * Delay before the next attempt after `failures` consecutive failures: the
 * base delay doubled per failure, capped. Zero failures means the normal
 * `base` cadence.
 */
/**
 * Consecutive failed reads of a query. TanStack resets `fetchFailureCount`
 * to 0 whenever a fetch starts (query-core `fetchState`), so between polls it
 * is never more than 1 and a backoff built on it never grows. This counts the
 * errors since the last success instead, from the query's own history.
 */
type QueryHistory = { state: { errorUpdateCount: number; dataUpdatedAt: number; errorUpdatedAt: number } };
const errorsAtLastSuccess = new WeakMap<object, number>();
export function failureStreak(query: QueryHistory): number {
  const { errorUpdateCount, dataUpdatedAt, errorUpdatedAt } = query.state;
  if (dataUpdatedAt >= errorUpdatedAt) {
    errorsAtLastSuccess.set(query, errorUpdateCount);
    return 0;
  }
  return Math.max(1, errorUpdateCount - (errorsAtLastSuccess.get(query) ?? 0));
}

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

/** How often a panel reads again while the host is checking and has nothing current to show. */
export const CHECKING_POLL_MS = 1000;

/** A cached read: the host's report (null before its first check) and whether a check is running. */
export type CachedRead<Report> = { report: Report | null; checking: boolean };

/**
 * Poll every second while the host checks and there is nothing current (no
 * report, or one saved before a restart); each poll is a cached read. Only
 * while reads succeed: after a failure the ordinary backoff applies, even
 * though the last good answer still says `checking`.
 */
export function cachedReadInterval<Report extends { stale?: unknown }>(
  read: CachedRead<Report> | undefined,
  failures: number,
  baseMs: number,
  capMs: number,
): number {
  if (failures === 0 && read?.checking && (!read.report || read.report.stale)) return CHECKING_POLL_MS;
  return backoffMs(failures, baseMs, capMs);
}
