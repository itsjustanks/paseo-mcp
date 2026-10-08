import { redactSecrets } from "./redact";

/** The editor's diagnostic shape (shared/mcpjson.ts JsonIssue): a 1-based line and column, or line 0 for none. */
export type IssueLike = { line: number; column: number; message: string };

/**
 * "Line 4, column 12: <message>" for the hand editor (0.20.0, final review).
 * Never a copy of the line itself: a line read on its own loses the context
 * that says it holds a key (`"value": "…"` under `"credentials"`), so no
 * excerpt is shown at all, only where to look and the parser's message,
 * redacted. Copy only ever sees this text.
 */
export function formatIssue(_source: string, issue: IssueLike): string {
  const message = redactSecrets(genericParserMessage(issue.message));
  return issue.line < 1 ? message : `Line ${issue.line}, column ${issue.column}: ${message}`;
}

/**
 * A JSON parser's message without any of the text it quotes: V8 sometimes
 * adds the input around the error (`Unexpected token 'x', "…" is not valid
 * JSON`) and always the position, which the line and column already give.
 */
export function genericParserMessage(message: string): string {
  const cleaned = message
    .replace(/,\s*"[\s\S]*"\s+is not valid JSON\s*$/, "")
    .replace(/\s*in JSON at position \d+(?:\s*\(line \d+ column \d+\))?/, "")
    .replace(/\s*\(line \d+ column \d+\)/, "")
    .replace(/"[^"]*"/g, "…")
    .trim();
  return cleaned || "This isn't valid JSON";
}
