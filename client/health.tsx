/** Cached MCP health, shared by the composer pill, the panels, and the surface. */
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import {
  healthNeedsAttention,
  mcpHealth,
  mcpHealthCached,
  scopedToDirectory,
  type McpHealth,
  type McpHealthReport,
} from "../shared/contracts";
import { cachedReadInterval, clockTime, failureStreak, type CachedRead } from "../shared/schedule";

export { CHECKING_POLL_MS, cachedReadInterval, type CachedRead } from "../shared/schedule";
import { canOpenMcp, openMcp } from "./navigate";
import { Button, Disclosure, Facts, Notice, Tag, useTokens, type Status } from "./ui";

export const HEALTH_QUERY_KEY = ["paseo-mcp", "health"] as const;

/**
 * Reads the host's last known health. The server probes on its own timer, so
 * this is a cheap read that never waits on a probe: on a fresh host the host
 * starts one and answers `checking`, and this reads again every few seconds
 * until the verdict is in. A host older than 0.11.3 does not start one, so the
 * first read there still asks for a probe. `refetch` always probes: it backs
 * the Refresh and Check now buttons.
 */
export function useHealth() {
  const callCached = useRpc(mcpHealthCached);
  const callHealth = useRpc(mcpHealth);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: HEALTH_QUERY_KEY,
    queryFn: async (): Promise<CachedRead<McpHealthReport>> => {
      const cached = await callCached({});
      if (!cached.report && cached.checking === undefined) return { report: await callHealth({}), checking: false };
      return { report: cached.report, checking: cached.checking ?? false };
    },
    staleTime: 60_000,
    // Only while something that shows health is mounted; slower after failures
    // (1, 2, 4 … 15 minutes) so an unreachable host is not asked every minute.
    refetchInterval: (query) => cachedReadInterval(query.state.data, failureStreak(query), 60_000, 15 * 60_000),
    retry: false,
  });
  const probe = useQuery({
    queryKey: [...HEALTH_QUERY_KEY, "probe"],
    queryFn: () => callHealth({}),
    enabled: false,
    retry: false,
  });
  const refetch = useCallback(async () => {
    const result = await probe.refetch();
    if (result.data) queryClient.setQueryData<CachedRead<McpHealthReport>>(HEALTH_QUERY_KEY, { report: result.data, checking: false });
    return result;
  }, [probe, queryClient]);
  const read = query.data;
  return {
    data: read?.report ?? undefined,
    error: query.error ?? probe.error,
    // The host's own check counts while there is nothing to show yet, so panels say "checking".
    isFetching: query.isFetching || probe.isFetching || Boolean(read?.checking && !read.report),
    refetch,
  };
}

/** "checked 14:05", or "as of 14:05 (saved before the plugin restarted)" until this run has checked. */
export function healthCheckedLabel(report: McpHealthReport, time: (iso: string) => string = clockTime): string {
  return report.stale ? `as of ${time(report.stale.asOf)} (${report.stale.reason})` : `checked ${time(report.checkedAt)}`;
}

export function healthStatus(status: McpHealth["status"]): Status {
  if (status === "ok") return "ok";
  if (status === "warn") return "attention";
  // 401 is how a working OAuth server answers an anonymous probe; informational.
  if (status === "unknown" || status === "auth-required") return "neutral";
  return "error";
}

export function healthWord(status: McpHealth["status"]): string {
  switch (status) {
    case "ok":
      return "healthy";
    case "auth-required":
      return "OAuth";
    case "warn":
      return "warning";
    case "binary-missing":
      return "no binary";
    case "down":
      return "down";
    default:
      return "unchecked";
  }
}

/** Results that need attention, split by where the definition lives relative to `directory`. */
export function splitIssues(report: McpHealthReport | undefined, directory: string) {
  const issues = (report?.results ?? []).filter((entry) => healthNeedsAttention(entry.status));
  const scopes = (entry: McpHealth) => entry.scopes ?? [];
  return {
    issues,
    // Defined by this workspace's own .mcp.json (or a parent project's).
    project: issues.filter((entry) => scopes(entry).some((scope) => scopedToDirectory(scope, directory))),
    // Defined in an editor's global config; affects every workspace.
    user: issues.filter((entry) => scopes(entry).some((scope) => scope.level === "user")),
    // Defined by some other project's .mcp.json only; shown so nothing is hidden.
    elsewhere: issues.filter(
      (entry) =>
        !scopes(entry).some((scope) => scope.level === "user" || scopedToDirectory(scope, directory)),
    ),
  };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// The composer chip moved to client/tools.tsx (McpChip) in 0.6.0: it is always
// on and reads both the health and the tool reports.

// ---------------------------------------------------------------- panels

/**
 * One block under a workspace or agent panel header: the servers an agent
 * here would load that need attention, each one press from its management
 * page, with problems elsewhere folded away. `names` is what an agent in this
 * workspace loads (see shared/budget.ts); without it, "here" falls back to
 * definitions scoped to the directory. Silent while everything is healthy.
 */
export function HealthSummary({ directory, names }: { directory: string; names: Set<string> | null }) {
  const t = useTokens();
  const { data, error } = useHealth();
  const { issues, project, user, elsewhere } = useMemo(() => splitIssues(data, directory), [data, directory]);
  if (error && !data) return <Text style={t.text.caption}>Health check unavailable.</Text>;
  if (!data || issues.length === 0) return null;
  const here = issues.filter((entry) => (names ? names.has(entry.name) : project.includes(entry)));
  const away = issues.filter((entry) => !here.includes(entry));
  const where = (entry: McpHealth) =>
    project.includes(entry) ? "this project" : user.includes(entry) ? "user config" : elsewhere.includes(entry) ? "other project" : "";
  const rows = (entries: McpHealth[]) =>
    entries.map((entry) => (
      <View key={entry.name} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: t.space.sm }}>
        <Text style={t.text.bodyStrong}>{entry.name}</Text>
        <Tag label={healthWord(entry.status)} tone={healthStatus(entry.status)} />
        <Tag label={where(entry)} />
        {entry.note ? <Text style={[t.text.caption, { flexShrink: 1 }]}>{entry.note}</Text> : null}
        {canOpenMcp() ? <Button label="Open" variant="ghost" onPress={() => openMcp(entry.name)} /> : null}
      </View>
    ));
  const tone: Status = here.some((entry) => healthStatus(entry.status) === "error") ? "error" : here.length > 0 ? "attention" : "neutral";
  return (
    <Notice tone={tone}>
      <View style={{ gap: t.space.sm }}>
        <Text style={t.text.body}>
          {here.length > 0
            ? `${plural(here.length, "MCP server")} this workspace loads ${here.length === 1 ? "needs" : "need"} attention`
            : `No MCP problems here · ${plural(away.length, "issue")} elsewhere`}
        </Text>
        {rows(here)}
        {away.length > 0 ? (
          here.length > 0 ? (
            <Disclosure title={`${plural(away.length, "issue")} elsewhere`}>{rows(away)}</Disclosure>
          ) : (
            rows(away)
          )
        ) : null}
        <Facts items={[{ value: healthCheckedLabel(data, (iso) => new Date(iso).toLocaleString()) }]} />
      </View>
    </Notice>
  );
}

/** Trailing tag for a project server row: its health, when the host has checked it. */
export function ServerHealthTag({ name }: { name: string }) {
  const { data } = useHealth();
  const entry = data?.results.find((item) => item.name === name);
  if (!entry) return null;
  return <Tag label={healthWord(entry.status)} tone={healthStatus(entry.status)} />;
}
