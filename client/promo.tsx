import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import React, { useState } from "react";
import { Text, View } from "react-native";
import { mcpSiblings } from "../shared/contracts";
import { promoSettings } from "../shared/settings";
import { AI_ROUTER } from "../shared/siblings";
import { QuietLine, copyToClipboard, useTokens, useToast } from "./ui";
import { useOpenLink } from "./links";

export const SIBLINGS_QUERY_KEY = ["paseo-mcp", "siblings"] as const;

/**
 * "Check out AI Router" at the bottom of the Overview: one line, a link to the
 * plugin, and its install source. Nothing once this daemon has it (0.19.2),
 * and nothing when the check fails. Hide is stored in the plugin's host settings (promo.json).
 * The installed check is asked once per app session, not on a timer: the
 * answer only changes when someone installs a plugin.
 */
export function AiRouterCard() {
  const t = useTokens();
  const toast = useToast();
  const openLink = useOpenLink();
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
  // Until the setting and the installed check are read, nothing: a line that appears and then hides itself reads
  // worse than one that appears late. 0.19.2: none at all once AI Router is installed (the shared standard's cross-promo rule).
  if (settings.status !== "ready" || hidden || !siblings.data) return null;
  if (siblings.data.aiRouter.installed) return null;

  const hide = () => {
    if (settings.status !== "ready") return;
    setDismissed(true);
    void settings.save({ ...settings.values, hideAiRouter: true }, settings.revision).then((saved) => {
      if (saved) return;
      setDismissed(false);
      toast.error("Could not save that. Try Hide again.");
    });
  };
  const open = () => openLink(AI_ROUTER.repoUrl);
  const copy = () =>
    void copyToClipboard(AI_ROUTER.installSource).then((ok) =>
      ok
        ? toast.show("AI Router install source copied.", { variant: "success" })
        : toast.show(`Couldn't copy. The install source is ${AI_ROUTER.installSource}`, { variant: "warning" }),
    );

  // One quiet line, never a card (the calm standard). Nothing about installing until the host has answered.
  const links = [
    { label: "View plugin", onPress: open },
    { label: "Copy install source", onPress: copy },
    { label: "Hide", onPress: hide, accessibilityLabel: `Hide the ${AI_ROUTER.name} suggestion` },
  ];
  return (
    <QuietLine icon="Route" links={links}>
      {`Also try ${AI_ROUTER.name}: ${AI_ROUTER.short}`}
    </QuietLine>
  );
}
