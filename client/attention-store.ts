/**
 * What the chip registry last decided (0.19.1), for the sidebar row's dot and
 * the old-shape chip component. They read this instead of asking the host
 * themselves, so the dot costs no extra reads.
 */
import { useSyncExternalStore } from "react";
import type { AttentionState, ChipFace } from "../shared/chips";

const EMPTY: AttentionState = { host: null, faces: new Map() };
let state: AttentionState = EMPTY;
const listeners = new Set<() => void>();

export function publishAttention(next: AttentionState): void {
  state = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Anything on this computer that needs the user: "failing", "sign-in", or null. */
export function useHostAttention(): AttentionState["host"] {
  return useSyncExternalStore(subscribe, () => state.host, () => null);
}

const NO_NAMES = { failing: [] as string[], signIn: [] as string[] };

/** The connectors behind the sidebar dot: broken ones and ones that need sign-in. */
export function useHostAttentionNames(): NonNullable<AttentionState["names"]> {
  return useSyncExternalStore(subscribe, () => state.names ?? NO_NAMES, () => NO_NAMES);
}

/** This agent's chip face, or null when its chat is calm. */
export function useChipFace(agentId: string): ChipFace | null {
  return useSyncExternalStore(subscribe, () => state.faces.get(agentId) ?? null, () => null);
}
