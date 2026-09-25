import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { McpAgentPanel } from "../../client/agent";
import { makeSignInCard } from "../../client/chat";
import { setSignInFocus } from "../../client/focus";
import { McpChip } from "../../client/tools";
import { Text, View } from "react-native";
import { McpSurface, McpWorkspacePanel } from "../../client/mcp";
import { registerSurfaceOpener } from "../../client/navigate";
import { HealthSettingsScreen, InjectionSettingsScreen } from "../../client/settings";
// Panels open the surface through the entry's opener; here it just records the request.
registerSurfaceOpener((id) => { (window as any).__opened = [...((window as any).__opened ?? []), id]; console.info("[open-surface]", id); });
const queryClient = new QueryClient();
// ?focus=<server>: the agent panel as the in-chat card's Connect opens it.
if (new URLSearchParams(location.search).get("focus")) setSignInFocus("agent-1", new URLSearchParams(location.search).get("focus"));
// The card's Connect records the panel it would open.
const SignInCard = makeSignInCard((workspaceId, agentId) => { (window as any).__openedPanel = { workspaceId, agentId }; console.info("[open-panel]", workspaceId, agentId); });
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
    {params.has("chip") ? <View style={{ padding: 24, gap: 12, backgroundColor: colors.surface0, minHeight: "100vh" as any }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Composer chip, this agent ({params.get("provider") ?? "codex"})</Text>
        <View style={{ flexDirection: "row" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, height: 28, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 }}>
            <McpChip {...props} workspaceId="ws-1" agentId="agent-1" />
          </View>
        </View>
      </View>
      : params.has("card") ? <View style={{ padding: 24, gap: 12, backgroundColor: colors.surface0, minHeight: "100vh" as any }}>
        <Text style={{ color: colors.foreground, fontSize: 13 }}>Assistant: I'll look up the open issues in Linear.</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12, fontFamily: "Menlo" }}>✕ mcp__linear__list_issues · failed</Text>
        <SignInCard {...props} agentId="agent-1" timestamp={new Date()} item={{ type: "plugin", kind: "mcp-sign-in", version: 1, data: { server: params.get("server") ?? "linear", provider: "claude" } }} />
      </View>
      : params.has("agent") ? <McpAgentPanel {...props} context="agent" workspaceId="ws-1" agentId="agent-1" />
      : params.has("health-settings") ? <HealthSettingsScreen {...props} />
      : params.has("settings") ? <InjectionSettingsScreen {...props} />
      : params.has("workspace") ? <McpWorkspacePanel {...props} context="workspace" workspaceId="ws-1" /> : <McpSurface {...props} />}
  </QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
