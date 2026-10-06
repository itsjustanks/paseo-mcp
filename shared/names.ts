/**
 * One connector, one name (0.19.2). Codex writes a name with a space or a
 * colon as a quoted TOML key (`[mcp_servers."Acme: CRM"]`), and the plugin
 * used to keep the quote marks, so the same connector was listed twice ("Acme:
 * CRM" in Claude, `"Acme: CRM"` in Codex), each "missing" from the other
 * app. Every name read from a file goes through this before names are
 * matched across apps.
 */

/** The name as the user knows it: spaces off both ends, and one pair of surrounding quote marks taken off (TOML's `"…"` and `'…'`). */
export function normaliseConnectorName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return (JSON.parse(trimmed) as string).trim();
    } catch {
      return trimmed.slice(1, -1).trim();
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).trim();
  return trimmed;
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A regular-expression source matching `name` as a TOML key in any form a
 * file may write it: bare, `"basic"` or `'literal'`. Used to find a
 * connector's own `[mcp_servers.<name>]` block whichever way it was written.
 */
export function tomlKeyPattern(name: string): string {
  const forms = new Set([escapeRe(name), escapeRe(JSON.stringify(name))]);
  if (!name.includes("'")) forms.add(escapeRe(`'${name}'`));
  return `(?:${[...forms].join("|")})`;
}
