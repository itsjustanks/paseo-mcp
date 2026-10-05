import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import { McpAgentPanel } from "./client/agent";
import { SignInCardSchema, makeSignInCard } from "./client/chat";
import { McpSurface, McpWorkspacePanel } from "./client/mcp";
import { registerSurfaceOpener } from "./client/navigate";
import { HealthSettingsScreen, InjectionSettingsScreen } from "./client/settings";
import { MCP_SCREEN_ID, McpSidebarItem, SidebarRow, type OpenScreen, type SidebarItemProps } from "./client/sidebar";
import { McpChip } from "./client/tools";
import { mcpAgentChat, mcpHealthCached, mcpPaseoTools, mcpToolsCached } from "./shared/contracts";
import { chipAgentFrom, createChipRegistry, type ChipAgent } from "./shared/chips";
import { SIGN_IN_KIND, SIGN_IN_VERSION } from "./shared/chat";
import { canObserveAgents, supportsButtonPills, supportsNativeScreens } from "./shared/host-features";

/**
 * What Paseo 0.11 adds to the client context: full screens and native sidebar
 * rows (the 0.8 SDK types don't have them). Present means the app supports
 * them; older apps keep the surface and the sidebar item as before.
 */
type ScreensClient = {
  addScreen?: (contribution: { id: string; title: string; Component: ComponentType<PluginSurfaceProps> }) => () => void;
  addSidebarHeaderItem?: (contribution: { id: string; title: string; Component: ComponentType<SidebarItemProps> }) => () => void;
  openScreen?: OpenScreen;
};

export default function contribute(client: PluginClientContext) {
  const screens = client as PluginClientContext & ScreensClient;
  const native = supportsNativeScreens(client, SidebarRow);
  // Opens the MCP page, whichever way this app shows it. Panels have no opener of their own; they borrow this one.
  const openMain = (capabilities: { openSurface(id: string): void; openScreen?: OpenScreen }) => {
    if (native && typeof capabilities.openScreen === "function") capabilities.openScreen({ screenId: MCP_SCREEN_ID });
    else capabilities.openSurface(MCP_SCREEN_ID);
  };
  if (native) {
    screens.addScreen!({ id: MCP_SCREEN_ID, title: "MCP servers", Component: McpSurface });
    screens.addSidebarHeaderItem!({ id: MCP_SCREEN_ID, title: "MCP", Component: McpSidebarItem });
    registerSurfaceOpener(() => screens.openScreen!({ screenId: MCP_SCREEN_ID }));
  } else {
    registerSurfaceOpener((id) => client.openSurface(id));
    client.addSurface(MCP_SCREEN_ID, McpSurface);
    client.addSidebarItem({ id: MCP_SCREEN_ID, title: "MCP", icon: "Plug", surface: MCP_SCREEN_ID });
  }
  client.addWorkspacePanel({
    id: "mcp-connections",
    title: "MCP connections",
    icon: "Plug",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: McpWorkspacePanel,
  });
  client.addWorkspacePanel({
    id: "mcp-agent",
    title: "MCP",
    icon: "Plug",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: McpAgentPanel,
  });
  client.addCommandCenterItem({
    id: "open-workspace-mcp",
    title: "Open workspace MCP connections",
    icon: "Plug",
    keywords: ["mcp", "project", "oauth", "connections"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("mcp-connections");
    },
  });
  client.addSettingsScreen({
    id: "injection",
    title: "Project servers",
    icon: "Syringe",
    Component: InjectionSettingsScreen,
  });
  client.addSettingsScreen({
    id: "health",
    title: "Health checks",
    icon: "HeartPulse",
    Component: HealthSettingsScreen,
  });
  client.addCommandCenterItem({
    id: "configure-health",
    title: "Configure MCP health checks",
    icon: "HeartPulse",
    keywords: ["mcp", "health", "background", "pill", "settings"],
    context: "global",
    onSelect({ openSettings }) {
      openSettings("health");
    },
  });
  client.addCommandCenterItem({
    id: "configure-injection",
    title: "Add project servers to agents",
    icon: "Syringe",
    keywords: ["mcp", "inject", "injection", "agents", "settings", "project servers", "workspace servers", ".mcp.json"],
    context: "global",
    onSelect({ openSettings }) {
      openSettings("injection");
    },
  });
  client.addCommandCenterItem({
    id: "open-agent-mcp",
    title: "MCP for this agent",
    icon: "Plug",
    keywords: ["mcp", "agent", "inject", "servers"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("mcp-agent");
    },
  });
  client.addCommandCenterItem({
    id: "open-mcp",
    title: "Open MCP management",
    icon: "Plug",
    keywords: ["mcp", "servers", "oauth", "add", "sync"],
    context: "global",
    onSelect(context) {
      openMain(context as typeof context & { openScreen?: OpenScreen });
    },
  });
  // The chip, `/mcp` and the in-chat sign-in card all open the agent's MCP
  // panel the same way.
  const openAgentPanel = (workspaceId: string, agentId: string) => client.openPanel("mcp-agent", { workspaceId, agentId });
  // 0.14.0. Paseo lists its own commands first, then plugins', then the
  // provider's, so this one is what `/mcp` runs in an agent's composer.
  client.addSlashCommand({
    name: "mcp",
    description: "Open this agent's MCP panel: servers, context cost, sign-in",
    argumentHint: "",
    context: "agent",
    onSubmit({ workspace, agent }) {
      openAgentPanel(workspace.id, agent.id);
    },
  });
  client.addTimelineRenderer({
    kind: SIGN_IN_KIND,
    version: SIGN_IN_VERSION,
    schema: SignInCardSchema,
    Component: makeSignInCard(openAgentPanel),
  });
  const removeChips = registerMcpChips(client, openAgentPanel);
  return () => {
    removeChips();
    registerSurfaceOpener(null);
  };
}

