#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
install_dir=${MCP_WORKSPACE_INSTALL_DIR:-"$HOME/.local/bin"}
mkdir -p "$install_dir"
install -m 0755 "$script_dir/bin/mcp-workspace" "$install_dir/mcp-workspace"
printf 'Installed: %s/mcp-workspace\n' "$install_dir"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) printf 'Add this to your shell profile if needed: export PATH="%s:$PATH"\n' "$install_dir" ;;
esac
