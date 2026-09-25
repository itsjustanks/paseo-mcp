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

- Adds servers from a gallery: recommended official servers, libraries you subscribe to by address or file (the MCP Gallery by default, your team's own list, a private registry), and optionally the MCP Registry, with trust badges (see [Add from catalogue](#add-from-catalogue)).
- Shows user-level MCP servers across Claude Code, Codex, Kimi Code, and Grok, one card per server with its editors, health, tools and sign-in state.
- Adds, edits, renames, imports, and exports definitions with masked secrets; removes a server from one editor, all editors, or everywhere including project `.mcp.json` files.
- Turns servers on or off per workspace from the workspace and agent panels, where the editor has such a switch.
- Starts Claude or Codex OAuth in the computer's default browser and shows the fallback URL.
- Shows each Paseo workspace's project-level `.mcp.json` servers in an **MCP connections** tab, available in both the workspace view and the Projects/Explorer view.
- Tells each workspace what an agent started there loads (project, local and user-level servers), what it costs in child processes and memory, and warns when the count is heavy enough to exhaust the agent's context.
- Checks every server's health in the background and flags problems per agent, per project, and per user config.
- Lists the tools each server exposes, the way Claude Code's `/mcp` view does, and keeps an always-on chip on every agent's composer with the server count and what their tool definitions cost that agent (`14 MCP · ~38k tokens`), or its status when something is wrong.
- Shows, per agent, which servers the chat actually used and which it loaded without using, and turns the unused ones off for the workspace in one confirmed step. `/mcp` in a composer opens that panel.
- Puts a small "needs sign-in" card in the chat when a tool call fails for lack of a sign-in, with a Connect button.
- Shows and switches Paseo's own built-in tools (the `mcp__paseo__*` tools the daemon adds to agents): for the whole host, per provider, and per tool.
- Syncs MCP definitions and Claude project trust to discovered account directories without copying OAuth grants.
- Keeps backups before config writes and preserves destination-specific credentials.

## Add from catalogue

**Servers → Add server** opens a gallery. Search it, filter by category, and press **Add** on a card; **Add by hand**
keeps the old form. Each card says who publishes it, whether it is **Official**, **Library**, **Team** or **Community**,
whether it is **Remote** or **Runs locally**, whether it signs in with **OAuth**, needs a **Key**, or has **No auth**,
and which library it came from.

| Shelf | Where it comes from |
| --- | --- |
| Recommended | 31 official servers shipped with the plugin (`shared/catalog-curated.ts`), each URL copied from the vendor's docs, which the card links to. Always shown; a library never hides one (see Merging) |
| Libraries | Every library in **Libraries** at the bottom of the gallery, most trusted first (see Merging). By default that is the **MCP Gallery** (`https://raw.githubusercontent.com/itsjustanks/mcp-gallery/main/v0.1/servers.json`). Add your own by address or file; the 0.12.0 team catalogue is now the library called **Team** |
| Registries | A library whose address is a registry, searched once you type two letters, latest versions only, cached a day per search, up to three pages of 100. The official **MCP Registry** (`registry.modelcontextprotocol.io`) is listed but off; switch it on in **Libraries**. Only remote servers are added in one click. A server that only ships a package (npm, PyPI, an image) is shown, marked "Runs code on this server", with its **Repository** and **Add by hand** (the form opens with its name filled in, nothing else) |

### Libraries

A library is JSON in the official MCP Registry's list shape: `{ "servers": [ { "server": <server.json>, "_meta": { … } } ],
"metadata": { "count": N } }`, each `server` a [server.json](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md)
(`name`, `description`, `version`, `remotes` or `packages`). The gallery's curation is optional, in
`_meta["io.github.itsjustanks/mcp-gallery"]`: `{ "id", "displayName", "category", "publisher", "iconUrl", "auth":
"oauth" | "token" | "none", "docsUrl", "verifiedAt" }`. Without it the card uses `title`, `websiteUrl`, `repository` and
`icons` from server.json; a field that doesn't fit (an http icon, one over 2048 characters) is ignored on its own. The
category is one of the gallery filter's names (`developer`, `data`, `docs`, `productivity`, `design`, `crm`, `support`,
`marketing`, `analytics`, `payments`, `automation`); the older words map to the closest (`database` → data,
`documentation` → docs, `observability` and `ai` → developer, `websites` → design) and anything else is Other. A 0.12.0
team catalogue file (a list of entries) reads as a library too, its text cleaned of hidden characters like any other.

```json
{
  "servers": [
    {
      "server": {
        "name": "com.acme/mcp",
        "description": "Acme orders and invoices.",
        "version": "2.1.0",
        "remotes": [{
          "type": "streamable-http",
          "url": "https://mcp.acme.com/mcp",
          "headers": [{ "name": "Authorization", "value": "Bearer {ACME_TOKEN}", "isRequired": true, "isSecret": true,
                        "variables": { "ACME_TOKEN": { "description": "Acme API token", "isRequired": true, "isSecret": true } } }]
        }]
      },
      "_meta": { "io.github.itsjustanks/mcp-gallery": { "displayName": "Acme", "category": "payments", "auth": "token" } }
    }
  ],
  "metadata": { "count": 1 }
}
```

- **Where a library lives.** An https address ending in `.json` is read as one document; any other address is a
  registry, searched through `GET {address}/v0.1/servers?search=…` (**Read as** picks either by hand). A path on the
  host (absolute, or starting with `~/`) is a private library that is never hosted. Plain http is read only from this
  machine (`localhost`, `127.0.0.1`). An address with a user name, a password or a key in its query is refused; a
  private address takes a header name, and its value is set in the panel, write-only, kept in
  `$PASEO_HOME/plugin-settings/paseo-mcp/team-auth.json` (0600), bound to the site of the address it was set for and
  never sent back to the app. It goes only to that site; if the address moves to another site, the value is deleted.
- **Reading.** A library is read in the background and kept for 15 minutes; **Refresh** reads it again. A failed read
  keeps the last good copy, says why, and waits a minute before it is tried again. Until the MCP Gallery is published
  its read fails with "HTTP 404: nothing is published at that address (yet)", and the recommended servers stand in.
- **Merging.** A server name is shown once, and a clash goes by trust, not by the order of the list: **Team** first,
  then libraries you added (by address or file), then the default public ones (MCP Gallery, MCP Registry). The order
  in **Libraries** only matters within each group. A Recommended card is never hidden. A library's copy of a
  Recommended server shows as the Recommended card itself, with the shipped text, docs link and auth, but only when it
  is exactly the same server: for a remote, the same address (query included), header names and templates, values to
  fill in and auth; for a package, the same command and arguments word for word (so the same version and flags) and
  the same environment variables. Anything less (another path, a `?via=…`, an extra header, another version) is its own
  **Library** card beside the Recommended one ("whoever can change that library can change this entry"). A library
  card is never **Official** by itself.
- **Rules.** Every server passes the team catalogue's rules (below): https only, no literal key, no `${…}`, no control
  characters, exact package versions (`npx name@1.2.3`, `uvx name==1.2.3`), no runner flags or runtime variables. One
  that fails is refused, listed by name with the reason, and the rest still show. A package the plugin doesn't start
  (an image, `mcpb`, NuGet) is shown with **Add by hand**. Header, env and argument values are `{PLACEHOLDER}` inputs
  asked for when you add the server, and secret unless their name is on the short public list; a header may be a
  template such as `Bearer {token}`. A library, and the plugin's cache of it, never holds a stored value. A document is
  capped at 1 MB and 500 servers. A server that would not fit a card (an address over 2048 characters, more than 64
  arguments, an argument over 1024) is refused with that reason, listed on the library's row.
- **Rolling back to 0.12.0.** 0.12.0 can't read the version 2 `catalog.json` and would show no team catalogue.
  Paseo rewrites that file in place when it migrates, without a backup, so the plugin keeps the version 1 document
  beside it as `catalog.v1.json` first. Before downgrading, copy it back:
  `cp $PASEO_HOME/plugin-settings/paseo-mcp/catalog.v1.json $PASEO_HOME/plugin-settings/paseo-mcp/catalog.json`.
  The Team key needs nothing; `team-auth.json` also keeps it in 0.12.0's shape.

Anyone can publish to the registry. **Official** is kept for the Recommended shelf and for a registry entry whose every
address is a recommended one, since those addresses were checked against the vendor's own docs. Every other registry
entry is **Community**. Its card shows the namespace as plain text ("published as supabase.com", "published as
github.com/<user>") with one line: the registry checks that the publisher owns that domain or GitHub account, not who
runs the service. `com.supabase/mcp` at `mcp.supabase.com/mcp` is Official; the same name at any other address is
Community. Community cards say what that costs:
"A third party relays your traffic and any key you give it", or "Runs code on this server" for a package. A registry
server that lists no headers reads "Sign-in unclear": the registry can't tell OAuth from no sign-in, so the card says to use
Connect OAuth if the server asks once it is added.

Adding asks where: **My editors** (the same editor configs as Apply) or **One project** (its `.mcp.json`). It shows the
exact change per file with secrets masked, and writes nothing until you press Add. A server that runs locally shows the
exact command line on its own line first (`npx @playwright/mcp@latest`). The install is bound to that preview: if the
entry or the change moved since you read it (a team file edited in between), nothing is written and the sheet asks you to
review again. Writes use the same writers as Import
(backup, atomic write, read back). A name that is already taken is never replaced; the sheet offers the next free name or
Skip. Afterwards it runs a health check, offers **Open server to connect** for an OAuth server, and says what the server
adds to the context budget.

A card whose server is already defined somewhere says **Added** and where ("in 3 of 4 editors", "in data-glue"). It
matches the address or the package and its ecosystem (npm, PyPI, OCI), not the name, so an `ikit-notion` at
`mcp.notion.com` counts as Notion, and an npm package never counts as a PyPI one of the same name. Its button reads
**Add to more** and starts with only the missing places picked.

A project's `.mcp.json` is usually in git, so a key never goes into it. Claude Code expands `${VAR}` in `.mcp.json`
(in `command`, `args`, `env`, `url` and `headers`), so a secret becomes a `${VAR}` reference and the sheet names the
variable to set where Claude Code starts (for Paseo agents, the daemon's environment or the provider's env in Paseo's
settings); if one is already set on this host, the sheet says so (by name, never the value). The plugin names every
variable itself, so an entry can't choose which of your variables is sent to its server: `MCP_<ID>_<INPUT>` for a
recommended entry (for example `MCP_HEROUI_PRO_HEROUI_PERSONAL_TOKEN`), and `MCP_TEAM__<ID>__<HASH6>__<INPUT>` or
`MCP_REG__…` for a team or registry entry, where HASH6 comes from the SHA-256 of its address or package, so it can't reuse
a recommended entry's variable. A name Claude Code uses itself (`MCP_CLIENT_SECRET`, `MCP_TIMEOUT` …) is refused.
Inputs are secret by default: only one named on a short list (region, project, workspace, org, team, site, host, port,
database, schema, env, locale, timezone, mode) is written as typed, and not even then when it sits in a header or env
line named otherwise, anywhere in a team or registry entry's address or arguments, or when the value looks like a
credential (`postgres://user:pass@…`, `sk-…`, `ghp_…`, a Slack webhook). Codex does not read `.mcp.json`, and **Add project servers to agents** passes the reference on unexpanded.

