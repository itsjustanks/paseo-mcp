import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { basename } from "node:path";
import { withDeadline } from "./run";

/**
 * Calls back into the Paseo daemon that sit on the panel's path (0.15.0): the
 * project list (`paseo.projects.list`) and the provider settings
 * (`paseo.config.get`). A busy daemon answers them in seconds, and the Add
 * gallery and the sign-in read used to wait for both on every call
 * (`paseo-mcp.auth took 10.0 s`, `paseo-mcp.catalog took 5.7 s`).
 *
 * Each read here follows the rules of the 0.11.3 cached reads:
 *
 * - With a copy, a read answers from it at once. A copy older than the TTL is
 *   refreshed in the background, and the read still does not wait.
 * - Only the first read ever, or a `fresh` one, waits for the daemon.
 * - Single-flight: however many reads arrive, one call is in flight at a time.
 * - A failed call keeps the last good copy, and is not tried again from a
 *   read until a TTL has passed.
 * - `invalidate()` throws the copy out (a write that changes what the daemon
 *   would answer): the very next read waits for a new answer instead of
 *   returning the old one, and a call that was already in flight when the
 *   write started never counts as fresh. Should that call fail, the old copy
 *   is still better than nothing and is returned.
 * - `markOld()` (Refresh pressed) has the next read refresh in the background
 *   too, but joins a call already in flight: pressing twice is one call.
 */

type Paseo = PluginHandlerContext["paseo"];

export const DAEMON_CACHE_TTL_MS = 15_000;

export type DaemonRead<T> = {
  /** The last good answer, refreshed in the background when old; waits only when there is none, or when `fresh`. */
  read(paseo: Paseo, options?: { fresh?: boolean }): Promise<T>;
  /** A write changed what the daemon would answer: the next read waits for a new answer, and a call already in flight is not reused. */
  invalidate(): void;
  /** Refresh was pressed: the next read refreshes in the background, joining a call already in flight. */
  markOld(): void;
  /** For tests: forget everything. */
  reset(): void;
  /** For tests: how many daemon calls have started. */
  calls(): number;
};

export function daemonRead<T>(options: {
  load: (paseo: Paseo) => Promise<T>;
  ttlMs?: number;
  now?: () => number;
}): DaemonRead<T> {
  const ttl = options.ttlMs ?? DAEMON_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  // `invalid`: thrown out by a write; the next read must not answer from it.
  let copy: { value: T; at: number; outdated: boolean; invalid: boolean } | null = null;
  let failedAt: number | null = null;
  let inFlight: { generation: number; call: Promise<T> } | null = null;
  let generation = 0;
  let epoch = 0;
  let started = 0;

  const refresh = (paseo: Paseo): Promise<T> => {
    // A call that started before a write is not shared with reads after it.
    if (inFlight?.generation === generation) return inFlight.call;
    const began = generation;
    const beganEpoch = epoch;
    started += 1;
    const call = options
      .load(paseo)
      .then((value) => {
        if (beganEpoch !== epoch) return value; // reset while in flight
        if (began === generation) {
          copy = { value, at: now(), outdated: false, invalid: false };
          failedAt = null;
        } else if (copy === null) {
          // Written to while in flight: better than nothing, but out of date.
          copy = { value, at: now(), outdated: true, invalid: true };
        }
        return value;
      })
      .catch((error: unknown) => {
        if (beganEpoch === epoch) failedAt = now();
        throw error;
      })
      .finally(() => {
        if (inFlight?.call === call) inFlight = null;
      });
    inFlight = { generation: began, call };
    return call;
  };

  return {
    async read(paseo, { fresh = false } = {}) {
      if (copy === null || fresh || copy.invalid) {
        try {
          return await refresh(paseo);
        } catch (error) {
          if (copy) return copy.value;
          throw error;
        }
      }
      const old = copy.outdated || now() - copy.at >= ttl;
      const failedRecently = failedAt !== null && now() - failedAt < ttl;
      if (old && !failedRecently) void refresh(paseo).catch(() => undefined);
      return copy.value;
    },
    invalidate() {
      generation += 1;
      failedAt = null;
      if (copy) copy = { ...copy, outdated: true, invalid: true };
    },
    markOld() {
      failedAt = null;
      if (copy) copy = { ...copy, outdated: true };
    },
    reset() {
      epoch += 1;
      copy = null;
      failedAt = null;
      inFlight = null;
    },
    calls: () => started,
  };
}

// ------------------------------------------------------------ the two reads

export type DaemonProject = { name: string; path: string };
type ProjectApi = { list(): Promise<{ entries?: Array<{ name?: string; path?: string }> } | Array<{ name?: string; path?: string }>> };

/** Every project Paseo has registered (Paseo 0.7+); [] from a host without the API. */
export const projectList = daemonRead<DaemonProject[]>({
  load: async (paseo) => {
    const projectApi = (paseo as unknown as { projects?: ProjectApi }).projects;
    if (!projectApi) return [];
    const result = await withDeadline(projectApi.list(), "its project list");
    const entries = Array.isArray(result) ? result : result.entries ?? [];
    return entries.flatMap((entry) => (entry.path ? [{ name: entry.name || basename(entry.path), path: entry.path }] : []));
  },
});

/**
 * The daemon's provider settings. The daemon returns config flattened
 * (`config.providers`), though a patch is written as `{ agents: { providers } }`.
 */
export const providerSettings = daemonRead<Record<string, unknown>>({
  load: async (paseo) => {
    const { config } = await withDeadline(paseo.config.get(), "its provider settings");
    const shape = config as { providers?: Record<string, unknown>; agents?: { providers?: Record<string, unknown> } };
    return shape.providers ?? shape.agents?.providers ?? {};
  },
});

/** A write changed what the daemon would answer: the next read of the project list or provider settings waits for a new answer. */
export function invalidateDaemonReads(what: "projects" | "config" | "all" = "all"): void {
  if (what !== "config") projectList.invalidate();
  if (what !== "projects") providerSettings.invalidate();
}

/** Refresh was pressed: the next read of each refreshes in the background, joining a call already running. */
export function refreshDaemonReads(what: "projects" | "config" | "all" = "all"): void {
  if (what !== "config") projectList.markOld();
  if (what !== "projects") providerSettings.markOld();
}

/** For tests: forget the cached daemon reads. */
export function resetDaemonReads(): void {
  projectList.reset();
  providerSettings.reset();
}

/** For tests and the bench: how many project-list and provider-settings calls reached the daemon. */
export function daemonReadCalls(): { projects: number; config: number } {
  return { projects: projectList.calls(), config: providerSettings.calls() };
}
