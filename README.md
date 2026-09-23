# Paseo MCP

Manage MCP servers, project connections, credentials, and OAuth from Paseo.

## Install

Requires Paseo 0.8 or newer (0.1.0 is the last release for Paseo 0.7):

```sh
paseo plugin add itsjustanks/paseo-mcp
```

Updates are handled by Paseo:

```sh
paseo plugin update paseo-mcp
```

## What it does

- Shows user-level MCP servers across Claude Code, Codex, Kimi Code, and Grok, one card per server with its editors, health, tools and sign-in state.
- Adds, edits, renames, imports, and exports definitions with masked secrets; removes a server from one editor, all editors, or everywhere including project `.mcp.json` files.
- Turns servers on or off per workspace from the workspace and agent panels, where the editor has such a switch.
- Starts Claude or Codex OAuth in the computer's default browser and shows the fallback URL.
- Shows each Paseo workspace's project-level `.mcp.json` servers in an **MCP connections** tab, available in both the workspace view and the Projects/Explorer view.
- Tells each workspace what an agent started there loads (project, local and user-level servers), what it costs in child processes and memory, and warns when the count is heavy enough to exhaust the agent's context.
- Checks every server's health in the background and flags problems per agent, per project, and per user config.
- Lists the tools each server exposes, the way Claude Code's `/mcp` view does, and keeps an always-on chip on every agent's composer with the server count and status.
- Shows and switches Paseo's own built-in tools (the `mcp__paseo__*` tools the daemon adds to agents): for the whole host, per provider, and per tool.
- Syncs MCP definitions and Claude project trust to discovered account directories without copying OAuth grants.
- Keeps backups before config writes and preserves destination-specific credentials.

## Inject servers into agents

Off by default. Turn it on under **Settings → Plugins → Paseo MCP → Injection**, or run the
**Configure MCP injection** command.

| Setting | Default | Meaning |
| --- | --- | --- |
| Inject workspace servers | off | Add the workspace's `.mcp.json` servers to every new agent |
| Providers | Codex | Inject for Codex, Claude Code, or both |
| Skip inline-credential servers | on | Leave out entries carrying tokens in `env`, `headers`, `args`, or the URL |

When an agent is created for a chosen provider, the plugin reads `.mcp.json` from the agent's
working directory (or its git root) and adds each server to the agent's MCP configuration. Servers
the agent already defines are kept as-is. Nothing is written to any config file, and a failure to
read leaves the agent unchanged. The daemon log shows `injected N servers into <provider> agent`.

Each agent also gets an **MCP** tab (and the **MCP for this agent** command) listing the workspace's
project servers, with a line showing the agent's provider and whether injection applies to it.

Settings live on the host at `$PASEO_HOME/plugin-settings/paseo-mcp/injection.json`
(`~/.paseo` by default). The hook reads that file directly; if it is missing or invalid, injection
stays off.

## The MCP surface

Five sections: **Overview**, **Servers**, **Projects**, **Import & Export**, **Guide & Setup**. Since
0.7.0 the old Tools and Accounts tabs are part of **Servers**: every server is one card showing its
transport, which editors define it and which are missing it, its health, its tool list (collapsed; some
servers list 77), and a sign-in row per account with Connect / Sign out. The strip above the cards
carries the totals those tabs used to lead with (servers, tools listed, accounts, sign-ins needed,
issues, gaps). Filters: all, gaps, issues, need sign-in. **Sync accounts** moved to Overview.

### Removing a server

Each card and each server page offers three scopes, each a two-step confirm that names the files:

| Scope | What is written |
| --- | --- |
| this editor | One editor config (pick which when the server is in several) |
| all editors | Every editor config that defines it |
| everywhere | All editors plus every registered project's `.mcp.json` that defines it |

Only **everywhere** keeps the server gone: Claude Code reads a project's `.mcp.json` straight back, so
the other two scopes say which projects still define it. Project files are backed up first, rewritten
atomically, read back and must parse, and an emptied file is left as `{"mcpServers":{}}` rather than
deleted. The confirm warns that those files are usually version-controlled (the change shows in
`git status`) and that inline credentials in a deleted definition are lost; export first if in doubt.
The result is reported per target, so a partial failure is visible.

## Per-workspace switches