The 0.12.0 team file shape still reads: a list of entries, or `{ "entries": [ … ] }`:

```json
[
  {
    "id": "team-n8n",
    "name": "Team n8n",
    "publisher": "Your team",
    "description": "Our workflows as tools.",
    "category": "automation",
    "transport": "http",
    "url": "https://n8n.example.com/mcp/team",
    "headers": { "Authorization": "Bearer {N8N_TOKEN}" },
    "inputs": [{ "id": "N8N_TOKEN", "label": "n8n token", "secret": true }],
    "auth": "header",
    "docs": "https://wiki.example.com/n8n-mcp"
  }
]
```

`transport` is `http` (with `url` and `headers`) or `stdio` (with `command`, `args` and `env`); `auth` is `oauth`,
`header`, `env` or `none`; values the user fills in are `{INPUT}` placeholders declared in `inputs` (secret and required
unless they say otherwise). Addresses must be https. An entry holding a literal key, a password in its URL, a `${…}`
reference, an undeclared placeholder, a control character, or a header name with a `.` is refused and listed with the
reason. A `stdio` entry that runs a package through `npx`, `bunx`, `pnpx`, `npm exec`, `uvx` or `pipx run` must name it
plainly with an exact version (`acme-mcp@1.2.3`, `mcp-server-fetch==1.0.0`): not `latest`, a range, `*`, an address or
no version, and no runner flag that picks another source or runs a shell command (`-p`, `--registry`, `--index-url`,
`--with`, `-c`, `--call`). Its `env` may not set what changes how the runner starts: `NODE_OPTIONS`, `NPM_CONFIG_*`,
`UV_*`, `PIP_*`, `PYTHON*`, `PATH`, `LD_*`, `DYLD_*`, `HOME`, `SHELL`, or a name the plugin reserves (`AWS_*`,
`ANTHROPIC_*`, `HTTPS_PROXY` …). Names, publishers, descriptions and labels are shown without bidi controls, zero-width
or control characters. An `envVar` on an input is ignored. The file must be under 1 MB. **Copy as catalogue entry** on any server card writes that server in this shape, templated so no
stored value is in it: of an address only the scheme and host stay (a host's first label becomes `{HOST_PREFIX}` unless
it is a plain word like `mcp`; a path that is not plain lowercase words becomes `{PATH}`; query keys become `PARAM_1…n`
with their values as inputs); every header and env value is a placeholder; of a command, only the command, its package
and flag names stay.

