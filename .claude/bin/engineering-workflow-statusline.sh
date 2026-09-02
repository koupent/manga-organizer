#!/usr/bin/env bash
set -u
config_dir=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
root_file="$config_dir/engineering-workflow/plugin-root"
plugin_root=
[ ! -r "$root_file" ] || IFS= read -r plugin_root < "$root_file"
if [ -z "$plugin_root" ] || [ ! -r "$plugin_root/scripts/statusline/statusline.sh" ]; then
  command -v claude >/dev/null 2>&1 || exit 0
  command -v jq >/dev/null 2>&1 || exit 0
  plugin_root=$(claude plugin list --json 2>/dev/null | jq -r '.[] | select(.id == "engineering-workflow-plugin@engineering-workflow" and .scope == "project") | .installPath' | head -n 1)
fi
[ -r "$plugin_root/scripts/statusline/statusline.sh" ] || exit 0
exec bash "$plugin_root/scripts/statusline/statusline.sh"
