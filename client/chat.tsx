/** The agent's context meter, what its chat used, and the in-chat sign-in card (0.14.0). */
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useAgent, useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { z } from "zod";
import { planTurnOffUnused, usedLine, usedUnused } from "../shared/chat";
import { mcpAgentChat, mcpAgentServers, mcpTurnOffUnused, type AgentMeter } from "../shared/contracts";
import { basisWord, shortTokens, usageLine, UNLISTED_SERVER_TOKENS } from "../shared/meter";
import { CHECKING_POLL_MS, backoffMs, failureStreak } from "../shared/schedule";
import { SWITCH_EFFECT_NOTE } from "../shared/enabled";
import { setSignInFocus } from "./focus";
import { Button, Card, Disclosure, Loading, Meter, Notice, Row, Section, Tag, TokensProvider, useTokens, useUi } from "./ui";

export const AGENT_CHAT_QUERY_KEY = ["paseo-mcp", "agent-chat"] as const;

/**
 * The host's cached meter (and, with `chat`, the chat read). The read never
 * waits; while the host is still working it says `checking`, and this asks
 * again every two seconds, otherwise once a minute (slower after failures).
 * A host older than 0.14.0 has no such RPC: the read fails, and the chip keeps
 * its old label.
 */
export function useAgentChat(workspaceId: string, agentId: string, providerId: string | null | undefined, chat: boolean) {
  const call = useRpc(mcpAgentChat);
  return useQuery({
    queryKey: [...AGENT_CHAT_QUERY_KEY, workspaceId, agentId, providerId ?? "", chat],
    queryFn: () => call({ workspaceId, providerId: providerId ?? "", agentId, chat }),
    enabled: Boolean(providerId),
    staleTime: 30_000,
    refetchInterval: (query) => {
      const failures = failureStreak(query);
      if (failures === 0 && query.state.data?.checking) return CHECKING_POLL_MS * 2;
      return backoffMs(failures, 60_000, 15 * 60_000);
    },
    retry: false,
  });
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** "14 servers · ≈38k tokens of tool definitions", or deferred. */
export function meterHeadline(meter: AgentMeter): string {
  const head = plural(meter.servers, "server");
  return meter.deferred
    ? `${head} · definitions deferred (tool search is on; ≈${shortTokens(meter.tokens)} if all loaded)`
    : `${head} · ≈${shortTokens(meter.tokens)} tokens of tool definitions`;
}

// ------------------------------------------------------------------ panel

/**
 * Why the panel does not offer "turn off the unused ones" for this read, or
 * null when it may: only a complete read of the whole chat whose last refresh
 * did not fail.
 */
export function turnOffBlocker(read: { chat: { complete: boolean } | null; stale: boolean }): string | null {
  if (read.stale) return read.chat ? "The last read of this chat failed, so these numbers may be out of date and nothing is offered to turn off." : "Couldn't read this chat's history, so nothing is offered to turn off.";
  if (!read.chat) return null;
  if (!read.chat.complete) return "This chat is too long to be sure which servers it used, so nothing is offered to turn off.";
  return null;
}

/**
 * The agent panel's context section: the meter, this chat's context use, the
 * heaviest servers, what the chat used and what it loaded without using, and
 * one action that turns the unused ones off for this workspace. The host
 * decides that on a fresh read of the whole chat and refuses if the list
 * shown here is no longer right (server/chat.ts `handleMcpTurnOffUnused`).
 */
export function ContextSection({ workspaceId, agentId, providerId }: { workspaceId: string; agentId: string; providerId: string | null | undefined }) {
  const t = useTokens();
  const toast = useToast();
  const queryClient = useQueryClient();
  const read = useAgentChat(workspaceId, agentId, providerId, true);
  const callAgentServers = useRpc(mcpAgentServers);
  const callTurnOff = useRpc(mcpTurnOffUnused);
  const provider = providerId ?? "";
  // Same key and function as the panel's own switch list, so both share one read.
  const serversQuery = useQuery({
    queryKey: ["paseo-mcp", "agent-servers", workspaceId, provider, agentId],
    queryFn: () => callAgentServers({ workspaceId, providerId: provider, agentId }),
    enabled: provider !== "",
    staleTime: 0,
    retry: 1,
  });
  const [armed, setArmed] = useState(false);
  const [running, setRunning] = useState(false);

  const data = read.data;
  const meter = data?.meter ?? null;
  const chat = data?.chat ?? null;
  const split = useMemo(() => (chat ? usedUnused(chat.loaded, chat.calls) : null), [chat]);
  const plan = useMemo(
    () => (chat && serversQuery.data ? planTurnOffUnused(serversQuery.data.servers, chat.calls) : null),
    [chat, serversQuery.data],
  );

  if (!provider) return null;
  if (!data) {
    if (read.isError) return null;
    return <Loading label="Estimating what this agent's MCP servers cost…" />;
  }

  const blocker = turnOffBlocker(data);

  const turnOff = async () => {
    if (!plan) return;
    setRunning(true);
    try {
      const result = await callTurnOff({ workspaceId, providerId: provider, agentId, expected: plan.off });
      if (result.done.length) toast.show(result.failed.length ? `Off for this workspace: ${result.done.join(", ")}. New sessions start without them.` : result.message, { variant: "success" });
      if (result.refused || result.failed.length) toast.error(result.refused ? result.message : `Not changed: ${result.failed.join(", ")}. Try their switches below.`);
    } catch {
      toast.error("The host did not answer. Check the switches below before trying again.");
    }
    setRunning(false);
    setArmed(false);
    void queryClient.invalidateQueries({ queryKey: ["paseo-mcp", "agent-servers"] });
    void queryClient.invalidateQueries({ queryKey: AGENT_CHAT_QUERY_KEY });
  };

  const usage = data.usage;
  return (
    <Section title="Context">
      <View style={{ gap: t.space.sm }}>
        {meter ? <Text style={t.text.bodyStrong}>{meterHeadline(meter)}</Text> : <Text style={t.text.caption}>Estimating…</Text>}
        {usage ? (
          <Meter fraction={usage.usedTokens / usage.maxTokens} label={usageLine(usage, meter)} tone={usage.usedTokens / usage.maxTokens >= 0.8 ? "attention" : "neutral"} />
        ) : data.checking && !chat ? null : (
          <Text style={t.text.caption}>This agent has not reported its context use yet.</Text>
        )}
        {meter && meter.defaults > 0 ? (
          <Text style={t.text.caption}>
            {`Estimates: listed servers are measured from their tool lists (JSON ÷ 4). ${plural(meter.defaults, "server")} could not be listed and count at a ${shortTokens(UNLISTED_SERVER_TOKENS)} default.`}
          </Text>
        ) : meter ? (
          <Text style={t.text.caption}>Estimates: measured from each server's tool list (JSON ÷ 4).</Text>
        ) : null}
        {meter && meter.costs.length > 0 ? (
          <Disclosure title="Heaviest servers" open>
            <Card padded={false}>
              {meter.costs.map((entry, index) => (
                <Row
                  key={entry.name}
                  first={index === 0}
                  title={entry.name}
                  meta={<Text style={t.text.caption}>{basisWord(entry.basis)}</Text>}
                  trailing={<Tag label={`≈${shortTokens(entry.tokens)}`} tone={entry.basis === "default" ? "neutral" : undefined} />}
                />
              ))}
            </Card>
          </Disclosure>
        ) : null}
        {chat && split ? (
          <View style={{ gap: t.space.xs }}>
            <Text style={t.text.body}>{split.used.length ? `Used in this chat: ${usedLine(split.used)}` : "Used in this chat: no MCP tool calls yet"}</Text>
            <Text style={t.text.body}>{`Loaded but unused: ${split.unused.length}`}</Text>
            {split.unused.length > 0 ? <Text style={t.text.caption}>{split.unused.join(", ")}</Text> : null}
            {chat.truncated ? <Text style={t.text.caption}>{`Read the last ${chat.scanned.toLocaleString()} timeline items; older calls are not counted.`}</Text> : null}
          </View>
        ) : data.checking ? (
          <Loading label="Reading this chat…" />
        ) : null}
        {blocker ? <Text style={t.text.caption}>{blocker}</Text> : null}
        {plan && plan.off.length > 0 && !blocker && !armed ? (
          <View style={{ flexDirection: "row" }}>
            <Button label="Turn off the unused ones for this workspace" onPress={() => setArmed(true)} />
          </View>
        ) : null}
        {plan && armed && !blocker ? (
          <Notice tone="attention">
            <View style={{ gap: t.space.sm }}>
              <Text style={t.text.bodyStrong}>{`Turn off ${plural(plan.off.length, "server")} for this workspace?`}</Text>
              <Text style={t.text.body}>{plan.off.join(", ")}</Text>
              {plan.kept.length > 0 ? (
                <Text style={t.text.caption}>{`Left as they are, with no switch for this provider: ${plan.kept.map((entry) => entry.name).join(", ")}.`}</Text>
              ) : null}
              <Text style={t.text.caption}>{`${SWITCH_EFFECT_NOTE} Each switch is the one in the list below; turn any back on there.`}</Text>
              <View style={{ flexDirection: "row", gap: t.space.sm }}>
                <Button label={`Turn off ${plan.off.length}`} variant="danger" loading={running} onPress={() => void turnOff()} />
                <Button label="Cancel" variant="ghost" disabled={running} onPress={() => setArmed(false)} />
              </View>
            </View>
          </Notice>
        ) : null}
      </View>
    </Section>
  );
}

// ------------------------------------------------------------ sign-in card

export const SignInCardSchema = z.object({ server: z.string().min(1).max(200), provider: z.string().max(100) });
export type SignInCardData = z.infer<typeof SignInCardSchema>;

/**
 * The in-chat card for a server whose tool call failed for lack of a sign-in.
 * Connect opens this agent's MCP panel with that server's sign-in rows first,
 * the same OAuth flow the panel always uses. `open` is the client's own panel
 * opener (the chip's), lent by the entry point.
 */
export function makeSignInCard(open: (workspaceId: string, agentId: string) => void) {
  return function SignInCard(props: PluginTimelineItemProps<SignInCardData>) {
    const t = useUi(props.theme, props.layout.compact);
    const workspaceId = useAgent(props.agentId, (agent) => agent.workspaceId);
    const { server } = props.item.data;
    return (
      <TokensProvider value={t}>
        <SignInCardBody
          server={server}
          onConnect={
            workspaceId
              ? () => {
                  setSignInFocus(props.agentId, server);
                  open(workspaceId, props.agentId);
                }
              : null
          }
        />
      </TokensProvider>
    );
  };
}

export function SignInCardBody({ server, onConnect }: { server: string; onConnect: (() => void) | null }) {
  const t = useTokens();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: t.space.md,
        borderWidth: 1,
        borderColor: t.color.border,
        borderRadius: t.radius.md,
        backgroundColor: t.color.surface1,
        paddingVertical: t.space.sm,
        paddingHorizontal: t.space.md,
        alignSelf: "flex-start",
        maxWidth: 560,
      }}
    >
      <View style={{ flexShrink: 1, gap: 2 }}>
        <Text style={t.text.bodyStrong} numberOfLines={1}>{`${server} needs sign-in`}</Text>
        <Text style={t.text.caption}>A tool call to it in this chat was refused for lack of a sign-in.</Text>
      </View>
      {onConnect ? <Button label="Connect" variant="primary" onPress={onConnect} /> : null}
    </View>
  );
}
