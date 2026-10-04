import type { PluginTheme } from "@getpaseo/plugin";
import * as HostRN from "@getpaseo/plugin/client/react-native";
import React, { createContext, useContext, useMemo, useState } from "react";
import { ActivityIndicator, Clipboard, Image, Pressable, ScrollView, Text, TextInput, View } from "react-native";

/**
 * The plugin's design system.
 *
 * Paseo hands each surface semantic colours, host-rendered icons and a compact
 * flag. Keep those host tokens as the source of truth so every theme and client
 * renders the same meaning.
 *
 * Two rules keep it honest:
 *   - one filled button per view; everything else is quieter than it,
 *   - nothing non-interactive gets a border, so a border means "you can press".
 */

// ------------------------------------------------------------------- colour

function parse(color: string): [number, number, number, number] | null {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(color.trim());
  if (hex) {
    const value = hex[1]!;
    const expand = (part: string) => parseInt(part.length === 1 ? part + part : part, 16);
    if (value.length === 3 || value.length === 4) {
      return [expand(value[0]!), expand(value[1]!), expand(value[2]!), value.length === 4 ? expand(value[3]!) / 255 : 1];
    }
    if (value.length === 6 || value.length === 8) {
      return [
        parseInt(value.slice(0, 2), 16),
        parseInt(value.slice(2, 4), 16),
        parseInt(value.slice(4, 6), 16),
        value.length === 8 ? parseInt(value.slice(6, 8), 16) / 255 : 1,
      ];
    }
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (rgb) {
    const parts = rgb[1]!.split(/[,/\s]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((part) => Number.isFinite(part))) {
      return [parts[0]!, parts[1]!, parts[2]!, Number.isFinite(parts[3]!) ? parts[3]! : 1];
    }
  }
  return null;
}

/**
 * Translucent version of a colour. A colour this cannot parse is returned
 * unchanged on purpose: a solid border is a cosmetic flaw, and the string
 * concatenation this replaces produced an invisible one.
 */
export function alpha(color: string, amount: number): string {
  const parsed = parse(color);
  if (!parsed) return color;
  const [r, g, b, a] = parsed;
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.max(0, Math.min(1, a * amount))})`;
}

export function mix(base: string, over: string, amount: number): string {
  const one = parse(base);
  const two = parse(over);
  if (!one || !two) return base;
  const blend = (a: number, b: number) => Math.round(a + (b - a) * Math.max(0, Math.min(1, amount)));
  return `rgb(${blend(one[0], two[0])}, ${blend(one[1], two[1])}, ${blend(one[2], two[2])})`;
}

export function isDarkSurface(color: string): boolean {
  const parsed = parse(color);
  if (!parsed) return false;
  const [r, g, b] = parsed;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

// Older Paseo hosts did not supply success and warning colours. These remain
// compatibility fallbacks for a directory install opened by an older client.
const SUCCESS = { dark: "#3ecf8e", light: "#12855a" };
const WARNING = { dark: "#e0a33e", light: "#a16207" };

// ---------------------------------------------------------------------- type

/**
 * One type scale for every Paseo plugin of ours (the shared design standard,
 * from AI Router 0.13.0), so sentences stay readable: nothing below 13 px,
 * descriptions at 15, section titles at 17, tab titles at 20 and the page
 * title at 22; headline numbers get 26. Spread one into a style:
 * `{ ...TYPE.body, color }`. The `t.text` tokens below are built from it.
 */
export const TYPE = {
  page: { fontSize: 22, lineHeight: 28, fontWeight: "700" },
  tabTitle: { fontSize: 20, lineHeight: 26, fontWeight: "700" },
  section: { fontSize: 17, lineHeight: 23, fontWeight: "600" },
  lead: { fontSize: 16, lineHeight: 24 },
  item: { fontSize: 15, lineHeight: 21, fontWeight: "600" },
  body: { fontSize: 15, lineHeight: 22 },
  secondary: { fontSize: 14, lineHeight: 20 },
  small: { fontSize: 13, lineHeight: 18 },
  mono: { fontSize: 13, lineHeight: 19, fontFamily: "monospace" },
  /** A headline number, such as a token count. */
  figure: { fontSize: 26, lineHeight: 32, fontWeight: "700" },
} as const;

/**
 * One spacing scale for every screen (the shared design standard §3, as in
 * AI Router 0.15.0). Screens use these names, never raw numbers: `section`
 * between cards and sections, `card` inside a card, `row` between the lines
 * of a card, `sm`/`xs`/`hair` for tight pairs (an icon and its text).
 */
export const SPACE = { hair: 2, xs: 4, sm: 8, row: 12, md: 16, card: 20, section: 24 } as const;
export const RADIUS = { card: 16, control: 10, pill: 999 } as const;

// -------------------------------------------------------------------- tokens

export type Tokens = ReturnType<typeof tokens>;

export function tokens(theme: PluginTheme, compact: boolean) {
  const dark = isDarkSurface(theme.colors.surface0);
  const ink = dark ? "#ffffff" : "#000000";
  const colors = theme.colors as PluginTheme["colors"] & Partial<{
    surface1: string;
    surface2: string;
    border: string;
    statusSuccess: string;
    statusWarning: string;
  }>;
  const fg = theme.colors.foreground;
  const muted = theme.colors.foregroundMuted;
  const accent = theme.colors.accent;
  const danger = theme.colors.statusDanger;
  const success = colors.statusSuccess || (dark ? SUCCESS.dark : SUCCESS.light);
  const warning = colors.statusWarning || (dark ? WARNING.dark : WARNING.light);

  return {
    compact,
    dark,
    color: {
      fg,
      muted,
      accent,
      accentFg: theme.colors.accentForeground,
      danger,
      success,
      warning,
      // Native semantic surfaces on Paseo 0.7+, with compatible derivation for
      // older hosts. Never nest one inside another of the same level.
      surface0: theme.colors.surface0,
      surface1: colors.surface1 || mix(theme.colors.surface0, ink, dark ? 0.05 : 0.03),
      surface2: colors.surface2 || mix(theme.colors.surface0, ink, dark ? 0.09 : 0.06),
      borderSubtle: alpha(muted, 0.14),
      border: colors.border || alpha(muted, 0.24),
      borderStrong: alpha(muted, 0.4),
      accentWash: alpha(accent, 0.14),
      accentLine: alpha(accent, 0.45),
      dangerWash: alpha(danger, 0.14),
      dangerLine: alpha(danger, 0.45),
      successWash: alpha(success, 0.14),
      warningWash: alpha(warning, 0.14),
      disabled: alpha(fg, 0.38),
      // Placeholder text is load-bearing (often the field's only label), so it
      // sits above the disabled tint contrast-wise without shouting.
      placeholder: alpha(fg, 0.5),
    },
    // The shared TYPE scale, the same on wide and narrow screens. Muted grey is
    // only for times, ids and hints (`caption`); sentences use `body`.
    text: {
      page: { ...TYPE.page, color: fg },
      display: { ...TYPE.tabTitle, color: fg },
      value: { ...TYPE.figure, color: fg },
      heading: { ...TYPE.section, color: fg },
      lead: { ...TYPE.lead, color: fg },
      body: { ...TYPE.body, fontWeight: "400" as const, color: fg },
      bodyStrong: { ...TYPE.item, color: fg },
      label: { ...TYPE.secondary, fontWeight: "500" as const, color: fg },
      caption: { ...TYPE.secondary, fontWeight: "400" as const, color: muted },
      small: { ...TYPE.small, fontWeight: "600" as const, color: fg },
      mono: { ...TYPE.mono, color: fg, fontFamily: compact ? "monospace" : "Menlo" },
    },
    space: SPACE,
    radius: { sm: 8, md: RADIUS.control, lg: RADIUS.card, pill: RADIUS.pill },
    control: { min: compact ? 44 : 36, button: 44, hit: { top: 6, bottom: 6, left: 6, right: 6 } },
    maxWidth: 980,
  };
}

const TokensContext = createContext<Tokens | null>(null);

export function TokensProvider({ value, children }: { value: Tokens; children: React.ReactNode }) {
  return <TokensContext.Provider value={value}>{children}</TokensContext.Provider>;
}

export function useTokens(): Tokens {
  const value = useContext(TokensContext);
  if (!value) throw new Error("useTokens must be used inside a Screen");
  return value;
}

export function useUi(theme: PluginTheme, compact: boolean): Tokens {
  return useMemo(() => tokens(theme, compact), [theme, compact]);
}

// ---------------------------------------------------------------- status map

export type Status = "ok" | "attention" | "error" | "neutral" | "busy";

export function statusColor(t: Tokens, status: Status): string {
  if (status === "ok") return t.color.success;
  if (status === "attention") return t.color.warning;
  if (status === "error") return t.color.danger;
  if (status === "busy") return t.color.accent;
  return t.color.muted;
}

// ----------------------------------------------------------------- structure

/** The app's icon component (Lucide names), when the host provides one; looked up at runtime so an app without it still renders. */
export const HostIcon = (HostRN as unknown as { Icon?: React.ComponentType<{ name: string; size?: number; color?: string }> }).Icon;

/** The icon each tone shows beside its words, so colour is never the only channel. */
export const TONE_ICON: Record<Status, string> = { ok: "CircleCheck", attention: "TriangleAlert", error: "CircleAlert", neutral: "Info", busy: "Loader" };

/** The colour a tone is drawn in; neutral uses the accent, so "one step left" doesn't read as a warning. */
function inkOf(t: Tokens, tone: Status | "accent"): string {
  return tone === "accent" || tone === "neutral" ? t.color.accent : statusColor(t, tone);
}

export function Screen({
  t,
  children,
  scroll = true,
  paddingTop,
}: {
  t: Tokens;
  children: React.ReactNode;
  scroll?: boolean;
  /** A header rendered above the scroll area already carries the top padding. */
  paddingTop?: number;
}) {
  const pad = t.compact ? SPACE.md : SPACE.section;
  const body = (
    <View style={{ maxWidth: t.maxWidth, width: "100%", alignSelf: "center", gap: t.space.section }}>{children}</View>
  );
  return (
    <TokensProvider value={t}>
      {scroll ? (
        <ScrollView
          style={{ flex: 1, backgroundColor: t.color.surface0 }}
          contentContainerStyle={{ padding: pad, paddingTop: paddingTop ?? pad, paddingBottom: 48 }}
        >
          {body}
        </ScrollView>
      ) : (
        <View style={{ flex: 1, backgroundColor: t.color.surface0, padding: pad, paddingTop: paddingTop ?? pad }}>{body}</View>
      )}
    </TokensProvider>
  );
}

/** A soft circle with an icon in it: the visual anchor of cards, steps and status. Nothing without the app's icons. */
export function IconBadge({ name, tone = "accent", size = 32 }: { name: string; tone?: Status | "accent"; size?: number }) {
  const t = useTokens();
  if (!HostIcon) return null;
  const color = inkOf(t, tone);
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: alpha(color, 0.14), alignItems: "center", justifyContent: "center", flexShrink: 0 }}
    >
      <HostIcon name={name} size={Math.round(size * 0.5)} color={color} />
    </View>
  );
}

/**
 * The page header every plugin of ours shares: the plugin's icon, its name,
 * and one line on its state with a coloured dot (and the word, so colour is
 * never the only channel).
 */
export function Header({ title, status, caption, icon: name = "Plug" }: { title: string; status: { status: Status; label: string }; caption?: string; icon?: string }) {
  const t = useTokens();
  const color = statusColor(t, status.status);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
      <IconBadge name={name} size={t.compact ? 40 : 46} />
      <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
        <Text accessibilityRole="header" numberOfLines={1} style={t.text.page}>{title}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
          <Text style={[t.text.caption, { flexShrink: 1 }]}>
            <Text style={{ color, fontWeight: "600" }}>{status.label}</Text>
            {caption ? ` · ${caption}` : ""}
          </Text>
        </View>
      </View>
    </View>
  );
}

/** Fixed-width cards that wrap on wide layouts and stack in compact ones. */
export function Grid({ children, min = 240 }: { children: React.ReactNode; min?: number }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: t.compact ? "column" : "row", flexWrap: t.compact ? "nowrap" : "wrap", alignItems: "stretch", gap: t.space.row }}>
      {React.Children.map(children, (child) =>
        child ? (
          <View style={{ width: t.compact ? "100%" : undefined, flexGrow: 1, flexBasis: t.compact ? undefined : min, minWidth: t.compact ? undefined : min }}>
            {child}
          </View>
        ) : null,
      )}
    </View>
  );
}

/** A numbered heading for a walkthrough card: a filled accent circle with the number. Index 0 draws no number. */
export function Step({ index, title }: { index: number; title: string }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      {index > 0 ? (
        <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: t.color.accent, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Text style={{ ...TYPE.secondary, fontWeight: "700", color: t.color.accentFg }}>{index}</Text>
        </View>
      ) : null}
      <Text style={[t.text.heading, { flexShrink: 1 }]}>{title}</Text>
    </View>
  );
}

/** Title, one sentence of orientation, and the actions for the whole surface. */
export function Toolbar({
  title,
  subtitle,
  actions,
  below,
}: {
  title?: string;
  subtitle?: string;
  actions?: React.ReactNode;
  below?: React.ReactNode;
}) {
  const t = useTokens();
  return (
    <View style={{ gap: t.space.row }}>
      <View
        style={{
          flexDirection: t.compact ? "column" : "row",
          alignItems: t.compact ? "stretch" : "flex-end",
          justifyContent: "space-between",
          gap: t.space.row,
        }}
      >
        {title || subtitle ? (
          <View style={{ gap: 4, flexShrink: 1 }}>
            {title ? <Text accessibilityRole="header" style={t.text.display}>{title}</Text> : null}
            {subtitle ? <Text style={t.text.caption}>{subtitle}</Text> : null}
          </View>
        ) : null}
        {actions ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm, flexShrink: 1 }}>{actions}</View> : null}
      </View>
      {below}
    </View>
  );
}

/** A titled group: the title at section size, an optional trailing action, then its content. */
export function Section({ title, trailing, children }: { title?: string; trailing?: React.ReactNode; children: React.ReactNode }) {
  const t = useTokens();
  return (
    <View style={{ gap: t.space.row }}>
      {title ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.space.sm }}>
          <Text accessibilityRole="header" style={[t.text.heading, { flexShrink: 1 }]}>{title}</Text>
          {trailing}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/**
 * A card. With `title` it opens with AI Router's card header: an icon badge,
 * the title at section size and an optional subtitle. `tone` tints its border.
 */
export function Card({
  children,
  level = 1,
  padded = true,
  tone,
  grow,
  title,
  icon: name,
  subtitle,
}: {
  children: React.ReactNode;
  level?: 1 | 2;
  padded?: boolean;
  tone?: Status;
  /** Fill the height it is given: cards in one gallery row line up. */
  grow?: boolean;
  title?: string;
  icon?: string;
  subtitle?: string;
}) {
  const t = useTokens();
  const pad = t.compact ? SPACE.md : SPACE.card;
  return (
    <View
      style={{
        backgroundColor: level === 1 ? t.color.surface1 : t.color.surface2,
        borderRadius: RADIUS.card,
        borderWidth: 1,
        borderColor: tone ? alpha(statusColor(t, tone), 0.4) : t.color.border,
        padding: padded ? pad : 0,
        // An unpadded card holds a list of Rows, which bring their own padding and dividers.
        gap: padded ? SPACE.row : 0,
        overflow: "hidden",
        ...(grow ? { flexGrow: 1 } : {}),
      }}
    >
      {title ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.row, ...(padded ? {} : { padding: pad, paddingBottom: SPACE.sm }) }}>
          {name ? <IconBadge name={name} tone={tone && tone !== "neutral" ? tone : "accent"} size={32} /> : null}
          <View style={{ flex: 1, gap: SPACE.hair, minWidth: 0 }}>
            <Text accessibilityRole="header" style={t.text.heading}>{title}</Text>
            {subtitle ? <Text style={t.text.caption}>{subtitle}</Text> : null}
          </View>
        </View>
      ) : null}
      {children}
    </View>
  );
}

/**
 * The big status card at the top of Overview: a tinted band with an icon and
 * the state in words, then whatever details and actions follow. Neutral uses
 * the accent, so "one step left" does not read as a warning.
 */
export function HeroCard({ tone, icon: name, title, lead, children }: { tone: Status; icon: string; title: string; lead?: React.ReactNode; children?: React.ReactNode }) {
  const t = useTokens();
  const color = inkOf(t, tone);
  return (
    <View style={{ backgroundColor: t.color.surface1, borderColor: alpha(color, 0.4), borderWidth: 1, borderRadius: RADIUS.card, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.md, padding: t.compact ? SPACE.md : SPACE.card, backgroundColor: alpha(color, 0.09) }}>
        <IconBadge name={name} tone={tone === "neutral" || tone === "busy" ? "accent" : tone} size={t.compact ? 44 : 48} />
        <View style={{ flex: 1, gap: SPACE.xs, minWidth: 0 }}>
          <Text accessibilityRole="header" style={[t.text.display, tone === "error" ? { color } : null]}>{title}</Text>
          {lead ? typeof lead === "string" ? <Text style={t.text.body}>{lead}</Text> : lead : null}
        </View>
      </View>
      {children ? <View style={{ padding: t.compact ? SPACE.md : SPACE.card, gap: SPACE.row }}>{children}</View> : null}
    </View>
  );
}

/** A thin rule between the parts of a card. */
export function Divider() {
  const t = useTokens();
  return <View style={{ height: 1, backgroundColor: t.color.border }} />;
}

/** Short lines, each with a check mark in the accent colour. `columns` lays them out two across when there is room. */
export function Bullets({ items, columns, icon: name = "Check" }: { items: readonly string[]; columns?: boolean; icon?: string }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: columns ? "row" : "column", flexWrap: columns ? "wrap" : "nowrap", columnGap: 20, rowGap: 8 }}>
      {items.map((line) => (
        <View key={line} style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, ...(columns ? { flexBasis: "45%", minWidth: 240, flexGrow: 1, flexShrink: 1 } : {}) }}>
          {HostIcon ? (
            <View style={{ paddingTop: 3 }}>
              <HostIcon name={name} size={16} color={t.color.accent} />
            </View>
          ) : (
            <Text style={[t.text.body, { color: t.color.accent }]}>•</Text>
          )}
          <Text style={[t.text.body, { flex: 1 }]}>{line}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * One line of a list. Slotted rather than positional, and deliberately without
 * flexWrap: a wrapping row is what pushes an action button off screen the
 * moment an account email gets long.
 */
export function Row({
  leading,
  title,
  subtitle,
  meta,
  trailing,
  expanded,
  onPress,
  tone,
  selected,
  first,
}: {
  leading?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  meta?: React.ReactNode;
  trailing?: React.ReactNode;
  expanded?: React.ReactNode;
  onPress?: () => void;
  tone?: Status;
  selected?: boolean;
  first?: boolean;
}) {
  const t = useTokens();
  const body = (
    <View style={{ gap: t.space.sm }}>
      <View style={{ flexDirection: t.compact ? "column" : "row", alignItems: t.compact ? "stretch" : "center", gap: t.space.row }}>
        {leading ? <View style={{ flexShrink: 0 }}>{leading}</View> : null}
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          {typeof title === "string" ? (
            <Text numberOfLines={1} style={t.text.bodyStrong}>
              {title}
            </Text>
          ) : (
            title
          )}
          {typeof subtitle === "string" ? (
            <Text numberOfLines={1} style={t.text.caption}>
              {subtitle}
            </Text>
          ) : (
            subtitle
          )}
          {meta}
        </View>
        {trailing ? (
          <View
            style={{
              flexDirection: "row",
              gap: t.space.sm,
              flexShrink: 0,
              alignItems: "center",
              justifyContent: t.compact ? "flex-start" : "flex-end",
            }}
          >
            {trailing}
          </View>
        ) : null}
      </View>
      {expanded}
    </View>
  );

  const style = {
    paddingVertical: t.space.row,
    paddingHorizontal: t.compact ? SPACE.row : SPACE.md,
    borderTopWidth: first ? 0 : 1,
    borderTopColor: t.color.borderSubtle,
    borderLeftWidth: tone ? 3 : 0,
    borderLeftColor: tone ? statusColor(t, tone) : "transparent",
    backgroundColor: selected ? t.color.accentWash : "transparent",
  };

  if (!onPress) return <View style={style}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(selected) }}
      onPress={onPress}
      style={({ pressed }) => [style, pressed ? { backgroundColor: alpha(t.color.muted, 0.1) } : null]}
    >
      {body}
    </Pressable>
  );
}

/** Up to three short facts, dot-separated — replaces long grey sentences. */
export function Facts({ items }: { items: Array<{ value: string; tone?: Status } | null | undefined> }) {
  const t = useTokens();
  const list = items.filter(Boolean) as Array<{ value: string; tone?: Status }>;
  if (list.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 2 }}>
      {list.map((item, index) => (
        <React.Fragment key={`${item.value}-${index}`}>
          {index > 0 ? <Text style={[t.text.caption, { opacity: 0.5 }]}>·</Text> : null}
          <Text style={[t.text.caption, item.tone ? { color: statusColor(t, item.tone), fontWeight: "600" } : null]}>{item.value}</Text>
        </React.Fragment>
      ))}
    </View>
  );
}

// ------------------------------------------------------------------- atoms

/** A dot and a word, always both — colour is never the only channel. */
export function StatusPill({ status, label }: { status: Status; label: string }) {
  const t = useTokens();
  const color = statusColor(t, status);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <Text style={{ ...TYPE.secondary, color: status === "neutral" ? t.color.fg : color, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

/**
 * One line of an at-a-glance list: what it is, its state as a pill, a short
 * hint, and a link to where it is dealt with.
 */
export function StatusLine({
  label,
  value,
  status,
  hint,
  action,
}: {
  label: string;
  value: string;
  status: Status;
  hint?: string | null;
  action?: { label: string; onPress: () => void } | null;
}) {
  const t = useTokens();
  const link = action ? (
    <Pressable accessibilityRole="link" accessibilityLabel={action.label} hitSlop={t.control.hit} onPress={action.onPress} style={{ paddingVertical: 4 }}>
      <Text style={{ ...TYPE.secondary, color: t.color.accent, fontWeight: "600" }}>{`${action.label} →`}</Text>
    </Pressable>
  ) : null;
  const state = (
    <>
      <StatusPill status={status} label={value} />
      {hint ? <Text style={[t.text.caption, { flexShrink: 1 }]}>{hint}</Text> : null}
    </>
  );
  // Narrow: the name and its link on one line, the state under it, so the link never wraps onto a line of its own.
  if (t.compact) {
    return (
      <View style={{ gap: 2, paddingVertical: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.space.sm, minHeight: 28 }}>
          <Text style={{ ...TYPE.body, fontWeight: "500", color: t.color.fg }}>{label}</Text>
          {link}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: t.space.sm, rowGap: 2 }}>{state}</View>
      </View>
    );
  }
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 32 }}>
      <Text style={{ ...TYPE.body, fontWeight: "500", color: t.color.fg, width: 140 }}>{label}</Text>
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 10, rowGap: 2 }}>{state}</View>
      {link}
    </View>
  );
}

/** A small label in a soft pill of its tone. */
export function Tag({ label, tone }: { label: string; tone?: Status }) {
  const t = useTokens();
  const color = tone ? statusColor(t, tone) : t.color.muted;
  return (
    <View
      style={{
        alignSelf: "flex-start",
        backgroundColor: tone ? alpha(color, 0.12) : t.color.surface2,
        borderColor: tone ? alpha(color, 0.45) : t.color.border,
        borderWidth: 1,
        borderRadius: t.radius.pill,
        paddingVertical: 2,
        paddingHorizontal: 10,
      }}
    >
      <Text style={{ ...TYPE.small, fontWeight: "600", color: tone ? color : t.color.fg }}>{label}</Text>
    </View>
  );
}

/**
 * A quiet square button with an app icon, and its label for screen readers.
 * Without app icons it falls back to a ghost text button with the label.
 */
export function IconButton({ icon: name, label, onPress }: { icon: string; label: string; onPress: () => void }) {
  const t = useTokens();
  if (!HostIcon) return <Button label={label} variant="ghost" onPress={onPress} />;
  const size = t.compact ? 44 : 38;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={t.control.hit}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: t.radius.md,
        borderWidth: 1,
        borderColor: t.color.border,
        backgroundColor: pressed ? alpha(t.color.muted, 0.12) : t.color.surface2,
        alignItems: "center",
        justifyContent: "center",
      })}
    >
      <HostIcon name={name} size={18} color={t.color.fg} />
    </Pressable>
  );
}

/** A tick box with its label beside it; the whole row presses. */
export function Checkbox({ checked, onChange, label, children }: { checked: boolean; onChange: (next: boolean) => void; label: string; children?: React.ReactNode }) {
  const t = useTokens();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked }}
      {...({ "aria-checked": checked } as object)}
      onPress={() => onChange(!checked)}
      hitSlop={t.control.hit}
      style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}
    >
      <View
        style={{
          width: 20,
          height: 20,
          marginTop: 1,
          borderRadius: 5,
          borderWidth: 1.5,
          borderColor: checked ? t.color.accent : t.color.borderStrong,
          backgroundColor: checked ? t.color.accent : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {checked ? <Text style={{ color: t.color.accentFg, fontSize: 13, lineHeight: 15, fontWeight: "700" }}>✓</Text> : null}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>{children ?? <Text style={t.text.body}>{label}</Text>}</View>
    </Pressable>
  );
}

/** A filter: one row of pressable pills, the first usually "All". */
export function Pills<T extends string>({ options, value, onChange }: { options: ReadonlyArray<{ value: T; label: string }>; value: T; onChange: (value: T) => void }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(option.value)}
            hitSlop={t.control.hit}
            style={{
              minHeight: t.compact ? 40 : 34,
              justifyContent: "center",
              paddingHorizontal: 12,
              borderRadius: t.radius.pill,
              borderWidth: 1,
              borderColor: active ? t.color.accentLine : t.color.border,
              backgroundColor: active ? t.color.accentWash : "transparent",
            }}
          >
            <Text style={{ ...TYPE.secondary, fontWeight: "600", color: active ? t.color.accent : t.color.fg }}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/**
 * AI Router's button: 44 px tall, 15 px words. Ghost is a text link in the
 * accent colour, for secondary actions beside a filled one.
 */
export function Button({
  label,
  onPress,
  variant = "secondary",
  disabled,
  loading,
  grow,
  icon: name,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  grow?: boolean;
  /** A Lucide icon before the label, when the app draws icons. */
  icon?: string;
}) {
  const t = useTokens();
  const off = Boolean(disabled) || Boolean(loading);
  const ghost = variant === "ghost";
  const palette = {
    primary: { bg: t.color.accent, border: t.color.accent, fg: t.color.accentFg },
    secondary: { bg: t.color.surface2, border: t.color.border, fg: t.color.fg },
    ghost: { bg: "transparent", border: "transparent", fg: t.color.accent },
    danger: { bg: t.color.dangerWash, border: t.color.dangerLine, fg: t.color.danger },
  }[variant];
  const fg = off ? t.color.disabled : palette.fg;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off, busy: Boolean(loading) }}
      onPress={onPress}
      disabled={off}
      hitSlop={t.control.hit}
      style={({ pressed }) => ({
        flexGrow: grow ? 1 : 0,
        minHeight: ghost ? 36 : t.control.button,
        paddingHorizontal: ghost ? 6 : 14,
        borderRadius: t.radius.md,
        borderWidth: ghost ? 0 : 1,
        borderColor: off && !ghost ? t.color.borderSubtle : palette.border,
        backgroundColor: off && variant === "primary" ? alpha(t.color.accent, 0.25) : palette.bg,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        gap: 8,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      {loading ? <ActivityIndicator size="small" color={fg} /> : name && HostIcon ? <HostIcon name={name} size={16} color={fg} /> : null}
      <Text style={{ ...TYPE.body, fontWeight: "600", color: fg }}>{label}</Text>
    </Pressable>
  );
}

/** An on/off switch with its state in a word as well as a position, so colour is never the only channel. */
export function Toggle({
  value,
  onChange,
  disabled,
  loading,
  label,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  loading?: boolean;
  label: string;
}) {
  const t = useTokens();
  const off = Boolean(disabled) || Boolean(loading);
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: off, busy: Boolean(loading) }}
      // react-native-web maps accessibilityState.checked inconsistently across versions; say it plainly too.
      {...({ "aria-checked": value } as object)}
      disabled={off}
      hitSlop={t.control.hit}
      onPress={() => onChange(!value)}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: t.control.min, opacity: off ? 0.6 : 1 }}
    >
      <View
        style={{
          width: 44,
          height: 26,
          borderRadius: 13,
          padding: 2,
          borderWidth: 1,
          borderColor: value ? t.color.accent : t.color.border,
          backgroundColor: value ? t.color.accent : t.color.surface2,
          justifyContent: "center",
        }}
      >
        <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: value ? t.color.accentFg : t.color.muted, alignSelf: value ? "flex-end" : "flex-start" }} />
      </View>
      {loading ? (
        <ActivityIndicator size="small" color={t.color.muted} />
      ) : (
        <Text style={{ ...TYPE.secondary, fontWeight: "600", color: value ? t.color.fg : t.color.muted }}>{value ? "On" : "Off"}</Text>
      )}
    </Pressable>
  );
}

/** A destructive action asks once, in place, rather than through a dialog. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  variant = "danger",
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  variant?: ButtonVariant;
}) {
  const t = useTokens();
  const [armed, setArmed] = useState(false);
  if (!armed) return <Button label={label} variant={variant} onPress={() => setArmed(true)} />;
  return (
    <View style={{ flexDirection: "row", gap: t.space.sm }}>
      <Button
        label={confirmLabel}
        variant="danger"
        onPress={() => {
          setArmed(false);
          onConfirm();
        }}
      />
      <Button label="Cancel" variant="ghost" onPress={() => setArmed(false)} />
    </View>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  value: T;
  onChange: (value: T) => void;
}) {
  const t = useTokens();
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: t.color.surface2,
        borderRadius: t.radius.md,
        padding: 3,
        alignSelf: "flex-start",
      }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active, disabled: Boolean(option.disabled) }}
            disabled={option.disabled}
            onPress={() => onChange(option.value)}
            hitSlop={t.control.hit}
            style={{
              paddingHorizontal: 14,
              minHeight: t.control.min,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: t.radius.md - 2,
              backgroundColor: active ? t.color.surface0 : "transparent",
            }}
          >
            <Text style={{ ...TYPE.secondary, fontWeight: "600", color: option.disabled ? t.color.disabled : active ? t.color.fg : t.color.muted }}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const inputStyle = (t: Tokens, mono: boolean | undefined) =>
  ({
    borderWidth: 1,
    borderColor: t.color.border,
    borderRadius: t.radius.md,
    backgroundColor: t.color.surface0,
    paddingVertical: 10,
    paddingHorizontal: 12,
    color: t.color.fg,
    ...(mono ? { fontFamily: t.compact ? "monospace" : "Menlo", fontSize: TYPE.mono.fontSize } : { fontSize: TYPE.body.fontSize }),
  }) as const;

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  multiline,
  mono,
  minHeight,
  autoFocus,
  hint,
}: {
  label?: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  mono?: boolean;
  minHeight?: number;
  autoFocus?: boolean;
  hint?: string;
}) {
  const t = useTokens();
  return (
    <View style={{ gap: 6 }}>
      {label ? <Text style={t.text.label}>{label}</Text> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={t.color.placeholder}
        accessibilityLabel={label ?? placeholder}
        multiline={multiline}
        autoFocus={autoFocus}
        autoCorrect={false}
        autoCapitalize="none"
        spellCheck={false}
        style={{ ...inputStyle(t, mono), minHeight: minHeight ?? (multiline ? 120 : t.control.min), textAlignVertical: multiline ? "top" : "center" }}
      />
      {hint ? <Text style={t.text.caption}>{hint}</Text> : null}
    </View>
  );
}

export function ComboBox({
  label,
  value,
  onChange,
  options,
  placeholder,
  hint,
  allowCustom = true,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string; description?: string; disabled?: boolean }>;
  placeholder?: string;
  hint?: string;
  allowCustom?: boolean;
}) {
  const t = useTokens();
  const [open, setOpen] = useState(false);
  const known = options.some((option) => option.value === value);
  const query = known ? "" : value.trim().toLowerCase();
  const matches = options
    .filter((option) => !query || option.value.toLowerCase().includes(query) || option.label.toLowerCase().includes(query))
    .slice(0, 12);
  return (
    <View style={{ gap: 6 }}>
      <Text style={t.text.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={(next) => {
          onChange(next);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => globalThis.setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        placeholderTextColor={t.color.placeholder}
        accessibilityLabel={label}
        autoCorrect={false}
        autoCapitalize="none"
        spellCheck={false}
        style={{ ...inputStyle(t, true), borderColor: !allowCustom && value && !known ? t.color.danger : t.color.border, minHeight: t.control.min }}
      />
      {open && matches.length > 0 ? (
        <View style={{ backgroundColor: t.color.surface2, borderRadius: t.radius.md, overflow: "hidden" }}>
          {matches.map((option, index) => (
            <Pressable
              key={option.value}
              disabled={option.disabled}
              onPress={() => {
                onChange(option.value);
                setOpen(false);
              }}
              style={({ pressed }) => ({
                paddingVertical: 10,
                paddingHorizontal: 12,
                borderTopWidth: index === 0 ? 0 : 1,
                borderTopColor: t.color.borderSubtle,
                backgroundColor: pressed ? t.color.accentWash : option.value === value ? t.color.surface0 : "transparent",
                opacity: option.disabled ? 0.45 : 1,
              })}
            >
              <Text style={t.text.bodyStrong}>{option.label}</Text>
              <Text style={t.text.caption}>{option.description ? `${option.value} · ${option.description}` : option.value}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {!allowCustom && value && !known ? <Text style={[t.text.caption, { color: t.color.danger }]}>Choose a listed value.</Text> : hint ? <Text style={t.text.caption}>{hint}</Text> : null}
    </View>
  );
}

/**
 * No RPC copies arbitrary text, so this goes through the host's clipboard —
 * which a host is free not to have. The caller says so rather than pretending
 * the copy happened; the text stays selectable either way.
 */
export function copyToClipboard(text: string): boolean {
  try {
    Clipboard.setString(text);
    return true;
  } catch {
    return false;
  }
}

export function CodeBlock({ children, tone, copy = true }: { children: string; tone?: Status; copy?: boolean }) {
  const t = useTokens();
  const [copied, setCopied] = useState(false);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: t.space.sm,
        backgroundColor: t.color.surface0,
        borderWidth: 1,
        borderColor: t.color.border,
        borderRadius: t.radius.md,
        borderLeftWidth: tone ? 3 : 1,
        borderLeftColor: tone ? statusColor(t, tone) : t.color.border,
        padding: 12,
      }}
    >
      <Text selectable style={[t.text.mono, { flex: 1, minWidth: 0 }]}>
        {children}
      </Text>
      {copy ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copied ? "Copied to clipboard" : "Copy to clipboard"}
          hitSlop={t.control.hit}
          onPress={() => {
            if (!copyToClipboard(children)) return;
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          <Text style={{ ...TYPE.secondary, fontWeight: "600", color: copied ? t.color.success : t.color.accent }}>{copied ? "Copied" : "Copy"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A message on a soft fill of its tone, with the tone's icon; neutral uses the accent. */
export function Notice({
  tone = "neutral",
  children,
  onDismiss,
}: {
  tone?: Status;
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  const t = useTokens();
  const color = inkOf(t, tone);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        backgroundColor: alpha(color, 0.08),
        borderRadius: 12,
        borderWidth: 1,
        borderColor: alpha(color, 0.3),
        borderLeftWidth: 4,
        borderLeftColor: color,
        padding: 14,
      }}
    >
      {HostIcon ? (
        <View style={{ paddingTop: 2 }}>
          <HostIcon name={TONE_ICON[tone]} size={18} color={color} />
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        {typeof children === "string" ? <Text style={t.text.body}>{children}</Text> : children}
      </View>
      {onDismiss ? <Button label="Dismiss" variant="ghost" onPress={onDismiss} /> : null}
    </View>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  const t = useTokens();
  return (
    <View style={{ padding: t.space.section, gap: t.space.sm, alignItems: "flex-start" }}>
      <Text style={t.text.heading}>{title}</Text>
      <Text style={[t.text.body, { maxWidth: 560 }]}>{body}</Text>
      {action ? <View style={{ paddingTop: t.space.sm }}>{action}</View> : null}
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm, padding: t.space.row }}>
      <ActivityIndicator size="small" color={t.color.accent} />
      {label ? <Text style={t.text.caption}>{label}</Text> : null}
    </View>
  );
}

export function ErrorText({ children }: { children: string }) {
  const t = useTokens();
  return <Text style={[t.text.body, { color: t.color.danger }]}>{children}</Text>;
}

/**
 * A refresh failed but an earlier answer is on screen: say so above it, with
 * the time that answer was read and why the new one failed, instead of
 * replacing the content with an error.
 */
export function StaleNote({ what, at, reason, onRetry }: { what: string; at: string; reason: string; onRetry?: () => void }) {
  const t = useTokens();
  return (
    <Notice tone="attention">
      <View style={{ gap: t.space.xs }}>
        <Text style={t.text.bodyStrong}>{`Could not refresh ${what}. Showing what was read at ${at}.`}</Text>
        <Text style={t.text.body}>{reason}</Text>
        {onRetry ? (
          <View style={{ flexDirection: "row" }}>
            <Button label="Try again" variant="ghost" onPress={onRetry} />
          </View>
        ) : null}
      </View>
    </Notice>
  );
}

/**
 * A "Learn more" style toggle: a chevron and a label; the children show while
 * it is open. `quiet` draws it small and muted, for extras such as "What you
 * can do here" that should not compete with the page (the calm standard §3).
 * `flush` drops the indent, for a whole card folded behind it.
 */
export function Disclosure({
  title,
  openTitle,
  children,
  open: initial = false,
  quiet,
  flush,
}: {
  title: string;
  openTitle?: string;
  children: React.ReactNode;
  open?: boolean;
  quiet?: boolean;
  flush?: boolean;
}) {
  const t = useTokens();
  const [open, setOpen] = useState(initial);
  const shown = open && openTitle ? openTitle : title;
  const color = quiet ? t.color.muted : t.color.accent;
  return (
    <View style={{ gap: quiet ? SPACE.sm : SPACE.row }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={shown}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        hitSlop={t.control.hit}
        style={{ flexDirection: "row", alignItems: "center", gap: SPACE.xs, minHeight: quiet ? 28 : 36, alignSelf: "flex-start" }}
      >
        {HostIcon ? (
          <HostIcon name={open ? "ChevronDown" : "ChevronRight"} size={quiet ? 14 : 16} color={color} />
        ) : (
          <Text style={{ ...(quiet ? TYPE.secondary : TYPE.body), color }}>{open ? "▾" : "▸"}</Text>
        )}
        <Text style={{ ...(quiet ? TYPE.secondary : TYPE.body), fontWeight: "600", color, flexShrink: 1 }}>{shown}</Text>
      </Pressable>
      {open ? <View style={{ gap: SPACE.sm, paddingLeft: flush || quiet ? 0 : SPACE.md }}>{children}</View> : null}
    </View>
  );
}

/** A heading inside a card, for one part of a longer explanation. */
export function SectionTitle({ icon: name, children }: { icon?: string; children: React.ReactNode }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
      {name && HostIcon ? <HostIcon name={name} size={18} color={t.color.accent} /> : null}
      <Text accessibilityRole="header" style={t.text.heading}>{children}</Text>
    </View>
  );
}

/**
 * One muted line with an icon and optional links, outside any card: for
 * things worth knowing but not worth a box (a sister plugin, where a
 * setting lives).
 */
export function QuietLine({ icon: name, children, links }: { icon?: string; children: React.ReactNode; links?: ReadonlyArray<{ label: string; onPress: () => void; accessibilityLabel?: string }> }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: SPACE.sm }}>
      {name && HostIcon ? (
        <View style={{ paddingTop: SPACE.hair }}>
          <HostIcon name={name} size={16} color={t.color.muted} />
        </View>
      ) : null}
      <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: SPACE.row, rowGap: SPACE.xs }}>
        {typeof children === "string" ? <Text style={[t.text.caption, { flexShrink: 1 }]}>{children}</Text> : children}
        {(links ?? []).map((link) => (
          <Pressable key={link.label} accessibilityRole="link" accessibilityLabel={link.accessibilityLabel ?? link.label} hitSlop={t.control.hit} onPress={link.onPress}>
            <Text style={{ ...TYPE.secondary, fontWeight: "600", color: t.color.accent }}>{link.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** "3 of 7 destinations" as a bar plus its number — never a bare bar. */
export function Coverage({ present, total, label }: { present: number; total: number; label?: string }) {
  const t = useTokens();
  const fraction = total > 0 ? present / total : 0;
  const status: Status = fraction === 1 ? "ok" : fraction === 0 ? "neutral" : "attention";
  return (
    <View style={{ gap: 4, minWidth: 120, flexGrow: 1 }}>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: alpha(t.color.muted, 0.2), overflow: "hidden" }}>
        <View style={{ width: `${Math.round(fraction * 100)}%`, height: "100%", backgroundColor: statusColor(t, status) }} />
      </View>
      <Text style={t.text.caption}>{label ?? `${present} of ${total}`}</Text>
    </View>
  );
}

export function Meter({ fraction, label, tone = "neutral" }: { fraction: number; label: string; tone?: Status }) {
  const t = useTokens();
  const value = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return (
    <View style={{ gap: 4, flexGrow: 1, minWidth: 120 }}>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: alpha(t.color.muted, 0.2), overflow: "hidden" }}>
        <View style={{ width: `${Math.round(value * 100)}%`, height: "100%", backgroundColor: statusColor(t, tone) }} />
      </View>
      <Text style={t.text.caption}>{label}</Text>
    </View>
  );
}

export function Spark({ values, tone = "neutral" }: { values: number[]; tone?: Status }) {
  const t = useTokens();
  const max = Math.max(1, ...values);
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 2, height: 16 }}>
      {values.map((value, index) => (
        <View
          key={index}
          style={{
            width: 5,
            height: Math.max(2, Math.round((value / max) * 16)),
            borderRadius: 1,
            backgroundColor: value > 0 ? statusColor(t, tone) : alpha(t.color.muted, 0.25),
          }}
        />
      ))}
    </View>
  );
}

/**
 * The preview stage: a rendered artifact, sized from its own aspect ratio and
 * whatever width the pane happens to have.
 */
export function Figure({
  uri,
  width,
  height,
  label,
  loading,
  note,
  placeholder,
}: {
  uri?: string;
  width?: number;
  height?: number;
  label: string;
  loading?: boolean;
  note?: string;
  placeholder?: React.ReactNode;
}) {
  const t = useTokens();
  const [stage, setStage] = useState(0);
  const aspect = width && height && width > 0 ? height / width : 0.62;
  const drawWidth = stage > 0 ? stage : 320;
  return (
    <View style={{ gap: t.space.sm }} onLayout={(event) => setStage(event.nativeEvent.layout.width)}>
      <View
        style={{
          borderRadius: t.radius.md,
          borderWidth: 1,
          borderColor: t.color.borderSubtle,
          backgroundColor: t.color.surface1,
          overflow: "hidden",
          minHeight: 160,
          justifyContent: "center",
        }}
      >
        {uri ? (
          <Image
            accessibilityLabel={label}
            source={{ uri }}
            resizeMode="contain"
            style={{ width: drawWidth, height: Math.max(160, Math.round(drawWidth * aspect)) }}
          />
        ) : loading ? (
          <Loading label="Rendering…" />
        ) : (
          placeholder ?? null
        )}
      </View>
      {note ? <Text style={t.text.caption}>{note}</Text> : null}
    </View>
  );
}

/** List beside detail on a wide screen; one at a time on a phone. */
export function SplitView({
  list,
  detail,
  showDetail,
  listWidth = 320,
}: {
  list: React.ReactNode;
  detail: React.ReactNode;
  showDetail: boolean;
  listWidth?: number;
}) {
  const t = useTokens();
  if (t.compact) return <View style={{ flex: 1 }}>{showDetail ? detail : list}</View>;
  return (
    <View style={{ flexDirection: "row", gap: SPACE.md, alignItems: "flex-start" }}>
      {/* ponytail: fixed cap — a long list must not scroll the detail away;
          go viewport-relative via useWindowDimensions if 640 ever feels wrong */}
      <ScrollView style={{ width: listWidth, flexShrink: 0, maxHeight: 640 }}>{list}</ScrollView>
      <View style={{ flex: 1, minWidth: 0 }}>{detail}</View>
    </View>
  );
}