// ------------------------------------------------------------------ chip

/**
 * One always-on chip per live agent while the setting is on: "12 MCP · ~38k
 * tokens" on a calm host, "12 MCP · 2 issues" when something breaks. Pressing
 * it opens that agent's MCP panel. The registry (shared/chips.ts) decides
 * which chips exist and what they say; this wires it to the app.
 *
 * 0.18.1: Paseo 0.8.0 stable and later take a chip as a button and the old
 * component shape threw, so the chip never showed on 0.9 or 0.11 apps
 * (itsjustanks/paseo-mcp#1, @hteo1337). And since 0.9, `agents.subscribe()`
 * only hears an observation the plugin opened itself, so new agents got no
 * chip either. Both are chosen at runtime; a 0.8.0-beta.1 app keeps the old
 * component and the old listener.
 */
const CHIP_SETTINGS_POLL_MS = 60_000;
const OBSERVE_RETRY_MIN_MS = 2_000;
const OBSERVE_RETRY_MAX_MS = 60_000;

type ChipButtonsClient = {
  addComposerPill(contribution: {
    id: string;
    workspaceId: string;
    agentId: string;
    button: { title: string; icon: string; label?: string; behavior: { kind: "action"; onPress(): void } };
  }): { update(patch: { label?: string; icon?: string }): void; remove(): void };
};
type AgentLike = { id?: string; workspaceId?: string | null; provider?: string | null; status?: string; archivedAt?: string | null };
type AgentListLike = { entries: Array<{ agent: AgentLike }> };
type AgentUpdateLike = { kind: string; agentId?: string; agent?: AgentLike };
type AgentObservation = {
  subscribe(observer: { snapshot(list: AgentListLike): void; update(message: { type: string; payload?: unknown }): void; error?(error: unknown): void }): () => void;
  release(): Promise<void>;
};

