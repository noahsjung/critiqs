#!/usr/bin/env bash
# before-after.sh --base REV --head REV --feature NAME --ports BASE --data DIR --out DIR [--source REPO]
# Runs the same walk on two instances at once: the base commit (before) on ports BASE..BASE+3 and the changed
# commit (after) on BASE+10..BASE+13, each with its own checkout and data under DIR/before and DIR/after.
# Screenshots land in OUT/before and OUT/after with the same names, so each pair compares one step.
# Both instances are stopped on exit, including an interrupted run; checkouts and evidence are kept.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
usage() { sed -n '2,7p' "$0"; exit 2; }
BASE_REV= HEAD_REV= FEATURE=all PORTS= DATA= OUT= SOURCE=${CRITIQS_SOURCE:-$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null || pwd)}
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || { echo "$1 needs a value" >&2; usage; }
  case $1 in
    --base) BASE_REV=$2 ;; --head) HEAD_REV=$2 ;; --feature) FEATURE=$2 ;; --ports) PORTS=$2 ;;
    --data) DATA=$2 ;; --out) OUT=$2 ;; --source) SOURCE=$2 ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
  shift 2
done
[ -n "$BASE_REV" ] && [ -n "$HEAD_REV" ] && [ -n "$DATA" ] && [ -n "$OUT" ] || usage
[[ "$PORTS" =~ ^[0-9]+$ ]] && [ "$PORTS" -ge 1024 ] && [ "$PORTS" -le 65522 ] || { echo "--ports BASE (1024-65522) is required" >&2; exit 2; }
[ "${DATA#/}" != "$DATA" ] || { echo "--data must be an absolute folder" >&2; exit 2; }
mkdir -p "$DATA" "$OUT"

stop_both() { for side in before after; do "$HERE/stack.sh" down --data "$DATA/$side" | grep -v '^down:'; done; }
trap stop_both EXIT
trap 'exit 130' INT TERM

# Start them one after the other: two `convex dev` runs starting at the same moment share Convex's local
# deployment state in the home folder, and one can stall. Once up, both run side by side.
for side in before after; do
  rev=$BASE_REV ports=$PORTS
  [ $side = after ] && rev=$HEAD_REV ports=$((PORTS + 10))
  "$HERE/stack.sh" up --data "$DATA/$side" --ports "$ports" --rev "$rev" --source "$SOURCE" > "$DATA/$side-up.log" 2>&1
done
status=0
for side in before after; do
  grep -q "doctor: ready" "$DATA/$side-up.log" || { echo "$side instance didn't start:"; tail -5 "$DATA/$side-up.log"; status=1; }
done
if [ $status = 0 ]; then
  for side in before after; do
    echo "== $side"
    "$HERE/walk.sh" --data "$DATA/$side" --feature "$FEATURE" --out "$OUT/$side" || status=1
  done
fi
echo "before/after evidence: $OUT/before and $OUT/after"
exit $status
