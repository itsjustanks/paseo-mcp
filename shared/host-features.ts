/**
 * Newer Paseo features this plugin uses only where the app has them (0.17.0,
 * the shared design standard §5). The plugin builds against the 0.8 SDK and
 * still loads on 0.9.1, so each feature is detected at runtime, here, purely,
 * and the caller falls back to what it did before.
 */

type Fn = (...args: never[]) => unknown;
const isFn = (value: unknown): value is Fn => typeof value === "function";

/**
 * Paseo 0.11: a full screen plus a native sidebar row. All four parts must be
 * there (adding a screen, adding a sidebar row, opening a screen, and the
 * app's SidebarRow to draw it); otherwise the old surface and sidebar item.
 */
export function supportsNativeScreens(client: unknown, sidebarRow: unknown): boolean {
  const candidate = (client ?? {}) as Record<string, unknown>;
  return isFn(candidate.addScreen) && isFn(candidate.addSidebarHeaderItem) && isFn(candidate.openScreen) && Boolean(sidebarRow);
}

/** Paseo 0.10: `openExternalUrl` on the plugin client module, which opens the system browser. Null on older apps. */
export function externalUrlOpener(clientModule: unknown): ((url: string) => Promise<void>) | null {
  const candidate = (clientModule ?? {}) as { openExternalUrl?: unknown };
  return isFn(candidate.openExternalUrl) ? (candidate.openExternalUrl as (url: string) => Promise<void>) : null;
}

/**
 * Paseo 0.8.0 stable: composer chips are buttons ({ title, icon, label,
 * behavior }, returning { update, remove }). `addHeaderButton` shipped with
 * them; the 0.8.0-beta.1 SDK this plugin builds against has neither, and its
 * chip is a React component. True means use the button shape.
 */
export function supportsButtonPills(client: unknown): boolean {
  return isFn(((client ?? {}) as Record<string, unknown>).addHeaderButton);
}

/**
 * Paseo 0.9: `agents.subscribe()` only hears an observation the plugin opened
 * itself with `agents.list({ subscribe: {} })`; `observeEvents` shipped with
 * those observations (0.9.0-beta.1). On a 0.8 app the plugin must not send
 * `subscribe`: it would replace the app's own agent subscription. (The same
 * test as @gpambrozio/paseo-skills' `canObserveAgents`.)
 */
export function canObserveAgents(paseo: unknown): boolean {
  return isFn(((paseo ?? {}) as Record<string, unknown>).observeEvents);
}

/**
 * Paseo 0.9 and later: `copyText` on the client/react-native module, the
 * app's own clipboard, in the browser and the mobile app alike (0.20.0). An
 * app without it uses `fallback` (React Native's deprecated Clipboard). A
 * rejected or `false` copy is a failed copy: resolves false, and the caller
 * says "Couldn't copy".
 */
export function clipboardCopier(rnModule: unknown, fallback: (text: string) => unknown): (text: string) => Promise<boolean> {
  const candidate = (rnModule ?? {}) as { copyText?: unknown };
  const copyText = isFn(candidate.copyText) ? (candidate.copyText as (text: string) => Promise<void>) : null;
  return async (text) => {
    try {
      if (copyText) {
        await copyText(text);
        return true;
      }
      return fallback(text) !== false;
    } catch {
      return false;
    }
  };
}

export type ToastVariant = "default" | "info" | "success" | "warning" | "error";
export type ToastApi = { show(message: string, options?: { variant?: ToastVariant; durationMs?: number }): void; error(message: string): void };

/**
 * The toast hook every screen uses (0.20.0): the app's `useToast` where it
 * has one, else `fallbackHook` (an inline message on the screen). Chosen once,
 * here, so a component never calls a hook conditionally. Every message goes
 * through `redact` first, whichever way it is shown.
 */
export function toastHook(rnModule: unknown, fallbackHook: () => ToastApi, redact: (text: string) => string): () => ToastApi {
  const candidate = (rnModule ?? {}) as { useToast?: unknown };
  const useBase = isFn(candidate.useToast) ? (candidate.useToast as () => ToastApi) : fallbackHook;
  return () => {
    const base = useBase();
    return {
      show: (message, options) => base.show(redact(message), options),
      error: (message) => base.error(redact(message)),
    };
  };
}

/** The app's `Modal` (Paseo 0.8+), or null: then a confirm stays in the page, as before 0.20.0. */
export function hostModal<T>(rnModule: unknown): T | null {
  const candidate = (rnModule ?? {}) as { Modal?: unknown };
  return isFn(candidate.Modal) || (candidate.Modal !== null && typeof candidate.Modal === "object") ? (candidate.Modal as T) : null;
}

export type InlineMessage = { id: number; message: string; variant: ToastVariant };

/**
 * Where toasts go on an app without `useToast`: the latest few messages,
 * each dropped after its time. The screen shows them as inline lines.
 */
export function createMessageStore(schedule: (run: () => void, ms: number) => unknown = setTimeout, keep = 3) {
  let messages: InlineMessage[] = [];
  let next = 1;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    push(message: string, variant: ToastVariant = "default", durationMs = 5000) {
      const id = next++;
      messages = [...messages, { id, message, variant }].slice(-keep);
      emit();
      schedule(() => {
        messages = messages.filter((entry) => entry.id !== id);
        emit();
      }, durationMs);
    },
    read: () => messages,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
