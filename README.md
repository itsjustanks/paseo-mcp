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
- Checks every server's health in the background and flags problems per agent, per project, and per user config.
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

On by default. The host probes every MCP server on a timer: HTTP endpoints are fetched (a 401/403
reads as "sign-in"), stdio commands are looked up on the login shell's PATH. The most recent result
is cached on the host, and every panel, pill, and the MCP surface reads that cached verdict, so
opening ten agents never probes your servers ten times. **Refresh** and **Check now** still run a
fresh probe. Configure it under **Settings → Plugins → Paseo MCP → Health checks**, or run the
**Configure MCP health checks** command.

| Setting | Default | Meaning |
| --- | --- | --- |
| Check servers in the background | on | Probe on a timer, not only when Refresh is pressed |
| Interval | 10 minutes | Time between background checks (1 to 1440 minutes) |
| Composer pill | on | Show a pill on each agent's composer while a server needs attention |

Settings live on the host at `$PASEO_HOME/plugin-settings/paseo-mcp/health.json`; an unreadable or
invalid file means the defaults apply. The daemon log shows `health check: N servers, M need attention`
after each pass.

### Composer pill

While any server is down, missing its binary, or waiting on a sign-in, every live agent's composer
shows an **MCP issue** pill with the count (and how many of those are defined by the agent's own
project). Press it to open MCP management. When everything is healthy there is no pill at all; it
appears when something breaks and goes away once it is fixed.

### Project level vs user level

Each health result carries the configs that define the server: an editor's global config
(`~/.claude.json`, `~/.codex/config.toml`, …) is **user level** and affects every workspace; a
`.mcp.json` in a registered project is **project level**. The workspace and agent panels list issues
under three headings — this project, user config, other project — and tag each project server row
with its health. A server defined at both levels is probed once, using the editor's copy, since that
is what the editor actually runs.

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
