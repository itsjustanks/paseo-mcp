/** What an agent in this workspace loads, where from, and what is running for it now (the panels' Technical details). */
import React from "react";
import { Text, View } from "react-native";
import { z } from "zod";
import {
  BUDGET_ATTENTION,
  BUDGET_PROBLEM,
  BUDGET_TOOLS_ATTENTION,
  costProfile,
  loadFor,
  loadsForWorkspace,
  scopeForProvider,
  userLevelNames,
  withAdded,
  type AddedServer,
  type WorkspaceLoad,
} from "../shared/budget";
import type { mcpWorkspace } from "../shared/contracts";
import { PASEO_TOOLS_LABEL } from "../shared/paseo-tools";
import { toolSearchLine, toolSearchOnLine } from "../shared/tool-search";
import { formatMemory } from "../shared/processes";
import { Facts, useTokens } from "./ui";

type WorkspaceData = z.output<typeof mcpWorkspace.output>;

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * Which editor's load to show. The agent panel names its provider; the
 * workspace panel shows the heaviest wired editor, since that is the agent
 * most likely to fall over.
 */
export function pickLoad(data: WorkspaceData, providerId?: string, added?: readonly AddedServer[]): WorkspaceLoad | null {
  if (!data.profile) return null;
  const injection = data.injection ?? null;
  const paseo = data.paseoTools ?? null;
  const search = data.toolSearch ?? null;
  if (providerId) {
    const scope = scopeForProvider(data.profile, providerId);
    // Only an agent has servers other plugins added; the agent panel passes them.
    if (scope) {
      const load = loadFor(data.profile, scope, injection, paseo, search);
      return added ? withAdded(load, added) : load;
    }
  }
  return loadsForWorkspace(data.profile, injection, paseo, search)[0] ?? null;
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
          { value: `${observed.processes} connector ${observed.processes === 1 ? "process" : "processes"}` },
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

// ------------------------------------------------------------ technical details

/**
 * The panels' "Technical details" (0.19.2): where the connectors an agent here
 * loads come from, how many run on this computer, the tool-search note, the
 * program count advice, and what is running now. The same facts the old
 * summary card and warning showed, as plain lines inside one fold-out: no
 * card, no warning box and no fold-out inside it.
 */
export function LoadDetails({ data, providerId, added }: { data: WorkspaceData; providerId?: string; added?: readonly AddedServer[] }) {
  const t = useTokens();
  const load = pickLoad(data, providerId, added);
  if (!load) return null;
  const cost = costProfile(load);
  const userNames = userLevelNames(load);
  const local = cost.local > 0 ? ` · ${cost.local} only in this folder` : "";
  return (
    <View style={{ gap: t.space.sm }}>
      <Facts
        items={[
          { value: `${plural(cost.total, "connector")}${load.label ? ` for ${load.label}` : ""}` },
          { value: `${cost.project} from this project's .mcp.json${local}` },
          { value: `${cost.user} from your AI apps' own settings` },
          cost.builtIn ? { value: `${PASEO_TOOLS_LABEL}: ${cost.paseoTools} tools` } : null,
          cost.added ? { value: `${cost.added} added when the chat started` } : null,
        ]}
      />
      <Facts
        items={[
          { value: `${cost.stdio} stdio (a program starts on this computer for each chat)` },
          { value: `${cost.http} http (on the web)` },
          cost.unknown ? { value: `${cost.unknown} unreadable` } : null,
        ]}
      />
      {!load.projectIncluded && load.projectNote ? <Text style={t.text.caption}>{load.projectNote}.</Text> : null}
      {load.toolSearch ? <Text style={t.text.caption}>{cost.deferred ? toolSearchOnLine(load.toolSearch) : toolSearchLine(load.toolSearch, cost.tools)}</Text> : null}
      {cost.tier !== "ok" ? (
        <Text style={t.text.caption}>
          {`Past ${BUDGET_ATTENTION} connectors each chat starts more programs and connections than it needs; past ${BUDGET_PROBLEM} it is heavy.${cost.builtIn && cost.paseoTools >= BUDGET_TOOLS_ATTENTION ? ` Paseo's own tools alone are ${cost.paseoTools}; unused groups can be turned off under Connectors → Built-in tools.` : ""}${userNames.length > 0 ? ` ${plural(userNames.length, "connector")} from your AI apps' own settings load in every project (${userNames.join(", ")}); move the ones only this project needs into its .mcp.json.` : ""}`}
        </Text>
      ) : null}
      {data.processes ? <RunningNow processes={data.processes} /> : null}
    </View>
  );
}
