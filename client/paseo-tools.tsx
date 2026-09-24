/** Paseo's built-in MCP tools: the Servers card, the Overview line and the agent panel row. */
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useState } from "react";
import { Text, View } from "react-native";
import {
  mcpPaseoTools,
  mcpSetPaseoTools,
  type PaseoToolsLoad,
  type PaseoToolsStateReport,
} from "../shared/contracts";
import { plainError } from "../shared/errors";
import {
  PASEO_TOOLS_LABEL,
  PASEO_TOOL_GROUPS,
  blockerText,
  catalogueDriftLine,
  paseoToolCount,
  toolChange,
  toolListOrigin,
  type PaseoToolsChange,
} from "../shared/paseo-tools";
import { ADD_PROJECT_SERVERS } from "../shared/settings";
import { backoffMs, failureStreak } from "../shared/schedule";
import { canOpenMcp, openMcp } from "./navigate";
import { Button, Card, Disclosure, ErrorText, Facts, Loading, Notice, Row, Section, Segmented, StatusLine, StatusPill, Tag, Toggle, useTokens, type Status } from "./ui";

export const PASEO_TOOLS_QUERY_KEY = ["paseo-mcp", "paseo-tools"] as const;

const APPLIES_NOTE = "Changes apply to agents started after the change; a running agent keeps the tools it started with.";

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * The host's Paseo-tools state. The host answers from a few-seconds cache, so
 * every chip and panel sharing this key costs one daemon read. Read once a
 * minute, like the chip's settings, so a change made in the app's own
 * settings shows within a minute; after failures (a host too old to know the
 * RPC, say) 1, 2, 4 … up to 30 minutes apart.
 */
export function usePaseoTools() {
  const call = useRpc(mcpPaseoTools);
  return useQuery({
    queryKey: PASEO_TOOLS_QUERY_KEY,
    queryFn: () => call({}),
    staleTime: 5_000,
    refetchInterval: (query) => backoffMs(failureStreak(query), 60_000, 30 * 60_000),
    retry: false,
  });
}

/**
 * Tools a new agent of `providerId` gets, or 0 with no answer. A provider the
 * host did not list gets what a provider with no settings gets, as the daemon
 * would give it, so the chip, the agent panel and the card agree.
 */
export function paseoToolsFor(state: PaseoToolsStateReport | undefined, providerId: string | null | undefined): number {
  return paseoToolCount(state, providerId);
}

/** Refresh asks the host to re-read the daemon config and the daemon's own tool list now. */
function useRefreshPaseoTools() {
  const call = useRpc(mcpPaseoTools);
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: () => call({ refresh: true }),
    onError: (error) => toast.error(plainError(error)),
    onSuccess: (state) => queryClient.setQueryData(PASEO_TOOLS_QUERY_KEY, state),
  });
}

function useSetPaseoTools() {
  const call = useRpc(mcpSetPaseoTools);
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (change: PaseoToolsChange) => call(change),
    onError: (error) => toast.error(plainError(error)),
    onSuccess: (result) => {
      if (result.state) queryClient.setQueryData(PASEO_TOOLS_QUERY_KEY, result.state);
      // The workspace and agent panels count these tools; let them re-read.
      void queryClient.invalidateQueries({ queryKey: ["paseo-mcp", "workspace"] });
      void queryClient.invalidateQueries({ queryKey: ["paseo-mcp", "agent-servers"] });
      if (result.ok) toast.show(result.message, { variant: "success" });
      else toast.error(result.message);
    },
  });
}

// ------------------------------------------------------------- overview

