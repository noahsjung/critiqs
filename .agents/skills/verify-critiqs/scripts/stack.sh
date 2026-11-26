#!/usr/bin/env bash
# One local Critiqs instance: its own checkout, a fresh local Convex deployment with development sign-in, the
# website (apps/web) and the sample app with the widget installed (examples/pilot).
#
#   stack.sh up     --data DIR --ports BASE [--rev REV] [--source REPO]
#   stack.sh doctor --data DIR
#   stack.sh down   --data DIR
#
# DIR    absolute folder for this instance (checkout, logs, temporary files). One folder per instance.
# BASE   first of four ports on 127.0.0.1: Convex API BASE, Convex site (HTTP actions, sign-in) BASE+1,
#        website BASE+2, sample app BASE+3. Give parallel instances ranges that don't overlap.
# REV    commit to run, resolved in REPO (default origin/main; fetch REPO first).
# REPO   a clone or worktree of Critiqs (default $CRITIQS_SOURCE, else this repository).
#
# `up` is safe to repeat: it reuses the checkout and installed packages when REV is unchanged, and always
# starts a fresh Convex deployment, so every walk begins from the same empty data. Linux only (/proc, ss).
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/env.sh"

usage() { sed -n '2,16p' "$0"; exit 2; }
ACTION=${1:-}; shift || true
DATA= BASE= REV=origin/main SOURCE=${CRITIQS_SOURCE:-$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null || pwd)}
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || { echo "$1 needs a value" >&2; usage; }
  case $1 in
    --data) DATA=$2 ;; --ports) BASE=$2 ;; --rev) REV=$2 ;; --source) SOURCE=$2 ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
  shift 2
done
[ -n "$DATA" ] && [ "${DATA#/}" != "$DATA" ] || { echo "--data must be an absolute folder" >&2; exit 2; }
LOGS=$DATA/logs PIDS=$DATA/pids

