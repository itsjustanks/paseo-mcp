/**
 * One opening of the Remove confirm (0.20.0). The dialog makes a new session
 * each time it opens and drops it on close, so nothing it chose (the app
 * picked under "From one app") survives a Cancel. Confirm is single-use: the
 * guard is a plain flag checked and set synchronously, so a double press
 * removes once; only a new opening re-arms it.
 */
import type { Destination, McpServerRow } from "./contracts";
import { removePlan, type ProjectFile, type RemovePlan, type RemoveScope } from "./servers";

export type RemoveSession = {
  readonly scope: RemoveScope;
  /** The app picked for scope `one` when the connector is in several. */
  destId(): string;
  select(destId: string): void;
  plan(): RemovePlan | null;
  /** True when this press removed; false when nothing to remove or already pressed. */
  confirm(): boolean;
};

export function openRemoveSession(input: {
  server: Pick<McpServerRow, "name" | "presentIn" | "inlineCredentialsIn" | "localIn">;
  destinations: readonly Destination[];
  projectFiles: readonly ProjectFile[];
  scope: RemoveScope;
  destId?: string;
  onRemove: (plan: RemovePlan) => void;
}): RemoveSession {
  const present = input.destinations.filter((dest) => input.server.presentIn.includes(dest.id));
  let destId = input.destId && present.some((dest) => dest.id === input.destId) ? input.destId : (present[0]?.id ?? "");
  let used = false;
  const plan = () => removePlan(input.server, input.destinations, input.scope, destId, input.projectFiles);
  return {
    scope: input.scope,
    destId: () => destId,
    select(next) {
      if (present.some((dest) => dest.id === next)) destId = next;
    },
    plan,
    confirm() {
      const current = plan();
      if (used || !current) return false;
      used = true;
      input.onRemove(current);
      return true;
    },
  };
}
