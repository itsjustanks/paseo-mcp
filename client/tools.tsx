/** Cached MCP tool lists, shared by the composer chip and the surface. */
import type { PluginComposerPillProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { chipLabel, mcpTools, mcpToolsCached, type McpServerTools, type McpTool, type McpToolsReport } from "../shared/contracts";
import { summarizeTools } from "../shared/tools";
import { useHealth } from "./health";
import { Button, Card, Disclosure, EmptyState, Facts, Row, Tag, useTokens, type Status } from "./ui";

export const TOOLS_QUERY_KEY = ["paseo-mcp", "tools"] as const;

/**
 * Reads the host's last known tool lists. The host refreshes on its own timer,
 * so this is a cheap read; only the very first call on a fresh host asks every
 * server. `refetch` always asks: it backs the Refresh button.
 */
export function useTools() {
  const callCached = useRpc(mcpToolsCached);
  const callTools = useRpc(mcpTools);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: TOOLS_QUERY_KEY,
    queryFn: async (): Promise<McpToolsReport> => {
      const cached = await callCached({});
      return cached.report ?? (await callTools({}));
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
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
    if (result.data) queryClient.setQueryData(TOOLS_QUERY_KEY, result.data);
    return result;
  }, [fresh, queryClient]);
  return {
    data: query.data,
    error: query.error ?? fresh.error,
    isFetching: query.isFetching || fresh.isFetching,
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
      return `${entry.tools.length} ${entry.tools.length === 1 ? "tool" : "tools"}`;
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
 * knowing about them (an issue count, a sign-in count, or the tool total).
 * Pressing it opens the agent's MCP panel. Colour is never the only channel:
 * the icon changes with the tone too.
 */
export function McpChip({ theme }: PluginComposerPillProps) {
  const health = useHealth();
  const tools = useTools();
  const { label, tone } = chipLabel(health.data, tools.data);
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
      return `Tools could not be listed: ${entry.note || "no answer"}.`;
  }
}

// ---------------------------------------------------------------- section

/**
 * The Tools section of the MCP surface: every server with its tool count and,
 * expanded, the tools themselves. Reads the cache; Refresh asks every server.
 */
export function ToolsSection({ onOpenServer }: { onOpenServer: (name: string) => void }) {
  const t = useTokens();
  const { data, error, isFetching, refetch } = useTools();
  const totals = data ? summarizeTools(data.servers) : null;
  const [filter, setFilter] = useState<"all" | "listed" | "sign-in" | "stdio">("all");
  const shown = (data?.servers ?? []).filter((entry) => {
    if (filter === "listed") return entry.kind === "listed";
    if (filter === "sign-in") return entry.kind === "auth-required";
    if (filter === "stdio") return entry.kind === "stdio";
    return true;
  });
  return (
    <View style={{ gap: t.space.lg }}>
      <View style={{ flexDirection: t.compact ? "column" : "row", alignItems: t.compact ? "stretch" : "flex-end", justifyContent: "space-between", gap: t.space.md }}>
        <View style={{ gap: 2, flexShrink: 1 }}>
          <Text style={t.text.display}>
            {totals ? `${totals.tools} tools across ${totals.listed} of ${totals.servers} servers` : "Tools"}
          </Text>
          <Text style={t.text.caption}>
            What each server would hand an agent, asked with the same initialize and tools/list a client sends. Nothing is guessed: a server that cannot be asked says why.
          </Text>
        </View>
        <View style={{ flexDirection: "row", gap: t.space.sm }}>
          <Button label="Refresh" loading={isFetching} onPress={() => void refetch()} />
        </View>
      </View>
      {totals ? (
        <Facts
          items={[
            { value: `${totals.listed} listed`, tone: totals.listed > 0 ? "ok" : undefined },
            totals.signIn > 0 ? { value: `${totals.signIn} need sign-in` } : null,
            totals.stdio > 0 ? { value: `${totals.stdio} command servers` } : null,
            totals.unavailable > 0 ? { value: `${totals.unavailable} not listed`, tone: "attention" } : null,
            data ? { value: `checked ${new Date(data.checkedAt).toLocaleString()}` } : null,
          ]}
        />
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
        {(
          [
            ["all", "All"],
            ["listed", "Listed"],
            ["sign-in", "Need sign-in"],
            ["stdio", "Command"],
          ] as const
        ).map(([value, label]) => (
          <Button key={value} label={label} variant={filter === value ? "secondary" : "ghost"} onPress={() => setFilter(value)} />
        ))}
      </View>
      {error && !data ? <Text style={[t.text.caption, { color: t.color.danger }]}>{`Tool listing failed: ${error instanceof Error ? error.message : String(error)}`}</Text> : null}
      <Card padded={false}>
        {!data && isFetching ? <EmptyState title="Asking every server" body="The first listing asks each HTTP server to initialize and list its tools. Later visits read the host's cache." /> : null}
        {data && shown.length === 0 ? <EmptyState title="Nothing here" body={data.servers.length === 0 ? "No MCP server is defined in any editor yet." : "No server matches this filter."} /> : null}
        {shown.map((entry, index) => (
          <Row
            key={entry.name}
            first={index === 0}
            title={
              <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm, minWidth: 0 }}>
                <Text numberOfLines={1} style={[t.text.bodyStrong, { flexShrink: 1 }]}>{entry.name}</Text>
                <Tag label={entry.transport} />
                {entry.serverInfo?.name && entry.serverInfo.name !== entry.name ? <Tag label={entry.serverInfo.name} /> : null}
              </View>
            }
            trailing={
              <>
                <Tag label={toolsWord(entry)} tone={toolsStatus(entry.kind)} />
                <Button label="Open" variant="ghost" onPress={() => onOpenServer(entry.name)} />
              </>
            }
            expanded={<ServerTools entry={entry} />}
          />
        ))}
      </Card>
    </View>
  );
}