/** One Overview line, the same shape as Health, Editors and Sign-in. */
export function PaseoToolsLine({ onOpen }: { onOpen: () => void }) {
  const query = usePaseoTools();
  const state = query.data;
  if (!state) {
    return (
      <StatusLine
        label="Paseo tools"
        value={query.error ? "unavailable" : "reading"}
        status={query.isFetching ? "busy" : "neutral"}
        hint={query.error ? plainError(query.error) : null}
      />
    );
  }
  const on = state.providers.filter((entry) => entry.tools > 0);
  if (!state.injected || on.length === 0) {
    return (
      <StatusLine
        label="Paseo tools"
        value="off"
        status="neutral"
        hint={state.blocker === "mcp-off" ? "Paseo's MCP server is off on this host" : state.blocker === "inject-off" ? "Not added to agents on this host" : "Off for every provider"}
        action={{ label: "Paseo tools", onPress: onOpen }}
      />
    );
  }
  const most = Math.max(...on.map((entry) => entry.tools));
  const drift = catalogueDriftLine(state);
  return (
    <StatusLine
      label="Paseo tools"
      value={`on · ${plural(most, "tool")}`}
      status={drift ? "attention" : "ok"}
      hint={drift || `for ${on.length <= 3 ? on.map((entry) => entry.id).join(", ") : `${on.length} of ${plural(state.providers.length, "provider")}`}${state.browserTools ? "" : " · browser tools off"}`}
      action={{ label: "Paseo tools", onPress: onOpen }}
    />
  );
}

// ------------------------------------------------------------- agent row

/** The load's one built-in entry, in the agent panel's list of what the agent loads. */
export function PaseoToolsAgentRow({ info, providerLabel, first }: { info: { tools: number; blocker: PaseoToolsLoad["blocker"]; asOf: string; source?: PaseoToolsLoad["source"] }; providerLabel: string; first?: boolean }) {
  const t = useTokens();
  const on = info.tools > 0;
  const reason = on
    ? `Paseo's own MCP server, added by the daemon to every ${providerLabel} agent. Switch it or its tools under Servers → Paseo tools; that changes every workspace.`
    : info.blocker
      ? blockerText(info.blocker)
      : `Off for ${providerLabel} agents on this host.`;
  return (
    <Row
      first={first}
      tone={on ? undefined : "neutral"}
      title={
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: t.space.sm, minWidth: 0 }}>
          <Text numberOfLines={1} style={[t.text.bodyStrong, { flexShrink: 1, opacity: on ? 1 : 0.6 }]}>{PASEO_TOOLS_LABEL}</Text>
          <Tag label="http" />
          <Tag label="built in" tone="ok" />
          {on ? <Tag label={plural(info.tools, "tool")} tone="ok" /> : null}
        </View>
      }
      subtitle={`mcp__paseo__* · ${info.source === "live" ? "tool list live from this host" : `tool list as of Paseo ${info.asOf}`}`}
      meta={<Text style={t.text.caption}>{reason}</Text>}
      trailing={
        <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
          <Tag label={on ? "on" : "off"} tone={on ? "ok" : undefined} />
          {canOpenMcp() ? <Button label="Manage" variant="ghost" onPress={() => openMcp()} /> : null}
        </View>
      }
    />
  );
}

// ------------------------------------------------------------- servers card

type Scope = "all" | string;

/**
 * The Servers section's card for Paseo's own server: whether the daemon adds
 * it to agents at all (the app's "Enable Paseo tools"), per provider, and per
 * tool. Everything is written through the daemon's config API and read back.
 */