# A pid file holds "<pid> <start time>": the start time (field 22 of /proc/<pid>/stat) proves the process is
# still the one this instance started, so a reused pid after a crash or reboot is never signalled.
start_time() { awk '{ print $22 }' "/proc/$1/stat" 2>/dev/null; }
ours() {
  local pid started
  [ -f "$1" ] && read -r pid started < "$1" || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] && [ -n "$started" ] && [ "$(start_time "$pid")" = "$started" ] && echo "$pid"
}
group_alive() { kill -0 -- -"$1" 2>/dev/null; }
stop_group() {
  local pid
  if pid=$(ours "$1"); then
    kill -- -"$pid" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do group_alive "$pid" || break; sleep 1; done
    group_alive "$pid" && kill -9 -- -"$pid" 2>/dev/null
  fi
  rm -f "$1"
}
stop_all() { for file in "$PIDS"/*.pid; do [ -f "$file" ] && stop_group "$file"; done; }
port_in_use() { ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; }
port_pid() { ss -ltnpH "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -n 1; }

case $ACTION in
down)
  stop_all
  if [ -f "$DATA/stack.env" ]; then
    load_instance "$DATA"
    for port in "$API_PORT" "$SITE_PORT" "$WEB_PORT" "$PILOT_PORT"; do
      port_in_use "$port" && echo "warning: port $port still answers (pid $(port_pid "$port")); not ours to stop"
    done
  fi
  echo "down: $DATA (evidence and checkout kept)"
  exit 0 ;;

doctor)
  load_instance "$DATA" || exit 1
  ok=1 groups=" "
  for name in convex web pilot; do
    if pid=$(ours "$PIDS/$name.pid") && group_alive "$pid"; then echo "process $name: running ($pid)"; groups+="$pid "
    else echo "process $name: NOT running"; ok=0; fi
  done
  for port in "$API_PORT" "$SITE_PORT" "$WEB_PORT" "$PILOT_PORT"; do
    owner=$(port_pid "$port"); group=$(ps -o pgid= -p "${owner:-0}" 2>/dev/null | tr -d ' ')
    [[ "$groups" == *" $group "* ]] || { echo "port $port: not held by this instance (pid ${owner:-none})"; ok=0; }
  done
  head=$(git -C "$CHECKOUT" rev-parse HEAD 2>/dev/null)
  [ "$head" = "$REV_SHA" ] && echo "checkout: $REV_SHA" || { echo "checkout: HEAD $head is not $REV_SHA"; ok=0; }
  config=$(curl -s --max-time 3 -w '\n%{http_code}' "http://127.0.0.1:$SITE_PORT/critiqs/config")
  code=${config##*$'\n'} body=${config%$'\n'*}
  if [ "$code" = 200 ] && [[ "$body" == *"\"signInUrl\":\"http://127.0.0.1:$SITE_PORT\""* ]] && [[ "$body" == *"\"website\":\"http://127.0.0.1:$WEB_PORT\""* ]]; then
    echo "backend config: 200, sign-in on $SITE_PORT, website $WEB_PORT"
  else echo "backend config: HTTP $code, or sign-in/website not this instance's: ${body:0:300}"; ok=0; fi
  for pair in "website $WEB_PORT" "sample app $PILOT_PORT"; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${pair##* }/")
    [ "$code" = 200 ] && echo "${pair% *}: 200 on ${pair##* }" || { echo "${pair% *}: HTTP $code on ${pair##* }"; ok=0; }
  done
  [ $ok = 1 ] && { echo "doctor: ready"; exit 0; } || { echo "doctor: NOT ready (logs in $LOGS)"; exit 1; } ;;

up) ;;
*) usage ;;
esac

[[ "$BASE" =~ ^[0-9]+$ ]] && [ "$BASE" -ge 1024 ] && [ "$BASE" -le 65532 ] || { echo "--ports BASE (1024-65532) is required for up" >&2; exit 2; }
API_PORT=$BASE SITE_PORT=$((BASE+1)) WEB_PORT=$((BASE+2)) PILOT_PORT=$((BASE+3))
mkdir -p "$LOGS" "$PIDS"
use_node24 || exit 1
use_data_tmp "$DATA"

# Stop this instance's earlier run, forget its old ports, then make sure nobody else holds the new ones.
stop_all
rm -f "$DATA/stack.env"
for port in $API_PORT $SITE_PORT $WEB_PORT $PILOT_PORT; do
  port_in_use "$port" && { echo "port $port is in use (pid $(port_pid "$port")); pick another --ports range" >&2; exit 1; }
done

REV_SHA=$(git -C "$SOURCE" rev-parse --verify "$REV^{commit}" 2>/dev/null) || { echo "can't resolve $REV in $SOURCE (fetch it first)" >&2; exit 1; }
CLONE_SOURCE=$(git -C "$SOURCE" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "$SOURCE")
CHECKOUT=$DATA/checkout
if [ "$(git -C "$CHECKOUT" rev-parse HEAD 2>/dev/null)" != "$REV_SHA" ]; then
  rm -rf "$CHECKOUT"
  git clone -q --shared --no-checkout "$CLONE_SOURCE" "$CHECKOUT" || exit 1
  git -C "$CHECKOUT" -c advice.detachedHead=false checkout -q "$REV_SHA" || exit 1
  rm -f "$DATA/installed"
fi
echo "checkout: $(git -C "$CHECKOUT" log --oneline -1)"
if [ "$(cat "$DATA/installed" 2>/dev/null)" != "$REV_SHA" ]; then
  (cd "$CHECKOUT" && bun install > "$LOGS/install.log" 2>&1) || { echo "bun install failed: $LOGS/install.log" >&2; exit 1; }
  echo "$REV_SHA" > "$DATA/installed"
fi

# From here on a failure stops everything this run started, so nothing is left half up.
fail() { echo "$1" >&2; stop_all; exit 1; }
start_bg() {
  local name=$1 dir=$2 pid; shift 2
  ( cd "$dir" && exec setsid "$@" ) > "$LOGS/$name.log" 2>&1 < /dev/null &
  pid=$!
  for _ in 1 2 3 4 5; do [ -n "$(start_time "$pid")" ] && break; sleep 0.2; done
  echo "$pid $(start_time "$pid")" > "$PIDS/$name.pid"
}
wait_log() { for _ in $(seq 1 "$3"); do grep -q "$2" "$LOGS/$1.log" 2>/dev/null && return 0; sleep 1; done; return 1; }
wait_http() { for _ in $(seq 1 "$2"); do curl -s -o /dev/null --max-time 2 "$1" && return 0; sleep 1; done; return 1; }
convex() { (cd "$BACKEND" && bunx convex "$@"); }
# Setting variables while `convex dev` is still pushing can fail with a transient 503
# ("OptimisticConcurrencyControlFailure"). Both steps below are safe to repeat.
retry() { for attempt in 1 2 3 4 5; do "$@" && return 0; sleep $((attempt * 2)); done; return 1; }
setup_local() { (cd "$BACKEND" && bun run setup:local > "$LOGS/setup-local.log" 2>&1); }
set_web_url() { convex env set CRITIQS_WEB_URL "http://127.0.0.1:$WEB_PORT" > /dev/null 2>>"$LOGS/env.log"; }

BACKEND=$CHECKOUT/packages/backend
rm -rf "$BACKEND/.convex" "$BACKEND/.env.local"
start_bg convex "$BACKEND" env CONVEX_AGENT_MODE=anonymous bunx convex dev \
  --local-cloud-port "$API_PORT" --local-site-port "$SITE_PORT" --typecheck disable --tail-logs always
# The first push stops on the missing CRITIQS_AUTH_ISSUER; that line means the deployment is up. On a busy
# machine it once didn't come within two minutes, so allow four.
wait_log convex "CRITIQS_AUTH_ISSUER\|functions ready" 240 || fail "Convex didn't start: $LOGS/convex.log"
retry setup_local || fail "setup:local failed: $LOGS/setup-local.log"
# Development sign-in shows its code on screen only while no mail service is set, so RESEND_API_KEY stays unset.
retry set_web_url || fail "couldn't set CRITIQS_WEB_URL: $LOGS/env.log"
[ "$(convex env get CRITIQS_WEB_URL 2>>"$LOGS/env.log")" = "http://127.0.0.1:$WEB_PORT" ] || fail "CRITIQS_WEB_URL didn't take: $LOGS/env.log"
wait_log convex "Convex functions ready" 180 || fail "Convex functions never got ready: $LOGS/convex.log"

start_bg web "$CHECKOUT/apps/web" env VITE_CRITIQS_BACKEND="http://127.0.0.1:$API_PORT" bunx vite --port "$WEB_PORT" --host 127.0.0.1 --strictPort
start_bg pilot "$CHECKOUT/examples/pilot" env VITE_CRITIQS_BACKEND="http://127.0.0.1:$API_PORT" bunx vite --port "$PILOT_PORT" --host 127.0.0.1 --strictPort
wait_http "http://127.0.0.1:$WEB_PORT/" 90 || fail "website didn't answer: $LOGS/web.log"
wait_http "http://127.0.0.1:$PILOT_PORT/" 90 || fail "sample app didn't answer: $LOGS/pilot.log"

{
  for name in DATA CHECKOUT REV_SHA API_PORT SITE_PORT WEB_PORT PILOT_PORT; do printf '%s=%q\n' "$name" "${!name}"; done
} > "$DATA/stack.env"
echo "up: backend http://127.0.0.1:$API_PORT (site $SITE_PORT), website http://127.0.0.1:$WEB_PORT, sample app http://127.0.0.1:$PILOT_PORT"
"$0" doctor --data "$DATA" || fail "doctor failed after start"
