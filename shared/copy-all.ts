/**
 * "Copy to all my AI apps" (0.15.0): every user-level server into every AI app
 * and account on this host that doesn't have it yet, through the same write
 * path as a server's "Add to missing". Nothing is removed, nothing is
 * overwritten. The host works the plan out and carries it out
 * (server/copy-all.ts); the words and the pure checks are here.
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { Destination } from "./contracts";
import { PASEO_SERVER_NAME } from "./paseo-tools";
import { providerName } from "./servers";

export const COPY_ALL_LABEL = "Copy to all my AI apps";

export const COPY_ALL_EXPLAINER =
  "Add a server once, and this copies it to every AI app and account on this computer that doesn't have it yet. Nothing is removed or replaced. A server that only one app understands is left for you to copy by hand. Sign-ins aren't copied: each app signs in on its own.";

const PlaceSchema = z.object({ id: z.string(), label: z.string() });

export const CopyPlanServerSchema = z.object({
  name: z.string(),
  /** The app and account whose copy is used, in plain words. */
  from: z.string(),
  /** Every app and account that doesn't have it yet. */
  targets: z.array(PlaceSchema),
  /** The copy carries a saved key (a header, an env value, a key in the address or arguments). */
  savedKey: z.boolean(),
  /** Set when the apps that have it don't all have the same version. */
  note: z.string().optional(),
  /** Apps and accounts it can't be copied to exactly, each with why ("copy this one by hand: it uses a Codex-only setting"). */
  blocked: z.array(z.object({ label: z.string(), reason: z.string() })).optional(),
});
export type CopyPlanServer = z.output<typeof CopyPlanServerSchema>;

export const mcpCopyPlan = defineRpc({
  name: "paseo-mcp.copy-plan",
  input: z.object({}),
  output: z.object({
    servers: z.array(CopyPlanServerSchema),
    /** Left out on purpose, with why (Paseo's own server, one that can only be copied by hand). */
    excluded: z.array(z.object({ name: z.string(), reason: z.string() })),
  }),
});

export const CopyResultSchema = z.object({
  name: z.string(),
  from: z.string(),
  /** Where it was written and read back. */
  written: z.array(z.string()),
  /** Where it wasn't, and why. */
  skipped: z.array(z.object({ label: z.string(), reason: z.string() })),
});
export type CopyResult = z.output<typeof CopyResultSchema>;

export const mcpCopyAll = defineRpc({
  name: "paseo-mcp.copy-all",
  input: z.object({
    /** The servers ticked in the preview, each with the places it showed. */
    servers: z.array(z.object({ name: z.string().min(1), targets: z.array(z.string()) })),
  }),
  output: z.object({
    ok: z.boolean(),
    message: z.string(),
    results: z.array(CopyResultSchema),
  }),
});

/** "Codex (demo@example.com)", or "Kimi" for an app without accounts. */
export function placeLabel(dest: Pick<Destination, "provider" | "account">): string {
  const app = providerName(dest.provider);
  return dest.account ? `${app} (${dest.account})` : app;
}

/** Paseo's own server: never copied, the daemon adds it to agents itself. */
export function isPaseoOwnServer(name: string, def: { url?: string }): boolean {
  if (name === PASEO_SERVER_NAME) return true;
  if (!def.url) return false;
  try {
    return new URL(def.url).pathname === "/mcp/agents";
  } catch {
    return false;
  }
}

type Comparable = { url?: string; command?: string; args?: string[]; headers?: Record<string, string>; env?: Record<string, string> };

function sorted(record: Record<string, string> | undefined): string {
  return JSON.stringify(Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

/** Two definitions of one server are the same when the address or command, arguments, headers and env match; the file's own spelling (`type`, the header table's name) doesn't count. */
export function sameDefinition(a: Comparable | null | undefined, b: Comparable | null | undefined): boolean {
  if (!a || !b) return false;
  return (
    (a.url ?? "") === (b.url ?? "") &&
    (a.command ?? "") === (b.command ?? "") &&
    JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []) &&
    sorted(a.headers) === sorted(b.headers) &&
    sorted(a.env) === sorted(b.env)
  );
}

/** The line under the result: "Copied 3 servers to 5 places. 1 was skipped." */
export function copySummary(results: readonly CopyResult[]): string {
  const places = results.reduce((sum, entry) => sum + entry.written.length, 0);
  const copied = results.filter((entry) => entry.written.length > 0).length;
  const skipped = results.reduce((sum, entry) => sum + entry.skipped.length, 0);
  if (results.length === 0) return "Nothing to copy: every app already has every server.";
  const head = places > 0 ? `Copied ${copied} server${copied === 1 ? "" : "s"} to ${places} place${places === 1 ? "" : "s"}.` : "Nothing was copied.";
  return skipped > 0 ? `${head} ${skipped} ${skipped === 1 ? "was" : "were"} skipped; see why below.` : head;
}
