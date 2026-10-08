import * as pluginClient from "@getpaseo/plugin/client";
import { Linking } from "react-native";
import { externalUrlOpener } from "../shared/host-features";
import { copyToClipboard, useToast } from "./ui";

/**
 * Paseo 0.10 and later hand plugins `openExternalUrl`, which opens the
 * system browser (the 0.8 SDK types don't declare it, so it is looked up at
 * runtime, the same as AI Router). Older apps fall back to `Linking.openURL`,
 * and when neither opens, the address goes to the clipboard so it can be
 * pasted. Call it straight from a press, so a browser allows the new tab.
 */
const openExternalUrl = externalUrlOpener(pluginClient);

export async function openLink(url: string): Promise<"opened" | "copied" | "failed"> {
  try {
    if (openExternalUrl) await openExternalUrl(url);
    else await Linking.openURL(url);
    return "opened";
  } catch {
    return (await copyToClipboard(url)) ? "copied" : "failed";
  }
}

/** The line to show when a link did not open: copied for pasting, or the address itself. */
export function linkFallbackText(result: "opened" | "copied" | "failed", url: string): string | null {
  if (result === "copied") return `Couldn't open a browser, so the link was copied: ${url}`;
  if (result === "failed") return `Couldn't open a browser. The address is ${url}`;
  return null;
}

/** `open(url)` for a press handler: opens the link, and says so in a toast when it couldn't. */
export function useOpenLink(): (url: string) => void {
  const toast = useToast();
  return (url) => {
    void openLink(url).then((result) => {
      const line = linkFallbackText(result, url);
      if (line) toast.show(line, { variant: "warning" });
    });
  };
}
