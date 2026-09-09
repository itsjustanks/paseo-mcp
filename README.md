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
- Shows each Paseo workspace's project-level `.mcp.json` servers.
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
