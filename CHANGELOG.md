# Changelog

## 0.7.0 — 2026-09-10

Navigation changed: the **Tools** and **Accounts** sections are gone. Everything they showed is on the server's card under **Servers**.

### One Servers section, one card per server
- Sections are now Overview · Servers · Projects · Import & Export · Guide & Setup. Each server is a card with its transport, health pill, tool count, sign-in pill, coverage bar with the editors missing it, which project `.mcp.json` files define it, its tool list (a collapsed disclosure, expanded shows name, description and arguments), its per-account sign-in rows with Connect OAuth / Reconnect / Sign out, **Open**, **Add to N missing**, and the removal controls.
- What moved where: the Tools tab's totals (tools listed, servers answering) and its Refresh button are in the strip and toolbar above the cards; its per-server rows are the Tools disclosure on each card. The Accounts tab's per-account sign-in rows are the card's sign-in rows; its "need sign-in" count is in the strip and the new **Need sign-in** filter; its account list and **Sync accounts** card are on Overview. Every former `go("tools")` / `go("accounts")` (Overview next step, Guide buttons) now lands on Servers with the right filter.
- Filters: All, Gaps, Issues, Need sign-in. Pure filter and sign-in logic lives in `shared/servers.ts`.

### Delete with three scopes
- Every card and server page: **Remove from this editor…** (pick the editor when it is in several), **all N editors**, **everywhere (N)**. Each is a two-step confirm that names the files and counts: "Remove jam from everywhere? 2 editor definitions will be deleted: … 2 project .mcp.json files will lose it too: /path/a/.mcp.json, /path/b/.mcp.json. Those files are usually version-controlled, so the change shows up in git status." It says when a definition carries inline credentials (lost with it), that files are backed up, that OAuth grants are untouched, and that there is no undo (Export first).
- **Everywhere** is new: `paseo-mcp.remove` takes `projectFiles` (absolute paths of registered projects' `.mcp.json`, validated against the project list) beside editor `targets`. Each file is backed up, rewritten atomically, read back and must parse; an emptied file is left as `{"mcpServers":{}}`. The RPC returns `removed` / `skipped` per target so partial failure is visible under the card. The other two scopes say which projects still define the server, since Claude Code reads those back.
- The only delete in 0.6.0 sat under the expanded JSON editor of one destination row; it is gone from there.

### Per-workspace switches
- The workspace panel and the agent panel list the servers an agent there loads, each tagged user-level / this project's .mcp.json / local, with a switch where the editor has one and the reason when it has none. New RPCs `paseo-mcp.agent-servers` (state read fresh from the config every call) and `paseo-mcp.set-enabled`.
- Claude: user-level and local servers go through `projects["<workspace directory>"].disabledMcpServers` in `~/.claude.json`, the list `/mcp disable` writes; off there means off for that workspace only. Project servers go through `enabledMcpjsonServers` / `disabledMcpjsonServers`, never the wrong family. The project key is the workspace directory, so a worktree gets its own entry; a missing entry is created with only the one list. The write refuses unless the file parses, refuses if anything outside that one entry would change (checked before writing, `assertUnrelatedKeysKept`), backs up, writes temp-file-then-rename, and reads back to verify.
- Codex: the servers the hook injects from `.mcp.json` can be left out per workspace; the set lives in the plugin's own `$PASEO_HOME/plugin-settings/paseo-mcp/workspace-disabled.json` and the `agent.create` hook skips them (`skipped … (off for this workspace)`). User-level Codex servers have no switch: Codex layers `config.toml` on top of the `mcp_servers` Paseo passes in `thread/start`, so dropping one from the record would not stop it loading, and `enabled = false` in `config.toml` is global. The row says so instead of drawing a dead switch. Kimi and Grok: no switch.
- Copy says "Takes effect when a new agent session starts; a running agent keeps the servers it started with."

### Chip opens the agent panel
- Pressing the composer chip opens `mcp-agent` for that workspace and agent (`openPanel`) instead of the global surface; **Manage all servers** inside the panel opens the surface. A panel over a modal because the panel already exists, stays docked beside the conversation while the user signs in, and its per-agent scope is exactly the chip's.

### Agent panel is actionable
- Per-workspace switches, Connect / Sign out for OAuth servers through the existing login flow, scoped to that agent's own provider and account, and the tools each server lists from the 0.6.0 cache.

### Not in this release
- No per-tool permissions, no `agent.permission_requested` hook, no `~/.claude/settings.json`. Per-server only.

### Tests
- 76 tests: `tests/servers.test.ts` (sign-in state, filters, all three removal plans), `tests/remove.test.ts` (project file rewrite), `tests/enabled.test.ts` and `tests/enabled-write.test.ts` (levers, every-other-key preservation against a copy in a temp dir, worktree entry), `tests/injection-disabled.test.ts` (hook skip and store). No test touches the real `~/.claude.json`.

## 0.6.0 — 2026-09-10

### Tools each server exposes
- New **Tools** section on the MCP surface, and a **Tools** card on every server's page: what each server would hand an agent, listed the way Claude Code's `/mcp` view lists it. Each tool shows its name, title, description, and the arguments it takes (required ones starred). Per server: the tool count, `serverInfo.name`/`version` and the protocol version from the handshake.
- The host asks every HTTP server with the same two requests a client sends, `initialize` then `tools/list`, six servers at a time, reading both plain JSON and SSE-framed answers, and echoing `mcp-session-id` when the server issues one. The result is cached on the host (one in-flight pass shared by concurrent callers, refreshed on a timer at six times the health interval), read cheaply through the new `paseo-mcp.tools-cached` RPC; **Refresh** forces a real pass through `paseo-mcp.tools`.
- Honest about what cannot be listed, and never invents a list. An OAuth server answers an anonymous probe with 401: shown calmly as **sign in to list** (18 of 42 servers on one real host). A stdio server would have to be run to be asked, and the plugin does not spawn anything: shown as **runs on demand** with the command name (7 of 42). A URL that lands on a web page is **not listed** with a path hint (1 of 42). The remaining 16 listed 501 tools between them.
- Tool names and descriptions are server-controlled text: flattened to one line, stripped of control characters, capped, and rendered on a single line. Notes go through the same redaction as health notes. `McpTool` carries `name`, `arguments` and `required` and `ToolRow` has an empty trailing slot, so a per-tool allow/deny/ask control can be added later without reshaping the data or the row.
- Logic lives in `shared/tools.ts` with the fetch injectable; `tests/tools.test.ts` covers shaping, both framings, session echo, 401, HTML-at-200, refused `tools/list`, no-tools capability, timeout, redaction, the concurrency limiter and the chip label. 45 tests.

### Always-on composer chip
- The break-only **MCP issue** pill from 0.4.0 is now one always-on chip per live agent. It reads the server count and the one thing worth knowing: `12 MCP · 2 issues` when something needs attention, `12 MCP · 3 need sign-in` otherwise, `12 MCP · 340 tools` when all is well. One chip, not two: a second permanent chip next to a problem-only pill would have been noise, and a chip whose text shifts to the problem is the same signal in one slot. Pressing it opens MCP management.
- Gated by the existing **Composer chip** setting (formerly "Composer pill", same key, default on), so a 0.4 settings file still applies.

### Protocol
- The `initialize` probe now declares protocol version `2025-06-18` and identifies as `paseo-mcp`.

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
