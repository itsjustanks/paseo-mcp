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

- Shows user-level MCP servers across Claude Code, Codex, Kimi Code, and Grok.
- Adds, edits, renames, removes, imports, and exports definitions with masked secrets.
- Starts Claude or Codex OAuth in the computer's default browser and shows the fallback URL.
- Shows each Paseo workspace's project-level `.mcp.json` servers in an **MCP connections** tab, available in both the workspace view and the Projects/Explorer view.
- Tells each workspace what an agent started there loads (project, local and user-level servers), what it costs in child processes and memory, and warns when the count is heavy enough to exhaust the agent's context.
- Checks every server's health in the background and flags problems per agent, per project, and per user config.
- Lists the tools each server exposes, the way Claude Code's `/mcp` view does, and keeps an always-on chip on every agent's composer with the server count and status.
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

| Status | Meaning | Needs attention |
| --- | --- | --- |
| `ok` | The endpoint answered `initialize`, or is alive and rejected the anonymous request the way the protocol says to (400, 405, 406, a redirect) | no |
| `auth-required` | 401 or 403: an OAuth server. This is how a working server answers a probe with no grant; the editor holds the sign-in. Shown as informational | no |
| `warn` | 404 (wrong path, or an inactive n8n workflow) or a 5xx from the server | yes |
| `down` | Connection refused or reset, DNS failure, TLS rejected, or no answer in 5 seconds | yes |
| `binary-missing` | A stdio command not found on PATH | yes |
| `unknown` | No readable definition | no |

Health notes never contain a URL, query string, token, or header value; the verdict is redacted
before it is cached, shown, or logged. Missing sign-ins are reported per account on the Accounts tab,
which reads each editor's own grant list.

### Composer chip

Every live agent's composer carries one **MCP** chip, always on. It reads the server count and the
one thing worth knowing about them, in this order: `12 MCP · 2 issues` while a server is down,
missing its binary, or answering with an error; `12 MCP · 3 need sign-in` while OAuth servers are
waiting on a grant; `12 MCP · 340 tools` when everything is healthy. Press it to open MCP
management, where the Tools section lives. Turn it off with the **Composer chip** setting.

## Tools each server exposes

The **Tools** section of MCP management, and the **Tools** card on each server's page, show what a
server would hand an agent: every tool's name, title, description and the arguments it takes
(required ones starred), plus the server's own name and version from the handshake. The host asks
each HTTP server with the same two requests a client sends, `initialize` then `tools/list`, a few
servers at a time, and caches the answer; the section reads the cache, and **Refresh** asks again.

Nothing is guessed. A server that cannot be asked says why:

| Shown as | Meaning |
| --- | --- |
| `N tools` | The server answered `tools/list`; expand the row to read them |
| `sign in to list` | An OAuth server: it answers an anonymous request with 401 and lists its tools only to a signed-in editor |
| `runs on demand` | A stdio (command) server: its tools are only knowable while an agent has it running, and the plugin does not start processes |
| `not listed` | The endpoint answered but not with MCP (a web page at the URL, a JSON-RPC error, a timeout), with the redacted reason |

Tool descriptions are text the server controls; they are flattened to one capped line before they
are stored or shown. The data carries each tool's name and argument list so a per-tool policy
control can be added alongside it later.

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

Health issues under the count are split the same way: servers this workspace loads first, each with
an **Open** button that lands on that server in MCP management, and problems elsewhere folded away.

## AgentLink integration

AgentLink is optional. Standard `~/.claude`, `~/.codex`, `~/.kimi-code`, and `~/.grok` setups work on their own.

When [AgentLink](https://github.com/itsjustanks/agent-link) account directories exist under `~/.agent-link` or `~/.agent-auth`, Paseo MCP discovers them automatically. It also reads hand-managed `~/.claude-accounts` and `~/.codex-accounts` directories. OAuth remains per account and is never copied.

## Development

```sh
npm install
npm run typecheck
paseo plugin add /absolute/path/to/paseo-mcp --link
```

Paseo's plugin host supplies the runtime. The npm dependencies are development types only.
