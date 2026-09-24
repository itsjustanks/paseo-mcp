import type { PluginRpcContract } from "@getpaseo/plugin";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import {
  handleMcpAdd,
  handleMcpApply,
  handleMcpAuth,
  handleMcpDefAll,
  handleMcpEditOne,
  handleMcpMatrix,
  handleMcpRemove,
  handleMcpRename,
  handleMcpSync,
} from "./server/handlers";
import { handleMcpCatalog, handleMcpCatalogEntry, handleMcpCatalogInstall, handleMcpCatalogPlan, handleMcpCatalogTeamAuth, hostCatalogSettings } from "./server/catalog";
import { handleMcpAgentServers, handleMcpSetEnabled } from "./server/enabled";
import { handleMcpHealth, handleMcpHealthCached } from "./server/health";
import { registerHooks } from "./server/hooks";
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
import { handleMcpPaseoTools, handleMcpSetPaseoTools } from "./server/paseo-tools";
import { markClientSeen } from "./server/presence";
import { handleMcpSiblings } from "./server/siblings";
import { handleMcpTools, handleMcpToolsCached } from "./server/tools";
import { handleMcpWorkspace } from "./server/workspace";
import {
  mcpAdd,
  mcpAgentServers,
  mcpApply,
  mcpAuth,
  mcpDefAll,
  mcpEditOne,
  mcpHealth,
  mcpHealthCached,
  mcpMatrix,
  mcpPaseoTools,
  mcpRemove,
  mcpRename,
  mcpSetEnabled,
  mcpSetPaseoTools,
  mcpSiblings,
  mcpSync,
  mcpTools,
  mcpToolsCached,
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
import { mcpCatalog, mcpCatalogEntry, mcpCatalogInstall, mcpCatalogPlan, mcpCatalogTeamAuth } from "./shared/catalog";
import { healthSettings, injectionSettings, promoSettings } from "./shared/settings";

/** Slow enough to be worth a line in the daemon log. */
const SLOW_RPC_MS = 5_000;

export default function contribute(server: PluginServerContext) {
  // Every RPC comes from a connected app: note it (background passes rest
  // while nobody is looking, server/presence.ts), and log the slow ones so a
  // stall shows up in `paseo plugin logs` with its name.
  const handle = <I extends ZodType, O extends ZodType>(
    contract: PluginRpcContract<I, O>,
    handler: (input: ZodOutput<I>, context: PluginHandlerContext) => ZodInput<O> | Promise<ZodInput<O>>,
  ) =>
    server.handle(contract, async (input, context) => {
      markClientSeen();
      const began = Date.now();
      try {
        return await handler(input, context);
      } finally {
        const ms = Date.now() - began;
        if (ms >= SLOW_RPC_MS) console.warn(`[paseo-mcp] ${contract.name} took ${(ms / 1000).toFixed(1)} s`);
      }
    });

  server.registerSettings(injectionSettings);
  server.registerSettings(healthSettings);
  server.registerSettings(promoSettings);
  server.registerSettings(hostCatalogSettings);
  registerHooks(server);
  handle(mcpMatrix, handleMcpMatrix);
  handle(mcpAdd, handleMcpAdd);
  handle(mcpApply, handleMcpApply);
  handle(mcpAuth, handleMcpAuth);
  handle(mcpDefAll, handleMcpDefAll);
  handle(mcpEditOne, handleMcpEditOne);
  handle(mcpRename, handleMcpRename);
  handle(mcpHealth, handleMcpHealth);
  handle(mcpHealthCached, handleMcpHealthCached);
  handle(mcpRemove, handleMcpRemove);
  handle(mcpSync, handleMcpSync);
  handle(mcpTools, handleMcpTools);
  handle(mcpToolsCached, handleMcpToolsCached);
  handle(mcpWorkspace, handleMcpWorkspace);
  handle(mcpAgentServers, handleMcpAgentServers);
  handle(mcpSetEnabled, handleMcpSetEnabled);
  handle(mcpRawGet, handleMcpRawGet);
  handle(mcpRawPut, handleMcpRawPut);
  handle(mcpImportParse, handleMcpImportParse);
  handle(mcpImportApply, handleMcpImportApply);
  handle(mcpExport, handleMcpExport);
  handle(mcpExportFile, handleMcpExportFile);
  handle(mcpLogin, handleMcpLogin);
  handle(mcpLoginComplete, handleMcpLoginComplete);
  handle(mcpLoginStatus, handleMcpLoginStatus);
  handle(mcpLoginCancel, handleMcpLoginCancel);
  handle(mcpLogout, handleMcpLogout);
  handle(mcpSiblings, handleMcpSiblings);
  handle(mcpPaseoTools, handleMcpPaseoTools);
  handle(mcpSetPaseoTools, handleMcpSetPaseoTools);
  handle(mcpCatalog, handleMcpCatalog);
  handle(mcpCatalogPlan, handleMcpCatalogPlan);
  handle(mcpCatalogInstall, handleMcpCatalogInstall);
  handle(mcpCatalogEntry, handleMcpCatalogEntry);
  handle(mcpCatalogTeamAuth, handleMcpCatalogTeamAuth);

  runStart();
  return runShutdown;
}
