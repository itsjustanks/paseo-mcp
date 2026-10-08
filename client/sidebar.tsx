import type { ComponentType } from "react";
import React from "react";
import { Pressable, Text, View } from "react-native";
import * as HostUi from "@getpaseo/plugin/client/ui";
import { ADD_SERVER_PARAM, addServerParams, checkNowParams, filterParams } from "../shared/screen-params";
import type { PluginTheme } from "@getpaseo/plugin";
import { Button, RADIUS, SPACE, TYPE, TokensProvider, statusColor, useUi } from "./ui";
import { MCP_NAME } from "../shared/guide";
import { useHostAttention, useHostAttentionNames } from "./attention-store";

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
export type SidebarItemProps = { currentScreen: ScreenLocation | null; openScreen: OpenScreen; theme?: { colors?: { foregroundMuted?: string; statusWarning?: string; statusDanger?: string } } };

export const MCP_SCREEN_ID = "mcp";
export { ADD_SERVER_PARAM };

/** The row's "+" (0.19.2): the same text "+" as Memories' and Skills' rows, in the muted colour, with its words for screen readers. */
function AddServerButton({ color, onPress }: { color: string; onPress(): void }) {
  return (
    <Pressable testID="mcp-sidebar-add" accessibilityRole="button" accessibilityLabel="Add a connector" hitSlop={6} onPress={onPress} style={{ alignItems: "center", justifyContent: "center", paddingHorizontal: SPACE.xs + SPACE.hair }}>
      <Text style={{ ...TYPE.sidebarPlus, color }}>+</Text>
    </Pressable>
  );
}

type Colors = NonNullable<SidebarItemProps["theme"]>["colors"];
const dotColor = (kind: "failing" | "sign-in", colors: Colors) => (kind === "failing" ? (colors?.statusDanger ?? "#d1242f") : (colors?.statusWarning ?? "#9a6700"));
const dotWords = (kind: "failing" | "sign-in") => (kind === "failing" ? "A connector isn't working" : "A connector needs sign-in");

/**
 * 0.19.1: a small dot when a connector is failing (danger) or needs sign-in
 * (warning), in place of a chip on every chat. It reads what the chip registry
 * last decided, so it costs no reads. 0.19.2: pressing it opens a quick
 * popover (as AI Router's and Hosts' dots do) on apps that have one.
 */
function AttentionDot({ kind, colors, onPress }: { kind: "failing" | "sign-in"; colors: Colors; onPress?: () => void }) {
  const dot = <View testID="mcp-sidebar-dot" accessible={!onPress} accessibilityLabel={dotWords(kind)} style={{ width: SPACE.sm, height: SPACE.sm, borderRadius: RADIUS.pill, backgroundColor: dotColor(kind, colors) }} />;
  if (!onPress) return dot;
  return (
    <Pressable testID="mcp-sidebar-dot-button" accessibilityRole="button" accessibilityLabel={`${dotWords(kind)}. Quick look`} hitSlop={SPACE.sm} onPress={onPress} style={{ padding: SPACE.xs }}>
      {dot}
    </Pressable>
  );
}

export type PopoverProps = { theme: PluginTheme; close(): void; openScreen: OpenScreen };
export type OpenPopover = (Content: ComponentType<PopoverProps>) => void;

/** "a (Everywhere), b (This project · data-glue) and 2 more". */
function names(list: readonly string[], where: Readonly<Record<string, string>> = {}): string {
  const head = list.slice(0, 3).map((name) => (where[name] ? `${name} (${where[name]})` : name)).join(", ");
  return list.length > 3 ? `${head} and ${list.length - 3} more` : head;
}

/** The dot's popover (0.19.2): what needs a look, in a line or two, and the two things to do about it. */
export function AttentionPopover({ theme, close, openScreen }: PopoverProps) {
  const t = useUi(theme, true);
  const { failing, signIn, where } = useHostAttentionNames();
  const go = (params?: Record<string, string>) => {
    openScreen(params ? { screenId: MCP_SCREEN_ID, params } : { screenId: MCP_SCREEN_ID });
    close();
  };
  const lines = [
    failing.length > 0 ? { kind: "failing" as const, head: `${failing.length} ${failing.length === 1 ? "connector isn't" : "connectors aren't"} working`, list: names(failing, where) } : null,
    signIn.length > 0 ? { kind: "sign-in" as const, head: `${signIn.length} ${signIn.length === 1 ? "needs" : "need"} sign-in`, list: names(signIn, where) } : null,
  ].filter((line): line is NonNullable<typeof line> => line !== null);
  const primary = failing.length > 0 ? { label: "Show them", params: filterParams("issues") } : signIn.length > 0 ? { label: "Show them", params: filterParams("sign-in") } : { label: `Open ${MCP_NAME}`, params: undefined };
  return (
    <TokensProvider value={t}>
      <View style={{ padding: t.space.md, gap: t.space.row, minWidth: 260, maxWidth: 360, backgroundColor: t.color.surface0 }}>
        {lines.length === 0 ? <Text style={t.text.bodyStrong}>{`${MCP_NAME} · all working`}</Text> : null}
        {lines.map((line) => (
          <View key={line.kind} style={{ gap: t.space.hair }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
              <View style={{ width: t.space.sm, height: t.space.sm, borderRadius: RADIUS.pill, backgroundColor: statusColor(t, line.kind === "failing" ? "error" : "attention") }} />
              <Text style={[t.text.bodyStrong, { flexShrink: 1 }]}>{line.head}</Text>
            </View>
            <Text style={[t.text.caption, { paddingLeft: t.space.md }]}>{line.list}</Text>
          </View>
        ))}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
          <Button label={primary.label} variant="primary" onPress={() => go(primary.params)} />
          <Button label="Check again" icon="RefreshCw" onPress={() => go(checkNowParams())} />
        </View>
      </View>
    </TokensProvider>
  );
}

/** The Connectors row in the app's sidebar, marked active while its screen is open, with a status dot when something needs the user and "+" to add a connector. */
export function McpSidebarItem({ currentScreen, openScreen, openPopover, theme }: SidebarItemProps & { openPopover?: OpenPopover }) {
  const attention = useHostAttention();
  if (!SidebarRow) return null;
  const color = theme?.colors?.foregroundMuted ?? "#888888";
  return (
    <SidebarRow
      icon="Plug"
      label={MCP_NAME}
      active={currentScreen?.screenId === MCP_SCREEN_ID}
      onPress={() => openScreen({ screenId: MCP_SCREEN_ID })}
      trailing={
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.xs }}>
          {attention ? <AttentionDot kind={attention} colors={theme?.colors} {...(typeof openPopover === "function" ? { onPress: () => openPopover(AttentionPopover) } : {})} /> : null}
          <AddServerButton color={color} onPress={() => openScreen({ screenId: MCP_SCREEN_ID, params: addServerParams() })} />
        </View>
      }
    />
  );
}