export function PaseoToolsCard({ hostLabel }: { hostLabel: string }) {
  const t = useTokens();
  const query = usePaseoTools();
  const mutation = useSetPaseoTools();
  const refresh = useRefreshPaseoTools();
  const [armed, setArmed] = useState<boolean | null>(null);
  const [scope, setScope] = useState<Scope>("all");
  const [pending, setPending] = useState<string | null>(null);
  const state = query.data;

  const send = (key: string, change: PaseoToolsChange) => {
    setPending(key);
    mutation.mutate(change, { onSettled: () => setPending(null) });
  };

  if (!state) {
    return (
      <Card>
        <Header state={null} />
        {query.isLoading ? <Loading label="Reading Paseo's settings…" /> : null}
        {query.error ? <ErrorText>{plainError(query.error)}</ErrorText> : null}
      </Card>
    );
  }

  const busy = mutation.isPending;
  const providerIds = state.providers.map((entry) => entry.id);
  // Built-ins with no settings of their own (copilot, pi …) sit in one quiet
  // row; they are still written by "All providers" and counted in the header.
  const main = state.providers.filter((entry) => entry.configured || entry.id === "claude" || entry.id === "codex");
  const quiet = state.providers.filter((entry) => !main.includes(entry));
  const scoped = scope === "all" ? state.providers : state.providers.filter((entry) => entry.id === scope);
  const disabledFor = (name: string) => scoped.filter((entry) => entry.disabledTools.includes(name)).map((entry) => entry.id);
  const setTool = (name: string, on: boolean) => send(`tool:${name}`, toolChange(scoped.map((entry) => entry.id), name, on));
  const providerRow = (entry: PaseoToolsStateReport["providers"][number], index: number) => (
    <Row
      key={entry.id}
      first={index === 0}
      title={entry.id}
      meta={
        <Facts
          items={[
            { value: entry.tools > 0 ? `${plural(entry.tools, "tool")} for new agents` : "none for new agents", tone: entry.tools > 0 ? "ok" : undefined },
            entry.disabledTools.length > 0 ? { value: `${entry.disabledTools.length} turned off` } : null,
            entry.configured ? null : { value: "built in, no settings yet" },
          ]}
        />
      }
      trailing={
        <Toggle
          label={`Paseo tools ${entry.enabled ? "on" : "off"} for ${entry.id}`}
          value={entry.enabled}
          disabled={busy}
          loading={pending === `provider:${entry.id}`}
          onChange={(next) => send(`provider:${entry.id}`, { providers: [{ id: entry.id, enabled: next }] })}
        />
      }
    />
  );

  return (
    <Card>
      <Header state={state} onRefresh={() => refresh.mutate()} refreshing={refresh.isPending || query.isFetching} />
      <Text style={[t.text.body, { color: t.color.muted, maxWidth: 680 }]}>
        {`Paseo's own MCP server. The daemon adds it to agents it starts, with ${plural(state.tools.length, "tool")} for agents, terminals, schedules, workspaces and the browser. ${toolListOrigin(state)}`}
      </Text>
      {catalogueDriftLine(state) ? <Notice tone="attention">{catalogueDriftLine(state)}</Notice> : null}
      <Text style={t.text.caption}>
        {`Servers from a project's .mcp.json are a different setting: Settings → Plugins → Paseo MCP → ${ADD_PROJECT_SERVERS}.`}
      </Text>

      <Row
        first
        title={`Add to every agent on ${hostLabel}`}
        subtitle={"Same setting as Settings → Orchestration → Enable Paseo tools in the app."}
        trailing={
          <Toggle
            label={`Paseo tools ${state.injectIntoAgents ? "on" : "off"} for this host`}
            value={state.injectIntoAgents}
            disabled={busy || armed !== null}
            loading={pending === "inject"}
            onChange={(next) => setArmed(next)}
          />
        }
      />
      {armed !== null ? (
        <Notice tone="attention">
          <View style={{ gap: t.space.sm }}>
            <Text style={t.text.bodyStrong}>
              {armed ? `Add Paseo tools to every new agent on ${hostLabel}?` : `Stop adding Paseo tools to agents on ${hostLabel}?`}
            </Text>
            <Text style={t.text.body}>
              {armed
                ? `Every agent started on this host, in every workspace and for every provider switched on below, gets Paseo's server and up to ${plural(state.tools.length, "tool")} in its context.`
                : "Every agent started on this host, in every workspace, starts without Paseo's server: no create_agent, terminals, schedules, heartbeats or browser tools. Orchestration from inside an agent stops working for new agents."}
              {` ${APPLIES_NOTE}`}
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
              <Button
                label={armed ? "Add to every agent" : "Turn off for every agent"}
                variant={armed ? "primary" : "danger"}
                onPress={() => {
                  const next = armed;
                  setArmed(null);
                  send("inject", { injectIntoAgents: next });
                }}
              />
              <Button label="Cancel" variant="ghost" onPress={() => setArmed(null)} />
            </View>
          </View>
        </Notice>
      ) : null}
      {state.blocker === "mcp-off" ? <Notice tone="attention">{blockerText("mcp-off")}</Notice> : null}

      <Section title="Per provider">
        <Card level={2} padded={false}>{main.map(providerRow)}</Card>
        {quiet.length > 0 ? (
          <Disclosure title={`${quiet.length} more built-in ${quiet.length === 1 ? "provider" : "providers"} with no settings · ${quiet.map((entry) => entry.id).join(", ")}`}>
            <Card level={2} padded={false}>{quiet.map(providerRow)}</Card>
          </Disclosure>
        ) : null}
      </Section>

      <Section title="Tools">
        <View style={{ gap: t.space.sm }}>
          {providerIds.length > 1 ? (
            <Segmented
              value={scope}
              onChange={setScope}
              options={[{ value: "all", label: "All providers" }, ...main.map((entry) => ({ value: entry.id, label: entry.id }))]}
            />
          ) : null}
          <Text style={t.text.caption}>
            {scope === "all"
              ? `A switch here changes the tool for all ${providerIds.length} providers at once (${providerIds.join(", ")}).`
              : `A switch here changes the tool for ${scope} only.`}
          </Text>
          {PASEO_TOOL_GROUPS.map((group) => {
            const tools = state.tools.filter((entry) => entry.group === group.id);
            const browser = group.id === "browser";
            const onCount = tools.filter((entry) => (browser ? state.browserTools : true) && disabledFor(entry.name).length === 0).length;
            const title = browser && !state.browserTools ? `${group.label} · off for this host` : `${group.label} · ${onCount} of ${tools.length} on`;
            return (
              <Disclosure key={group.id} title={title}>
                {browser ? (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: t.space.sm }}>
                    <Button
                      label={state.browserTools ? "Turn off browser tools" : "Turn on browser tools"}
                      variant="secondary"
                      loading={pending === "browser"}
                      disabled={busy}
                      onPress={() => send("browser", { browserTools: !state.browserTools })}
                    />
                    <Text style={[t.text.caption, { flexShrink: 1 }]}>
                      {state.browserTools
                        ? `All ${tools.length} for every provider, in one setting (browserTools.enabled).`
                        : "Off for every provider on this host (browserTools.enabled). The switches below apply once it is on."}
                    </Text>
                  </View>
                ) : null}
                <Card level={2} padded={false}>
                  {tools.map((entry, index) => {
                    const off = disabledFor(entry.name);
                    const on = off.length === 0;
                    const mixed = !on && off.length < scoped.length;
                    return (
                      <Row
                        key={entry.name}
                        first={index === 0}
                        tone={on && (!browser || state.browserTools) ? undefined : "neutral"}
                        title={
                          <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm, minWidth: 0 }}>
                            <Text numberOfLines={1} style={[t.text.mono, { color: t.color.fg, flexShrink: 1 }]}>{entry.name}</Text>
                            {mixed ? <Tag label={`off for ${off.join(", ")}`} tone="attention" /> : null}
                          </View>
                        }
                        subtitle={entry.description}
                        trailing={
                          <Toggle
                            label={`${entry.name} ${on ? "on" : "off"}${scope === "all" ? "" : ` for ${scope}`}`}
                            value={on}
                            disabled={busy || (browser && !state.browserTools)}
                            loading={pending === `tool:${entry.name}`}
                            onChange={(next) => setTool(entry.name, next)}
                          />
                        }
                      />
                    );
                  })}
                </Card>
              </Disclosure>
            );
          })}
        </View>
      </Section>
      <Text style={t.text.caption}>{`${APPLIES_NOTE} Written through Paseo's config API and read back; config.json is never edited by hand.`}</Text>
    </Card>
  );
}

function Header({ state, onRefresh, refreshing }: { state: PaseoToolsStateReport | null; onRefresh?: () => void; refreshing?: boolean }) {
  const t = useTokens();
  const pill: { status: Status; label: string } | null = !state
    ? null
    : state.injected
      ? { status: "ok", label: `on for ${state.providers.filter((entry) => entry.tools > 0).length} of ${plural(state.providers.length, "provider")}` }
      : { status: "neutral", label: state.blocker === "mcp-off" ? "MCP server off" : "not added to agents" };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: t.space.sm }}>
      <Text style={t.text.heading}>Paseo tools</Text>
      <Tag label="built in" />
      {pill ? <StatusPill status={pill.status} label={pill.label} /> : null}
      <View style={{ flex: 1 }} />
      {onRefresh ? <Button label="Refresh" variant="ghost" loading={refreshing} onPress={onRefresh} /> : null}
    </View>
  );
}
