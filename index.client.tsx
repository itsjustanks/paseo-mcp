import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { McpAgentPanel } from "./client/agent";
import { McpSurface, McpWorkspacePanel } from "./client/mcp";
import { registerSurfaceOpener } from "./client/navigate";
import { HealthSettingsScreen, InjectionSettingsScreen } from "./client/settings";
import { McpChipIconAttention, McpChipIconCalm } from "./client/tools";
import { chipLabel, mcpHealthCached, mcpToolsCached } from "./shared/contracts";

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
 * chip to look at, not two. This registry polls the same cached reports the
 * chip used to read via hooks (client/tools.tsx has the icons) and pushes
 * updates into each pill; it also decides whether a pill exists at all.
 * Pressing it opens that agent's MCP panel (0.7.0; it used to open the surface).
 */
const CHIP_POLL_MS = 3_000;

function registerMcpChips(client: PluginClientContext): () => void {
  const agents = new Map<string, string>(); // agentId -> workspaceId
  const pills = new Map<string, PluginButtonRegistration>();
  // Assume on until the host says otherwise: the setting defaults to on, and a
  // chip that appears a minute late reads worse than one that blinks off.
  let wanted = true;
  let stopped = false;
  let label = "MCP";
  let icon = McpChipIconCalm;

  const reconcile = () => {
    if (stopped) return;
    for (const [agentId, workspaceId] of agents) {
      if (wanted && !pills.has(agentId)) {
        pills.set(
          agentId,
          client.addComposerPill({
            id: "mcp-chip",
            workspaceId,
            agentId,
            button: {
              title: "MCP for this agent",
              icon,
              label,
              behavior: {
                kind: "action",
                onPress() {
                  // The panel, not the surface: it's this agent's own MCP view.
                  client.openPanel("mcp-agent", { workspaceId, agentId });
                },
              },
            },
          }),
        );
      } else if (!wanted && pills.has(agentId)) {
        pills.get(agentId)?.remove();
        pills.delete(agentId);
      }
    }
    for (const agentId of [...pills.keys()]) {
      if (agents.has(agentId)) continue;
      pills.get(agentId)?.remove();
      pills.delete(agentId);
    }
  };

  const poll = async () => {
    try {
      const [health, tools] = await Promise.all([client.rpc(mcpHealthCached, {}), client.rpc(mcpToolsCached, {})]);
      wanted = health.showComposerPill;
      const chip = chipLabel(health.report, tools.report);
      label = chip.label;
      icon = chip.tone === "attention" ? McpChipIconAttention : McpChipIconCalm;
      for (const registration of pills.values()) registration.update({ label, icon });
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
  const timer = setInterval(() => void poll(), CHIP_POLL_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
    for (const registration of pills.values()) registration.remove();
    pills.clear();
  };
}
