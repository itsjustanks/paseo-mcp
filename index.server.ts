import type { PluginServerContext } from "@getpaseo/plugin/server";
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
} from "./server/handlers";
import { runShutdown, runStart } from "./server/lifecycle";
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
} from "./server/mcpjson";
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
} from "./shared/contracts";
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
} from "./shared/mcpjson";
import { injectionSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(injectionSettings);
  server.handle(mcpMatrix, handleMcpMatrix);
  server.handle(mcpAdd, handleMcpAdd);
  server.handle(mcpApply, handleMcpApply);
  server.handle(mcpAuth, handleMcpAuth);
  server.handle(mcpDefAll, handleMcpDefAll);
  server.handle(mcpEditOne, handleMcpEditOne);
  server.handle(mcpRename, handleMcpRename);
  server.handle(mcpHealth, handleMcpHealth);
  server.handle(mcpRemove, handleMcpRemove);
  server.handle(mcpSync, handleMcpSync);
  server.handle(mcpWorkspace, handleMcpWorkspace);
  server.handle(mcpRawGet, handleMcpRawGet);
  server.handle(mcpRawPut, handleMcpRawPut);
  server.handle(mcpImportParse, handleMcpImportParse);
  server.handle(mcpImportApply, handleMcpImportApply);
  server.handle(mcpExport, handleMcpExport);
  server.handle(mcpExportFile, handleMcpExportFile);
  server.handle(mcpLogin, handleMcpLogin);
  server.handle(mcpLoginComplete, handleMcpLoginComplete);
  server.handle(mcpLoginStatus, handleMcpLoginStatus);
  server.handle(mcpLoginCancel, handleMcpLoginCancel);
  server.handle(mcpLogout, handleMcpLogout);

  runStart();
  return runShutdown;
}
