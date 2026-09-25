/** Cached MCP tool lists, shared by the composer chip and the surface. */
import type { PluginComposerPillProps } from "@getpaseo/plugin/client";
import { useAgent, useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useCallback } from "react";
import { Text, View } from "react-native";
import { chipLabel, mcpTools, mcpToolsCached, type McpServerTools, type McpTool, type McpToolsReport } from "../shared/contracts";
import { clockTime, failureStreak } from "../shared/schedule";
import { cachedReadInterval, useHealth, type CachedRead } from "./health";
import { useAgentChat } from "./chat";
import { paseoToolsFor, usePaseoTools } from "./paseo-tools";
import { Card, Disclosure, Facts, Row, useTokens, type Status } from "./ui";

export const TOOLS_QUERY_KEY = ["paseo-mcp", "tools"] as const;

/**
 * Reads the host's last known tool lists. The host refreshes on its own timer,
 * so this is a cheap read that never waits on a listing: on a fresh host the
 * host starts one and answers `checking`, and this reads again every few
 * seconds until the lists are in (see useHealth). `refetch` always asks: it
 * backs the Refresh button.
 */
export function useTools() {
  const callCached = useRpc(mcpToolsCached);
  const callTools = useRpc(mcpTools);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: TOOLS_QUERY_KEY,
    queryFn: async (): Promise<CachedRead<McpToolsReport>> => {
      const cached = await callCached({});
      if (!cached.report && cached.checking === undefined) return { report: await callTools({}), checking: false };
      return { report: cached.report, checking: cached.checking ?? false };
    },
    staleTime: 5 * 60_000,
    // Only while a chip or panel is mounted; slower after failures.
    refetchInterval: (query) => cachedReadInterval(query.state.data, failureStreak(query), 5 * 60_000, 30 * 60_000),
    retry: false,
  });
  const fresh = useQuery({
    queryKey: [...TOOLS_QUERY_KEY, "fresh"],
    queryFn: () => callTools({}),
    enabled: false,
    retry: false,
  });
  const refetch = useCallback(async () => {
    const result = await fresh.refetch();
    if (result.data) queryClient.setQueryData<CachedRead<McpToolsReport>>(TOOLS_QUERY_KEY, { report: result.data, checking: false });
    return result;
  }, [fresh, queryClient]);
  const read = query.data;
  return {
    data: read?.report ?? undefined,
    error: query.error ?? fresh.error,
    isFetching: query.isFetching || fresh.isFetching || Boolean(read?.checking && !read.report),
    refetch,
  };
}

export function toolsStatus(kind: McpServerTools["kind"]): Status {
  if (kind === "listed") return "ok";
  if (kind === "unavailable") return "attention";
  return "neutral";
}

/** The trailing word for a server's tools state: a count when known, otherwise why not. */
export function toolsWord(entry: McpServerTools): string {
  switch (entry.kind) {
    case "listed":
      return `${entry.tools.length} ${entry.tools.length === 1 ? "tool" : "tools"}${entry.stale ? ` (as of ${clockTime(entry.stale.asOf)})` : ""}`;
    case "auth-required":
      return "sign in to list";
    case "stdio":
      return "runs on demand";
    default:
      return "not listed";
  }
}

// ------------------------------------------------------------------- chip

/**
 * Always-on composer chip body: the server count and the one thing worth
 * knowing about them (an issue count, a sign-in count, or, since 0.14.0, what
 * this agent's tool definitions cost: "~38k tokens", or "deferred").
 * Pressing it opens the agent's MCP panel. Colour is never the only channel:
 * the icon changes with the tone too.
 */
