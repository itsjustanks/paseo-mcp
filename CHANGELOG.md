# Changelog

## 0.5.1 — 2026-09-10

### Fixed: health checks used the wrong protocol and over-reported problems
- HTTP servers were health-checked with a bare `GET`. Streamable-HTTP MCP servers speak JSON-RPC over `POST`, so a correctly working server answers a `GET` with 400 or 405, and an OAuth server answers anything unauthenticated with 401. A 400 was filed as a warning, and a 401 was counted as a problem needing attention, so on one real host 16 of 44 healthy servers were flagged, including every server with a token in its URL query string.
- The probe now sends the same JSON-RPC `initialize` request an MCP client opens a session with (`content-type: application/json`, `accept: application/json, text/event-stream`, the configured headers, the configured URL intact), follows redirects, and keeps the 5 second timeout. Same host, same 44 servers: 2 need attention (one stdio binary not on PATH, one endpoint answering 404), 18 are OAuth servers answering 401 as they should, the rest are healthy.
- Reclassified honestly: a JSON-RPC result is `ok`; 400/405/406 and redirects are `ok` (reachable); 404 and 5xx are `warn`; refused, reset, DNS failure, TLS rejection and timeout are `down`. 401/403 stay `auth-required` but no longer count as needing attention: `healthNeedsAttention` excludes it, so the composer pill, the panel counts, the Issues filter, and the daemon log line (`N servers, M need attention, K OAuth`) treat a sign-in state as informational. The tag reads "OAuth" in a neutral tone. Missing sign-ins are still reported per account on the Accounts tab, which reads each editor's own grant list.
- Health notes are redacted before they are cached, rendered or logged: never the URL, its query string, a query value, a header value, or a JWT-looking run. Several real definitions carry tokens in the URL, and an error message can echo the whole request.
- Classification, redaction and the probe itself live in `shared/health.ts` with the fetch injectable; `tests/health.test.ts` covers 200 JSON-RPC result (plain and SSE-framed), 401, 403, 405, 400, 301/307, 404, 500, timeout, DNS failure, the request shape, and a token-bearing URL never reaching a note. 28 tests.

## 0.5.0 — 2026-09-10

### Workspace context
- The **MCP connections** workspace panel and the per-agent **MCP** panel now lead with what an agent started in that workspace loads: the workspace `.mcp.json` (natively for Claude Code, via injection for chosen providers), Claude Code's per-directory entries, and the editor's user-level config, counted once per name. The workspace panel shows the heaviest wired editor; the agent panel uses the agent's provider (`useAgent`). A Codex agent without injection is told plainly that `.mcp.json` is not loaded and why.
- **Cost profile**: stdio servers (a child process per agent session) versus http (no local process), split by scope, with how many need attention here versus elsewhere.
- **Running now**: the MCP server processes running for this workspace, per server, with process count and resident memory. Read from the daemon host's process table: the plugin host is a child of the Paseo daemon, so the daemon's other children are the agents it launched, and a server process is attributed to the workspace when its agent or its own working directory sits under the workspace directory (`ps` + `/proc/<pid>/cwd` on Linux, `lsof` on macOS). When the table cannot be read the panel says so instead of showing a zero.
- **Context-budget warning** at 8 servers ("getting heavy") and 16 or more ("over budget"), with the user-level servers the agent loads listed so they can be scoped per project, and a button to MCP management. Thresholds and the evidence behind them are in `shared/budget.ts`.

### Health summary
- Issues are now split into servers this workspace loads and problems elsewhere, elsewhere folded into a disclosure. Every problem row has an **Open** button that lands on that server in MCP management; the client entry lends panels its `openSurface` through `client/navigate.ts`.

### Contracts and tests
- `paseo-mcp.workspace` gains optional `profile`, `injection` and `processes`; `Destination` gains `providerId`. Both are optional or defaulted so a 0.5 client reads a 0.4 host.
- Counting and threshold logic lives in `shared/budget.ts`, process attribution in `shared/processes.ts`; `npm test` runs `tests/*.test.ts` with `node:test` via `tsx`. The UI fixture gained `?heavy` (25 user-level servers) and `?no-procs`.

## 0.4.0 — 2026-09-09

### Fixed
- The **MCP connections** workspace panel now appears in the Projects/Explorer view. Its registration omitted `locations`, which defaults to `["workspace"]`; it now declares `["workspace", "explorer"]` like the agent panel.

### Background health checks
- New host-scoped **Health checks** settings screen (Settings → Plugins → Paseo MCP → Health checks, or the "Configure MCP health checks" command): background checks on/off (default on), interval in minutes (default 10, 1 to 1440), and whether to show the composer pill (default on).
- The host probes every server on that interval, caches the verdict, and shares one in-flight probe between concurrent callers. The surface, both panels and the pill read the cache through the new `paseo-mcp.health-cached` RPC; Refresh and Check now still force a fresh probe. The timer is cleared on plugin shutdown and stays idle while checks are off.
- Settings are read server-side from `$PASEO_HOME/plugin-settings/paseo-mcp/health.json`; the envelope reader is now shared with injection in `server/settings.ts`.

### Composer pill
- Every live agent gets an **MCP issue** pill while a server is down, missing its binary, or needs a sign-in, with the count and how many are defined by the agent's own project. Pressing it opens MCP management. A healthy host shows no pill.

### Project level vs user level
- Health results now carry `scopes`: every editor config (user level) and every registered project's `.mcp.json` (project level) that defines the server. The workspace and agent panels show issues split into this project, user config, and other project, and tag each project server row with its health.

## 0.3.0 — 2026-09-09

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
