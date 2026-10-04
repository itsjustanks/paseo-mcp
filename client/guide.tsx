import React, { useState } from "react";
import { Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import { ADDED_TO_ONE_APP, FEWER_IS_FASTER, HOW_IT_WORKS, HOW_TO_USE, WHAT_IS, WORDS } from "../shared/guide";
import { Card, HostIcon, IconBadge, Tag, TYPE, alpha, useTokens } from "./ui";

/**
 * The Overview's guide, the same four cards as AI Router's (the shared design
 * standard): what MCP servers are, how it works, how to use it, and the words
 * you'll see. The words live in shared/guide.ts.
 */

/** Below this width the "How it works" steps stack top to bottom instead of left to right. */
const FLOW_STACK_WIDTH = 640;

/** The container's own width, so a layout can follow a half-width window as well as a phone. Null until measured. */
function useWidth(): [number | null, (event: LayoutChangeEvent) => void] {
  const [width, setWidth] = useState<number | null>(null);
  return [
    width,
    (event) => {
      const next = Math.round(event.nativeEvent.layout.width);
      if (next !== width) setWidth(next);
    },
  ];
}

function TextLink({ label, onPress }: { label: string; onPress: () => void }) {
  const t = useTokens();
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={label} hitSlop={t.control.hit} onPress={onPress} style={{ paddingVertical: 6, alignSelf: "flex-start" }}>
      <Text style={{ ...TYPE.body, fontWeight: "600", color: t.color.accent }}>{label}</Text>
    </Pressable>
  );
}

/** "What are MCP servers?", with the AI apps found on this computer. */
export function WhatIsCard({ apps }: { apps: readonly string[] }) {
  const t = useTokens();
  return (
    <Card title="What are MCP servers?" icon="Plug">
      {WHAT_IS.map((line) => (
        <Text key={line} style={t.text.body}>{line}</Text>
      ))}
      {apps.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <Text style={t.text.caption}>AI apps on this computer:</Text>
          {apps.map((name) => (
            <Tag key={name} label={name} tone="ok" />
          ))}
        </View>
      ) : null}
    </Card>
  );
}

function Arrow({ down }: { down: boolean }) {
  const t = useTokens();
  const glyph = HostIcon ? (
    <HostIcon name={down ? "ArrowDown" : "ArrowRight"} size={20} color={t.color.muted} />
  ) : (
    <Text style={[t.text.lead, { color: t.color.muted }]}>{down ? "↓" : "→"}</Text>
  );
  return (
    <View accessible={false} style={down ? { width: 48, alignItems: "center", paddingVertical: 2 } : { paddingTop: 16, width: 24, alignItems: "center" }}>
      {glyph}
    </View>
  );
}

/** Four steps with icons and arrows: across on a wide screen, down on a narrow one. */
export function HowItWorksCard() {
  const t = useTokens();
  const [width, onLayout] = useWidth();
  const stacked = width === null ? t.compact : width < FLOW_STACK_WIDTH;
  return (
    <Card title="How it works" icon="Workflow">
      <View onLayout={onLayout} style={{ flexDirection: stacked ? "column" : "row", alignItems: stacked ? "stretch" : "flex-start" }}>
        {HOW_IT_WORKS.map((step, index) => (
          <React.Fragment key={step.icon}>
            {index > 0 ? <Arrow down={stacked} /> : null}
            {stacked ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
                <IconBadge name={step.icon} size={48} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={t.text.bodyStrong}>{`${index + 1}. ${step.title}`}</Text>
                  <Text style={t.text.body}>{step.text}</Text>
                </View>
              </View>
            ) : (
              <View style={{ flex: 1, alignItems: "center", gap: 8, paddingHorizontal: 4 }}>
                <IconBadge name={step.icon} size={52} />
                <Text style={[t.text.bodyStrong, { textAlign: "center" }]}>{`${index + 1}. ${step.title}`}</Text>
                <Text style={{ ...TYPE.secondary, color: t.color.fg, textAlign: "center" }}>{step.text}</Text>
              </View>
            )}
          </React.Fragment>
        ))}
      </View>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12, padding: 14, borderRadius: 12, backgroundColor: alpha(t.color.accent, 0.07) }}>
        {HostIcon ? (
          <View style={{ paddingTop: 3 }}>
            <HostIcon name="Gauge" size={18} color={t.color.accent} />
          </View>
        ) : null}
        <Text style={[t.text.body, { flex: 1 }]}>
          <Text style={{ fontWeight: "700" }}>{FEWER_IS_FASTER.title}</Text>
          {` ${FEWER_IS_FASTER.text}`}
        </Text>
      </View>
    </Card>
  );
}

function Numbered({ n, children }: { n: number; children: React.ReactNode }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
      <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: t.color.accent, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Text style={{ ...TYPE.secondary, fontWeight: "700", color: t.color.accentFg }}>{n}</Text>
      </View>
      <View style={{ flex: 1, gap: 2, paddingTop: 3 }}>{children}</View>
    </View>
  );
}

/** Numbered steps for a first server, then the way to put every server in every app. */
export function HowToUseCard({ onAdd, onCopy }: { onAdd: () => void; onCopy: () => void }) {
  const t = useTokens();
  return (
    <Card title="How to use it" icon="ListOrdered">
      {HOW_TO_USE.map((line, index) => (
        <Numbered key={line} n={index + 1}>
          <Text style={t.text.body}>{line}</Text>
          {index === 0 ? <TextLink label="Open Servers" onPress={onAdd} /> : null}
        </Numbered>
      ))}
      <View style={{ gap: 4, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: t.color.border, backgroundColor: t.color.surface0 }}>
        <Text style={t.text.bodyStrong}>{ADDED_TO_ONE_APP.title}</Text>
        <Text style={t.text.body}>{ADDED_TO_ONE_APP.text}</Text>
        <TextLink label="Copy to all my AI apps" onPress={onCopy} />
      </View>
    </Card>
  );
}

/** One plain line for each word the panel uses, two across when there is room. */
export function GlossaryCard() {
  const t = useTokens();
  return (
    <Card title="Words you'll see" icon="BookOpen">
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 24, rowGap: 16 }}>
        {WORDS.map((word) => (
          <View key={word.term} style={{ flexDirection: "row", alignItems: "flex-start", gap: 12, flexBasis: 300, flexGrow: 1, flexShrink: 1 }}>
            <IconBadge name={word.icon} size={30} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={t.text.bodyStrong}>{word.term}</Text>
              <Text style={t.text.body}>{word.text}</Text>
            </View>
          </View>
        ))}
      </View>
    </Card>
  );
}

/** The Overview's guide, top to bottom: what it is, how it works, how to use it, and the words. */
export function OverviewGuide({ apps, onAdd, onCopy }: { apps: readonly string[]; onAdd: () => void; onCopy: () => void }) {
  return (
    <>
      <WhatIsCard apps={apps} />
      <HowItWorksCard />
      <HowToUseCard onAdd={onAdd} onCopy={onCopy} />
      <GlossaryCard />
    </>
  );
}
