import {
  CatalogSetupSchema,
  ORG_PLACEHOLDERS,
  SETUP_CLIENT_LABELS,
  SETUP_REASON_MAX,
  SETUP_STEP_MAX,
  SETUP_STEPS_MAX,
  cleanText,
  cutText,
  hasEnvReference,
  hasUnwritableChar,
  looksLikeCredentialValue,
  placeholdersIn,
  registrableDomain,
  type CatalogEntry,
  type CatalogSetup,
  type SetupClient,
  type SetupKind,
} from "./catalog";

export { CatalogSetupSchema, ORG_PLACEHOLDERS, SETUP_CLIENTS, SETUP_CLIENT_LABELS, SETUP_KINDS, type CatalogSetup, type SetupClient, type SetupKind } from "./catalog";

/**
 * "Needs setup" (0.16.0): official servers that can't be added in one click.
 * An entry's `setup` says why, links the vendor's own guide, and for two kinds
 * lets the gallery finish the job:
 *
 *   - `byo-oauth`: the vendor only accepts a sign-in app the user registers
 *     (Google Workspace, HubSpot, Zoom). The user makes one, pastes its client
 *     ID and secret, and the plugin writes it the way each AI app takes it.
 *   - `per-org`: the address holds the user's own subdomain (Zendesk).
 *   - `approved-clients`: the vendor only lets its approved AI apps sign in.
 *     With `clients`, those of the approved apps the plugin can write to.
 *   - `admin`: an administrator has to turn it on first.
 *
 * Everything here is pure. `setup` comes from a library like any other text:
 * cleaned, capped, links https only, and a template's host can't be moved.
 */


// ------------------------------------------------------------------ vendors

/**
 * The vendors whose own sign-in app the gallery may ask for, by the exact
 * hosts their MCP servers and guides are on. Shipped in the plugin and never
 * read from a library: Claude Code sends the client secret to whichever
 * sign-in server the MCP server names, so a library entry called "Gmail" at
 * any other address would collect a real secret. A new vendor takes a
 * release. The Google pattern is one label ending in `mcp` (gmailmcp,
 * calendarmcp…); storage.googleapis.com and bucket hosts don't match.
 */
export const BYO_OAUTH_VENDORS: ReadonlyArray<{ vendor: string; server: RegExp; links: readonly string[]; idName?: string }> = [
  {
    vendor: "Google",
    server: /^[a-z0-9-]+mcp\.googleapis\.com$/,
    links: ["developers.google.com", "console.cloud.google.com", "cloud.google.com", "workspace.google.com", "support.google.com"],
  },
  { vendor: "HubSpot", server: /^mcp\.hubspot\.com$/, links: ["developers.hubspot.com", "knowledge.hubspot.com", "app.hubspot.com", "www.hubspot.com"] },
  { vendor: "Zoom", server: /^mcp\.zoom\.us$/, links: ["developers.zoom.us", "marketplace.zoom.us", "support.zoom.com", "www.zoom.com"] },
  // 0.18.3: Meta Ads (mcp.facebook.com/ads). Meta calls the client ID the App ID, and its sign-in takes no secret.
  { vendor: "Meta", server: /^mcp\.facebook\.com$/, links: ["developers.facebook.com", "www.facebook.com", "business.facebook.com"], idName: "App ID" },
];

export type ByoVendor = (typeof BYO_OAUTH_VENDORS)[number];

