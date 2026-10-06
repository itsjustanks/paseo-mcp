import React, { useState } from "react";
import { Pressable, ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { MCP_NAME, TABS_META, TAB_ORDER, type TabId } from "../shared/guide";
import { HostIcon, SPACE, TYPE, useTokens } from "./ui";

/**
 * Four tabs, one job each, in one row: Overview, Connectors, Projects and Help
 * (0.19.0). Icons are Lucide names drawn by the Paseo app; the words live in
 * shared/guide.ts. No intro block under the bar: the user found the stacked
 * headers messy, so each tab starts with its own content.
 */
export const TABS = TAB_ORDER.map((id) => ({ id, ...TABS_META[id] }));

/** The tab that stays lit for a section that isn't in the bar (adding with a link lives under Connectors). */
const TAB_FOR: Partial<Record<TabId, TabId>> = { transfer: "servers" };

export type SectionId = TabId;

/** About what one tab needs with its label (icon, name, padding). */
const LABELLED_TAB_WIDTH = 150;

/**
 * An underline tab bar in one row. When the full labels do not fit (a narrow
 * screen, or a half-width desktop window, measured here), every tab shows its
 * icon and the active tab its label beside it, so nothing is cut off. Without
 * app icons, the labels scroll sideways instead.
 */
export function TabBar({ active, onSelect }: { active: SectionId; onSelect: (id: SectionId) => void }) {
  const t = useTokens();
  const [width, setWidth] = useState<number | null>(null);
  const tight = t.compact || (width !== null && width < TABS.length * LABELLED_TAB_WIDTH);
  const iconsOnly = tight && Boolean(HostIcon);
  const onLayout = (event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    if (next !== width) setWidth(next);
  };
  const lit = TAB_FOR[active] ?? active;
  const items = TABS.map((tab) => {
    const selected = tab.id === lit;
    const color = selected ? t.color.accent : t.color.muted;
    return (
      <Pressable
        key={tab.id}
        accessibilityRole="tab"
        accessibilityLabel={tab.label}
        accessibilityState={{ selected }}
        // react-native-web 0.21 ignores accessibilityState; say it the web way too.
        aria-selected={selected}
        onPress={() => onSelect(tab.id)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: SPACE.sm,
          minHeight: 44,
          paddingHorizontal: t.compact ? SPACE.sm : SPACE.row,
          marginBottom: -1,
          borderBottomWidth: 2,
          borderBottomColor: selected ? t.color.accent : "transparent",
          opacity: pressed ? 0.7 : 1,
          ...(iconsOnly && !selected ? { flexGrow: 1 } : {}),
        })}
      >
        {HostIcon ? <HostIcon name={tab.icon} size={16} color={color} /> : null}
        {!iconsOnly || selected ? (
          <Text numberOfLines={1} style={{ ...TYPE.secondary, color: selected ? t.color.accent : t.color.fg, fontWeight: selected ? "700" : "500" }}>
            {tab.label}
          </Text>
        ) : null}
      </Pressable>
    );
  });
  const bar = { flexDirection: "row" as const, borderBottomWidth: 1, borderBottomColor: t.color.border };
  if (tight && !HostIcon) {
    // The rule sits on a wrapper: a horizontal ScrollView does not draw its own bottom border on the web.
    return (
      <View onLayout={onLayout} style={{ borderBottomWidth: 1, borderBottomColor: t.color.border }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="tablist" accessibilityLabel={`${MCP_NAME} sections`} style={{ flexGrow: 0 }}>
          {items}
        </ScrollView>
      </View>
    );
  }
  return (
    <View accessibilityRole="tablist" accessibilityLabel={`${MCP_NAME} sections`} onLayout={onLayout} style={bar}>
      {items}
    </View>
  );
}
