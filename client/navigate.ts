/**
 * Panels get no `openSurface`; only the client entry and command-center items
 * do. The entry registers its opener here once, so a problem row inside a
 * workspace or agent panel can still jump straight to the management page,
 * and can say which server it meant.
 */

let opener: ((id: string) => void) | null = null;
let pendingServer: string | null = null;

export function registerSurfaceOpener(open: ((id: string) => void) | null): void {
  opener = open;
}

/** True when a panel can open the MCP surface on this host. */
export function canOpenMcp(): boolean {
  return opener !== null;
}

/** Opens MCP management; with a name, the surface lands on that server. */
export function openMcp(server: string | null = null): void {
  pendingServer = server;
  opener?.("mcp");
}

/** The server a just-opened surface was asked to show, consumed on read. */
export function takePendingServer(): string | null {
  const server = pendingServer;
  pendingServer = null;
  return server;
}

/**
 * 0.19.2: on Paseo 0.11 the page keeps its tab in the screen's params, so the
 * window title follows it ("Connectors · Help"). The entry registers how; an
 * older app has none and the title stays "Connectors".
 */
let tabSync: ((tab: "overview" | "servers" | "projects" | "guide") => void) | null = null;

export function registerTabSync(sync: typeof tabSync): void {
  tabSync = sync;
}

export function syncTab(tab: "overview" | "servers" | "projects" | "guide"): void {
  tabSync?.(tab);
}

export function canSyncTab(): boolean {
  return tabSync !== null;
}
