#!/usr/bin/env bash
# Installs the browser tools the walks use, once per machine: playwright-core (pinned) into
# ~/.cache/verify-critiqs/tools and the Chromium build it expects. Safe to repeat.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/env.sh"
use_node24
mkdir -p "$VERIFY_CRITIQS_TOOLS"
have=$(node -p "require('$VERIFY_CRITIQS_TOOLS/node_modules/playwright-core/package.json').version" 2>/dev/null || true)
if [ "$have" != "$PLAYWRIGHT_VERSION" ]; then
  (cd "$VERIFY_CRITIQS_TOOLS" && [ -f package.json ] || echo '{"private":true}' > package.json)
  npm install --prefix "$VERIFY_CRITIQS_TOOLS" --no-audit --no-fund "playwright-core@$PLAYWRIGHT_VERSION" > /dev/null
fi
# The walks launch Chromium by path (chrome_path in env.sh), so any build in ~/.cache/ms-playwright works; the
# one playwright-core would pick needn't be present. Download only when there is none. Playwright 1.56 doesn't
# know Ubuntu 26.04 ("does not support chromium on ubuntu26.04-x64"); the Ubuntu 24.04 build runs fine there.
# The download is unpacked under TMPDIR, so keep TMPDIR on disk (a small RAM /tmp fails with errno -122).
if ! chrome_path > /dev/null; then
  export TMPDIR=$VERIFY_CRITIQS_TOOLS/tmp; mkdir -p "$TMPDIR"
  PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=${PLAYWRIGHT_HOST_PLATFORM_OVERRIDE:-ubuntu24.04-x64} \
    node "$VERIFY_CRITIQS_TOOLS/node_modules/playwright-core/cli.js" install chromium
fi
echo "tools ready: playwright-core $PLAYWRIGHT_VERSION, Chromium $(chrome_path)"
