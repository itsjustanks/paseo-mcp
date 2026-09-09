import type { PluginClientContext } from "@getpaseo/plugin/client";
import { McpSurface, McpWorkspacePanel } from "./client/mcp";
import { InjectionSettingsScreen } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  client.addSurface("mcp", McpSurface);
  client.addWorkspacePanel({
    id: "mcp-connections",
    title: "MCP connections",
    icon: "Plug",
    context: "workspace",
    Component: McpWorkspacePanel,
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
    id: "open-mcp",
    title: "Open MCP management",
    icon: "Plug",
    keywords: ["mcp", "servers", "oauth", "add", "sync"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("mcp");
    },
  });
  return () => {};
}
