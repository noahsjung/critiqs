#!/usr/bin/env bash
# Shared setup for the verify-critiqs scripts. Source it; don't run it.
# Finds Node 24+, keeps temporary files on disk (in <data>/tmp, or a shorter on-disk folder for Chromium's
# Unix socket when <data>/tmp is over 58 bytes), and points at the shared browser tools (playwright-core and
# its Chromium), installed once by setup-tools.sh.

VERIFY_CRITIQS_TOOLS=${VERIFY_CRITIQS_TOOLS:-$HOME/.cache/verify-critiqs/tools}
PLAYWRIGHT_VERSION=1.56.1

# Critiqs' consumer and framework checks need Node 24+ (CI's version); Node 22 with npm 9 fails them.
node24_dir() {
  local candidate ver major
  for candidate in \
    "${CRITIQS_NODE24_BIN:-}" \
    "$(dirname "$(command -v node 2>/dev/null || echo /x/node)")" \
    "$HOME/.cache/verify-critiqs/node24/bin" \
    "$HOME"/.nvm/versions/node/v*/bin; do
    [ -n "$candidate" ] && [ -x "$candidate/node" ] || continue
    ver=$("$candidate/node" --version 2>/dev/null) || continue
    major=${ver#v}; major=${major%%.*}
    [[ "$major" =~ ^[0-9]+$ ]] && [ "$major" -ge 24 ] && { echo "$candidate"; return 0; }
  done
  return 1
}

use_node24() {
  local dir
  dir=$(node24_dir) || { echo "verify-critiqs: Node 24+ not found. Set CRITIQS_NODE24_BIN to a folder holding node 24+." >&2; return 1; }
  export PATH="$dir:$PATH"
}

# Temporary files go on disk inside the instance's data folder so a small or RAM-backed /tmp doesn't fill up
# when package checks unpack tarballs or Playwright unpacks Chromium.
use_data_tmp() {
  export TMPDIR="$1/tmp" CONVEX_TMPDIR="$1/tmp"
  mkdir -p "$TMPDIR"
}

# Chromium puts SingletonSocket under $TMPDIR/org.chromium.Chromium.XXXXXX/SingletonSocket (+45 chars), which
# Linux caps at 107 bytes. Keep CONVEX_TMPDIR in the data folder and use a short on-disk TMPDIR for Chromium.
use_browser_tmp() {
  export CONVEX_TMPDIR="$1/tmp"
  mkdir -p "$CONVEX_TMPDIR"
  local dir="$1/tmp"
  [ "${#dir}" -le 58 ] || dir="${XDG_CACHE_HOME:-$HOME/.cache}/vc-tmp"
  [ "${#dir}" -le 58 ] || dir="/tmp/vc-tmp-$(id -u)"
  export TMPDIR="$dir"
  mkdir -p "$TMPDIR"
}

# The Chromium the walks launch: $CRITIQS_CHROME, else the newest build in ~/.cache/ms-playwright.
chrome_path() {
  local chrome
  if [ -n "${CRITIQS_CHROME:-}" ] && [ -x "$CRITIQS_CHROME" ]; then echo "$CRITIQS_CHROME"; return 0; fi
  # Builds unpack to chrome-linux64/ or, for the Ubuntu 24.04 fallback build, chrome-linux/.
  chrome=$(ls -d "$HOME"/.cache/ms-playwright/chromium-[0-9]*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -n 1)
  [ -n "$chrome" ] && [ -x "$chrome" ] && { echo "$chrome"; return 0; }
  return 1
}

# Reads the ports and paths `stack.sh up` saved for an instance.
load_instance() {
  local data=$1
  [ -f "$data/stack.env" ] || { echo "verify-critiqs: no instance in $data (run stack.sh up first)" >&2; return 1; }
  # shellcheck disable=SC1091
  . "$data/stack.env"
}
