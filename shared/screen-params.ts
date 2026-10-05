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
