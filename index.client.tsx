import type { PluginClientContext } from "@getpaseo/plugin/client";
import { McpAgentPanel } from "./client/agent";
import { McpSurface, McpWorkspacePanel } from "./client/mcp";
import { registerSurfaceOpener } from "./client/navigate";
import { HealthSettingsScreen, InjectionSettingsScreen } from "./client/settings";
import { McpChip } from "./client/tools";
import { mcpHealthCached } from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  // Panels have no openSurface of their own; lend them this one.
  registerSurfaceOpener((id) => client.openSurface(id));
  client.addSurface("mcp", McpSurface);
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
  client.addSidebarItem({ id: "mcp", title: "MCP", icon: "Plug", surface: "mcp" });
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
    title: "Injection",
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
    title: "Configure MCP injection",
    icon: "Syringe",
    keywords: ["mcp", "inject", "agents", "settings", "workspace servers"],
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
    onSelect({ openSurface }) {
      openSurface("mcp");
    },
  });
  const removeChips = registerMcpChips(client);
  return () => {
    removeChips();
    registerSurfaceOpener(null);
  };
}

// ------------------------------------------------------------------ chip

/**
 * One always-on chip per live agent while the setting is on. It replaces the
 * 0.4 break-only pill: the same slot now reads "12 MCP · 340 tools" on a calm
 * host and shifts to "12 MCP · 2 issues" when something breaks, so there is one
 * chip to look at, not two. The chip body (client/tools.tsx) reads the cached
 * health and tool reports; this registry only decides whether a chip exists.
 * Pressing it opens the MCP surface, where the Tools section lives.
 */
const CHIP_SETTINGS_POLL_MS = 60_000;

function registerMcpChips(client: PluginClientContext): () => void {
  const agents = new Map<string, string>(); // agentId -> workspaceId
  const pills = new Map<string, () => void>();
  // Assume on until the host says otherwise: the setting defaults to on, and a
  // chip that appears a minute late reads worse than one that blinks off.
  let wanted = true;
  let stopped = false;

  const reconcile = () => {
    if (stopped) return;
    for (const [agentId, workspaceId] of agents) {
      if (wanted && !pills.has(agentId)) {
        pills.set(
          agentId,
          client.addComposerPill({
            id: "mcp-chip",
            title: "Open MCP management",
            workspaceId,
            agentId,
            Component: McpChip,
            onPress() {
              client.openSurface("mcp");
            },
          }),
        );
      } else if (!wanted && pills.has(agentId)) {
        pills.get(agentId)?.();
        pills.delete(agentId);
      }
    }
    for (const agentId of [...pills.keys()]) {
      if (agents.has(agentId)) continue;
      pills.get(agentId)?.();
      pills.delete(agentId);
    }
  };

  const poll = async () => {
    try {
      const cached = await client.rpc(mcpHealthCached, {});
      wanted = cached.showComposerPill;
    } catch {
      // Host unreachable: keep whatever the last poll decided.
    }
    reconcile();
  };

  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") {
      agents.delete(update.agentId);
      reconcile();
      return;
    }
    if (update.kind !== "upsert" || !update.agent.workspaceId) return;
    agents.set(update.agent.id, update.agent.workspaceId);
    reconcile();
  });
  void poll();
  const timer = setInterval(() => void poll(), CHIP_SETTINGS_POLL_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
    for (const remove of pills.values()) remove();
    pills.clear();
  };
}
