import type { ComponentType } from "react";
import React from "react";
import * as HostUi from "@getpaseo/plugin/client/ui";

/**
 * Paseo 0.11 and later draw a plugin's sidebar entry natively: the plugin
 * hands over a component that renders the app's own `SidebarRow`, and the
 * row opens a full screen with the app's own header. The 0.8 SDK types don't
 * declare any of it, so everything here is looked up at runtime; on an older
 * app `SidebarRow` is missing and the entry falls back to `addSidebarItem`.
 */
type SidebarRowProps = { icon?: string; label?: string; onPress(): void; active?: boolean };
export const SidebarRow = (HostUi as unknown as { SidebarRow?: ComponentType<SidebarRowProps> }).SidebarRow;

export type ScreenLocation = { screenId: string; params: Record<string, string> };
export type OpenScreen = (input: { screenId: string; params?: Record<string, string> }) => void;
export type SidebarItemProps = { currentScreen: ScreenLocation | null; openScreen: OpenScreen };

export const MCP_SCREEN_ID = "mcp";

/** The MCP row in the app's sidebar, marked active while the MCP screen is open. */
export function McpSidebarItem({ currentScreen, openScreen }: SidebarItemProps) {
  if (!SidebarRow) return null;
  return <SidebarRow icon="Plug" label="MCP" active={currentScreen?.screenId === MCP_SCREEN_ID} onPress={() => openScreen({ screenId: MCP_SCREEN_ID })} />;
}
