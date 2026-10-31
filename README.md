# mcp-workspace

Start combined Filesystem and sandboxed Terminal MCP tools for the directory you are in, then expose them with a temporary Cloudflare Quick Tunnel.

```bash
cd ~/projects/my-app && mcp-workspace
```

The launcher prints a Streamable HTTP URL after it confirms MCP initialization and discovers tools from both underlying servers. Keep the terminal open while using it; press **Ctrl+C** to stop both child processes. Each run uses the current directory and gets a new temporary URL.

## Prerequisites

- Linux or macOS
- Node.js 24 or newer, npm, and `npx`
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
- Network access to npm on first launch so `npx` can fetch the pinned packages

Install the command from npm or GitHub:

```bash
npm install -g mcp-workspace
# or, until the npm release is published:
npm install -g github:thirtythreeabhi/mcp-workspace
```

Or clone this repository and run `./install.sh`. Ensure `~/.local/bin` is on `PATH`.

## Pinned dependencies

The launcher uses these exact published versions:

- [Supergateway 4.2.1](https://www.npmjs.com/package/supergateway) for the Streamable HTTP gateway
- [@modelcontextprotocol/server-filesystem 2.1.0](https://www.npmjs.com/package/%40modelcontextprotocol/server-filesystem), restricted to the current directory
- [nanosandbox-mcp 0.3.3](https://www.npmjs.com/package/nanosandbox-mcp) for sandboxed terminal commands

## Startup and shutdown

The launcher checks Node.js and required commands, validates the port, and fails if the local port is occupied. It writes the gateway configuration to a private temporary directory, starts the gateway, and waits for a successful MCP initialize and `tools/list` response that includes both `filesystem_` and `terminal_` tools. It then starts Cloudflare Tunnel and checks the public URL with the same MCP exchange before announcing readiness. Startup checks time out after 90 seconds and print relevant diagnostics.

The launcher monitors both child processes. If either stops, it terminates its peer and exits nonzero. SIGINT and SIGTERM stop both process groups, wait briefly, force-stop any survivor, and remove temporary configuration and logs.

## Protocol compatibility

Supergateway 4.2.1 and the pinned servers expose the legacy MCP `initialize` / `tools/list` exchange over Streamable HTTP. Readiness negotiates protocol version `2025-11-25`. A client that sends `2026-07-28` may be rejected by an MCP SDK that only lists earlier protocol versions; upgrading the launcher’s package pins does not automatically make every client protocol date compatible. The startup check catches a failed exchange and does not announce an unusable URL. The gateway and server SDKs must both implement the client’s requested protocol before that date is supported end to end.

## Defaults and limits

- Gateway binds to `127.0.0.1`; Cloudflare Quick Tunnel forwards to it.
- Authentication is intentionally disabled. Leave authentication and custom headers blank in your MCP client.
- Filesystem tools can read and write only under the selected directory.
- Terminal commands run in nanosandbox with the selected workspace writable and the Node.js installation read-only. Network access is disabled, command time is capped at 180 seconds, memory at 1 GB, output at 1 MB per stream, and concurrency at one. Linux also caps CPU and process count.
- The launcher generates a new temporary URL each run and stores no credentials.

**Unauthenticated Quick Tunnels are public.** Anyone who obtains the current URL can invoke the tools while the launcher is running. Use it only for workspaces you are comfortable exposing, and stop the launcher when finished.

## Troubleshooting

- **Node.js version error:** install Node.js 24 or newer and reopen your terminal.
- **Missing command:** install npm/Node.js or `cloudflared` and ensure it is on `PATH`.
- **Port already in use:** choose another port, for example `MCP_WORKSPACE_PORT=8790 mcp-workspace`.
- **Gateway or tool discovery timeout:** check npm connectivity and inspect the launcher error output; the startup check requires both underlying servers to initialize and publish tools.
- **Unsupported protocol version:** configure the client to request `2025-11-25` if it supports version selection. If it only requests `2026-07-28`, this dependency set cannot promise compatibility; no authentication setting changes this protocol limitation.
- **Tunnel timeout:** check `cloudflared` connectivity and retry. The launcher exits and cleans up if it cannot verify the URL.

## Tests

Run `npm test` for the local automated suite. It uses mocks and does not require a public tunnel.

To use a different local port:

```bash
MCP_WORKSPACE_PORT=8790 mcp-workspace
```

The script exposes only the directory from which it is launched and accepts no workspace path argument.
