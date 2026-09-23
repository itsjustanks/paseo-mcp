/**
 * What went wrong, in words a person can act on. The daemon and the RPC layer
 * report failures in their own terms ("Plugin RPC timed out: paseo-mcp.rpc");
 * this turns the ones that reach the panel into a plain sentence. A message
 * that is already specific (the plugin's own, like "This Paseo workspace no
 * longer exists.") is kept as it is. Pure, so the wording is tested.
 */
export function plainError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const message = raw.split("\n")[0]?.trim() ?? "";
  if (!message) return "The host gave no reason. Try again; if it keeps happening, check the plugin log with: paseo plugin logs paseo-mcp";
  if (/Plugin RPC timed out/i.test(message)) {
    return "The MCP plugin on this host did not answer within 30 seconds. It may be busy with a slow check; try again in a moment.";
  }
  if (/Plugin is not available|has no server entry|exited during initialization|did not initialize/i.test(message)) {
    return "The MCP plugin is not running on this host right now (disabled, restarting, or it failed to start). Check with: paseo plugin ls";
  }
  if (/does not contribute RPC/i.test(message)) {
    return "The MCP plugin on this host is an older version that does not know this request. Update it with: paseo plugin update paseo-mcp";
  }
  if (/fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|disconnected|connection (?:is )?closed|not connected/i.test(message)) {
    return "Lost the connection to this host. Check that Paseo can reach it, then try again.";
  }
  if (/^\[\s*\{|invalid_type|Invalid input|Expected .* received/i.test(message)) {
    return "The MCP plugin answered in a shape this app does not understand; the app and the plugin on this host are probably different versions.";
  }
  return message;
}
