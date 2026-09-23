import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import React, { useState } from "react";
import { Linking, Text, View } from "react-native";
import { mcpSiblings } from "../shared/contracts";
import { promoSettings } from "../shared/settings";
import { AI_ROUTER } from "../shared/siblings";
import { Button, Card, Tag, copyToClipboard, useTokens } from "./ui";

export const SIBLINGS_QUERY_KEY = ["paseo-mcp", "siblings"] as const;

/**
 * "Check out AI Router" at the bottom of the Overview: one line, a link to the
 * plugin, and its install source, or an Installed badge when this daemon
 * already has it. Hide is stored in the plugin's host settings (promo.json).
 * The installed check is asked once per app session, not on a timer: the
 * answer only changes when someone installs a plugin.
 */
export function AiRouterCard() {
  const t = useTokens();
  const toast = useToast();
  const settings = useSettings(promoSettings);
  const callSiblings = useRpc(mcpSiblings);
  const [dismissed, setDismissed] = useState(false);
  const hidden = dismissed || (settings.status === "ready" && settings.values.hideAiRouter);
  const siblings = useQuery({
    queryKey: SIBLINGS_QUERY_KEY,
    queryFn: () => callSiblings({}),
    enabled: settings.status === "ready" && !hidden,
    staleTime: Infinity,
    retry: false,
  });
  // Until the setting is read, nothing: a card that appears and then hides itself reads worse than one that appears late.
  if (settings.status !== "ready" || hidden) return null;
  const installed = siblings.data?.aiRouter.installed === true;

  const hide = () => {
    if (settings.status !== "ready") return;
    setDismissed(true);
    void settings.save({ ...settings.values, hideAiRouter: true }, settings.revision).then((saved) => {
      if (saved) return;
      setDismissed(false);
      toast.error("Could not save that. Try Hide again.");
    });
  };
  const open = () => {
    Linking.openURL(AI_ROUTER.repoUrl).catch(() => {
      const copied = copyToClipboard(AI_ROUTER.repoUrl);
      toast.show(copied ? `No browser here — copied ${AI_ROUTER.repoUrl}` : `No browser here — the plugin is at ${AI_ROUTER.repoUrl}`, { variant: "warning" });
    });
  };
  const copy = () =>
    copyToClipboard(AI_ROUTER.installSource)
      ? toast.show("AI Router install source copied.", { variant: "success" })
      : toast.show(`No clipboard here — the install source is ${AI_ROUTER.installSource}`, { variant: "warning" });

  return (
    <Card>
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
        <Text style={[t.text.heading, { flex: 1, minWidth: 0 }]}>{`Check out ${AI_ROUTER.name}`}</Text>
        <Button label="Hide" variant="ghost" onPress={hide} />
      </View>
      <Text style={[t.text.body, { color: t.color.muted, maxWidth: 680 }]}>{AI_ROUTER.pitch}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: t.space.sm }}>
        <Button label="View plugin" onPress={open} />
        {/* Nothing in this slot until the host has answered, so the button does not turn into a badge under the pointer. */}
        {siblings.isPending ? null : installed ? <Tag label="Installed" tone="ok" /> : <Button label="Copy install source" onPress={copy} />}
      </View>
    </Card>
  );
}