function registerMcpChips(client: PluginClientContext, openAgentPanel: (workspaceId: string, agentId: string) => void): () => void {
  const buttons = supportsButtonPills(client);
  const registry = createChipRegistry({
    addChip(agent, face) {
      const onPress = () => openAgentPanel(agent.workspaceId, agent.id);
      if (buttons) {
        const registration = (client as unknown as ChipButtonsClient).addComposerPill({
          id: "mcp-chip",
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          button: { title: "MCP for this agent", icon: face.icon, label: face.label, behavior: { kind: "action", onPress } },
        });
        return { update: (next) => registration.update({ label: next.label, icon: next.icon }), remove: () => registration.remove() };
      }
      // The 0.8.0-beta.1 shape: the component reads the reports and draws its own label.
      const remove = client.addComposerPill({ id: "mcp-chip", title: "MCP for this agent", workspaceId: agent.workspaceId, agentId: agent.id, Component: McpChip, onPress });
      return { update: () => undefined, remove };
    },
    async readHealth() {
      const cached = await client.rpc(mcpHealthCached, {});
      return { wanted: cached.showComposerPill, report: cached.report };
    },
    labels: buttons
      ? {
          tools: async () => (await client.rpc(mcpToolsCached, {})).report,
          paseo: () => client.rpc(mcpPaseoTools, {}),
          meter: async (agent) => (await client.rpc(mcpAgentChat, { workspaceId: agent.workspaceId, providerId: agent.provider, agentId: agent.id, chat: false })).meter,
        }
      : null,
    schedule: (run, ms) => setTimeout(run, ms),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    pollMs: CHIP_SETTINGS_POLL_MS,
    maxPollMs: 15 * 60_000,
  });

  const onUpdate = (update: AgentUpdateLike) => {
    if (update.kind === "remove" && update.agentId) {
      registry.remove(update.agentId);
      return;
    }
    if (update.kind !== "upsert" || !update.agent?.id) return;
    // A closed or archived agent loses its chip (0.18.3).
    const agent = chipAgentFrom(update.agent);
    if (agent) registry.upsert(agent);
    else registry.remove(update.agent.id);
  };
  const stopFollowing = canObserveAgents(client.paseo) ? observeAgents(client, registry.replaceAll, onUpdate) : client.paseo.agents.subscribe((update) => onUpdate(update as unknown as AgentUpdateLike));
  registry.start();

  return () => {
    stopFollowing();
    registry.stop();
  };
}

/**
 * Paseo 0.9 and later: keep an agent observation open for the plugin's
 * lifetime. The snapshot replaces what is known (first, and after every
 * reconnect), updates apply in between, and an observation the app drops is
 * reopened with backoff. The approach of @gpambrozio/paseo-skills' followAgents.
 */
function observeAgents(client: PluginClientContext, replaceAll: (agents: ChipAgent[]) => void, onUpdate: (update: AgentUpdateLike) => void): () => void {
  const lifetime = new AbortController();
  let observation: AgentObservation | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let delay = OBSERVE_RETRY_MIN_MS;
  const fromList = (list: AgentListLike) => list.entries.map((entry) => chipAgentFrom(entry.agent)).filter((agent): agent is ChipAgent => agent !== null);

  const reopen = () => {
    observation = null;
    if (lifetime.signal.aborted || retry !== null) return;
    retry = setTimeout(() => {
      retry = null;
      open();
    }, delay);
    delay = Math.min(delay * 2, OBSERVE_RETRY_MAX_MS);
  };
  const open = () => {
    (client.paseo.agents as unknown as { list(options: { subscribe: object; signal: AbortSignal }): Promise<AgentListLike & { subscription?: AgentObservation }> })
      .list({ subscribe: {}, signal: lifetime.signal })
      .then((result) => {
        if (lifetime.signal.aborted) {
          void result.subscription?.release().catch(() => undefined);
          return;
        }
        replaceAll(fromList(result));
        const subscription = result.subscription;
        if (!subscription) throw new Error("the app returned no agent observation");
        observation = subscription;
        subscription.subscribe({
          snapshot(list) {
            delay = OBSERVE_RETRY_MIN_MS;
            replaceAll(fromList(list));
          },
          update(message) {
            if (message.type === "agent_update") onUpdate(message.payload as AgentUpdateLike);
          },
          error: reopen,
        });
      })
      .catch(reopen);
  };
  open();
  return () => {
    lifetime.abort();
    if (retry !== null) clearTimeout(retry);
    retry = null;
    void observation?.release().catch(() => undefined);
    observation = null;
  };
}
