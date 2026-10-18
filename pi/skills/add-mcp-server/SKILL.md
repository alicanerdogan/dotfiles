---
name: add-mcp-server
description: Add an MCP server to pi. Use when asked to "add mcp server", "configure mcp", "add mcp", "new mcp server", "setup mcp", "connect mcp server", or "register mcp server". Handles both global and project-local configurations.
---

# Add an MCP Server

Add an MCP server to Pi's built-in MCP support. Determine scope and server type, write the config, and verify the connection.

## Step 1: Determine Scope

Ask the user if not obvious from context:

| Scope | Config File | When to Use |
|-------|-------------|-------------|
| **Global** | `~/.pi/agent/mcp.json` | Server used across all projects |
| **Project** | `.pi/mcp.json` (project root) | Server specific to one project |

Project configs are read only in trusted projects. A project entry replaces a global entry with the same name.

## Step 2: Determine Server Type

MCP servers connect via **stdio** (local process) or **streamable HTTP** (remote URL). The legacy SSE transport is not supported.

**Stdio server** — runs a local command:
```json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "package-name@latest"],
      "env": { "KEY": "value" }
    }
  }
}
```

**HTTP server** — connects to a URL:
```json
{
  "mcpServers": {
    "server-name": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${TOKEN}" }
    }
  }
}
```

## Step 3: Gather Configuration

Collect only what's needed. Everything except `command`/`url` is optional.

| Field | Type | Description |
|-------|------|-------------|
| `command` | string | Executable to run (stdio). One executable, not a shell string |
| `args` | string[] | Command arguments (stdio) |
| `env` | object | Environment variables (stdio). Values may use `${VAR}` |
| `cwd` | string | Working directory (stdio). Relative paths resolve against the session dir |
| `url` | string | Server URL (streamable HTTP) |
| `headers` | object | HTTP headers (HTTP). Values may use `${VAR}` |
| `type` | `"stdio"` / `"http"` / `"streamable-http"` | Optional; inferred from `command` vs `url` |
| `description` | string | One sentence about the server, shown in the system prompt |
| `timeout` | number | Per-request timeout in seconds (default 60) |
| `enabled` | boolean | Set `false` to keep the entry without connecting |
| `exposure` | see below | How tools reach the model (default: `codemode`) |

Server names may contain only letters, digits, `_`, and `-`. Tools are registered as `mcp__<server>__<tool>`.

### Exposure

| Exposure | Behavior |
|----------|----------|
| `codemode` (default) | Callable from `codemode` scripts; not declared directly |
| `deferred` | Loaded into the model by `tool_search` on demand |
| `direct` | Declared like a built-in tool; use for small, frequently used tool sets |
| `hidden` | Registered but unreachable |

`toolExposure` overrides exposure per tool. Keys are exact server tool names or `*` patterns:
```json
{
  "exposure": "deferred",
  "toolExposure": { "search_code": "direct", "delete_*": "hidden" }
}
```

## Step 4: Write the Config

Preferred: use the shell command, which writes the right file and shape without loading a session.

```bash
# Global stdio server
pi mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .

# Global HTTP server with OAuth
pi mcp add docs --url https://example.com/mcp

# Project-local server
pi mcp add -l tools --env API_KEY='${TOOLS_KEY}' -- uvx tools-mcp
```

Options: `--env KEY=VALUE`, `--cwd <dir>`, `--header KEY=VALUE`, `--bearer-token-env-var <NAME>`, `--oauth-client-id`, `--oauth-client-secret`, `--oauth-callback-port`, `--oauth-client-name`, `--exposure <mode>`, `--description <text>`, `--local`/`-l`.

To edit JSON manually:

1. Read the target config file if it exists
2. Merge the new server into the existing `mcpServers` object
3. Write the updated JSON

If the file doesn't exist, create it with the full structure:
```json
{
  "mcpServers": {
    "server-name": { ... }
  }
}
```

Warn if a server with the same name already exists and confirm before overwriting.

## Step 5: Verify

1. Run `pi mcp list` to connect every enabled server and print its state, tools, and errors. It exits `1` on an invalid entry or a failure.
2. In an interactive session, `/mcp` inspects connections and can change exposure or enabled state; run `/reload` after editing a config file outside the session.
3. Report success or troubleshoot connection errors. OAuth servers that need sign-in: run `/mcp login <server>` or `pi mcp login <server>`.

Remove a server with `pi mcp remove <server>` (stored OAuth credentials are kept).
