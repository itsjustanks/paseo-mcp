import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useAgent, useSettings } from "@getpaseo/plugin/client";
import React from "react";
import { Text, View } from "react-native";
import { injectionSettings, injectionTargets } from "../shared/settings";
import { UnusedInChatItem } from "./chat";
import { WorkspaceBody } from "./mcp";
import { Tag, TokensProvider, useTokens, useUi, type Status } from "./ui";

function providerLabel(provider: string): string {
  if (provider === "claude") return "Claude Code";
  if (provider === "codex") return "Codex";
  return provider;
}

/** Under Technical details: which app this chat runs on, and whether project connectors are added to it. */
function AgentIntro({ agentId }: { agentId: string }) {
  const t = useTokens();
  const agent = useAgent(agentId, ({ provider, model }) => ({ provider, model }));
  const settings = useSettings(injectionSettings);
  if (!agent) return <Text style={t.text.caption}>Agent unavailable.</Text>;

  const injection: { label: string; tone: Status } =
    settings.status === "loading"
      ? { label: "Checking…", tone: "neutral" }
      : settings.status !== "ready"
        ? { label: "Project-connector settings unavailable", tone: "attention" }
        : !settings.values.injectWorkspaceServers
          ? { label: "Project connectors not added", tone: "neutral" }
          : injectionTargets(settings.values, agent.provider)
            ? { label: "Project connectors added for this provider", tone: "ok" }
            : { label: `Project connectors added, but not for ${providerLabel(agent.provider)}`, tone: "attention" };

  return (
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: t.space.sm }}>
      <Text style={t.text.body}>
        Runs on {providerLabel(agent.provider)}
        {agent.model ? ` · ${agent.model}` : ""}
      </Text>
      <Tag label={injection.label} tone={injection.tone} />
      {settings.status === "ready" && settings.values.injectWorkspaceServers ? (
        <Text style={t.text.caption}>
          New agents get this workspace's .mcp.json connectors; this agent's own list is not changed after creation.
        </Text>
      ) : null}
    </View>
  );
}

export function McpAgentPanel(props: PluginAgentPanelProps) {
  const t = useUi(props.theme, props.layout.compact);
  const provider = useAgent(props.agentId, ({ provider }) => provider);
  return (
    <TokensProvider value={t}>
      <WorkspaceBody
        key={`${props.workspaceId}:${props.agentId}`}
        host={props.host}
        workspaceId={props.workspaceId}
        caption="Connectors for this chat"
        intro={<AgentIntro agentId={props.agentId} />}
        providerId={provider ?? undefined}
        agentId={props.agentId}
        chatSection={<UnusedInChatItem workspaceId={props.workspaceId} agentId={props.agentId} providerId={provider} />}
      />
    </TokensProvider>
  );
}
