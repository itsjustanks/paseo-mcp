/** Cached MCP health, shared by the composer pill, the panels, and the surface. */
import type { PluginComposerPillProps } from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
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
import { Facts, Notice, Tag, useTokens, type Status } from "./ui";

export const HEALTH_QUERY_KEY = ["paseo-mcp", "health"] as const;

/**
 * Reads the host's last known health. The server probes on its own timer, so
 * this is a cheap read; only the very first call on a fresh host (no report
 * yet) asks for a real probe. `refetch` always probes: it backs the Refresh
 * and Check now buttons.
 */
export function useHealth() {
  const callCached = useRpc(mcpHealthCached);
  const callHealth = useRpc(mcpHealth);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: HEALTH_QUERY_KEY,
    queryFn: async (): Promise<McpHealthReport> => {
      const cached = await callCached({});
      return cached.report ?? (await callHealth({}));
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
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
    if (result.data) queryClient.setQueryData(HEALTH_QUERY_KEY, result.data);
    return result;
  }, [probe, queryClient]);
  return {
    data: query.data,
    error: query.error ?? probe.error,
    isFetching: query.isFetching || probe.isFetching,
    refetch,
  };
}

export function healthStatus(status: McpHealth["status"]): Status {
  if (status === "ok") return "ok";
  if (status === "auth-required" || status === "warn") return "attention";
  if (status === "unknown") return "neutral";
  return "error";
}

export function healthWord(status: McpHealth["status"]): string {
  switch (status) {
    case "ok":
      return "healthy";
    case "auth-required":
      return "sign-in";
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

// ------------------------------------------------------------------- pill

/**
 * Composer pill body. The client entry only registers the pill while the cached
 * report has at least one issue, so a healthy host shows nothing rather than a
 * permanent "0 problems" badge on every agent; this component covers the brief
 * window between a fix landing and the entry removing the pill.
 */
export function HealthPill({ theme, workspaceId }: PluginComposerPillProps) {
  const workspace = useWorkspace(workspaceId, ({ directory }) => ({ directory }));
  const { data } = useHealth();
  const { issues, project } = useMemo(() => splitIssues(data, workspace?.directory ?? ""), [data, workspace]);
  const calm = issues.length === 0;
  const color = calm ? theme.colors.foregroundMuted : theme.colors.statusWarning;
  const label = calm
    ? "MCP healthy"
    : project.length > 0
      ? `${plural(issues.length, "MCP issue")} · ${project.length} in this project`
      : plural(issues.length, "MCP issue");
  return (
    <>
      <Icon name={calm ? "Plug" : "TriangleAlert"} size={14} color={color} />
      <Text numberOfLines={1} style={{ color, flexShrink: 1 }}>
        {label}
      </Text>
    </>
  );
}

// ---------------------------------------------------------------- panels

/**
 * One block under a workspace or agent panel header: which servers need
 * attention, and whether the fix belongs in this project's `.mcp.json` or in
 * the user's editor config. Silent while everything is healthy.
 */
export function HealthSummary({ directory }: { directory: string }) {
  const t = useTokens();
  const { data, error } = useHealth();
  const { issues, project, user, elsewhere } = useMemo(() => splitIssues(data, directory), [data, directory]);
  if (error && !data) return <Text style={t.text.caption}>Health check unavailable.</Text>;
  if (!data || issues.length === 0) return null;
  const rows = (entries: McpHealth[], where: string) =>
    entries.map((entry) => (
      <View key={`${where}-${entry.name}`} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: t.space.sm }}>
        <Text style={t.text.bodyStrong}>{entry.name}</Text>
        <Tag label={healthWord(entry.status)} tone={healthStatus(entry.status)} />
        <Tag label={where} />
        {entry.note ? <Text style={t.text.caption}>{entry.note}</Text> : null}
      </View>
    ));
  return (
    <Notice tone={issues.some((entry) => healthStatus(entry.status) === "error") ? "error" : "attention"}>
      <View style={{ gap: t.space.sm }}>
        <Text style={t.text.body}>{`${plural(issues.length, "MCP server")} need attention`}</Text>
        {rows(project, "this project")}
        {rows(user.filter((entry) => !project.includes(entry)), "user config")}
        {rows(elsewhere, "other project")}
        <Facts
          items={[
            project.length ? { value: `${project.length} in this project's .mcp.json` } : null,
            user.length ? { value: `${user.length} in editor configs (every workspace)` } : null,
            { value: `checked ${new Date(data.checkedAt).toLocaleString()}` },
          ]}
        />
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
