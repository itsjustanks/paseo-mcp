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
