import { backoffMs } from "../shared/schedule";
import { clientSeenWithin } from "./presence";

/**
 * One background pass on a timer (health checks, tool lists), with the rules
 * both share:
 *
 * - The delay is recomputed on every beat, so a settings change applies
 *   without a reload; a switched-off pass wakes once a minute to notice it
 *   being switched back on.
 * - It only runs while an app is connected (server/presence.ts). With nobody
 *   looking, probing forty servers every ten minutes is work for no one.
 * - A failed pass is retried sooner than the normal interval but backs off
 *   exponentially, never faster than once a minute.
 */

const IDLE_RECHECK_MS = 60_000;
const RETRY_BASE_MS = 60_000;

export type BackgroundPass = { start(): void; stop(): void; nextRunAt(): string | null };

export function backgroundPass(options: {
  /** For the daemon log. */
  name: string;
  firstDelayMs: number;
  /** Normal time between passes, read on every beat; null means switched off. */
  intervalMs: () => number | null;
  run: () => Promise<void>;
  log?: (line: string) => void;
}): BackgroundPass {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let next: string | null = null;
  let failures = 0;
  let paused = false;
  const log = options.log ?? ((line: string) => console.log(line));

  const schedule = (delayMs: number, willRun: boolean) => {
    if (timer) clearTimeout(timer);
    next = willRun ? new Date(Date.now() + delayMs).toISOString() : null;
    timer = setTimeout(beat, delayMs);
  };

  const beat = () => {
    timer = null;
    const interval = options.intervalMs();
    if (interval === null) return schedule(IDLE_RECHECK_MS, false);
    if (!clientSeenWithin()) {
      if (!paused) log(`[paseo-mcp] ${options.name}: no app connected, pausing until one is`);
      paused = true;
      return schedule(IDLE_RECHECK_MS, false);
    }
    paused = false;
    options
      .run()
      .then(() => {
        failures = 0;
      })
      .catch((error: unknown) => {
        failures += 1;
        log(`[paseo-mcp] ${options.name} failed (attempt ${failures}): ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (timer !== null || stopped) return;
        const delay = failures === 0 ? interval : Math.min(interval, backoffMs(failures - 1, RETRY_BASE_MS, interval));
        schedule(delay, true);
      });
  };

  let stopped = false;
  return {
    start() {
      if (timer) return;
      stopped = false;
      schedule(options.firstDelayMs, options.intervalMs() !== null);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      next = null;
    },
    nextRunAt: () => next,
  };
}
