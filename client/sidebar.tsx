import type { ComponentType } from "react";
import React from "react";
import { Pressable, Text } from "react-native";
import * as HostUi from "@getpaseo/plugin/client/ui";
import { ADD_SERVER_PARAM, addServerParams } from "../shared/screen-params";
import { HostIcon, SPACE, TYPE } from "./ui";
import { MCP_NAME } from "../shared/guide";

/**
 * Paseo 0.11 and later draw a plugin's sidebar entry natively: the plugin
 * hands over a component that renders the app's own `SidebarRow`, and the
 * row opens a full screen with the app's own header. The 0.8 SDK types don't
 * declare any of it, so everything here is looked up at runtime; on an older
 * app `SidebarRow` is missing and the entry falls back to `addSidebarItem`.
 *
 * 0.18.3: a "+" in the row's trailing slot opens the MCP page on Add a server
 * (the gallery), like Memories' "+" on its Skills row.
 */
type SidebarRowProps = { icon?: string; label?: string; onPress(): void; active?: boolean; trailing?: React.ReactNode };
export const SidebarRow = (HostUi as unknown as { SidebarRow?: ComponentType<SidebarRowProps> }).SidebarRow;

export type ScreenLocation = { screenId: string; params: Record<string, string> };
export type OpenScreen = (input: { screenId: string; params?: Record<string, string> }) => void;
export type SidebarItemProps = { currentScreen: ScreenLocation | null; openScreen: OpenScreen; theme?: { colors?: { foregroundMuted?: string } } };

export const MCP_SCREEN_ID = "mcp";
export { ADD_SERVER_PARAM };

/** The row's "+": a quiet icon in the muted colour, with its words for screen readers. */
function AddServerButton({ color, onPress }: { color: string; onPress(): void }) {
  return (
    <Pressable testID="mcp-sidebar-add" accessibilityRole="button" accessibilityLabel="Add a connector" hitSlop={6} onPress={onPress} style={{ alignItems: "center", justifyContent: "center", paddingHorizontal: SPACE.xs + SPACE.hair }}>
      {HostIcon ? <HostIcon name="Plus" size={16} color={color} /> : <Text style={{ ...TYPE.lead, color }}>+</Text>}
    </Pressable>
  );
}

/** The Connectors row in the app's sidebar, marked active while its screen is open, with "+" to add a connector. */
export function McpSidebarItem({ currentScreen, openScreen, theme }: SidebarItemProps) {
  if (!SidebarRow) return null;
  const color = theme?.colors?.foregroundMuted ?? "#888888";
  return (
    <SidebarRow
      icon="Plug"
      label={MCP_NAME}
      active={currentScreen?.screenId === MCP_SCREEN_ID}
      onPress={() => openScreen({ screenId: MCP_SCREEN_ID })}
      trailing={<AddServerButton color={color} onPress={() => openScreen({ screenId: MCP_SCREEN_ID, params: addServerParams() })} />}
    />
  );
}
