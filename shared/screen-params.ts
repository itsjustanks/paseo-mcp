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
