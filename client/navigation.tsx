import * as HostRN from "@getpaseo/plugin/client/react-native";
import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTokens } from "./ui";

/**
 * Five sections, one job each, in one row. Icons are Lucide names drawn by the
 * Paseo app; `heading` is the one line under the bar saying what the section
 * is for (the bar already names it). Same pattern as AI Router's tabs.
 */
export const TABS = [
  { id: "overview", label: "Overview", icon: "LayoutDashboard", heading: "Is every server healthy and in every editor, and what to do next." },
  { id: "servers", label: "Servers", icon: "Server", heading: "One card per server: where it is defined, its health, its tools, and who is signed in. Open a server to edit a definition." },
  { id: "projects", label: "Projects", icon: "FolderCode", heading: "Servers a project brings with its own .mcp.json. They are read here; sign-in happens from the workspace itself." },
  { id: "transfer", label: "Import & Export", icon: "ArrowLeftRight", heading: "Add one server by hand, paste a block of JSON from a README, or write every definition to a backup file." },
  { id: "guide", label: "Guide & Setup", icon: "BookOpen", heading: "Five steps from a README to every editor and every account on this host, and what to do when something does not work." },
] as const;

export type SectionId = (typeof TABS)[number]["id"];

/** The app's icon component, when the host provides one; looked up at runtime so an app without it still renders the bar. */
const HostIcon = (HostRN as unknown as { Icon?: React.ComponentType<{ name: string; size?: number; color?: string }> }).Icon;

/**
 * An underline tab bar in one row. Narrow screens show every section's icon
 * and the active one's label beside its icon, so nothing is hidden. Without
 * app icons, the labels scroll sideways instead.
 */
export function TabBar({ active, onSelect }: { active: SectionId; onSelect: (id: SectionId) => void }) {
  const t = useTokens();
  const iconsOnly = t.compact && Boolean(HostIcon);
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
          minHeight: t.compact ? 44 : 40,
          paddingHorizontal: t.compact ? 10 : 12,
          marginBottom: -1,
          borderBottomWidth: 2,
          borderBottomColor: selected ? t.color.accent : "transparent",
          opacity: pressed ? 0.7 : 1,
          ...(iconsOnly && !selected ? { flexGrow: 1 } : {}),
        })}
      >
        {HostIcon ? <HostIcon name={tab.icon} size={16} color={color} /> : null}
        {!iconsOnly || selected ? (
          <Text numberOfLines={1} style={{ color: selected ? t.color.accent : t.color.fg, fontSize: 13, fontWeight: selected ? "700" : "500" }}>
            {tab.label}
          </Text>
        ) : null}
      </Pressable>
    );
  });
  const bar = { flexDirection: "row" as const, borderBottomWidth: 1, borderBottomColor: t.color.border };
  if (t.compact && !HostIcon) {
    // The rule sits on a wrapper: a horizontal ScrollView does not draw its own bottom border on the web.
    return (
      <View style={{ borderBottomWidth: 1, borderBottomColor: t.color.border }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="tablist" accessibilityLabel="MCP sections" style={{ flexGrow: 0 }}>
          {items}
        </ScrollView>
      </View>
    );
  }
  return (
    <View accessibilityRole="tablist" accessibilityLabel="MCP sections" style={bar}>
      {items}
    </View>
  );
}

/** One line under the tabs saying what the section is for. */
export function SectionHeading({ section }: { section: SectionId }) {
  const t = useTokens();
  const tab = TABS.find((entry) => entry.id === section)!;
  return <Text style={[t.text.body, { color: t.color.muted, maxWidth: 760 }]}>{tab.heading}</Text>;
}