The **MCP connections** workspace panel and each agent's **MCP** panel list the servers an agent there
loads, each tagged with its origin (user-level, this project's `.mcp.json`, local) and with a switch
where the editor has one. A switch takes effect when a new agent session starts; a running agent keeps
the servers it started with. State is read from the config on every refresh, so a `/mcp disable` done in
a terminal shows up here.

| Provider | Server origin | Lever |
| --- | --- | --- |
| Claude Code | user-level, local | `projects["<workspace dir>"].disabledMcpServers` in `~/.claude.json` — off for this workspace only, the definition is untouched. Same list `/mcp disable` writes. |
| Claude Code | this project's `.mcp.json` | `enabledMcpjsonServers` / `disabledMcpjsonServers` for that directory (the approval lists). "Asks at launch" means neither list names it yet. |
| Codex | this project's `.mcp.json` (injected) | The plugin's own `$PASEO_HOME/plugin-settings/paseo-mcp/workspace-disabled.json`; the `agent.create` hook leaves the server out for that directory. |
| Codex | user-level | No switch. Codex layers `config.toml` on top of what Paseo passes it, and `enabled = false` there is global. The row shows its state and says so. |
| Kimi, Grok | any | No switch. |

The project entry is keyed by the workspace's own directory, so a worktree workspace gets its own entry
rather than sharing the project root's. Writing `~/.claude.json` is guarded: the file must parse, the new
document may differ only inside that one project entry (checked before the write), the write is a temp
file plus rename, a backup is taken first, and the result is read back and must hold the state just
written. Any failure refuses the write and reports why.

## Health checks

On by default. The host probes every MCP server on a timer: HTTP endpoints get the same JSON-RPC
`initialize` POST an MCP client opens a session with (configured headers and URL sent intact, so a
token in the query string counts), stdio commands are looked up on the login shell's PATH. The most recent result
is cached on the host, and every panel, pill, and the MCP surface reads that cached verdict, so
opening ten agents never probes your servers ten times. **Refresh** and **Check now** still run a
fresh probe. Configure it under **Settings → Plugins → Paseo MCP → Health checks**, or run the
**Configure MCP health checks** command.

| Setting | Default | Meaning |
| --- | --- | --- |
| Check servers in the background | on | Probe on a timer, not only when Refresh is pressed |
| Interval | 10 minutes | Time between background checks (1 to 1440 minutes) |
| Composer chip | on | Show an always-on MCP chip on each agent's composer |

Settings live on the host at `$PASEO_HOME/plugin-settings/paseo-mcp/health.json`; an unreadable or
invalid file means the defaults apply. The daemon log shows `health check: N servers, M need attention, K OAuth`
after each pass.

Background passes only run while a Paseo app is connected to the daemon (any RPC from the app counts;
the composer chip reads the cached verdict once a minute). With no app connected for 15 minutes the
log says `health check: no app connected, pausing until one is` and nothing is probed; the first read
after that answers with the last verdict and refreshes it in the background. A pass that fails is
retried after 1, 2, 4 … minutes, never more often than the interval. Probes run eight at a time.

| Status | Meaning | Needs attention |
| --- | --- | --- |
| `ok` | The endpoint answered `initialize`, or is alive and rejected the anonymous request the way the protocol says to (400, 405, 406, a redirect) | no |
| `auth-required` | 401 or 403: an OAuth server. This is how a working server answers a probe with no grant; the editor holds the sign-in. Shown as informational | no |
| `warn` | 404 (wrong path, or an inactive n8n workflow) or a 5xx from the server | yes |
| `down` | Connection refused or reset, DNS failure, TLS rejected, or no answer in 5 seconds | yes |
| `binary-missing` | A stdio command not found on PATH | yes |
| `unknown` | No readable definition | no |

Health notes never contain a URL, query string, token, or header value; the verdict is redacted
before it is cached, shown, or logged. Missing sign-ins are reported per account on each server's card,
which reads each editor's own grant list.

### Composer chip

Every live agent's composer carries one **MCP** chip, always on. It reads the server count and the
one thing worth knowing about them, in this order: `12 MCP · 2 issues` while a server is down,
missing its binary, or answering with an error; `12 MCP · 3 need sign-in` while OAuth servers are
waiting on a grant; `12 MCP · 340 tools` when everything is healthy. Press it to open that agent's
**MCP** panel: the servers it loads with their switches, sign-in, and tools, plus a **Manage all servers**
button to the full surface. Turn it off with the **Composer chip** setting.

## Tools each server exposes

Each server's card on the Servers section (the **Tools** disclosure) and the **Tools** card on its page
show what a server would hand an agent: every tool's name, title, description and the arguments it takes
(required ones starred), plus the server's own name and version from the handshake. The host asks
each HTTP server with the same two requests a client sends, `initialize` then `tools/list`, a few
servers at a time, and caches the answer; the section reads the cache, and **Refresh** asks again.

Nothing is guessed. A server that cannot be asked says why:

| Shown as | Meaning |
| --- | --- |
| `N tools` | The server answered `tools/list`; expand Tools on the card to read them |
| `sign in to list` | An OAuth server: it answers an anonymous request with 401 and lists its tools only to a signed-in editor |
| `runs on demand` | A stdio (command) server: its tools are only knowable while an agent has it running, and the plugin does not start processes |
| `not listed` | The endpoint answered but not with MCP (a web page at the URL, a JSON-RPC error, a timeout), with the redacted reason |

A server that listed its tools before and does not answer on a later pass (a timeout, a restart, an
error page) keeps its earlier list, marked "as of HH:MM" with the reason the new ask failed, so a blip
never shrinks the tool count on the chip. An edited URL starts over.

Tool descriptions are text the server controls; they are flattened to one capped line before they
are stored or shown. The data carries each tool's name and argument list so a per-tool policy
control can be added alongside it later.

## Paseo tools

Every Paseo daemon runs its own MCP server, `paseo`, and with `daemon.mcp.injectIntoAgents` on it
adds that server to every agent it starts. It hands each agent 39 tools for agents, terminals,
schedules, heartbeats and workspaces, plus 22 `browser_*` tools when browser tools are on: 61 in all
(Paseo 0.9.1). The **Paseo tools** card at the top of **Servers** shows and changes what agents get:

| Control | Daemon setting | Default |
| --- | --- | --- |
| Add to every agent on this host | `mcp.injectIntoAgents`, the app's Settings → Orchestration → Enable Paseo tools | off when unset in `config.json` |
| Per provider | `providers.<id>.paseoTools.enabled` | on (absent means on) |
| Per tool | `providers.<id>.paseoTools.disabledTools`, bare names such as `list_agents` | none |
| Turn off browser tools | `browserTools.enabled` | off |

The host-wide switch changes every agent on the host, so it asks twice. The tool switches write to
every provider at once under **All providers**, or to one provider when one is picked. A tool that is
off for only some providers says which. `mcp.enabled` (the `--no-mcp` flag) turns the server off
altogether; the config API cannot change it, so the card only says so when it is off.

Every change goes through the daemon's config API (`paseo.config.patch`), never by editing
`config.json`. Only the fields that change are sent. `disabledTools` starts from the current list,
so names the plugin does not know are kept, and a provider patch carries only `paseoTools`, so
`extends`, `env` and every other field stay as they are. The config is read back after the write
and the card shows what was saved. The daemon copies the policy into an agent when it starts, so
**a change applies to agents started after it**; a running agent keeps the tools it started with.

The tool list is a catalogue in `shared/paseo-tools.ts` copied from Paseo 0.9.1, and the card says
so. The daemon cannot be asked for it: `/mcp/agents` wants a per-run token that only agents get
when the daemon has a password.

The same count feeds everything else: the Overview has a **Paseo tools** line, the workspace and
agent panels list **Paseo tools (built in)** among what an agent loads, and the composer chip counts
it as one more server with its tools, for the agent's own provider only.

### Project level vs user level

Each health result carries the configs that define the server: an editor's global config
(`~/.claude.json`, `~/.codex/config.toml`, …) is **user level** and affects every workspace; a
`.mcp.json` in a registered project is **project level**. The workspace and agent panels list issues
under three headings — this project, user config, other project — and tag each project server row
with its health. A server defined at both levels is probed once, using the editor's copy, since that
is what the editor actually runs.

## Workspace context

The **MCP connections** tab and each agent's **MCP** tab lead with what an agent started in that
workspace actually loads, counted from the same files the CLI reads:

- the workspace's `.mcp.json` (read natively by Claude Code, or added by injection for the chosen
  providers),
