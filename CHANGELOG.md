# Changelog

## Unreleased

### Inject servers into agents
- New host-scoped **Injection** settings screen (Settings → Plugins → Paseo MCP → Injection, or the "Configure MCP injection" command): turn on "Inject workspace servers", choose Codex, Claude Code, or both, and whether to skip inline-credential servers. Off by default.
- New `agent.create` hook: when injection is on for the agent's provider, reads `.mcp.json` from the agent's working directory or its git root and adds each server to the agent's `mcpServers` in the SDK shape (`stdio`: type, command, args, env; `http`/`sse`: type, url, headers). Servers the agent already defines win; inline-credential servers are skipped by default; nothing is written to disk. Logs `injected N servers into <provider> agent`. Never blocks creation.
- New per-agent **MCP** panel (workspace and explorer tabs, plus the "MCP for this agent" command) showing the workspace's project servers and sign-in, with a header line naming the agent's provider and model and whether injection applies to it.
- Settings are read server-side from `$PASEO_HOME/plugin-settings/paseo-mcp/injection.json`; an unreadable or invalid file means injection stays off.

## 0.2.0 — 2026-09-09

Requires Paseo 0.8 or newer.

### Paseo 0.8
- Migrated to the Paseo 0.8 runtime layout: `index.client.tsx` and `index.server.ts` entries, code under `client/`, `server/`, and `shared/`, and `requirements.paseo` set to `>=0.8.0`. SDK dependency is `@getpaseo/plugin` `0.8.0-beta.1`.
- Removed the legacy `index.ts` entry and the local type shim.

### Surface
- Redesigned to match the Hosts and 9Router panels.
- The Servers tab always shows "Add server", "Import", and "Refresh", not only when the list is empty.
- Each HTTP server shows its account sign-in rows inline, with Authorise, Cancel, Sign out, and paste-the-callback-URL completion.
- Health results carry a "checked at" timestamp and a "Check now" button, so configured, reachable, and signed-in are no longer conflated.
- An OAuth sign-in started on the daemon host can be finished from any browser by pasting the callback URL.

## 0.1.0 — 2026-08-29

Initial standalone release.
