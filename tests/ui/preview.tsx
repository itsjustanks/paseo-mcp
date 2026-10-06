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
import { McpSidebarItem, type ScreenLocation } from "../../client/sidebar";
import { publishAttention } from "../../client/attention-store";
import { createChipRegistry, type ChipFace } from "../../shared/chips";
import { mcpHealthCached } from "../../shared/contracts";
import { callPreviewRpc } from "./plugin";
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
/** ?sidebar: the app's sidebar row beside the MCP screen; the row and its "+" open the screen the way Paseo 0.11 does. */
function SidebarPreview(props: any) {
  const [screen, setScreen] = useState<ScreenLocation | null>(null);
  (window as any).__screen = screen;
  return <View style={{ flexDirection: "row", minHeight: "100vh" as any, backgroundColor: props.theme.colors.surface0 }}>
    <View style={{ width: 240, padding: 8, borderRightWidth: 1, borderRightColor: props.theme.colors.border, backgroundColor: props.theme.colors.surface1 }}>
      <McpSidebarItem currentScreen={screen} openScreen={({ screenId, params }) => setScreen({ screenId, params: params ?? {} })} theme={props.theme} />
    </View>
    <View style={{ flex: 1 }}>{screen ? <McpSurface {...props} params={screen.params} /> : null}</View>
  </View>;
}
/**
 * 0.19.1: the real chip registry against the fake host, for one agent in the
 * data-glue project (?provider=claude|codex). It decides the chip and feeds
 * the sidebar row's dot, as in the app.
 */
let previewFace: ChipFace | null = null;
const faceListeners = new Set<() => void>();
const registry = createChipRegistry({
  addChip(_agent, face) {
    const set = (next: ChipFace | null) => { previewFace = next; for (const listener of faceListeners) listener(); };
    set(face);
    return { update: set, remove: () => set(null) };
  },
  readHealth: async () => {
    const cached: any = await callPreviewRpc(mcpHealthCached, {});
    return { wanted: cached.showComposerPill, report: cached.report, signIn: cached.signIn };
  },
  publish: publishAttention,
  schedule: (run, ms) => setTimeout(run, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  pollMs: 60_000,
  maxPollMs: 15 * 60_000,
});
registry.upsert({ id: "agent-1", workspaceId: "ws-1", provider: params.get("provider") ?? "codex", cwd: "/home/demo/projects/data-glue" });
function usePreviewFace(): ChipFace | null {
  const [face, setFace] = useState(previewFace);
  useEffect(() => { const listener = () => setFace(previewFace); faceListeners.add(listener); return () => { faceListeners.delete(listener); }; }, []);
  return face;
}
/** The chip as the app draws a button chip: icon and label, or nothing at all on a calm chat. */
function ChipPreview() {
  const face = usePreviewFace();
  const warn = face?.icon === "TriangleAlert";
  const color = warn ? colors.statusWarning : colors.foregroundMuted;
  return face ? <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, height: 28, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 }}>
      <Text style={{ color, fontWeight: "700", fontSize: 12 }}>{warn ? "⚠" : "⚿"}</Text>
      <Text style={{ color, fontSize: 13 }}>{face.label}</Text>
    </View>
    : <Text style={{ color: colors.foregroundMuted, fontSize: 13, fontStyle: "italic" }}>(no chip: this chat is calm)</Text>;
}
function Preview() {
  const [compact, setCompact] = useState(innerWidth < 640);
  useEffect(() => { const resize = () => setCompact(innerWidth < 640); addEventListener("resize", resize); return () => removeEventListener("resize", resize); }, []);
  const props = { theme: { colors }, host: { id: "preview", label: "paseo" }, layout: { compact, platform: "web" as const } };
  return <QueryClientProvider client={queryClient}>
    {params.has("chip") ? <View style={{ padding: 24, gap: 12, backgroundColor: colors.surface0, minHeight: "100vh" as any }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Composer chip, this agent ({params.get("provider") ?? "codex"})</Text>
        <View style={{ flexDirection: "row" }}>
          {params.has("old-chip") ? <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, height: 28, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 }}>
            <McpChip {...props} workspaceId="ws-1" agentId="agent-1" />
          </View> : <ChipPreview />}
        </View>
      </View>
      : params.has("card") ? <View style={{ padding: 24, gap: 12, backgroundColor: colors.surface0, minHeight: "100vh" as any }}>
        <Text style={{ color: colors.foreground, fontSize: 13 }}>Assistant: I'll look up the open issues in Linear.</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12, fontFamily: "Menlo" }}>✕ mcp__linear__list_issues · failed</Text>
        <SignInCard {...props} agentId="agent-1" timestamp={new Date()} item={{ type: "plugin", kind: "mcp-sign-in", version: 1, data: { server: params.get("server") ?? "linear", provider: "claude" } }} />
      </View>
      : params.has("sidebar") ? <SidebarPreview {...props} />
      : params.has("agent") ? <McpAgentPanel {...props} context="agent" workspaceId="ws-1" agentId="agent-1" />
      : params.has("health-settings") ? <HealthSettingsScreen {...props} />
      : params.has("settings") ? <InjectionSettingsScreen {...props} />
      : params.has("workspace") ? <McpWorkspacePanel {...props} context="workspace" workspaceId="ws-1" /> : <McpSurface {...props} />}
  </QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
