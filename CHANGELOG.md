# Changelog

## 0.11.0 — 2026-09-24

The context budget now knows whether an agent's CLI loads tool definitions up front, the Paseo tools list says when it may be out of date (or comes live from the host), and the two "inject" settings have different names.

### Tool search (sources read 2026-09-24)
- Claude Code: "Tool search is enabled by default: MCP tools are deferred and discovered on demand. Claude Code disables it when `ANTHROPIC_BASE_URL` points to a non-first-party host" ([MCP docs, Configure tool search](https://code.claude.com/docs/en/mcp#configure-tool-search)). `ENABLE_TOOL_SEARCH` set to `true`, `auto` or `auto:N` overrides that; `false` loads everything up front ([env vars](https://code.claude.com/docs/en/env-vars)).
- `ENABLE_TOOL_SEARCH=auto` is a threshold: Claude Code "loads the tools it would otherwise defer upfront while their definitions total less than 10% of the context window", and `auto:N` sets N% "where `N` is 0-100" ([MCP docs](https://code.claude.com/docs/en/mcp#configure-tool-search)). `auto` and `auto:N` up to 10 count as on; above 10, or outside 0-100, they count as unknown.
- `ENABLE_TOOL_SEARCH` can sit in settings.json's `env` field ([MCP docs](https://code.claude.com/docs/en/mcp#configure-tool-search)), and so can a proxy `ANTHROPIC_BASE_URL`. A settings file's `env` "overwrites the same variable exported in your shell, and when more than one settings file sets a variable, the highest-precedence one applies" ([settings reference, `env`](https://code.claude.com/docs/en/settings-reference#env)); local beats project beats user ([settings precedence](https://code.claude.com/docs/en/settings#settings-precedence)). Paseo's Claude sessions load all three (`CLAUDE_SETTING_SOURCES` in `claude/agent.js`).
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`: "MCP tool search is disabled and all MCP tools load upfront, even when you set `ENABLE_TOOL_SEARCH`" ([env vars](https://code.claude.com/docs/en/env-vars); only managed settings on v2.1.227+ can keep it on). AI Router sets it on every routed Claude session (`ROUTED_CLAUDE_ENV`), so a routed agent is off twice over.
- Google Cloud's Agent Platform models before Claude 4.5 and Microsoft Foundry deployments hosted on Azure load tools up front ([MCP docs](https://code.claude.com/docs/en/mcp#configure-tool-search)). The plugin cannot see the model or the deployment, so those count as unknown.
- Codex defers MCP tools "when `tool_search` and namespaced tools are supported", which depends on the model's `supports_search_tool` ([openai/codex#29486](https://github.com/openai/codex/pull/29486), merged 2026-06-22). The plugin cannot see the model, so Codex counts as unknown. Nothing we found says any other CLI defers tools, so the others count as off.

### Budget
- A pure resolver, `toolSearch(providerId, …)` in `shared/tool-search.ts`, answers on, off or unknown with a plain reason. Its inputs, later ones winning: the daemon's own environment; the provider entry's `env`, on top of its base entry's `env` when `extends` names a built-in (Paseo's `mergeRuntimeSettings` in `provider-registry.js`); AI Router's `routeAgents`; then Claude Code's settings files' `env`, user (`settings.json` in the provider's `CLAUDE_CONFIG_DIR`, else `~/.claude`), then the workspace's `.claude/settings.json` and `.claude/settings.local.json` on the workspace and agent panels. The base CLI comes from an entry's `extends`, a built-in id, or the editor list. Every file is read-only, through the stat-keyed cache; a missing or broken one is no layer. AI Router's file is `$PASEO_HOME/plugin-settings/ai-router/routing.json`; missing, unreadable, or a `version` other than 1 (AI Router's `parseRoutingEnvelope` then uses its defaults) means not routed. AI Router routes the built-in `claude` provider only while `routeAgents` is on, and always routes its own `ai-router` provider.
- Tool search **on**: the tool check no longer raises the tier; the server check (8 and 16) still does. The panel says "Claude Code's tool search is on: tool definitions load up front only while they fit in 10% of the context window, and on demand past that." A warning raised by the server count says each server still starts with every session.
- **Off** or **unknown**: the same tiers and numbers as 0.10.0, and the warning names the reason, e.g. "AI Router re-routes this provider through OmniRoute (custom ANTHROPIC_BASE_URL) whenever its endpoint is up, so Claude Code's tool search is off and all 76 tool definitions load with the first prompt." A settings file is named in the reason ("~/.claude/settings.json sets a custom ANTHROPIC_BASE_URL (proxy.example.com)").
- The thresholds stay in `shared/budget.ts`. A load without Paseo tools and without a verdict gives the 0.10.0 cost profile key for key; `deferred` appears only when a verdict does.

### Paseo tools list
- Live list: `/mcp/agents` is open when the daemon has no password (@getpaseo/server 0.9.1 `server/auth.js`, `isAgentMcpRequestAuthorized`). In that case the host asks it for `tools/list` at the address the daemon bound: `listen` in `$PASEO_HOME/paseo.pid`, which the supervisor writes when the worker is ready (`supervisor-entrypoint.js` → `updatePidLock`). When the file is missing, unreadable or has no address, it falls back to `PASEO_LISTEN`, `daemon.listen`, or `127.0.0.1:$PORT` (default 6767, as in `config.js`), and the card says "Tool list live from this host". It asks at most every ten minutes, in the background, one ask at a time; **Refresh** asks now. A failure is not retried before then, and a good list is kept until a newer one replaces it. With a password (`PASEO_PASSWORD` or `daemon.auth.password`), a socket listener or the MCP server off, nothing is sent and the catalogue stands. No token is ever sent. A tool only the live list knows can be switched; a typo is still refused.
- Version check: the daemon starts each plugin from its own `@getpaseo/server` package (`plugins/runtime.js`, `fork(plugin-process.js)`), so the plugin reads the running version from that package's `package.json`. `@getpaseo/client` has no version call, and the endpoint's `serverInfo` says `agent-mcp 2.0.0` in every release. When the list is the catalogue and the host runs another version, the card and the Overview line say: "This list is from Paseo 0.9.1; this host runs X, so new tools may be missing and removed ones may still show."

### "Inject" settings
- This plugin's setting is now **Add project servers to agents** (settings screen **Project servers**, command **Add project servers to agents**). It was "Inject workspace servers" under "Injection". The settings file `injection.json` and its keys are unchanged.
- The settings screen points to Servers → Paseo tools for Paseo's own tools. The Paseo tools card points to this setting for a project's `.mcp.json` servers.
- Every user-facing "inject" string now names what it does: agent panel tags ("Project servers added for this provider"), per-workspace switch reasons, load notes, and the Codex note on the agent panel. The daemon log line `injected N servers into <provider> agent` is unchanged.

### Contracts
Additive only. Optional `toolSearch` on `paseo-mcp.workspace` (per provider id) and `paseo-mcp.agent-servers`. Optional `source`, `hostVersion` and `liveNote` on the Paseo tools state, and `source` on the Paseo tools load. No settings document changed. Nothing new starts a process. The live ask is an async `fetch` off the read path, except on Refresh (5 s limit).

### Tests
178 tests (was 138): the resolver for every input, `auto:N` from 0 to 999, AI Router's file present, absent, broken and at another version, provider and daemon env, a derived provider's inherited env, the user settings file in `~/.claude` and in a provider's `CLAUDE_CONFIG_DIR`, the project and local files, broken files (`tests/tool-search.test.ts`); budget tiers with tool search on, off and unknown, and the unchanged-numbers guarantee; the drift line, version discovery, the listen address (from `paseo.pid`, missing, garbage) and password rules, and the live list against a fake daemon (used, refused with a password, down, asking for a token, kept after a failure, never retried in a loop, one ask shared) (`tests/paseo-live.test.ts`). The existing tests never reach a real daemon. The UI preview takes `?routed`, `?proxy` and `?no-tool-search` (tool search off, or a 0.10 host), `?live` and `?host-version=0.10.2`.

## 0.10.0 — 2026-09-24

Paseo's own tools, the `mcp__paseo__*` set every daemon adds to its agents, are now shown, counted and switchable. Before this the plugin did not know they existed: an agent's load, the context-budget warning and the chip all left out 61 tools.

### What the daemon does (read from @getpaseo/server 0.9.1)
- The built-in server registers 39 tools for agents, terminals, schedules, heartbeats and workspaces, and 22 `browser_*` tools when `browserTools.enabled` is on (`speak` only exists for voice sessions).
- An agent gets it when `mcp.enabled` and `mcp.injectIntoAgents` are both on. `providers.<id>.paseoTools.enabled: false` turns it off for one provider (absent means on). `disabledTools` takes bare names (`list_agents`).
- Six providers are built in: `claude`, `codex`, `copilot`, `opencode`, `pi`, `omp`. Each is on and gets the tools with no config entry at all. Missing `injectIntoAgents` counts as off.
- The policy is copied into an agent when it starts, so changes apply to new agents.
- `/mcp/agents` needs a per-run token only agents get when a daemon password is set, so the plugin cannot ask it for `tools/list`. The tool list is a catalogue in `shared/paseo-tools.ts`, marked "as of Paseo 0.9.1" wherever it is shown.

### Servers
- A **Paseo tools** card at the top of Servers. It has the host-wide switch (the app's "Enable Paseo tools"), with a two-step confirm because it changes every agent on the host, and a switch per provider. The tool list is grouped into Agents, Terminals, Schedules and heartbeats, Workspaces and Browser. Each tool has a switch, for all providers at once or one picked provider, and **Turn off browser tools** for the group.
- Writes go through `paseo.config.patch()` only. The patch holds just the changed fields, `disabledTools` is merged with the current list (unknown names kept), and a provider patch carries only `paseoTools`. The config is read back and checked, and the card shows the state saved. A tool name the catalogue does not know is refused before anything is sent. If another client changed the same provider's list at the same moment, the result says so and shows the list now saved.
- The card lists every provider that can run an agent: the six built-ins and every enabled config entry. **All providers** writes each of them, built-ins with no entry included. Built-ins with no settings yet sit in a quieter row. An editor found on disk that Paseo has no provider for (`~/.kimi-code`, `~/.grok`) gets no Paseo tools unless the config declares it.

### Counted
- The workspace and agent panels list **Paseo tools (built in)** among what an agent loads, for the providers that actually get it, with its tool count.
- The context budget gets a tool check next to the server check (`shared/budget.ts`: 40 and 80 tools, the lines 8 and 16 servers stand for at five each). Paseo tools count at their real number; other servers stay at five each. The worse check wins. A load without Paseo tools gets the same numbers as before.
- The composer chip counts Paseo tools as one more server, with their tools, when the agent's own provider gets them.
- Overview: a **Paseo tools** line, "on · 61 tools for claude, codex", with a link to the card.

### Contracts
Additive only: new RPCs `paseo-mcp.paseo-tools` and `paseo-mcp.set-paseo-tools`. Optional `paseoTools` on `paseo-mcp.workspace` and `paseo-mcp.agent-servers`, and optional fields on the cost profile. No settings document changed. Reads share one daemon config read for 5 s, never one taken before a write, and nothing on the path starts a process. Panels re-read every minute, so a change made in the Paseo app shows within a minute.

### Tests
138 tests (was 114): the catalogue by name, the config reader, every combination of the four settings, the patch builder (merge, keep, no-op, several providers, unknown names), the provider list (built-ins, config entries, editors Paseo cannot run), the write handler against a fake daemon (fields kept, read-back, refusal, a read-back that disagrees or fails, a racing client), budget and chip counts with and without Paseo tools (`tests/paseo-tools.test.ts`). The no-spawn test also calls both new RPCs. The UI preview answers them and takes `?paseo-off` and `?no-browser`; `PREVIEW_PORT` picks another port.

## 0.9.0 — 2026-09-23

The MCP page gets AI Router's navigation: one row of tabs with icons, a line under it saying what the tab is for, and an Overview that answers "is everything OK, and what do I do next" before anything else.

### Navigation
- The five section tiles are now an underline tab bar (`client/navigation.tsx`): Overview · Servers · Projects · Import & Export · Guide & Setup, each with a Lucide icon drawn by the app. On a narrow screen every tab shows its icon and the active one its label too, so nothing is hidden; an app that hands plugins no icons gets the labels in a sideways-scrolling row instead. Same pattern and code shape as AI Router's tabs.
- One line under the bar says what each section is for; it replaces the big per-section headlines ("Every MCP server, in every editor.", "Bring servers in, keep a copy out." …). The Guide's line now says five steps; it said four above five cards.
- The header, the tab bar and the content share one left edge (the header sat 20 px to the right of everything under it).
- Unchanged: every `go()` deep link, a panel opening the page on one server (`openMcp` / `takePendingServer`), the Guide's buttons that land on Servers with a filter, and pressing Servers to get back to the list from a server's page.

### Overview
- First card: the next step, with its one primary button. Under it, one line each for Health, Editors, Sign-in, Tools and Projects: a status pill, which servers it is about, and a link to the filtered list ("1 down · supabase · Show issues →"). These replace the five number tiles; every number is still there.
- The header pill and the next step now come from one decision table (`shared/overview.ts`) and always name the same problem, most urgent first: a server that is down or not installed, then sign-in, then gaps, then warnings. Before, the pill said "1 server down" while the card below asked to "Apply 3 servers to the editors missing them". A server with only a warning used to leave the pill at "All servers healthy"; it now reads "1 warning". Sign-in counts the same servers as the Servers tab's Need sign-in filter.
- Needs attention: one row per server with every reason it is listed (a server both down and holding a token in clear text was listed twice).
- When the host cannot be read, the error sits in the next-step card with its Retry instead of a second Retry box above it; Browse servers and the extra Refresh are left out when they would do nothing.

### Check out AI Router
- A small card at the bottom of Overview: "Check out AI Router", one line on what it does, **View plugin** (opens https://github.com/itsjustanks/paseo-plugin-ai-router the way sign-in links open; if no browser opens, the address is copied and said in a toast) and **Copy install source** (`git:https://github.com/itsjustanks/paseo-plugin-ai-router.git:apps/paseo`, with the usual no-clipboard toast). AI Router shows the same card pointing here.
- When this daemon already has AI Router, an **Installed** badge replaces the copy button. The host checks Paseo's own install records (`server/siblings.ts`): `$PASEO_HOME/plugins/sources.json` for git and npm installs, and `plugins` in `$PASEO_HOME/config.json`, the only record of a directory install. Both go through the stat-keyed file cache, so a check is two `stat`s, and the app asks once per session.
- **Hide** removes it on that host, stored with the plugin's settings (`$PASEO_HOME/plugin-settings/paseo-mcp/promo.json`, new `promoSettings`). There is no Show-again button; deleting that file brings it back.

### Also fixed
- Arming a removal on one server card armed it on every card: six "Remove … from Claude?" confirmations appeared at once. The armed removal and its result now belong to one server. On the list, the three red remove buttons sit behind a quiet **Remove…** disclosure; a server's own page still shows them open.
- A list inside a card (editors, accounts, import targets, projects) had a 12 px gap between rows, which showed as dark bands between selected rows; rows now sit flush with their dividers.
- Projects says so when the project list cannot be read, instead of showing nothing. Empty lists say what was checked: "Checked 6 servers: none has "jam" in its name and needs sign-in", with a button to show all.
- Tabs report their selected state to the web build (`aria-selected`).
- Removed the now-unused `Choice`, `Intro` and `StatCard` components.

### Contracts
Additive only: new RPC `paseo-mcp.siblings` (`{ aiRouter: { installed } }`) and host settings `promo` (`hideAiRouter`, default off). No existing RPC changed shape.

### Tests
114 tests (was 102): the verdict and next-step table (`tests/overview.test.ts`), the installed check against both records, broken files and changes on disk, and the Hide setting (`tests/siblings.test.ts`). The no-spawn test also calls the new RPC. The UI preview (`npm run preview:ui`) answers the new RPC and takes `?ai-router` (installed), `?promo-hidden` and `?no-icons` (label fallback).

## 0.8.0 — 2026-09-23

The plugin no longer chugs. Opening an MCP panel used to start `codex mcp list` once per Codex account, per panel, and wait for each one; now nothing waits on a process.

### Why it was slow
- Every read of the Servers section, the workspace panel and each agent's MCP panel ran `codex mcp list --json` once per Codex account (primary plus every AgentLink slot) with `execFileSync`. That command asks each HTTP server over the network whether it uses OAuth, up to 5 s per server, and the synchronous call froze the whole plugin while it ran: health reads, the composer chip, and the `agent.create` hook all queued behind it. Past the daemon's 30 s RPC limit the app retried, which queued more runs. On a daemon this is the `WARNING: failed to clean up stale arg0 temp dirs` line every ~5 s: Codex prints it on every start.
- The workspace panel threw the Codex answers away (it shows Claude sign-in rows only), and the Claude agent panel asked for every account to use one.

### Measured (`npm run bench`: sandbox HOME, 3 Codex accounts, fake `codex` taking 5 s like a real one waiting on an unreachable server)

| | 0.7.0 | 0.8.0 |
| --- | --- | --- |
| Codex runs, panel closed | 0 / min | 0 / min |
| Codex runs, panel open | 12 / min (66 for one open-and-refresh; 332 s to drain) | 3, once, in the background; none after |
| Plugin frozen for (longest event-loop stall, panel open) | 181 s | 13 ms |
| A cheap RPC while the panel loads (median / max) | 66 s / 284 s | 1 ms / 1 ms |
| RPCs past the daemon's 30 s limit, and app retries | 28, 20 | 0, 0 |
| `agent.create` hook while the panel loads | 70.6 s | 1 ms |
| `auth` / `workspace` / `agent-servers` RPC | 15.1 s each | 1 ms (workspace 57 ms cold: one `ps` + `lsof`) |
| Codex warnings in the plugin log | 102 | 0 (one explanation per account) |

### Changes
- Codex sign-in state (`server/codex-auth.ts`, `shared/accounts.ts`): panel reads answer at once from Codex's grant file (`$CODEX_HOME/.credentials.json`, used where there is no keyring) and Codex's last answer. `codex mcp list` runs only in the background, one process at a time, 20 s limit, when the last answer is missing, older than 30 minutes, or the account's `config.toml` or grant file changed, and on Refresh or a finished sign-in. Only a success is cached; a failure keeps the last good answer, is shown with its time and reason, and is retried after 1, 2, 4 … minutes. The workspace panel never starts Codex; an agent panel checks only its own account.
- Fixed: Codex prints `o_auth` for a connected OAuth server; 0.7.0 read that as "unknown", so Codex grants never showed as connected.
- Codex's stderr is captured instead of passed to the plugin log. The arg0 warning is explained once per account with the directory and the fix (something under `$CODEX_HOME/tmp/arg0` is owned by another user, usually root from `docker exec` without `--user`; `chown -R` it once as root).
- Config reads go through an mtime/size/inode-keyed cache (`server/files.ts`): `~/.claude.json` was parsed five or six times per panel refresh. A file caught mid-write keeps its last good parse for 60 s instead of emptying the server list. Credential files (`auth.json`, `.credentials.json`) are read fresh and never cached.
- No blocking calls left on the RPC path: the login-shell PATH lookup, `ps` and `lsof` are async with timeouts, and one process-table snapshot serves every panel for 5 s. The `agent.create` hook finds the git root by walking up to `.git` instead of starting `git`. Calls back into the daemon (config, workspaces, projects) have a 10 s deadline with a plain-English error.
- Health and tool passes (`server/background.ts`) run only while an app is connected (any RPC in the last 15 minutes), back off 1, 2, 4 … minutes after a failure, and probe eight servers at a time instead of all at once. After a pause, the first read answers with the last verdict and refreshes in the background.
- A server that listed its tools before and fails on a later pass keeps its earlier list, marked "as of HH:MM" with the reason, so a blip does not shrink the chip's tool count.
- Panels keep the last good data when a refresh fails, with an "as of HH:MM" pill and a note saying what failed and why, instead of replacing the content with an error. Errors from the daemon are reworded into plain sentences (`shared/errors.ts`), e.g. a 30 s timeout says the plugin is busy and to try again.
- Client polling: health and tool reads back off after failures; the composer chip's settings poll runs only while there is an agent and backs off when the host does not answer; Codex sign-in is re-read every 3 s only while a background check is running. The agent panel's switch list is re-read on every visit as its comment always said (the host turns refetch-on-mount off).
- Every RPC slower than 5 s is logged with its name. Removed the unused `ToolsSection` component.

### Contracts
All additions are optional, so a 0.7 app reads a 0.8 host and the other way round: `paseo-mcp.auth` takes `refresh` and returns `checking`; accounts carry `statusAsOf`, `checking`, `statusNote`; a tool list entry can carry `stale: { reason, asOf }`.

### Tests
102 tests (was 76): Codex state mapping and grant rules (`tests/accounts.test.ts`), the file cache and last-good tool lists (`tests/cache.test.ts`), background Codex checks with caching, invalidation, backoff and single-flight (`tests/codex-auth.test.ts`), pausing and backoff of background passes (`tests/background.test.ts`), and "no spawn loop" against the real handlers with a fake `codex` (`tests/no-spawn.test.ts`).

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
