#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
project_dir=$(cd -- "$script_dir" && pwd -P)
install_dir=${MCP_WORKSPACE_INSTALL_DIR:-"$HOME/.local/bin"}
install -d "$install_dir" "$install_dir/../lib/mcp-workspace"
install -m 0755 "$project_dir/bin/mcp-workspace" "$install_dir/mcp-workspace"
install -m 0644 "$project_dir/lib/launcher.js" "$install_dir/../lib/mcp-workspace/launcher.js"
install -m 0644 "$project_dir/lib/ollama-server.js" "$install_dir/../lib/mcp-workspace/ollama-server.js"
install -m 0644 "$project_dir/lib/devtools-core.js" "$install_dir/../lib/mcp-workspace/devtools-core.js"
install -m 0644 "$project_dir/lib/devtools-server.js" "$install_dir/../lib/mcp-workspace/devtools-server.js"
install -m 0644 "$project_dir/lib/host-control.js" "$install_dir/../lib/mcp-workspace/host-control.js"
install -m 0644 "$project_dir/lib/devtools-v1.js" "$install_dir/../lib/mcp-workspace/devtools-v1.js"
install -m 0644 "$project_dir/lib/jobs.js" "$install_dir/../lib/mcp-workspace/jobs.js"
install -m 0644 "$project_dir/lib/video-core.js" "$install_dir/../lib/mcp-workspace/video-core.js"
install -m 0644 "$project_dir/lib/video-server.js" "$install_dir/../lib/mcp-workspace/video-server.js"
install -m 0644 "$project_dir/lib/video-workflow.js" "$install_dir/../lib/mcp-workspace/video-workflow.js"
install -m 0644 "$project_dir/lib/video-worker.js" "$install_dir/../lib/mcp-workspace/video-worker.js"
install -m 0644 "$project_dir/lib/resources.js" "$install_dir/../lib/mcp-workspace/resources.js"
install -m 0644 "$project_dir/lib/remotion-core.js" "$install_dir/../lib/mcp-workspace/remotion-core.js"
install -m 0644 "$project_dir/lib/remotion-worker.js" "$install_dir/../lib/mcp-workspace/remotion-worker.js"
printf 'Installed: %s/mcp-workspace\n' "$install_dir"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) printf 'Add this to your shell profile if needed: export PATH="%s:$PATH"\n' "$install_dir" ;;
esac
