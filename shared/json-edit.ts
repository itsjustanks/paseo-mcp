/**
 * The hand editor's JSON (0.20.0 review): a masked, read-only view until the
 * user presses "Reveal to edit", which loads the real definition into a
 * separate buffer. Save sends only that buffer; hiding, closing or leaving
 * drops it. The masked text is never an edit buffer, so it can't be saved.
 * Pure transitions, driven by the component's reducer and by the tests.
 */
export type JsonEditState =
  | { mode: "masked"; loading: boolean; error: string }
  | { mode: "raw"; buffer: string; baseline: string; version?: string };

export type JsonEditAction =
  | { type: "reveal-start" }
  | { type: "reveal-failed"; error: string }
  | { type: "revealed"; raw: string; version?: string }
  | { type: "edit"; text: string }
  | { type: "saved"; text: string }
  | { type: "revert" }
  | { type: "hide" };

export const JSON_EDIT_START: JsonEditState = { mode: "masked", loading: false, error: "" };

export function jsonEditReducer(state: JsonEditState, action: JsonEditAction): JsonEditState {
  switch (action.type) {
    case "reveal-start":
      return state.mode === "masked" ? { ...state, loading: true, error: "" } : state;
    case "reveal-failed":
      return state.mode === "masked" ? { mode: "masked", loading: false, error: action.error } : state;
    case "revealed":
      return state.mode === "masked" && state.loading ? { mode: "raw", buffer: action.raw, baseline: action.raw, ...(action.version ? { version: action.version } : {}) } : state;
    case "edit":
      return state.mode === "raw" ? { ...state, buffer: action.text } : state;
    case "saved":
      return state.mode === "raw" ? { ...state, baseline: action.text } : state;
    case "revert":
      return state.mode === "raw" ? { ...state, buffer: state.baseline } : state;
    case "hide":
      return JSON_EDIT_START;
  }
}

/** The only text Save may send: the revealed buffer, or nothing at all from the masked view. */
export function jsonToSave(state: JsonEditState): string | null {
  return state.mode === "raw" ? state.buffer : null;
}

export const jsonDirty = (state: JsonEditState): boolean => state.mode === "raw" && state.buffer !== state.baseline;

/** The connector's version at Reveal (0.20.0), sent with Save so a change since then is refused. */
export const jsonVersion = (state: JsonEditState): string | undefined => (state.mode === "raw" ? state.version : undefined);

/**
 * The same separation for the Fields form (0.20.0 review): masked and
 * read-only until "Reveal to edit" loads the real values into their own
 * buffer; Hide drops it, and a reveal that lands after Hide is ignored.
 */
export type RevealState<T> = { mode: "masked"; loading: boolean; error: string } | { mode: "raw"; value: T };
export type RevealAction<T> = { type: "reveal-start" } | { type: "reveal-failed"; error: string } | { type: "revealed"; value: T } | { type: "hide" };

export const REVEAL_START = { mode: "masked", loading: false, error: "" } as const;

export function revealReducer<T>(state: RevealState<T>, action: RevealAction<T>): RevealState<T> {
  switch (action.type) {
    case "reveal-start":
      return state.mode === "masked" ? { ...state, loading: true, error: "" } : state;
    case "reveal-failed":
      return state.mode === "masked" ? { mode: "masked", loading: false, error: action.error } : state;
    case "revealed":
      return state.mode === "masked" && state.loading ? { mode: "raw", value: action.value } : state;
    case "hide":
      return REVEAL_START;
  }
}

/** The values the form may save: only revealed ones. */
export function revealedValue<T>(state: RevealState<T>): T | null {
  return state.mode === "raw" ? state.value : null;
}
