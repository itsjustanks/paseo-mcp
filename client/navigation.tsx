import React, { useState } from "react";
import { Pressable, ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { TAB_INTROS, TAB_ORDER, type TabId } from "../shared/guide";
import { Bullets, Disclosure, HostIcon, IconBadge, TYPE, useTokens } from "./ui";

/**
 * Five sections, one job each, in one row: the same underline tabs, intros
 * and type as AI Router (the shared design standard). Icons are Lucide names
 * drawn by the Paseo app; the words live in shared/guide.ts.
 */
export const TABS = TAB_ORDER.map((id) => ({ id, ...TAB_INTROS[id] }));

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
  const items = TABS.map((tab) => {
    const selected = tab.id === active;
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
          gap: 6,
          minHeight: 44,
          paddingHorizontal: t.compact ? 8 : 11,
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
        <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="tablist" accessibilityLabel="MCP sections" style={{ flexGrow: 0 }}>
          {items}
        </ScrollView>
      </View>
    );
  }
  return (
    <View accessibilityRole="tablist" accessibilityLabel="MCP sections" onLayout={onLayout} style={bar}>
      {items}
    </View>
  );
}

/**
 * The top of each tab: its icon, a clear title, one or two plain sentences on
 * what it is for, and "What you can do here". On a phone that list folds away
 * behind "Learn more", so the tab's own content stays near the top.
 */
export function TabIntro({ section }: { section: SectionId }) {
  const t = useTokens();
  const tab = TAB_INTROS[section];
  const list = (
    <View style={{ gap: 10, padding: 14, borderRadius: 14, backgroundColor: t.color.surface1, borderWidth: 1, borderColor: t.color.border }}>
      {!t.compact ? <Text style={{ ...TYPE.secondary, fontWeight: "600", color: t.color.muted }}>What you can do here</Text> : null}
      <Bullets items={tab.canDo} columns={!t.compact} />
    </View>
  );
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 14 }}>
        <IconBadge name={tab.icon} size={t.compact ? 40 : 46} />
        <View style={{ flex: 1, gap: 4, minWidth: 0 }}>
          <Text accessibilityRole="header" style={t.text.display}>{tab.title}</Text>
          <Text style={t.text.lead}>{tab.summary}</Text>
        </View>
      </View>
      {t.compact ? (
        <Disclosure key={section} title="Learn more: what you can do here">
          {list}
        </Disclosure>
      ) : (
        list
      )}
    </View>
  );
}
