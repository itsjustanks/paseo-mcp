/** What an agent in this workspace loads, what it costs, and what is running for it now. */
import React from "react";
import { Text, View } from "react-native";
import { z } from "zod";
import {
  BUDGET_ATTENTION,
  BUDGET_PROBLEM,
  costProfile,
  loadFor,
  loadsForWorkspace,
  scopeForProvider,
  userLevelNames,
  type WorkspaceLoad,
} from "../shared/budget";
import type { mcpWorkspace } from "../shared/contracts";
import { formatMemory } from "../shared/processes";
import { canOpenMcp, openMcp } from "./navigate";
import { Button, Card, Disclosure, Facts, Notice, Tag, useTokens, type Status } from "./ui";

type WorkspaceData = z.output<typeof mcpWorkspace.output>;

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function tierStatus(tier: "ok" | "attention" | "problem"): Status {
  return tier === "problem" ? "error" : tier === "attention" ? "attention" : "ok";
}

/**
 * Which editor's load to show. The agent panel names its provider; the
 * workspace panel shows the heaviest wired editor, since that is the agent
 * most likely to fall over.
 */
export function pickLoad(data: WorkspaceData, providerId?: string): WorkspaceLoad | null {
  if (!data.profile) return null;
  const injection = data.injection ?? null;
  if (providerId) {
    const scope = scopeForProvider(data.profile, providerId);
    if (scope) return loadFor(data.profile, scope, injection);
  }
  return loadsForWorkspace(data.profile, injection)[0] ?? null;
}

// -------------------------------------------------------------- context budget

function ContextBudget({ load, providerId }: { load: WorkspaceLoad; providerId?: string }) {
  const t = useTokens();
  const cost = costProfile(load);
  const userNames = userLevelNames(load);
  const who = providerId ? "This agent" : load.label ? `A ${load.label.split(" · ")[0]} agent here` : "An agent here";
  if (cost.tier === "ok") return null;
  const severe = cost.tier === "problem";
  return (
    <Notice tone={severe ? "error" : "attention"}>
      <View style={{ gap: t.space.sm }}>
        <Text style={t.text.bodyStrong}>
          {severe
            ? `${who} loads ${plural(cost.total, "MCP server")} — enough to exhaust its context before it starts`
            : `${who} loads ${plural(cost.total, "MCP server")} — a real share of its context goes to tool definitions`}
        </Text>
        <Text style={t.text.body}>
          Every server's tool definitions are sent with the first prompt. Claude Code defers them past 10% of the
          window; Cursor stops at 40 tools. Past {BUDGET_ATTENTION} servers the cost shows, past {BUDGET_PROBLEM} agents
          can fail with "Prompt is too long" before their first tool call.
        </Text>
        {userNames.length > 0 ? (
          <>
            <Text style={t.text.body}>
              {plural(userNames.length, "server")} come from user-level config and load in every workspace. Move the ones
              only this project needs into its .mcp.json, or remove them from the editor config.
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.xs }}>
              {userNames.map((name) => <Tag key={name} label={name} />)}
            </View>
          </>
        ) : null}
        {canOpenMcp() ? (
          <View style={{ flexDirection: "row" }}>
            <Button label="Open MCP management" onPress={() => openMcp()} />
          </View>
        ) : null}
      </View>
    </Notice>
  );
}

// ------------------------------------------------------------------ running

function RunningNow({ processes }: { processes: NonNullable<WorkspaceData["processes"]> }) {
  const t = useTokens();
  if (!processes.available) {
    return <Text style={t.text.caption}>Running processes not readable: {processes.reason}.</Text>;
  }
  const { observed } = processes;
  if (observed.agents === 0) {
    return <Text style={t.text.caption}>No agent from this workspace is running now, so there is nothing to measure yet.</Text>;
  }
  return (
    <View style={{ gap: t.space.sm }}>
      <Facts
        items={[
          { value: `${plural(observed.agents, "agent")} running here` },
          { value: `${observed.processes} MCP ${observed.processes === 1 ? "process" : "processes"}` },
          { value: `${formatMemory(observed.rssKb)} resident` },
        ]}
      />
      {observed.servers.map((entry) => (
        <View key={entry.name} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: t.space.sm }}>
          <Text style={t.text.bodyStrong}>{entry.name}</Text>
          <Text style={t.text.caption}>
            {entry.processes} {entry.processes === 1 ? "process" : "processes"} · {formatMemory(entry.rssKb)}
          </Text>
        </View>
      ))}
      {observed.unmatchable.length > 0 ? (
        <Text style={t.text.caption}>
          Not matchable to a process: {observed.unmatchable.join(", ")} (the command alone does not identify it).
        </Text>
      ) : null}
    </View>
  );
}

// ------------------------------------------------------------------- summary

/**
 * The card the workspace and agent panels lead with: how many servers an
 * agent here loads and from where, what they cost, and which ones are running.
 * `attention` is how many of those servers the health check flags.
 */
export function WorkspaceContext({
  data,
  providerId,
  attention,
}: {
  data: WorkspaceData;
  providerId?: string;
  attention: { here: number; elsewhere: number } | null;
}) {
  const t = useTokens();
  const load = pickLoad(data, providerId);
  if (!load) return null;
  const cost = costProfile(load);
  const scope = cost.local > 0 ? ` · ${cost.local} local` : "";
  const who = providerId ? "this agent" : load.label ? `a ${load.label.split(" · ")[0]} agent here` : "an agent here";
  return (
    <View style={{ gap: t.space.md }}>
      <Card tone={cost.total > 0 ? tierStatus(cost.tier) : undefined}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: t.space.sm }}>
          <Text style={t.text.heading}>
            {plural(cost.total, "MCP server")} for {who}
          </Text>
          {cost.total > 0 ? <Tag label={cost.tier === "ok" ? "within budget" : cost.tier === "attention" ? "getting heavy" : "over budget"} tone={tierStatus(cost.tier)} /> : null}
        </View>
        <Facts
          items={[
            { value: `${cost.project} from this project's .mcp.json${scope}` },
            { value: `${cost.user} from user-level config` },
            attention
              ? attention.here > 0
                ? { value: `${attention.here} need attention here`, tone: "attention" }
                : { value: "none need attention here", tone: "ok" }
              : null,
            attention && attention.elsewhere > 0 ? { value: `${attention.elsewhere} elsewhere` } : null,
          ]}
        />
        <Facts
          items={[
            { value: `${cost.stdio} stdio — a child process per agent session` },
            { value: `${cost.http} http — no local process` },
            cost.unknown ? { value: `${cost.unknown} unreadable` } : null,
          ]}
        />
        {!load.projectIncluded && load.projectNote ? <Text style={t.text.caption}>{load.projectNote}.</Text> : null}
        {data.processes ? (
          <Disclosure title="Running now" open={data.processes.available && data.processes.observed.agents > 0}>
            <RunningNow processes={data.processes} />
          </Disclosure>
        ) : null}
      </Card>
      <ContextBudget load={load} providerId={providerId} />
    </View>
  );
}