- Claude Code's per-directory ("local") entries for that workspace,
- the editor's user-level config (`~/.claude.json`, `~/.codex/config.toml`, …), which loads in
  every workspace.

A name defined at two levels is counted once. The workspace tab shows the heaviest wired editor;
the agent tab shows the agent's own provider. Under the count: how many are **stdio** (a child
process per agent session) versus **http** (no local process), how many need attention here versus
elsewhere, and a **Running now** section listing the MCP server processes currently running for
this workspace with their resident memory. That section reads the daemon host's process table
(`ps`, `/proc` on Linux, `lsof` on macOS), attributing a server to the workspace when its agent, or
the server process itself, works in the workspace directory. When the table cannot be read the panel
says so rather than showing a zero.

### Context-budget warning

Every server's tool definitions are sent to the agent with its first prompt. Claude Code defers
them once they pass 10% of the context window (MCP tool search, 2.1.7+); Cursor stops at 40 tools
and warns that some models ignore more. The panel warns at **8** servers ("getting heavy", about 40
tools at five per server) and flags **16** or more as "over budget" (about 80 tools, well over 100K
tokens before any work, the range where Paseo-launched agents fail with "Prompt is too long"). The
warning lists the user-level servers the agent loads, since those are the ones that can be moved into
one project's `.mcp.json` or removed from the editor config, with a button to MCP management. The
thresholds live in `shared/budget.ts`.