export function McpChip({ theme, agentId, workspaceId }: PluginComposerPillProps) {
  const health = useHealth();
  const tools = useTools();
  // Paseo's built-in server counts when this agent's provider gets it.
  const provider = useAgent(agentId, (agent) => agent.provider);
  const paseo = usePaseoTools();
  // 0.14.0: this agent's context meter, read beside the reports and never
  // waited on; until it arrives (or on an older host) the label is as before.
  const meter = useAgentChat(workspaceId, agentId, provider, false);
  const { label, tone } = chipLabel(health.data, tools.data, paseoToolsFor(paseo.data, provider), meter.data?.meter ?? null);
  const color = tone === "attention" ? theme.colors.statusWarning : theme.colors.foregroundMuted;
  return (
    <>
      <Icon name={tone === "attention" ? "TriangleAlert" : "Plug"} size={14} color={color} />
      <Text numberOfLines={1} style={{ color, flexShrink: 1 }}>
        {label}
      </Text>
    </>
  );
}

// ------------------------------------------------------------------- rows

/**
 * One tool. The row is slotted so a per-tool control (allow / deny / ask) can
 * take the `trailing` slot later without the layout moving; `control` is that
 * slot, empty for now. Description text is server-controlled and already
 * flattened to one capped line on the host; `numberOfLines` keeps it there.
 */
export function ToolRow({ tool, first, control }: { tool: McpTool; first?: boolean; control?: React.ReactNode }) {
  const t = useTokens();
  const args = tool.takesArguments
    ? tool.arguments.map((name) => (tool.required.includes(name) ? `${name}*` : name)).join(", ")
    : "";
  return (
    <Row
      first={first}
      title={
        <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm, minWidth: 0 }}>
          <Text numberOfLines={1} style={[t.text.mono, { color: t.color.fg, flexShrink: 1 }]}>
            {tool.name}
          </Text>
          {tool.title && tool.title !== tool.name ? (
            <Text numberOfLines={1} style={[t.text.caption, { flexShrink: 1 }]}>
              {tool.title}
            </Text>
          ) : null}
        </View>
      }
      subtitle={tool.description || undefined}
      meta={
        <Facts
          items={[
            tool.takesArguments ? { value: `arguments: ${args}` } : { value: "no arguments" },
          ]}
        />
      }
      trailing={control}
    />
  );
}

/** A server's tool list, or the honest reason there is none. */
export function ServerTools({ entry, open = false }: { entry: McpServerTools; open?: boolean }) {
  const t = useTokens();
  const info = entry.serverInfo ? `${entry.serverInfo.name}${entry.serverInfo.version ? ` ${entry.serverInfo.version}` : ""}` : "";
  const facts = (
    <Facts
      items={[
        info ? { value: info } : null,
        entry.protocolVersion ? { value: `protocol ${entry.protocolVersion}` } : null,
      ]}
    />
  );
  if (entry.kind !== "listed") {
    return (
      <View style={{ gap: t.space.xs }}>
        <Text style={t.text.caption}>{reasonText(entry)}</Text>
        {facts}
      </View>
    );
  }
  if (entry.tools.length === 0) {
    return (
      <View style={{ gap: t.space.xs }}>
        <Text style={t.text.caption}>The server answered and listed no tools.</Text>
        {facts}
      </View>
    );
  }
  return (
    <View style={{ gap: t.space.sm }}>
      {facts}
      {entry.stale ? (
        <Text style={t.text.caption}>
          {entry.stale.restored
            ? `This list is from ${clockTime(entry.stale.asOf)}, ${entry.stale.reason}. It is replaced once the server answers again.`
            : `This list is from ${clockTime(entry.stale.asOf)}; the latest ask did not get an answer (${entry.stale.reason}). It is kept until the server answers again.`}
        </Text>
      ) : null}
      <Disclosure title={toolsWord(entry)} open={open}>
        <Card level={2} padded={false}>
          {entry.tools.map((tool, index) => (
            <ToolRow key={tool.name} tool={tool} first={index === 0} />
          ))}
        </Card>
      </Disclosure>
    </View>
  );
}

function reasonText(entry: McpServerTools): string {
  switch (entry.kind) {
    case "auth-required":
      return "This server needs a sign-in before it will list its tools. Your editor holds the grant; connect it from this server's sign-in rows and the list appears in the editor.";
    case "stdio":
      return `Command server: ${entry.note}. The plugin does not start processes, so nothing is listed here rather than guessed.`;
    default:
      return `Tools could not be listed: ${entry.note || "the server gave no answer"}.`;
  }
}
