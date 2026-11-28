#!/usr/bin/env bash
# walk.sh --data DIR --feature onboarding|comment|access|all --out DIR
# Runs the browser walks against a running instance (stack.sh up). Screenshots and results.json go to OUT,
# which should be outside the instance's data folder so teardown never removes the proof.
# Exit 0 only when at least one step ran and every step passed.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/env.sh"
DATA= args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [ "${args[i]}" = --data ]; then
    [ $((i + 1)) -lt ${#args[@]} ] || { echo "--data needs a value" >&2; exit 2; }
    DATA=${args[i + 1]}
  fi
done
[ -n "$DATA" ] || { sed -n '2,5p' "$0"; exit 2; }
[ -f "$DATA/stack.env" ] || { echo "no instance in $DATA (run stack.sh up first)" >&2; exit 1; }
"$HERE/stack.sh" doctor --data "$DATA" > /dev/null || { echo "the instance in $DATA isn't ready; run stack.sh doctor --data $DATA" >&2; exit 1; }
use_node24 || exit 1
use_browser_tmp "$DATA"
CRITIQS_CHROME=$(chrome_path) || { echo "no Chromium found; run setup-tools.sh" >&2; exit 1; }
export CRITIQS_CHROME VERIFY_CRITIQS_TOOLS
exec node "$HERE/walk.mjs" "$@"
