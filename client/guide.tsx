import React, { useState } from "react";
import { Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import { ADDED_TO_ONE_APP, FEWER_IS_FASTER, HOW_IT_WORKS, HOW_TO_USE, WHAT_IS, WORDS } from "../shared/guide";
import { Card, Disclosure, Divider, HostIcon, IconBadge, RADIUS, SPACE, SectionTitle, Tag, TYPE, alpha, useTokens } from "./ui";

/**
 * The guide: one card, its parts split by dividers: what connectors are, how
 * they work, how to use them, and the words you'll see. Overview folds it
 * behind "New to connectors? How they work" (open until the first connector is
 * added); Help shows it open (0.19.0). The words live in shared/guide.ts.
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
    <Pressable accessibilityRole="link" accessibilityLabel={label} hitSlop={t.control.hit} onPress={onPress} style={{ paddingVertical: SPACE.xs, alignSelf: "flex-start" }}>
      <Text style={{ ...TYPE.body, fontWeight: "600", color: t.color.accent }}>{label}</Text>
    </Pressable>
  );
}

/** One part of the guide: a heading and its text, inside the guide's single card. */
function Part({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: SPACE.row }}>
      <SectionTitle icon={icon}>{title}</SectionTitle>
      {children}
    </View>
  );
}

/** "What are connectors?", with the AI apps found on this computer. */
function WhatIs({ apps }: { apps: readonly string[] }) {
  const t = useTokens();
  return (
    <Part title="What are connectors?" icon="Plug">
      {WHAT_IS.map((line) => (
        <Text key={line} style={t.text.body}>{line}</Text>
      ))}
      {apps.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACE.sm }}>
          <Text style={t.text.caption}>AI apps on this computer:</Text>
          {apps.map((name) => (
            <Tag key={name} label={name} tone="ok" />
          ))}
        </View>
      ) : null}
    </Part>
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
    <View accessible={false} style={down ? { width: 48, alignItems: "center", paddingVertical: SPACE.hair } : { paddingTop: SPACE.md, width: SPACE.section, alignItems: "center" }}>
      {glyph}
    </View>
  );
}

/** Four steps with icons and arrows: across on a wide screen, down on a narrow one. */
function HowItWorks() {
  const t = useTokens();
  const [width, onLayout] = useWidth();
  const stacked = width === null ? t.compact : width < FLOW_STACK_WIDTH;
  return (
    <Part title="How it works" icon="Workflow">
      <View onLayout={onLayout} style={{ flexDirection: stacked ? "column" : "row", alignItems: stacked ? "stretch" : "flex-start" }}>
        {HOW_IT_WORKS.map((step, index) => (
          <React.Fragment key={step.icon}>
            {index > 0 ? <Arrow down={stacked} /> : null}
            {stacked ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.row }}>
                <IconBadge name={step.icon} size={44} />
                <View style={{ flex: 1, gap: SPACE.hair }}>
                  <Text style={t.text.bodyStrong}>{`${index + 1}. ${step.title}`}</Text>
                  <Text style={t.text.body}>{step.text}</Text>
                </View>
              </View>
            ) : (
              <View style={{ flex: 1, alignItems: "center", gap: SPACE.sm, paddingHorizontal: SPACE.xs }}>
                <IconBadge name={step.icon} size={48} />
                <Text style={[t.text.bodyStrong, { textAlign: "center" }]}>{`${index + 1}. ${step.title}`}</Text>
                <Text style={{ ...TYPE.secondary, color: t.color.fg, textAlign: "center" }}>{step.text}</Text>
              </View>
            )}
          </React.Fragment>
        ))}
      </View>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: SPACE.row, padding: SPACE.md, borderRadius: RADIUS.control, backgroundColor: alpha(t.color.accent, 0.07) }}>
        {HostIcon ? (
          <View style={{ paddingTop: SPACE.hair }}>
            <HostIcon name="Gauge" size={18} color={t.color.accent} />
          </View>
        ) : null}
        <Text style={[t.text.body, { flex: 1 }]}>
          <Text style={{ fontWeight: "700" }}>{FEWER_IS_FASTER.title}</Text>
          {` ${FEWER_IS_FASTER.text}`}
        </Text>
      </View>
    </Part>
  );
}

function Numbered({ n, children }: { n: number; children: React.ReactNode }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: SPACE.row }}>
      <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: t.color.accent, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Text style={{ ...TYPE.secondary, fontWeight: "700", color: t.color.accentFg }}>{n}</Text>
      </View>
      <View style={{ flex: 1, gap: SPACE.hair, paddingTop: SPACE.xs }}>{children}</View>
    </View>
  );
}

/** Numbered steps for a first connector, then the way to put every connector in every app. */
function HowToUse({ onAdd, onCopy }: { onAdd: () => void; onCopy: () => void }) {
  const t = useTokens();
  return (
    <Part title="How to use it" icon="ListOrdered">
      {HOW_TO_USE.map((line, index) => (
        <Numbered key={line} n={index + 1}>
          <Text style={t.text.body}>{line}</Text>
          {index === 0 ? <TextLink label="Add a connector" onPress={onAdd} /> : null}
        </Numbered>
      ))}
      <View style={{ gap: SPACE.xs, padding: SPACE.md, borderRadius: RADIUS.control, borderWidth: 1, borderColor: t.color.border, backgroundColor: t.color.surface0 }}>
        <Text style={t.text.bodyStrong}>{ADDED_TO_ONE_APP.title}</Text>
        <Text style={t.text.body}>{ADDED_TO_ONE_APP.text}</Text>
        <TextLink label="Copy to all my AI apps" onPress={onCopy} />
      </View>
    </Part>
  );
}

/** One plain line for each word the panel uses, two across when there is room. */
function Glossary() {
  const t = useTokens();
  return (
    <Part title="Words you'll see" icon="BookOpen">
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: SPACE.section, rowGap: SPACE.md }}>
        {WORDS.map((word) => (
          <View key={word.term} style={{ flexDirection: "row", alignItems: "flex-start", gap: SPACE.row, flexBasis: 300, flexGrow: 1, flexShrink: 1 }}>
            <IconBadge name={word.icon} size={32} />
            <View style={{ flex: 1, gap: SPACE.hair }}>
              <Text style={t.text.bodyStrong}>{word.term}</Text>
              <Text style={t.text.body}>{word.text}</Text>
            </View>
          </View>
        ))}
      </View>
    </Part>
  );
}

/** The guide's parts: what connectors are, how they work, how to use them, and the words. Help shows them inside its last question. */
export function GuideParts({ apps, onAdd, onCopy }: { apps: readonly string[]; onAdd: () => void; onCopy: () => void }) {
  return (
    <>
      <WhatIs apps={apps} />
      <Divider />
      <HowItWorks />
      <Divider />
      <HowToUse onAdd={onAdd} onCopy={onCopy} />
      <Divider />
      <Glossary />
    </>
  );
}

/** The whole guide in one card. */
export function GuideCard(props: { apps: readonly string[]; onAdd: () => void; onCopy: () => void }) {
  return (
    <Card>
      <GuideParts {...props} />
    </Card>
  );
}

/** "New to connectors? How they work": one fold-out, one card. Open while there is nothing set up yet. */
export function OverviewGuide({ apps, onAdd, onCopy, open }: { apps: readonly string[]; onAdd: () => void; onCopy: () => void; open: boolean }) {
  return (
    <Disclosure key={open ? "open" : "closed"} flush title="New to connectors? How they work" openTitle="Hide how connectors work" open={open}>
      <GuideCard apps={apps} onAdd={onAdd} onCopy={onCopy} />
    </Disclosure>
  );
}
