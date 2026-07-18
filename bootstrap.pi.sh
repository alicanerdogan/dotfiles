#!/bin/bash
# Bootstrap pi coding agent: use this repo's pi/ as the live ~/.pi/agent config.
# Can be run standalone (only bootstraps pi) or via bootstrap.sh.

set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pi_dir="$repo_dir/pi"
agent="$HOME/.pi/agent"
agent_bak="$HOME/.pi/agent.bak"

mkdir -p "$HOME/.pi"

if [[ -L "$agent" ]]; then
  # already symlinked: only verify it points at this repo
  target="$(readlink "$agent")"
  if [[ "$target" != "$pi_dir" ]]; then
    echo "error: ~/.pi/agent points to '$target', expected '$pi_dir'" >&2
    echo "remove it manually and re-run to re-point" >&2
    exit 1
  fi
  echo "~/.pi/agent already linked to this repo - skipping backup/sync"
elif [[ -e "$agent" ]]; then
  # existing live config: back it up, then sync its contents into the repo
  if [[ -e "$agent_bak" || -L "$agent_bak" ]]; then
    mv "$agent_bak" "$agent_bak.$(date +%Y%m%d-%H%M%S)"
  fi
  mv "$agent" "$agent_bak"

  # backup wins on conflicts; review the result afterwards with git diff
  rsync -a "$agent_bak/" "$pi_dir/"

  ln -s "$pi_dir" "$agent"
else
  ln -s "$pi_dir" "$agent"
fi

# install declared pi packages (skills/extensions from npm/git)
if command -v pi >/dev/null; then
  pi update --extensions
else
  echo "pi not installed yet - after installing, run: pi update --extensions"
fi
