#!/usr/bin/env bash
set -euo pipefail

# Install the Devin CLI using the official installer
curl -fsSL https://cli.devin.ai/install.sh | sh

# Verify the binary was installed
if [ ! -f "$HOME/.local/bin/devin" ]; then
  echo "ERROR: Devin CLI binary not found at $HOME/.local/bin/devin" >&2
  exit 1
fi

# Ensure ~/.local/bin is on PATH via profile
PROFILE_LINE='export PATH="$HOME/.local/bin:$PATH"'
if ! grep -qF '.local/bin' "$HOME/.bashrc" 2>/dev/null; then
  echo "$PROFILE_LINE" >> "$HOME/.bashrc"
fi

echo "Devin CLI installed successfully at $HOME/.local/bin/devin"