The server lines assume five tools per server. Paseo's built-in server is counted by its real
number of tools (61, or 39 without browser tools), so a second check counts tools: about 40 is
"getting heavy" and 80 "over budget", the same lines as 8 and 16 servers at five each. The worse of
the two checks wins. Without Paseo tools both checks always agree, so the numbers are unchanged.

Health issues under the count are split the same way: servers this workspace loads first, each with
an **Open** button that lands on that server in MCP management, and problems elsewhere folded away.

## Sign-in state and Codex

Claude Code records which servers each account still has to authorize in its own config dir, so its
sign-in state is a file read. Codex keeps MCP OAuth grants in the OS keyring, or, where there is none
(a Linux container, or `mcp_oauth_credentials_store = "file"`), in `$CODEX_HOME/.credentials.json`. The
plugin reads that file directly: a usable grant there shows as connected at once. Nothing from it
leaves the host except that yes/no; no token is read into a response or a log.

For everything the file cannot answer (keyring grants, whether a server wants OAuth at all), Codex is
asked with `codex mcp list --json`, which checks each server over the network and can take seconds. So
it never runs while a panel waits:

- Panel reads answer at once from the file and Codex's last answer. Only the Servers section and a
  Codex agent's own panel start a check, in the background, and only when the last answer is missing,
  older than 30 minutes, or that account's `config.toml` or grant file changed. **Refresh** and a
  finished sign-in ask again.
- One Codex process at a time, 20 second limit each. A failed check keeps the last good answer, shown
  with its time and the reason, and is retried after 1, 2, 4 … minutes (up to 30).
- The workspace panel never starts Codex; it shows Claude sign-in rows only.

### "failed to clean up stale arg0 temp dirs"

Codex prints this on every start when it cannot tidy `$CODEX_HOME/tmp/arg0`: something in there
belongs to another user, usually root, left by running `codex` through `docker exec` without `--user`.
It is harmless. The plugin captures Codex's output instead of passing it to its log, and explains the
warning once per account with the exact directory. To silence it, fix the ownership once, as root on
the daemon host (in the paseo-dev-stack container: `docker compose exec --user root paseo chown -R paseo:paseo /home/paseo/.codex/tmp`).

## AgentLink integration

AgentLink is optional. Standard `~/.claude`, `~/.codex`, `~/.kimi-code`, and `~/.grok` setups work on their own.

When [AgentLink](https://github.com/itsjustanks/agent-link) account directories exist under `~/.agent-link` or `~/.agent-auth`, Paseo MCP discovers them automatically. It also reads hand-managed `~/.claude-accounts` and `~/.codex-accounts` directories. OAuth remains per account and is never copied.

## Development

```sh
npm install
npm run typecheck
npm test
paseo plugin add /absolute/path/to/paseo-mcp --link
```

`npm run bench` runs the load harness (`tests/perf/harness.ts`): the plugin in its own process against
a sandbox HOME with a fake `codex`, playing daemon and app, and prints processes started per minute,
event-loop stalls, and RPC timings with the panel closed and open. `npm run bench -- --quick` takes
about a minute.

Paseo's plugin host supplies the runtime. The npm dependencies are development types only.