## Add project servers to agents

Off by default. Turn it on under **Settings → Plugins → Paseo MCP → Project servers**, or run the
**Add project servers to agents** command. This is the plugin's own setting and is mainly for Codex,
which does not read `.mcp.json`. It is not Paseo's **Enable Paseo tools** (`mcp.injectIntoAgents`),
which adds Paseo's own `mcp__paseo__*` tools; that one is on the [Paseo tools](#paseo-tools) card.

| Setting | Default | Meaning |
| --- | --- | --- |
| Add project servers to agents | off | Add the workspace's `.mcp.json` servers to every new agent |
| Providers | Codex | Codex, Claude Code, or both |
| Skip inline-credential servers | on | Leave out entries carrying tokens in `env`, `headers`, `args`, or the URL |

When an agent is created for a chosen provider, the plugin reads `.mcp.json` from the agent's
working directory (or its git root) and adds each server to the agent's MCP configuration. Servers
the agent already defines are kept as-is. Nothing is written to any config file, and a failure to
read leaves the agent unchanged. The daemon log shows `injected N servers into <provider> agent`.

Each agent also gets an **MCP** tab (and the **MCP for this agent** command) listing the workspace's
project servers, with a line showing the agent's provider and whether project servers are added for it.

Settings live on the host at `$PASEO_HOME/plugin-settings/paseo-mcp/injection.json`
(`~/.paseo` by default; the file and its keys kept their 0.10 names). The hook reads that file
directly; if it is missing or invalid, the setting stays off.

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
| Codex | this project's `.mcp.json` (added by **Add project servers to agents**) | The plugin's own `$PASEO_HOME/plugin-settings/paseo-mcp/workspace-disabled.json`; the `agent.create` hook leaves the server out for that directory. |
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
fresh probe and wait for it. Configure it under **Settings → Plugins → Paseo MCP → Health checks**, or run the
**Configure MCP health checks** command.

