import type { PluginClientContext } from "@getpaseo/plugin/client";
import { McpAgentPanel } from "./client/agent";
import { SignInCardSchema, makeSignInCard } from "./client/chat";
import { McpSurface, McpWorkspacePanel } from "./client/mcp";
import { registerSurfaceOpener } from "./client/navigate";
import { HealthSettingsScreen, InjectionSettingsScreen } from "./client/settings";
import { McpChip } from "./client/tools";
import { mcpHealthCached } from "./shared/contracts";
import { SIGN_IN_KIND, SIGN_IN_VERSION } from "./shared/chat";
import { backoffMs } from "./shared/schedule";

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
    onSelect({ openSurface }) {
      openSurface("mcp");
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
 * One always-on chip per live agent while the setting is on. It replaces the
 * 0.4 break-only pill: the same slot now reads "12 MCP · ~38k tokens" on a calm
 * host and shifts to "12 MCP · 2 issues" when something breaks, so there is one
 * chip to look at, not two. The chip body (client/tools.tsx) reads the cached
 * health and tool reports; this registry only decides whether a chip exists.
 * Pressing it opens that agent's MCP panel (0.7.0; it used to open the surface).
 */
const CHIP_SETTINGS_POLL_MS = 60_000;

function registerMcpChips(client: PluginClientContext, openAgentPanel: (workspaceId: string, agentId: string) => void): () => void {
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
            title: "MCP for this agent",
            workspaceId,
            agentId,
            Component: McpChip,
            onPress() {
              // The panel, not the surface: the chip belongs to one agent, and
              // the agent's MCP panel shows what that agent loads with its
              // per-workspace switches and sign-in. "Manage all servers" inside
              // it is the door to the full surface.
              openAgentPanel(workspaceId, agentId);
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

  // The setting is read once a minute while there is an agent to put a chip
  // on, and less often while the host does not answer (1, 2, 4 … 15 minutes).
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void poll(), backoffMs(failures, CHIP_SETTINGS_POLL_MS, 15 * 60_000));
  };
  const poll = async () => {
    timer = null;
    if (agents.size > 0) {
      try {
        const cached = await client.rpc(mcpHealthCached, {});
        wanted = cached.showComposerPill;
        failures = 0;
      } catch {
        // Host unreachable: keep whatever the last poll decided.
        failures += 1;
      }
      reconcile();
    }
    schedule();
  };

  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") {
      agents.delete(update.agentId);
      reconcile();
      return;
    }
    if (update.kind !== "upsert" || !update.agent.workspaceId) return;
    const first = agents.size === 0;
    agents.set(update.agent.id, update.agent.workspaceId);
    reconcile();
    // The first agent to appear gets the setting read now, not at the next beat.
    if (first && timer !== null) {
      clearTimeout(timer);
      void poll();
    }
  });
  void poll();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
    for (const remove of pills.values()) remove();
    pills.clear();
  };
}
