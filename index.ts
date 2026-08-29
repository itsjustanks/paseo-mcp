import type { PluginContext } from "@getpaseo/plugin";
import {
  mcpAdd,
  mcpApply,
  mcpAuth,
  mcpDefAll,
  mcpEditOne,
  mcpHealth,
  mcpMatrix,
  mcpRemove,
  mcpRename,
  mcpSync,
  mcpWorkspace,
} from "./contracts.shared";
import {
  handleMcpAdd,
  handleMcpApply,
  handleMcpAuth,
  handleMcpDefAll,
  handleMcpEditOne,
  handleMcpHealth,
  handleMcpMatrix,
  handleMcpRemove,
  handleMcpRename,
  handleMcpSync,
  handleMcpWorkspace,
} from "./handlers.server";
import { runShutdown, runStart } from "./lifecycle.shared";
import { McpSurface, McpWorkspacePanel } from "./mcp.client";
import {
  mcpExport,
  mcpExportFile,
  mcpImportApply,
  mcpImportParse,
  mcpLogin,
  mcpLoginCancel,
  mcpLoginComplete,
  mcpLoginStatus,
  mcpLogout,
  mcpRawGet,
  mcpRawPut,
} from "./mcpjson.shared";
import {
  handleMcpExport,
  handleMcpExportFile,
  handleMcpImportApply,
  handleMcpImportParse,
  handleMcpLogin,
  handleMcpLoginCancel,
  handleMcpLoginComplete,
  handleMcpLoginStatus,
  handleMcpLogout,
  handleMcpRawGet,
  handleMcpRawPut,
} from "./mcpjson.server";

export default function contribute(plugin: PluginContext) {
  plugin.handle(mcpMatrix, handleMcpMatrix);
  plugin.handle(mcpAdd, handleMcpAdd);
  plugin.handle(mcpApply, handleMcpApply);
  plugin.handle(mcpAuth, handleMcpAuth);
  plugin.handle(mcpDefAll, handleMcpDefAll);
  plugin.handle(mcpEditOne, handleMcpEditOne);
  plugin.handle(mcpRename, handleMcpRename);
  plugin.handle(mcpHealth, handleMcpHealth);
  plugin.handle(mcpRemove, handleMcpRemove);
  plugin.handle(mcpSync, handleMcpSync);
  plugin.handle(mcpWorkspace, handleMcpWorkspace);
  plugin.handle(mcpRawGet, handleMcpRawGet);
  plugin.handle(mcpRawPut, handleMcpRawPut);
  plugin.handle(mcpImportParse, handleMcpImportParse);
  plugin.handle(mcpImportApply, handleMcpImportApply);
  plugin.handle(mcpExport, handleMcpExport);
  plugin.handle(mcpExportFile, handleMcpExportFile);
  plugin.handle(mcpLogin, handleMcpLogin);
  plugin.handle(mcpLoginComplete, handleMcpLoginComplete);
  plugin.handle(mcpLoginStatus, handleMcpLoginStatus);
  plugin.handle(mcpLoginCancel, handleMcpLoginCancel);
  plugin.handle(mcpLogout, handleMcpLogout);

  plugin.addSurface("mcp", McpSurface);
  plugin.addWorkspacePanel({
    id: "mcp-connections",
    title: "MCP connections",
    icon: "Plug",
    context: "workspace",
    Component: McpWorkspacePanel,
  });
  plugin.addSidebarItem({ id: "mcp", title: "MCP", icon: "Plug", surface: "mcp" });
  plugin.addCommandCenterItem({
    id: "open-workspace-mcp",
    title: "Open workspace MCP connections",
    icon: "Plug",
    keywords: ["mcp", "project", "oauth", "connections"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("mcp-connections");
    },
  });
  plugin.addCommandCenterItem({
    id: "open-mcp",
    title: "Open MCP management",
    icon: "Plug",
    keywords: ["mcp", "servers", "oauth", "add", "sync"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("mcp");
    },
  });

  runStart();
  return runShutdown;
}
