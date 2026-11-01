# mcp-workspace

Start combined Filesystem, sandboxed Terminal, and workspace-scoped Developer MCP tools, plus a separate video-editing MCP endpoint for the directory you are in. Expose them using a zero-setup Cloudflare Quick Tunnel, a named Cloudflare Tunnel, or a free static ngrok development hostname.

```bash
cd ~/projects/my-app && mcp-workspace
```

The launcher prints two Streamable HTTP URLs only after it confirms local and public MCP initialization and discovers workspace and video tools. Keep the terminal open while using it; press **Ctrl+C** to stop the supervised processes. Each run exposes the current directory. In default Quick Tunnel mode the URL changes on every launch; named Cloudflare or ngrok modes below keep the same hostname.

## Prerequisites

- Linux or macOS
- Node.js 24 or newer, npm, and `npx`
- Either [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (default) or [`ngrok`](https://ngrok.com/download/linux) (static dev URL without owning a domain)
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

The launcher checks Node.js and required commands, validates the port, and fails if the local port is occupied. It writes the gateway configuration to a private temporary directory, then starts Supergateway and the selected tunnel provider **concurrently**. Local and public MCP initialize / `tools/list` probes also run concurrently, checking both the workspace tools and the separate Video MCP tool list. It announces the URLs only after all local and public checks succeed. Startup stages and elapsed time print to stderr. Both probes have 90-second readiness windows; they are no longer sequential. The pinned `npx` packages prefer the npm cache on repeat launches.

The launcher monitors both child processes. If either stops, it terminates its peer and exits nonzero. SIGINT and SIGTERM stop both process groups, wait briefly, force-stop any survivor, and remove temporary configuration and logs.

## Static MCP URL without a domain: ngrok free plan

ngrok assigns one persistent development hostname to every free account (currently commonly ending in `.ngrok-free.dev` or `.ngrok-free.app`). It stays assigned across agent restarts. No domain purchase, Cloudflare login, or named Cloudflare Tunnel is required.

One-time Ubuntu setup:

1. Create a free account at https://dashboard.ngrok.com and find your assigned development hostname under **Gateway → Domains**.
2. Install the ngrok CLI using the official Ubuntu instructions: `sudo snap install ngrok` (if Snap is available), or https://ngrok.com/download/linux.
3. Add your **private** authtoken locally: `ngrok config add-authtoken YOUR_TOKEN`. Copy the token from your ngrok dashboard; do not paste it into ChatGPT.
4. Reinstall this source repository (`cd ~/Downloads/mcp-workspace && ./install.sh`), then launch from the project you want to expose:

```bash
cd ~/Downloads/rupee-os
MCP_WORKSPACE_NGROK_URL=https://YOUR-ASSIGNED-NAME.ngrok-free.dev mcp-workspace
```

Replace the URL above with **your own exact assigned ngrok dev domain** (no `/workspace/mcp` suffix in the variable). You can make the setting persistent by adding an `export MCP_WORKSPACE_NGROK_URL=https://YOUR-ASSIGNED-NAME.ngrok-free.dev` line to `~/.bashrc`, then opening a new terminal. After that just run `mcp-workspace` in your project.

The launcher starts `ngrok http 8787 --url https://YOUR-ASSIGNED-NAME.ngrok-free.dev` (using `MCP_WORKSPACE_PORT` if changed) alongside the local MCP gateway. It validates local and public MCP tool discovery **before** printing the endpoint. Register the resulting `https://YOUR-ASSIGNED-NAME.ngrok-free.dev/workspace/mcp` address in ChatGPT once, and keep the tunnel process running when using it. Restarting the process keeps the hostname, although you may need to refresh the ChatGPT connection after tool schema changes.

**Limits and gotchas:** the free plan is subject to request and bandwidth quotas and displays an interstitial warning to browser traffic. Programmatic MCP traffic generally avoids the browser warning, but ChatGPT interoperability must be confirmed using the actual public endpoint; if the warning appears for MCP calls, initialization may fail. The launcher does not bypass it or claim success on an HTML warning response. ngrok exposes the **same unauthenticated tools** as Cloudflare: treat the URL like an access credential. Do not expose your entire Downloads folder when a narrower project directory will do.

For the original temporary URL, leave `MCP_WORKSPACE_NGROK_URL` unset and continue using Cloudflare Quick Tunnel.

## Keep the same ChatGPT MCP connection across restarts with Cloudflare (optional)

**Cloudflare Quick Tunnels cannot keep the same URL.** To avoid creating a new ChatGPT MCP connection on each restart, use a **named, locally managed Cloudflare Tunnel** with your own hostname. You need a Cloudflare account and a domain managed through Cloudflare. There is no accountless permanent `trycloudflare.com` hostname.

One-time setup on **your host machine** (not through the MCP nanosandbox):

1. Run `cloudflared tunnel login` and then `cloudflared tunnel create mcp-workspace`. Save the tunnel UUID from the output.
2. In a domain managed by Cloudflare, route a hostname: `cloudflared tunnel route dns mcp-workspace mcp.example.com` (replace with a hostname under your own domain).
3. Create `~/.cloudflared/mcp-workspace.yml` with your actual UUID and credentials path:

```yaml
tunnel: YOUR-TUNNEL-UUID
credentials-file: /home/YOUR-USER/.cloudflared/YOUR-TUNNEL-UUID.json
ingress:
  - hostname: mcp.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

4. Run `mcp-workspace` with these environment variables (example, set them in your shell's project launcher script to avoid retyping):

```bash
MCP_WORKSPACE_TUNNEL_NAME=mcp-workspace \
MCP_WORKSPACE_PUBLIC_URL=https://mcp.example.com \
MCP_WORKSPACE_TUNNEL_CONFIG="$HOME/.cloudflared/mcp-workspace.yml" \
mcp-workspace
```

Add **`https://mcp.example.com/workspace/mcp`** to ChatGPT once. With this mode the launcher runs the same named tunnel and verifies the public endpoint each time; the address stays constant across restarts. ChatGPT may briefly show a connection error while the process is stopped. If the tool schema changes, reconnect or refresh the ChatGPT connection to rediscover tools.

`MCP_WORKSPACE_PORT` defaults to 8787. If you change it, make sure the YAML `ingress.service` points to the matching local port. The launcher validates the provided hostname and configuration file, but does not create your Cloudflare account, domain, DNS route or tunnel credentials.

**Security:** The stable URL is publicly reachable and authentication remains disabled by design. Anyone with that URL can invoke the exposed tools. Prefer launching in a single, deliberately chosen project workspace rather than your entire Downloads folder. Never run two different workspaces on the same stable endpoint without knowing which one ChatGPT will access.


## Host-side Remotion rendering and installation — v1.3.0

The Video MCP can install a **fixed, pinned Remotion project** using Ubuntu's network, and render with the host's CPU/RAM instead of the offline nanosandbox. No general-purpose host-shell command is exposed. Dependency installation uses `npm install --ignore-scripts --no-audit --no-fund --no-progress --save=false` with a fixed npm registry and validates the project manifest first. Current pinned Remotion and @remotion/cli version: **4.0.539**.

The starter project is in `~/Downloads/remotion-project`, outside the application codebase. It contains `src/index.ts`, `src/root.tsx` and `src/talentstream.tsx`, an editable 10-second `TalentStreamOpening` composition, a draft-only `TalentStreamV4` placeholder, and local narration/music under `public/`. The full 62-second Remotion film has **not** been designed or rendered yet.

**Important activation step:** video host execution is off by default. Run `./install.sh` from the updated `mcp-workspace` checkout, stop the existing server, and relaunch `mcp-workspace` with environment variable `MCP_WORKSPACE_REMOTION_HOST_ENABLED=1` (and your existing ngrok URL). Restarting interrupts the live MCP connection. The updated Video MCP then exposes `video_remotion_status`, `video_remotion_install_start`, and `video_remotion_render_start`. Call `install_start` once, poll `video_render_status` and `video_render_logs` using its returned job ID, and render only after `remotion_status` confirms installation. Use `video_render_cancel` to abort. This calls Ubuntu host npm; it does not pass through nanosandbox. No arbitrary npm packages, scripts or host command args are accepted.

The Remotion worker does not inject process CPU, memory, Node heap, concurrency or render-duration ceilings. Rendering is governed by Ubuntu, Chrome, available hardware and any applicable OS-level restrictions. It can exhaust host RAM/CPU under load. The existing nanosandbox terminal still inherits independent sandbox/provider limits even though this version omits the explicit `--cpu`, `--memory` and `--timeout` flags from its launcher configuration.

**Security:** both MCP endpoints intentionally have no authentication, and Remotion executes JavaScript from the project directory. A party with access to the public MCP connection and filesystem write capability could modify trusted project source and trigger code execution with the server user's privileges. The opt-in environment flag is **not authentication**. Do not enable host rendering on a publicly discoverable/shared endpoint, and never run this server as root. Use a private tunnel or network access control if you enable host operations.

Remotion has a separate license for some commercial usage; review the current terms at https://www.remotion.dev/license before commercial deployments.

## Separate Video MCP — v1.2.0

The same ngrok or Cloudflare tunnel serves two MCP endpoints on one local port:

- **Workspace:** `https://YOUR-ASSIGNED-DOMAIN/workspace/mcp` — unchanged filesystem, terminal, developer tools
- **Video:** `https://YOUR-ASSIGNED-DOMAIN/video/mcp` — a separate set of eleven tools with the `video_` prefix

You can add the video endpoint as a second ChatGPT custom MCP server. **Authentication stays disabled** on both endpoints. You do not need a second ngrok account, domain, tunnel or local port. Supergateway routes the paths, and the launcher verifies both endpoints before announcing readiness.

Install FFmpeg/FFprobe on Ubuntu for video tools: `sudo apt install ffmpeg` (include libx264 and AAC encoders).

Video tools:

- `video_capabilities` — check installed FFmpeg and FFprobe
- `video_probe` — inspect duration, resolution, codecs and audio
- `video_capture_page` — optional, locally allowlisted Chrome capture into a workspace PNG (see setup below)
- `video_preview_frame` / `video_contact_sheet` — return a single JPEG frame or an eight-frame visual montage
- `video_timeline_save` / `video_timeline_read` — save and edit JSON timelines with SHA-256 checks
- `video_render_start` / `video_render_status` / `video_render_logs` / `video_render_cancel` — render, monitor and cancel background MP4 jobs

Example editable timeline:

~~~json
{
  "width": 1280,
  "height": 720,
  "fps": 30,
  "clips": [
    { "path": "recording.mp4", "start": 2, "end": 8, "speed": 1 },
    { "path": "recording.mp4", "start": 8, "end": 16, "speed": 1.5 }
  ]
}
~~~

Save it as `demo.timeline.json` and render to a **new** file like `demo-edited.mp4`. The parent output directory must exist. Read video results using the existing Filesystem MCP or your local video player; this endpoint does not yet transfer MP4 bytes directly to ChatGPT.

The initial release supports trimming, joining, reordering, speed adjustments and retaining existing audio (adding silence when a clip has none). Clips are normalized and exported as MP4/libx264/AAC. Text overlays, crossfades, subtitles, separate voiceover tracks and Kdenlive project export are not yet implemented.

Inputs and outputs must stay inside the selected workspace; symlinks, path traversal and access to Git internals are rejected. Supported source extensions: MP4/MOV/MKV/WebM/AVI/M4V. Outputs never overwrite an existing MP4. Limits: 24 clips, 30 minutes output, 0.5–2× speed, max 1920×1080; one render worker per workspace, with a two-hour deadline. Render jobs continue after MCP sessions disconnect and persist across gateway reloads. Their records, logs and temporary files live inside ignored `.mcp-video/`.

**Risk:** This is intentionally an unauthenticated endpoint invoking restricted host FFmpeg operations. Parameter restrictions and file-path checks are not a full codec sandbox. Prefer running in a narrow project directory and avoid processing untrusted files.

### Activate when convenient

The source changes do **not** hot-reload your active connection. When ready, stop `mcp-workspace`, run `cd ~/Downloads/mcp-workspace && ./install.sh`, and restart it with the same ngrok settings. Refresh the existing workspace connector, then connect the second URL ending in `/video/mcp`.


### Local frontend screenshots for product videos

The Video MCP source now includes **video_capture_page**, an opt-in Chrome screenshot tool for local development apps. It creates a new PNG under the workspace and returns its relative path, pixel dimensions and SHA-256. It does not use a signed-in Chrome profile or log into an application.

Because this MCP endpoint has no authentication, browser capture is **disabled by default**. To enable it for a specific, locally running dev server, set the capture origin when launching mcp-workspace on the actual Ubuntu host:

~~~bash
# Start the app yourself in a separate terminal, using safe demo data.
# Then launch the MCP server from Downloads, retaining your usual ngrok settings.
cd ~/Downloads
MCP_WORKSPACE_CAPTURE_ORIGIN=http://127.0.0.1:3000 mcp-workspace
~~~

The origin must be http://127.0.0.1:PORT or http://localhost:PORT, without credentials, query strings or arbitrary hostnames. The tool accepts only simple pathnames such as /en and /en/recruiter/dashboard. Calls can specify outputPath, width, height and waitMs (0–6000). Example arguments:

~~~json
{"route":"/en","outputPath":"Organized/Videos/Generated/TalentStream-AI/marketing-capture.png","width":1600,"height":900,"waitMs":1800}
~~~

The parent directory must exist and the screenshot must not exist yet. Chrome runs in a temporary fresh profile with background networking disabled and a localhost-only hostname resolver rule; it doesn't reuse your interactive browser session. Auth-protected pages may redirect to a sign-in screen. Capturing real recruiter screens requires an explicitly configured demo account/session or safe mock mode in the application; this tool does not bypass authentication.

**Operational constraints:** The tool executes Chrome in the host-side video server, not the nanosandbox terminal; headless Chrome cannot run in the current nanosandbox because socket creation is denied. It requires google-chrome installed on the Ubuntu host, a reachable local development app, a host-side source sync/reload and a ChatGPT plugin tool-schema refresh. The existing locally approved maintenance-grant procedure remains necessary for hot deployment. Chrome will process the locally served app and any subresources it requests; the resolver restriction is defense-in-depth, not a security boundary against an untrusted application. Only point it to an app that you trust.

Screenshots are inputs for the existing FFmpeg/Python compositing workflow, not automated UI tours: this tool doesn't click buttons or create authenticated sessions. Your Video MCP's existing timeline functions remain useful for cutting and joining the rendered MP4s.

## Developer tools (v1.3.0)

The first-party stdio developer server exposes fourteen workspace-scoped tools plus two narrowly scoped host-maintenance tools with explicit descriptions and structured JSON responses:

- `developer_code_search` — literal content search with file/extension filters and line numbers (bounded; skips dependencies and generated directories).
- `developer_repo_status` — read branch, HEAD, and staged/unstaged change summaries. Accepts `repoPath` (relative to the workspace) so `~/Downloads` can expose multiple repositories without requiring Downloads itself to be a Git checkout.
- `developer_repo_diff` — bounded, read-only staged or unstaged Git diff. Accepts `repoPath` to select a nested checkout and optional `path` relative to that checkout. Streams Git output and returns `truncated: true` with a partial diff when `maxChars` is exceeded, instead of failing on large diffs.
- `developer_file_hash` — get SHA-256 for a regular file before changing it.
- `developer_edit_checked` — exact-match edits with `expectedSha256`, conflict detection, and optional `dryRun`. Rejects invalid UTF-8 and binary files before writing so file contents cannot be silently re-encoded. Changes are written using a same-directory temporary file and rename; this does not protect against noncooperating host editors racing after the final hash check.
- `developer_read_lines` — read numbered UTF-8 lines from an existing file, with SHA-256, pagination-style line bounds (up to 250 lines), and a bounded response (up to 28,000 characters).
- `developer_apply_patch` — apply a unified diff to up to 12 existing UTF-8 files, each with a supplied expected SHA-256; validates every file and hunk before writing. Supports `dryRun` and rejects new/deleted files, renames, unsafe paths, symlinks, hard links, stale hashes, and unsupported patch formats. Writes are atomic per file, **not transactional across multiple files**.
- `developer_apply_changes` — create, replace, delete or move up to 12 files in a batch with SHA-256 checks, dry runs and best-effort rollback.
- `developer_project_overview` — inspect the top-level structure, detected stack, package manager, scripts, test infrastructure and Git state.
- `developer_job_start` / `developer_job_status` / `developer_job_logs` / `developer_job_cancel` — launch, inspect and cancel managed nanosandbox jobs by ID, one concurrent job at a time. Job records live in the running MCP server process.
- `developer_workspace_diagnostics` — inspect workspace, platform and known sandbox limits.
- `developer_host_status` — read-only comparison of SHA-256 hashes for thirteen pinned source/installed MCP files and the registered host launcher. Does not read arbitrary host paths.
- `developer_host_maintenance` — requires a local one-use five-minute grant and an explicit `reload` or `sync_and_reload` action. For synchronization it verifies all thirteen provided source hashes before writing only the fixed installed files, then reloads the gateway without restarting the tunnel.

All developer paths are relative to the selected workspace; symlink paths and `.git` access through file editing are rejected. Git commands use a restricted environment and disable external diff drivers, text converters, hooks, fsmonitor, and submodule recursion. The Git tools require a checkout whose `.git` is an actual directory and reject linked worktrees/submodules that use `.git` redirection files. The ordinary Filesystem MCP write/edit tools do not enforce SHA-256 checks; use `developer_edit_checked` when stale edits matter. Files larger than 1 MB cannot be edited by `developer_edit_checked` or `developer_apply_patch`. Git operations are read-only. No general host shell, arbitrary host filesystem editing, network execution, or Docker access has been added.

## Host maintenance: installation drift and gateway reloads

This feature is deliberately separate from the unauthenticated sandbox terminal. A public caller can obtain only the fixed-file hash comparison from `developer_host_status`; it **cannot** sync or restart the gateway without a short-lived one-use grant created on the Ubuntu host.

**One-time upgrade from v0.5.0:** In the host terminal, run `cd ~/Downloads/mcp-workspace && ./install.sh`. Stop the old foreground `mcp-workspace` session with Ctrl+C, then run `cd ~/Downloads && mcp-workspace` again using your existing ngrok environment configuration. This first restart cannot be done remotely using the old 21-tool server because its running process does not contain the maintenance feature.

Future changes can be checked through `developer_host_status`. To authorize one sync/reload from ChatGPT, run this on the host in another terminal:

```bash
mcp-workspace maintenance grant
```

The local command prints a random grant token valid for five minutes and one operation. Give the token only for a maintenance action you intend. The authenticated `sync_and_reload` operation requires the complete expected SHA-256 values from the immediately preceding status snapshot; it rejects stale source files. `reload` does no copy. The gateway briefly disconnects during reload, but the existing ngrok process and assigned hostname remain in place. Refresh the ChatGPT connector schema to discover new tools. Updating the installed launcher file does not hot-reload the already-running launcher JavaScript; a full host restart is still required for changes to launcher supervision behavior.

The maintenance copy path assumes the `./install.sh` layout under `~/.local/bin` and `~/.local/lib/mcp-workspace` (or the equivalent configured `MCP_WORKSPACE_INSTALL_DIR`). There is no arbitrary command or file-path argument in these tools. **Security limitation:** the source repository is exposed for editing by the existing unauthenticated Filesystem tools, so review any changes and source hashes before granting deployment. A one-use grant is authorization to deploy those exact source bytes, not a general guarantee that the repository is trustworthy.

## Protocol compatibility

Supergateway 4.2.1 and the pinned servers expose the legacy MCP `initialize` / `tools/list` exchange over Streamable HTTP. Readiness negotiates protocol version `2025-11-25`. A client that sends `2026-07-28` may be rejected by an MCP SDK that only lists earlier protocol versions; upgrading the launcher’s package pins does not automatically make every client protocol date compatible. The startup check catches a failed exchange and does not announce an unusable URL. The gateway and server SDKs must both implement the client’s requested protocol before that date is supported end to end.

## Defaults and limits

- Gateway binds to `127.0.0.1`; Cloudflare Quick Tunnel (default), named Cloudflare, or ngrok forwards to it.
- Authentication is intentionally disabled. Leave authentication and custom headers blank in your MCP client.
- Filesystem tools can read and write only under the selected directory.
- Terminal commands run in nanosandbox with the selected workspace writable and the Node.js installation read-only. Network access is disabled, command time is capped at 180 seconds, memory at 1 GB, output at 1 MB per stream, and concurrency at one. Linux also caps CPU and process count.
- Quick Tunnel mode generates a new temporary URL every run. Named Cloudflare and ngrok use existing assigned hostnames; tunnel credentials remain in each provider's local agent configuration.

**All tunnel modes are public and unauthenticated.** Anyone who obtains the current URL can invoke the tools while the launcher is running. Use it only for workspaces you are comfortable exposing, and stop the launcher when finished.

## Troubleshooting

- **Node.js version error:** install Node.js 24 or newer and reopen your terminal.
- **Missing command:** install npm/Node.js or `cloudflared` and ensure it is on `PATH`.
- **Port already in use:** choose another port, for example `MCP_WORKSPACE_PORT=8790 mcp-workspace`.
- **Gateway or tool discovery timeout:** check npm connectivity and inspect the launcher error output; the startup check requires both underlying servers to initialize and publish tools.
- **Unsupported protocol version:** configure the client to request `2025-11-25` if it supports version selection. If it only requests `2026-07-28`, this dependency set cannot promise compatibility; no authentication setting changes this protocol limitation.
- **Tunnel timeout:** check `cloudflared` connectivity and retry. The launcher exits and cleans up if it cannot verify the URL. The printed `[+Xs]` startup stages help distinguish npm/gateway slowness from public tunnel delays.
- **Named tunnel cannot start:** check `MCP_WORKSPACE_TUNNEL_CONFIG`, your tunnel credentials, Cloudflare DNS hostname route, and whether the config's ingress service points to your `MCP_WORKSPACE_PORT`.
- **ngrok fails:** check that the ngrok CLI is installed, `ngrok config add-authtoken` succeeded, and `MCP_WORKSPACE_NGROK_URL` is your account's assigned dev domain. The free-plan browser interstitial may interfere with some MCP clients; verify a real MCP POST response, not just a browser page.

## Tests

Run `npm test` for the local automated suite (55 passing tests as of v1.3.0). It includes sandbox-safe developer tool checks and an actual stdio JSON-RPC exchange, plus mocked launcher supervision tests. It does not require a public tunnel. For an isolated installer smoke test run `MCP_WORKSPACE_INSTALL_DIR=/tmp/mcp-workspace-install/bin ./install.sh`, then execute the installed command with `--help` only if the launcher supports it; otherwise test the installed developer server through stdio. A real public Cloudflare tunnel cannot be exercised from the offline nanosandbox.

To use a different local port:

```bash
MCP_WORKSPACE_PORT=8790 mcp-workspace
```

The script exposes only the directory from which it is launched and accepts no workspace path argument.

## v1.1.0 behavior and limitations

Run `./install.sh` from the updated checkout to deploy all seven installed source files, then restart `mcp-workspace` and refresh the MCP connection to discover the additional six developer tools. The MCP endpoint intentionally has **no authentication**. The existing locally approved maintenance grant remains a separate controlled live-reload mechanism, not endpoint authentication.

`apply_changes` validates all inputs before writing. If a write fails, it attempts rollback; external concurrent edits and rollback I/O failures can prevent full recovery. For important changes, use a clean Git working tree and check the diff. The existing `filesystem_write_file` is not hash-checked.

Managed jobs use the same pinned `nanosandbox-mcp` runner with a 180-second command timeout, 1GB memory limit, network disabled and no host Docker socket access. The runner is started asynchronously, so status can be polled while a command is executing. Only one job can run at once; logs are bounded and jobs do not survive server restarts. Verify `job_start` with a smoke command on the actual installed host before relying on it.

The new tools do not provide Git push, host shell access or unrestricted process management.
