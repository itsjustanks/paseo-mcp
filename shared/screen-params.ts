/**
 * What the MCP screen can be opened with (Paseo 0.11 screen params, 0.18.3).
 * `add`: open on Add a server. `at` makes each press new, so pressing "+"
 * again while the page is open opens the gallery again.
 */
export const ADD_SERVER_PARAM = "add";

export function addServerParams(at: number = Date.now()): Record<string, string> {
  return { [ADD_SERVER_PARAM]: "server", at: String(at) };
}

/** The press to act on, from the params a screen was opened with: its `at` when it asks for Add a server, else null. */
export function addServerRequest(params: Record<string, string> | undefined | null): string | null {
  return params?.[ADD_SERVER_PARAM] === "server" ? (params.at ?? "1") : null;
}

/**
 * 0.19.1: `check=now` opens the screen and checks every connector again, from
 * the "Check connectors" command. `at` makes each press new, like Add.
 */
export const CHECK_PARAM = "check";

export function checkNowParams(at: number = Date.now()): Record<string, string> {
  return { [CHECK_PARAM]: "now", at: String(at) };
}

/** The press to act on when the screen was opened to check now, else null. */
export function checkNowRequest(params: Record<string, string> | undefined | null): string | null {
  return params?.[CHECK_PARAM] === "now" ? (params.at ?? "1") : null;
}

/**
 * 0.19.2: `tab` keeps the screen's tab in its params, so Paseo's window title
 * says where you are ("Connectors · Help"). `filter` opens Connectors on one
 * filter (the sidebar dot's popover: "Show them").
 */
export const TAB_PARAM = "tab";
export const FILTER_PARAM = "filter";
const FILTERS = ["all", "issues", "sign-in", "gaps"] as const;
export type ScreenFilter = (typeof FILTERS)[number];

export function filterParams(filter: ScreenFilter, at: number = Date.now()): Record<string, string> {
  return { [TAB_PARAM]: "servers", [FILTER_PARAM]: filter, at: String(at) };
}

/** The filter a screen was opened with, and its press, else null. */
export function filterRequest(params: Record<string, string> | undefined | null): { filter: ScreenFilter; at: string } | null {
  const filter = params?.[FILTER_PARAM];
  return filter && (FILTERS as readonly string[]).includes(filter) ? { filter: filter as ScreenFilter, at: params?.at ?? "1" } : null;
}

const TABS = ["overview", "servers", "projects", "guide"] as const;
export type ScreenTab = (typeof TABS)[number];

/** The tab in a screen's params, or null for none (Overview). */
export function tabFromParams(params: Record<string, string> | undefined | null): ScreenTab | null {
  const tab = params?.[TAB_PARAM];
  return tab && (TABS as readonly string[]).includes(tab) ? (tab as ScreenTab) : null;
}

/** Paseo's window title for the screen: "Connectors", or "Connectors · Help" on a tab. */
export function screenTitle(name: string, labels: Readonly<Record<ScreenTab, string>>, params: Record<string, string> | undefined | null): string {
  if (addServerRequest(params)) return `${name} · Add a connector`;
  const tab = tabFromParams(params) ?? (filterRequest(params) ? "servers" : null);
  return !tab || tab === "overview" ? name : `${name} · ${labels[tab]}`;
}
