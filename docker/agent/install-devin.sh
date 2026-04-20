#!/bin/sh
set -eu

# Install the Devin CLI using the official installer.
# The upstream installer ends with `devin setup` which opens a browser for
# interactive login — unusable inside a Docker build.  We download the script,
# strip the trailing `setup` invocation, and run the rest under bash
# (the installer uses pipefail).
TMPSCRIPT=$(mktemp /tmp/devin-install.XXXXXX.sh)
curl -fsSL https://cli.devin.ai/install.sh -o "$TMPSCRIPT"

# Remove the last line if it invokes `setup` (interactive auth prompt)
if tail -1 "$TMPSCRIPT" | grep -q 'setup'; then
  sed -i '$ d' "$TMPSCRIPT"
fi

bash "$TMPSCRIPT"
rm -f "$TMPSCRIPT"

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
