import { useSyncExternalStore } from "react";

/**
 * Which server's sign-in an agent's MCP panel should lead with. The in-chat
 * card sets it and opens the panel; the panel shows that server's sign-in rows
 * first and clears it on Dismiss. Client memory only.
 */
const focus = new Map<string, string>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function setSignInFocus(agentId: string, server: string | null): void {
  if (server) focus.set(agentId, server);
  else focus.delete(agentId);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSignInFocus(agentId: string | undefined): string | null {
  return useSyncExternalStore(
    subscribe,
    () => (agentId ? focus.get(agentId) ?? null : null),
    () => null,
  );
}
