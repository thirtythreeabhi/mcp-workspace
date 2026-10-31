# mcp-workspace

Start a combined Filesystem + Terminal MCP server for the directory you are in, then expose it through a temporary Cloudflare Quick Tunnel.

```bash
cd ~/projects/my-app
mcp-workspace
```

The launcher prints one Streamable HTTP URL for Groq Playground. Keep the terminal open while using the MCP server; press **Ctrl+C** to stop it. Each run uses the current directory and produces a new temporary URL.

## Install

Requirements: Linux or macOS, Node.js/npm, `cloudflared`, and a working `npx` connection to npm on first run.

```bash
git clone https://github.com/thirtythreeabhi/mcp-workspace.git
cd mcp-workspace
./install.sh
```

Make sure `~/.local/bin` is on `PATH`. Open a new terminal (or update the current shell's `PATH`) before running `mcp-workspace`.

The launcher fetches pinned versions on first run:

- [Supergateway](https://github.com/supercorp-ai/supergateway) 4.2.1 — combines the servers behind one Streamable HTTP URL.
- [Official Filesystem MCP server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) 2.1.0 — restricted to the current directory.
- [nanosandbox-mcp](https://github.com/Erio-Harrison/nanosandbox) 0.3.1 — runs Terminal commands in a sandbox restricted to the current directory.

## Groq Playground

Add one MCP server with the URL printed by the launcher. Select **Streamable HTTP**. Leave authentication and custom headers blank. The tools appear with `filesystem_` and `terminal_` prefixes.

## Defaults and limits

- The local gateway binds to `127.0.0.1`; Cloudflare Tunnel forwards to it.
- Authentication is disabled, as configured by the user.
- Filesystem tools can read and write under the selected directory.
- Terminal commands run in `nanosandbox-mcp`; the selected directory is writable, network access is disabled, command time is capped at 180 seconds, memory at 1 GB, output at 1 MB per stream, and concurrent commands at one. Linux also caps CPU and process count.
- The Node.js installation directory is mounted read-only so commands such as `node --test` and `npm test` can use the installed runtime. Other host files and credentials are not deliberately mounted.

**Unauthenticated Quick Tunnels are public.** Anyone who obtains the current URL can invoke the exposed tools while the launcher is running. Use this only for workspaces you are comfortable exposing, and stop the launcher when finished. Quick Tunnel URLs are temporary and change on later runs.

The launcher uses a temporary config file with mode `0600` and removes it on exit. No credentials are stored by this project.

## Options

Set a different local port if `8787` is already in use:

```bash
MCP_WORKSPACE_PORT=8790 mcp-workspace
```

The script only exposes the folder from which it is launched. It does not accept a workspace path argument.
