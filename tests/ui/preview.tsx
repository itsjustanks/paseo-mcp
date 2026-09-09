import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { McpAgentPanel } from "../../client/agent";
import { McpSurface, McpWorkspacePanel } from "../../client/mcp";
import { InjectionSettingsScreen } from "../../client/settings";
const queryClient = new QueryClient();
const params = new URLSearchParams(location.search);
const light = !params.has("dark");
const colors = light ? {
  surface0: "#ffffff", surface1: "#f8f9fa", surface2: "#eef0f2", border: "#dfe3e8", foreground: "#1f2328",
  foregroundMuted: "#636c76", accent: "#1f6f43", accentForeground: "#ffffff", statusSuccess: "#1a7f37", statusWarning: "#9a6700", statusDanger: "#cf222e",
} : {
  surface0: "#11151b", surface1: "#1a2029", surface2: "#252d38", border: "#394352", foreground: "#eef1f6",
  foregroundMuted: "#a2adbc", accent: "#a5b4fc", accentForeground: "#14192c", statusSuccess: "#6ee7a0", statusWarning: "#facc6b", statusDanger: "#fda4af",
};
function Preview() {
  const [compact, setCompact] = useState(innerWidth < 640);
  useEffect(() => { const resize = () => setCompact(innerWidth < 640); addEventListener("resize", resize); return () => removeEventListener("resize", resize); }, []);
  const props = { theme: { colors }, host: { id: "preview", label: "paseo" }, layout: { compact, platform: "web" as const } };
  return <QueryClientProvider client={queryClient}>
    {params.has("agent") ? <McpAgentPanel {...props} context="agent" workspaceId="ws-1" agentId="agent-1" />
      : params.has("settings") ? <InjectionSettingsScreen {...props} />
      : params.has("workspace") ? <McpWorkspacePanel {...props} context="workspace" workspaceId="ws-1" /> : <McpSurface {...props} />}
  </QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