| Setting | Default | Meaning |
| --- | --- | --- |
| Check servers in the background | on | Probe on a timer, not only when Refresh is pressed |
| Interval | 10 minutes | Time between background checks (1 to 1440 minutes) |
| Composer chip | on | Show an always-on MCP chip on each agent's composer |
| Chat notices: sign-in problems | on | Add one card to a chat when an MCP tool call there fails for lack of a sign-in (see [In-chat sign-in card](#in-chat-sign-in-card)) |

Settings live on the host at `$PASEO_HOME/plugin-settings/paseo-mcp/health.json`; an unreadable or
invalid file means the defaults apply. The daemon log shows `health check: N servers, M need attention, K OAuth`
after each pass.

Background passes only run while a Paseo app is connected to the daemon (any RPC from the app counts;
the composer chip reads the cached verdict once a minute). With no app connected for 15 minutes the
log says `health check: no app connected, pausing until one is` and nothing is probed; the first read
after that answers with the last verdict and refreshes it in the background. A pass that fails is
retried after 1, 2, 4 … minutes, never more often than the interval. Probes run eight at a time.
The tool lists follow the same rules on six times the interval.

Opening a panel never waits on a probe. The cached read answers at once: with the last verdict when
there is one, or with "checking" on a host that has none yet. When there is no verdict, only a saved
one, or one older than the interval (after a pause), a pass starts in the background and the panel
reads again every second until the verdict is in. If a read fails meanwhile, the panel backs off
(2, 4, 8 … minutes, counted from the last successful read) rather than asking every second.

The last verdicts and tool lists are also kept on disk, so a plugin reload, an update or a daemon
restart does not start from nothing. After a restart the first read shows the saved verdict and tool
lists marked "as of HH:MM (saved before the plugin restarted)" and checks again straight away. The
file is `$PASEO_HOME/plugin-data/paseo-mcp/cache.json` (the same `plugin-data/<id>` place Shared
Browser uses), written atomically once per completed pass, `0600`, and only while an app is connected.
It holds no URLs, query strings, header values, env values or command arguments: servers are keyed by
name and a hash of their URL, headers and command, and notes are the same redacted ones the panels
show. It does hold what the panels show next to each server: account labels (with the account's
email), config file paths and the stdio command name. Treat it like `~/.claude.json`, which holds all
of that and more: don't share it. A tool list last read more than 7 days ago is not restored, and a
server that stops answering keeps its old list for at most 7 days. A corrupt file, or one from another
version, is ignored. Deleting it is safe.

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

Every live agent's composer carries one **MCP** chip, always on. It reads the number of servers
that agent loads and the one thing worth knowing about them, in this order: `14 MCP · 2 issues`
while a server is down, missing its binary, or answering with an error; `14 MCP · 3 need sign-in`
while OAuth servers are waiting on a grant; otherwise what their tool definitions cost that agent,
`14 MCP · ~38k tokens`, or `14 MCP · deferred` when its provider's tool search is on (see
[Context meter](#context-meter)). Until the estimate is in, or on a host older than 0.14.0, the chip
reads as it did before (`12 MCP · 340 tools`). Press it, or type `/mcp` in the composer, to open that
agent's **MCP** panel: the servers it loads with their switches, sign-in, tools and context cost,
plus a **Manage all servers** button to the full surface. Turn the chip off with the **Composer chip**
setting.

Paseo ranks its own slash commands first, then plugins', then the provider's, so in Paseo's composer
`/mcp` opens this panel and hides the provider's own `/mcp`, which only works interactively in the
CLIs anyway. A message with an attachment still reaches the provider.

The chip never makes a network call or starts a process: its estimate uses cached tool counts only.

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

Where the tool list comes from:

- **Live**, when the daemon has no password. `/mcp/agents` is then open, so the host asks it for
  `tools/list` at the address the daemon bound, which Paseo writes to `listen` in
  `$PASEO_HOME/paseo.pid`. When that file is missing or has no address, it uses `PASEO_LISTEN`,
  `daemon.listen` in `config.json`, or `127.0.0.1:$PORT` (default 6767). The card says "Tool list live from this host".
  The host asks once at most every ten minutes, in the background, or now when you press
  **Refresh**. A failed ask is not retried before then, and a good list is kept until a newer one
  replaces it.
- **The catalogue** in `shared/paseo-tools.ts`, copied from Paseo 0.9.1, otherwise. With a password
  (`PASEO_PASSWORD` or `daemon.auth.password`), `/mcp/agents` wants a per-run token that only
  agents get. The plugin never sends or guesses one. The card says "as of Paseo 0.9.1". When the host
  runs another Paseo version, the card and the Overview line add: "This list is from Paseo 0.9.1;
  this host runs X, so new tools may be missing and removed ones may still show." The version is
  read from the `@getpaseo/server` package the daemon started the plugin from.

The card also points to **Add project servers to agents** for servers from a project's `.mcp.json`.

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

- the workspace's `.mcp.json` (read natively by Claude Code, or added by **Add project servers to agents** for the chosen
  providers),
- Claude Code's per-directory ("local") entries for that workspace,
- the editor's user-level config (`~/.claude.json`, `~/.codex/config.toml`, …), which loads in
  every workspace.

A name defined at two levels is counted once. The workspace tab shows the heaviest wired editor;
the agent tab shows the agent's own provider.

The agent tab also lists servers the agent was actually started with that no editor config or Paseo
tools explain, tagged **Added when created**: other plugins add these from their own `agent.create`
hooks (Shared Browser's `shared-browser`, for one), and whoever creates an agent can pass its own. Each shows its name and transport; an HTTP one
shows its tool count from the same probe the Tools view uses (asked in the background, at most
every ten minutes), a stdio one says "runs on demand". They count towards that agent's budget, at
their real tool count where the probe has one and five otherwise. They come from the record the
daemon writes after every hook ran (`$PASEO_HOME/agents/<project dir>/<agent id>.json`, read-only);
Paseo's agent API does not return an agent's servers, and a hook only sees what plugins earlier in
id order added. The workspace tab has no agent, so it cannot know these and does not count them. Under the count: how many are **stdio** (a child
process per agent session) versus **http** (no local process), how many need attention here versus
elsewhere, and a **Running now** section listing the MCP server processes currently running for
this workspace with their resident memory. That section reads the daemon host's process table
(`ps`, `/proc` on Linux, `lsof` on macOS), attributing a server to the workspace when its agent, or
the server process itself, works in the workspace directory. When the table cannot be read the panel
says so rather than showing a zero.

### Context meter

The agent tab's **Context** section estimates what that agent's MCP tool definitions cost, the same
number the chip shows:

| Server | Counted as |
| --- | --- |
| Listed HTTP server | Measured: each tool's name, description and input schema as JSON, ÷ 4, from the raw `tools/list` answer (before descriptions are cut for display) |
| Added when created, HTTP | Measured the same way from its own probe |
| Paseo tools (built in) | 135 tokens per tool, measured on Paseo 0.9.1's own `tools/list` (61 tools, about 8,250 tokens) |
| Anything not listed (stdio, OAuth before sign-in, unreachable) | 2,500: five tools at 500, an assumption between Paseo's measured 135 and the roughly 1,500 per tool Anthropic reported for large servers |

A server switched off for the workspace is not counted. Every number is an estimate and says "≈" or
"~". When the agent has reported its context use, the section adds "This chat: 360k of 1M context; MCP
definitions ≈38k of that." With tool search on, the definitions load on demand, so the chip says
"deferred" and the panel says so instead of claiming a share. **Heaviest servers** lists each server,
biggest first, with how it was estimated.

Below that, from the agent's own timeline: **Used in this chat** ("supabase ×4, linear ×1") and
**Loaded but unused** with their names. The host reads the timeline through Paseo's plugin API, the
newest 2,000 items at most, in the background, and keeps the answer a minute; the panel says when older
items were not read. Claude agents' tool calls are named `mcp__<server>__<tool>` and Codex agents'
`<server>.<tool>`; both are mapped to the servers the agent loads. A name two loaded servers could own
counts for both.

**Turn off the unused ones for this workspace** uses the same per-workspace switches as the rows
below it. It asks first, names exactly the servers that change, and applies to new sessions only.
It only offers servers that have a switch for this provider and are on now; unused servers without
one are named and left alone. It is never offered when the chat is longer than the 2,000 items read or
the last read failed; the panel says which. On confirm the host reads the whole chat again and
switches off only if its own list matches the one you confirmed; otherwise it switches nothing and
asks you to review again. A call to a server outside the loaded list counts as a use of any loaded
server it could belong to.

### In-chat sign-in card

With **Chat notices: sign-in problems** on (the default), when an MCP tool call in a chat fails with
an auth-shaped error (401 or 403, "unauthorized", "invalid_token", "needs authentication"), the host
adds one small card to that chat: "linear needs sign-in", with **Connect**. Connect opens the agent's
MCP panel with that server's sign-in rows first, the same OAuth flow as its row. The card carries the
server and provider names only, never the error text.

There is at most one card per server per chat, even across plugin restarts: the first time a chat is
seen, its timeline is read back for an earlier card, and if that read fails nothing is added. The host
checks each finished turn only while a Paseo app is connected; the panel's chat read catches failures
from before that. Paseo's own server never gets a card.

### Context-budget warning

Without tool search, every server's tool definitions are sent to the agent with its first prompt.
Cursor stops at 40 tools and warns that some models ignore more. The panel warns at **8** servers ("getting heavy", about 40
tools at five per server) and flags **16** or more as "over budget" (about 80 tools, well over 100K
tokens before any work, the range where Paseo-launched agents fail with "Prompt is too long"). The
warning lists the user-level servers the agent loads, since those are the ones that can be moved into
one project's `.mcp.json` or removed from the editor config, with a button to MCP management. The
thresholds live in `shared/budget.ts`.

The server lines assume five tools per server. Paseo's built-in server is counted by its real
number of tools (61, or 39 without browser tools), so a second check counts tools: about 40 is
"getting heavy" and 80 "over budget", the same lines as 8 and 16 servers at five each. The worse of
the two checks wins. Without Paseo tools both checks always agree, so the numbers are unchanged.

#### Tool search

Claude Code's MCP tool search is on by default: it loads tool names at the start and definitions
only when needed, so a long tool list costs little context. The host judges it per provider
(`shared/tool-search.ts`) and the panel says which applies:

| Verdict | When | Budget |
| --- | --- | --- |
| **on** | A Claude-based provider with none of the settings below, or `ENABLE_TOOL_SEARCH` set to `true`, `auto`, or `auto:N` with N up to 10 (`auto`'s own threshold) | The tool check does not raise the tier; the server check still does (stdio processes and connections are real). One line: "Claude Code's tool search is on: tool definitions load up front only while they fit in 10% of the context window, and on demand past that." |
| **off** | A custom `ANTHROPIC_BASE_URL` (any host but `api.anthropic.com`), `ENABLE_TOOL_SEARCH=false`, or `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`, which Claude Code says keeps tool search off even with `ENABLE_TOOL_SEARCH` set, unless managed settings set it (source 5). Also every non-Claude CLI except Codex. | As before, and the warning names the reason: "AI Router re-routes this provider through OmniRoute (custom ANTHROPIC_BASE_URL) whenever its endpoint is up, so Claude Code's tool search is off and all 76 tool definitions load with the first prompt." |
| **unknown** | Codex (it defers MCP tools only when the model supports tool search), Claude on Google Cloud's Agent Platform or Microsoft Foundry, `ENABLE_TOOL_SEARCH=auto:N` with N above 10 (tools load up front until they fill N% of the context window) or outside 0-100, or a provider whose CLI is not known | As before, with the reason |

Sources, later ones winning:

1. The daemon's own environment.
2. The provider entry's `env` in the daemon config. A provider with `extends: "claude"` (or another
   built-in) starts with that built-in's `env` and puts its own on top, as Paseo does.
3. AI Router. It routes the built-in `claude` provider while its **routeAgents** setting is on
   (read-only from `$PASEO_HOME/plugin-settings/ai-router/routing.json`; a missing or unreadable
   file, or a `version` other than 1, means not routed, as AI Router reads it). It always routes
   its own `ai-router` provider. A routed session gets both `ANTHROPIC_BASE_URL` and
   `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`.
4. The `env` in Claude Code's own settings files: the user `settings.json` in the provider's
   `CLAUDE_CONFIG_DIR` (or `~/.claude`), then, on the workspace and agent panels, the workspace's
   `.claude/settings.json` and `.claude/settings.local.json`. Claude Code's docs say a value there
   "overwrites the same variable exported in your shell, and when more than one settings file sets
   a variable, the highest-precedence one applies"
   ([settings reference, `env`](https://code.claude.com/docs/en/settings-reference#env)); local
   beats project beats user ([settings precedence](https://code.claude.com/docs/en/settings#settings-precedence)).
   An empty value cancels one set lower down. A missing or broken file counts as not there.

5. Claude Code's managed settings, above everything: `managed-settings.json` and then every `*.json`
   in `managed-settings.d/` (alphabetical, hidden files skipped), in
   `/Library/Application Support/ClaudeCode/` on macOS, `/etc/claude-code/` on Linux and WSL
   ([managed settings](https://code.claude.com/docs/en/managed-settings)). Read for Claude-based
   providers only. A managed `ENABLE_TOOL_SEARCH` decides even over
   `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` and AI Router's routing: Claude Code ignores "a value you
   set yourself" under that flag, but "on Claude Code v2.1.227 or later, managed settings can keep
   tool search on" ([env vars](https://code.claude.com/docs/en/env-vars)). The docs name no other
   key for this, so the plugin takes a managed `env.ENABLE_TOOL_SEARCH` as the override. It cannot
   see the CLI version without starting it, so the panel says the override needs v2.1.227 or later:
   "Managed settings (/etc/claude-code/managed-settings.json) keep tool search on, even with
   CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS set (this needs Claude Code v2.1.227 or later)." On Google
   Cloud's Agent Platform or Microsoft Foundry the override "has no effect", so those stay unknown.
   A missing or broken file counts as not there. The macOS configuration profile, the Windows
   registry and server-managed settings are not files and are not read.

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