function httpsHost(link: string): string {
  try {
    const url = new URL(link);
    return url.protocol === "https:" && !url.port && !url.username && !url.password ? url.hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}

/** The shipped vendor whose own MCP server this address is (https, default port), or null. */
export function byoVendor(url: string): ByoVendor | null {
  const host = httpsHost(url.trim());
  return host ? (BYO_OAUTH_VENDORS.find((vendor) => vendor.server.test(host)) ?? null) : null;
}

/** Whether a link is https on one of the vendor's own sites. */
export function vendorLink(vendor: ByoVendor, link: string): boolean {
  return vendor.links.includes(httpsHost(link));
}

// ------------------------------------------------------------------ parsing

/** An https address that may be shown and opened: parses, https, no user name, no control character. */
export function httpsLink(link: string): boolean {
  if (link.length > 2048 || hasUnwritableChar(link) || hasEnvReference(link)) return false;
  try {
    const url = new URL(link);
    return url.protocol === "https:" && !url.username && !url.password && url.hostname.includes(".");
  } catch {
    return false;
  }
}

const SCOPE_WORD = /^[A-Za-z0-9._:/+-]{1,200}$/;

/** A setup's shown text through cleanText and its caps; lists without empty lines. */
export function cleanSetup(setup: CatalogSetup): CatalogSetup {
  const line = (text: string | undefined, max: number) => cutText(cleanText(text ?? "").trim(), max);
  return {
    kind: setup.kind,
    reason: line(setup.reason, SETUP_REASON_MAX),
    guideUrl: setup.guideUrl.trim(),
    ...(setup.steps ? { steps: setup.steps.map((step) => line(step, SETUP_STEP_MAX)).filter(Boolean).slice(0, SETUP_STEPS_MAX) } : {}),
    ...(setup.redirectHint !== undefined ? { redirectHint: line(setup.redirectHint, 80) } : {}),
    ...(setup.clients ? { clients: [...new Set(setup.clients)] } : {}),
    ...(setup.scopes !== undefined ? { scopes: setup.scopes.trim().split(/\s+/).filter(Boolean).join(" ") } : {}),
    ...(setup.urlTemplate !== undefined ? { urlTemplate: setup.urlTemplate.trim() } : {}),
    ...(setup.label !== undefined ? { label: line(setup.label, 80) } : {}),
    ...(setup.secretless !== undefined ? { secretless: setup.secretless } : {}),
  };
}

/**
 * Everything wrong with a setup, for the entry whose address it describes
 * ([] when it's fine). The same rules for the shipped list, a team file and a
 * library: https guide only, plain one-line text, fields only where their
 * kind uses them, and a per-org template the value can't move off its host.
 */
export function setupProblems(setup: CatalogSetup, entry: Pick<CatalogEntry, "url" | "transport" | "headers"> & { docs?: string }): string[] {
  const issues: string[] = [];
  const texts = [setup.reason, ...(setup.steps ?? []), setup.redirectHint ?? "", setup.label ?? ""];
  if (!setup.reason.trim()) issues.push("setup needs a reason");
  if (!httpsLink(setup.guideUrl)) issues.push("setup guideUrl must be an https link");
  if (texts.some(hasEnvReference)) issues.push("setup text holds a ${…} reference");
  if (texts.some((text) => looksLikeCredentialValue(text.replace(/https:\/\/\S+/g, " ")))) issues.push("setup text holds what looks like a key");
  const only = (field: keyof CatalogSetup, kinds: SetupKind[]) => {
    if (setup[field] !== undefined && !kinds.includes(setup.kind)) issues.push(`setup ${field} is only for ${kinds.join(" or ")}`);
  };
  only("redirectHint", ["byo-oauth"]);
  only("scopes", ["byo-oauth"]);
  only("clients", ["byo-oauth", "approved-clients"]);
  only("urlTemplate", ["per-org"]);
  only("label", ["per-org"]);
  only("secretless", ["byo-oauth"]);
  if (setup.scopes !== undefined && !setup.scopes.split(" ").every((word) => SCOPE_WORD.test(word))) issues.push("setup scopes must be scope names separated by spaces");
  if (setup.kind === "byo-oauth") {
    if (entry.transport !== "http" || !entry.url) issues.push("a byo-oauth setup needs a web address");
    const vendor = entry.url ? byoVendor(entry.url) : null;
    if (!vendor) issues.push(`a byo-oauth setup is only for a vendor's own server this plugin knows (${BYO_OAUTH_VENDORS.map((known) => known.vendor).join(", ")})`);
    else {
      // Every link on the card and the sheet: the guide, the docs, and any address in the text (any case, http too).
      const texts = [setup.reason, setup.redirectHint ?? "", ...(setup.steps ?? [])];
      const links = [setup.guideUrl, ...(entry.docs ? [entry.docs] : []), ...texts.flatMap((text) => text.match(/https?:\/\/[^\s)<>"']+/gi) ?? [])];
      if (links.some((link) => !vendorLink(vendor, link.replace(/[.,;:]+$/, "")))) issues.push(`a byo-oauth setup's links must all be https on ${vendor.vendor}'s own sites`);
    }
    if (entry.url && placeholdersIn(entry.url).length > 0) issues.push("a byo-oauth setup needs a fixed address");
    if (entry.headers && Object.keys(entry.headers).length > 0) issues.push("a byo-oauth setup signs in with OAuth; it has no headers");
    if (!setup.clients?.length) issues.push("a byo-oauth setup must name the AI apps that take it (clients)");
  }
  if (setup.kind === "per-org") {
    if (!setup.urlTemplate) issues.push("a per-org setup needs urlTemplate");
    else {
      const problem = orgTemplateProblem(setup.urlTemplate);
      if (problem) issues.push(`setup urlTemplate ${problem}`);
      else if ((entry.url ?? "").trim() !== setup.urlTemplate) issues.push("setup urlTemplate must be the server's own address");
    }
    if (!setup.label?.trim()) issues.push("a per-org setup needs a label");
  }
  return [...new Set(issues)];
}

/**
 * A library's `setup` (untrusted JSON) as a checked, cleaned setup, or why
 * not. `problem` is plain and quotes nothing from the text.
 */
export function parseSetup(raw: unknown, entry: Pick<CatalogEntry, "url" | "transport" | "headers"> & { docs?: string }): { setup: CatalogSetup | null; problem: string } {
  const parsed = CatalogSetupSchema.safeParse(raw);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.map(String).join(".") || "setup";
    return { setup: null, problem: `its setup field '${cutText(cleanText(field), 40)}' is not valid` };
  }
  const setup = cleanSetup(parsed.data);
  const issues = setupProblems(setup, entry);
  return issues.length ? { setup: null, problem: issues[0] ?? "setup is not valid" } : { setup, problem: "" };
}

/** Why a card with this setup is shown but not added: approved-clients with no app we can write to, and admin. "" otherwise. */
export function setupBlockedReason(setup: CatalogSetup | undefined): string {
  if (!setup) return "";
  if (setup.kind === "admin" || (setup.kind === "approved-clients" && !setup.clients?.length)) return setup.reason || "It needs setting up outside this app first.";
  return "";
}

/** The https addresses in one step, to show as links. */
export function stepLinks(step: string): string[] {
  return (step.match(/https:\/\/[^\s)<>"']+/g) ?? []).map((link) => link.replace(/[.,;:]+$/, "")).filter(httpsLink);
}

// ----------------------------------------------------------------- per-org

const ORG_VALUE = /^[a-z0-9-]{1,63}$/;
const HOST_LABELS = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const MULTI_LABEL_ONLY = /^(co|com|net|org|ac|gov|edu|ne|or)\.[a-z]{2}$/;
/**
 * Hosting domains where each subdomain is a different customer's site: a
 * `{subdomain}` under one points at whoever owns that name, not the vendor.
 */
export const SHARED_HOSTING = new Set([
  "github.io", "gitlab.io", "vercel.app", "netlify.app", "pages.dev", "workers.dev", "herokuapp.com", "azurewebsites.net",
  "web.app", "firebaseapp.com", "appspot.com", "onrender.com", "fly.dev", "cloudfront.net", "amazonaws.com", "blogspot.com",
  "glitch.me", "replit.app", "repl.co", "ngrok.io", "ngrok-free.app", "trycloudflare.com", "run.app", "railway.app", "surge.sh",
]);

function orgParts(template: string): { id: string; host: string; path: string; inHost: boolean; base: string } | null {
  const ids = placeholdersIn(template);
  const id = ids[0] ?? "";
  if (ids.length !== 1 || !(ORG_PLACEHOLDERS as readonly string[]).includes(id)) return null;
  const match = /^https:\/\/([^/?#@:]+)(\/[^?#]*)?$/.exec(template);
  if (!match) return null;
  const host = match[1] ?? "";
  const path = match[2] ?? "";
  const token = `{${id}}`;
  if (host.includes(token)) {
    if (!host.startsWith(`${token}.`)) return null;
    const base = host.slice(token.length + 1);
    return { id, host, path, inHost: true, base };
  }
  return { id, host, path, inHost: false, base: host };
}

/**
 * Why a per-org address template can't be used, "" when it can. It must be
 * https with no port, user name, query or fragment, and hold exactly one
 * `{subdomain}` or `{org}`: either the whole first label of the host
 * (`https://{subdomain}.zendesk.com/api/mcp`, under at least a two-label
 * domain that is not a bare public suffix) or one whole path segment on a
 * fixed host.
 */
export function orgTemplateProblem(template: string): string {
  if (hasUnwritableChar(template) || hasEnvReference(template)) return "holds a control character or ${…}";
  const parts = orgParts(template);
  if (!parts) return "needs https, and exactly one {subdomain} or {org} as a whole host label or path segment";
  if (!HOST_LABELS.test(parts.base) || MULTI_LABEL_ONLY.test(parts.base)) return "needs a vendor domain under the placeholder";
  if (parts.inHost && SHARED_HOSTING.has(registrableDomain(parts.base))) return "is under a shared hosting domain, where each subdomain is someone else's site";
  if (parts.inHost) {
    if (parts.path.includes("{")) return "may hold the placeholder once";
  } else {
    const segments = parts.path.split("/");
    if (segments.filter((segment) => segment.includes("{")).length !== 1 || !segments.includes(`{${parts.id}}`)) return "must hold the placeholder as a whole path segment";
  }
  return "";
}

/** Why a typed subdomain or org can't be used, "" when it can: lowercase letters, digits and `-`, 1 to 63, not starting or ending with `-`. */
export function orgValueProblem(value: string, label = "It"): string {
  if (!ORG_VALUE.test(value)) return `${label} can only hold lowercase letters, numbers and - (1 to 63 of them).`;
  if (value.startsWith("-") || value.endsWith("-")) return `${label} can't start or end with -.`;
  if (looksLikeCredentialValue(value)) return `${label} reads like a key, not a name.`;
  return "";
}

/**
 * The address for one organisation, or why not. The value is checked on its
 * own (orgValueProblem) and the result again: the host must be the template's
 * own host (path placeholder) or the value as one label under the template's
 * domain, so nothing typed can point the server anywhere else.
 */
export function fillOrgTemplate(template: string, value: string): { url: string; problem: string } {
  const templateProblem = orgTemplateProblem(template);
  if (templateProblem) return { url: "", problem: `The address template ${templateProblem}.` };
  const valueProblem = orgValueProblem(value);
  if (valueProblem) return { url: "", problem: valueProblem };
  const parts = orgParts(template);
  if (!parts) return { url: "", problem: "The address template can't be read." };
  const url = template.replace(`{${parts.id}}`, value);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url: "", problem: "That doesn't make a valid address." };
  }
  const expectedHost = parts.inHost ? `${value}.${parts.base}` : parts.base;
  if (parsed.protocol !== "https:" || parsed.hostname !== expectedHost || parsed.port || parsed.username || parsed.password) {
    return { url: "", problem: "That would point the server at another site." };
  }
  if (registrableDomain(parsed.hostname) !== registrableDomain(parts.base)) return { url: "", problem: "That would point the server at another site." };
  return { url, problem: "" };
}

/** The placeholder a per-org entry's address holds, or "". */
export function orgInputId(entry: Pick<CatalogEntry, "setup">): string {
  if (entry.setup?.kind !== "per-org" || !entry.setup.urlTemplate) return "";
  return orgParts(entry.setup.urlTemplate)?.id ?? "";
}

// --------------------------------------------------------------- byo-oauth

/**
 * The fixed port Claude Code listens on for this sign-in. Claude Code sends
 * `http://localhost:PORT/callback` as the redirect address when `oauth.callbackPort`
 * is set ("Use pre-configured OAuth credentials", code.claude.com/docs/en/mcp),
 * and the vendor must have that exact address registered. One port for every
 * app, so one Google client covers Gmail, Calendar, Drive, Docs and Sheets.
 */
export const CLAUDE_CALLBACK_PORT = 33418;

export function claudeRedirectUri(port: number = CLAUDE_CALLBACK_PORT): string {
  return `http://localhost:${port}/callback`;
}

/**
 * A typed client. The install has the secret; the plan only `hasSecret`
 * (0.16.0 review): the preview is asked for as the user types, and the
 * secret has no business crossing to the daemon on every keystroke.
 */
export type OAuthClientInput = { clientId: string; clientSecret?: string; hasSecret?: boolean };

/** How a byo-oauth setup's client is asked for: the vendor's name for its ID, and whether it has a secret at all. */
export type ClientShape = { idName: string; secretless: boolean };

export function clientShape(entry: Pick<CatalogEntry, "url" | "setup">): ClientShape {
  return { idName: byoVendor(entry.url ?? "")?.idName ?? "client ID", secretless: entry.setup?.secretless === true };
}

const CLIENT_ID = /^[A-Za-z0-9._~@:+/=-]{1,512}$/;

/** What is wrong with a typed client ID and secret, never quoting either. */
export function oauthClientProblems(client: OAuthClientInput, shape: ClientShape = { idName: "client ID", secretless: false }): string[] {
  const issues: string[] = [];
  const id = client.clientId.trim();
  if (!id) issues.push(`Paste the ${shape.idName}.`);
  else if (!CLIENT_ID.test(id)) issues.push(`The ${shape.idName} holds a space or a character it never has.`);
  if (shape.secretless) return issues;
  if (client.clientSecret === undefined) {
    if (!client.hasSecret) issues.push("Paste the client secret.");
    return issues;
  }
  const secret = client.clientSecret.trim();
  if (!secret) issues.push("Paste the client secret.");
  else if (secret.length > 1024) issues.push("The client secret is longer than any client secret.");
  else if (/\s/.test(secret) || hasUnwritableChar(secret)) issues.push("The client secret must be one line with no spaces.");
  else if (hasEnvReference(secret)) issues.push("The client secret can't hold ${…}.");
  return issues;
}

/** Which AI app a destination's config belongs to, as a setup names them; "" for any other. */
export function destinationClient(dest: { provider: string; format: string; configPath: string }): SetupClient | "" {
  if (dest.provider === "claude") return "claude";
  if (dest.provider === "codex") return "codex";
  if (dest.provider === "kimi" || dest.provider === "grok") return "";
  if (dest.format === "json-mcp") return dest.configPath.endsWith(".claude.json") ? "claude" : "";
  return /codex/i.test(dest.configPath) ? "codex" : "";
}

/** Why an app can't take a byo-oauth server, per app, from its own docs. */
const BYO_UNSUPPORTED: Record<SetupClient | "", string> = {
  claude: "",
  codex: "Codex takes a client ID but has no place for a client secret (developers.openai.com/codex/mcp), and this app's sign-in needs one.",
  "": "This app has no setting for a sign-in app you registered yourself.",
};

/**
 * Whether one AI app gets a setup's server. byo-oauth: only apps the setup
 * names and the plugin knows how to hand a client to (Claude Code: the
 * `oauth` object plus its secure store). approved-clients: only the apps the
 * vendor approved. Other setups: every app.
 */
export function setupTargetSupport(setup: CatalogSetup | undefined, dest: { provider: string; format: string; configPath: string; label?: string }): { ok: boolean; reason: string } {
  if (!setup || setup.kind === "per-org") return { ok: true, reason: "" };
  const client = destinationClient(dest);
  const named = client !== "" && (setup.clients ?? []).includes(client);
  if (setup.kind === "byo-oauth") {
    if (client === "claude" && named) return { ok: true, reason: "" };
    return { ok: false, reason: client === "claude" ? "This app's listing doesn't name Claude Code." : BYO_UNSUPPORTED[client] };
  }
  if (setup.kind === "approved-clients") {
    if (named) return { ok: true, reason: "" };
    const approved = (setup.clients ?? []).map((id) => SETUP_CLIENT_LABELS[id]).join(" and ");
    return { ok: false, reason: approved ? `Only ${approved} of your apps are on its approved list.` : "This app isn't on its approved list." };
  }
  return { ok: false, reason: setup.reason };
}

/**
 * The server as Claude Code keeps a pre-registered client: `type`, `url` and
 * an `oauth` object with `clientId` and `callbackPort` (and `scopes` when the
 * vendor lists them), exactly as `claude mcp add-json` takes it. The secret is
 * never in it: Claude Code keeps that in its secure store (the macOS
 * Keychain, or `.credentials.json` elsewhere), filed under the server's name,
 * type, address and headers.
 */
export function byoOauthDefinition(entry: Pick<CatalogEntry, "url" | "setup">, clientId: string, port: number = CLAUDE_CALLBACK_PORT): Record<string, unknown> {
  const scopes = entry.setup?.scopes?.trim();
  return {
    type: "http",
    url: entry.url ?? "",
    oauth: { clientId: clientId.trim(), callbackPort: port, ...(scopes ? { scopes } : {}) },
  };
}

/** The preview of one Claude config: the entry as written, and a line for the secret, which is not in the file. */
export function byoOauthPreview(name: string, definition: Record<string, unknown>, secretless = false): string {
  const json = `${JSON.stringify({ mcpServers: { [name]: definition } }, null, 2)}\n`;
  return secretless ? json : `${json}// Client secret: not in this file. Claude Code keeps it in its secure store.\n`;
}

/** Text with every copy of the secret replaced by •••, for anything shown or logged. */
export function scrubSecret(text: string, secret: string): string {
  const value = secret.trim();
  return value.length >= 4 ? text.split(value).join("•••") : text;
}

export type SetupTarget = { id: string; label: string; provider: string; format: string; configPath: string };

export type ByoOauthPlan = {
  issues: string[];
  /** The chosen apps that get the server. */
  supported: SetupTarget[];
  /** The chosen apps that can't, each with why. */
  skipped: Array<{ label: string; reason: string }>;
  /** What goes into each supported app's config (no secret in it). */
  definition: Record<string, unknown>;
  previews: Array<{ file: string; label: string; text: string }>;
  redirectUri: string;
  notes: string[];
};

/**
 * A bring-your-own-app install, planned: the typed client checked (never
 * quoted), each chosen app sorted into gets it or skipped with why, and the
 * exact config each supported app gets. The secret is in none of it.
 */
export function planByoOauth(entry: Pick<CatalogEntry, "url" | "setup" | "name">, targets: SetupTarget[], client: OAuthClientInput): ByoOauthPlan {
  const setup = entry.setup;
  const redirectUri = claudeRedirectUri();
  const issues: string[] = [];
  if (setup?.kind !== "byo-oauth") issues.push("This server isn't set up with your own sign-in app.");
  const shape = clientShape(entry);
  issues.push(...oauthClientProblems(client, shape));
  const supported: SetupTarget[] = [];
  const skipped: ByoOauthPlan["skipped"] = [];
  for (const target of targets) {
    const support = setupTargetSupport(setup, target);
    if (support.ok) supported.push(target);
    else skipped.push({ label: target.label, reason: support.reason });
  }
  if (targets.length === 0) issues.push("Pick at least one app.");
  else if (supported.length === 0) issues.push(`None of the apps you picked can take a sign-in app you registered. ${(setup?.clients ?? []).map((id) => SETUP_CLIENT_LABELS[id]).join(" and ") || "No app"} can.`);
  const definition = byoOauthDefinition(entry, client.clientId);
  const notes = [
    `Register exactly ${redirectUri} as the redirect address; Claude Code listens there when you sign in.`,
    shape.secretless
      ? `No client secret: ${byoVendor(entry.url ?? "")?.vendor ?? "this vendor"}'s sign-in doesn't use one, so only the ${shape.idName} is written.`
      : "The client secret is not written into any file: Claude Code keeps it in its secure store (the macOS Keychain, or ~/.claude/.credentials.json elsewhere). To change it later, remove the server and add it again.",
    ...skipped.map((entry) => `Skipped ${entry.label}: ${entry.reason}`),
    "After adding, sign in with Connect.",
  ];

  return { issues: [...new Set(issues)], supported, skipped, definition, previews: [], redirectUri, notes };
}

/**
 * A plan's issue that only says a box is still empty ("Paste the client ID.",
 * "Pick at least one app.", "Your Zendesk subdomain is required"), as against
 * a real problem with what was typed. The sheet shows the first kind as a
 * quiet "To finish" line, not in red, so nothing reads as an error before the
 * user has typed anything (0.18.2).
 */
export function isStillToFill(issue: string): boolean {
  return /^(Paste the |Pick at least one |Pick one of the )/.test(issue) || / is required$/.test(issue);
}
