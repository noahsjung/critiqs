---
name: verify-critiqs
description: "Start a local Critiqs (noahsjung/critiqs) instance for any commit, with its own ports and data, and drive the website and the installed widget in Chromium to prove a change with screenshots, including before/after pairs. Use before writing any Critiqs start-up or browser-walk script."
---

# Verify Critiqs

One shared way to run and drive Critiqs. Reuse it; don't write your own start-up or walk scripts. Extend
`scripts/walk.mjs` and `features/` instead, so the next agent gets your journey too.

`$K` below is `.agents/skills/verify-critiqs/scripts` in this repository. Every instance takes an absolute data
folder and a port range of its own, so agents can run several at once. Run start-up and walks through any
machine-wide lock or memory cap the current run uses.

## Launch

```sh
$K/setup-tools.sh                                   # once per machine: playwright-core 1.56.1, a Chromium
$K/stack.sh up --data ~/.cache/verify-critiqs/instances/<name> --ports 11000 --rev HEAD
```

- `--rev` is any commit in `--source` (default: this repository, or `$CRITIQS_SOURCE`; `git fetch` first if
  targeting a remote ref like `origin/main`). The instance clones its own checkout into `<data>/checkout`, so it
  never touches a worktree another agent uses.
- Ports: Convex API `BASE`, Convex site (sign-in, `/critiqs/config`) `BASE+1`, website `BASE+2`, sample app
  with the widget installed (`examples/pilot`) `BASE+3`. Ranges must not overlap.
- Every `up` starts a fresh, empty Convex deployment; the checkout and `bun install` are reused while `--rev` is
  unchanged. From checkout to ready takes ~11–18 s with Bun's package cache warm.
- Ready means `stack.sh up` ends with `doctor: ready`.

## Doctor

`$K/stack.sh doctor --data <data>` checks the three processes, the checkout's commit, the backend's
`/critiqs/config` answer, and HTTP 200 from the website and sample app. Run it first whenever anything looks off.

## Drive

```sh
$K/walk.sh --data <data> --feature onboarding|comment|all --out .local/verify-out/<label>
$K/before-after.sh --base origin/main --head HEAD --feature comment --ports 11010 \
  --data ~/.cache/verify-critiqs/instances/<name> --out .local/verify-out/pairs
```

The walks are Playwright scripts in `scripts/walk.mjs`. Recipes, selectors and end states per feature:
[features/README.md](features/README.md). `before-after.sh` starts both commits at once (ports `BASE..+3` and
`BASE+10..+13`), runs the same walk on each, and stops both.

## Evidence

Each walk writes numbered screenshots and `results.json` (`rev`, each step's `ok`, file and what it showed) to
`--out`. Steps check saved data as well as the screen (the project row, the comment's `messages` row and its
thread's `pageKey`). Keep `--out` outside the data folder; open every screenshot before calling it proof.

## Cleanup

`$K/stack.sh down --data <data>` stops only the processes this instance started (by the process groups it
recorded) and warns about any port still answering. Checkouts, logs and evidence stay. Delete a data folder
yourself when it's no longer needed.

## Helpers

All in `scripts/`; each prints its usage when run without arguments. Linux only (`/proc`, `ss`, `setsid`).

| Script | What it does |
| --- | --- |
| `setup-tools.sh` | Installs playwright-core 1.56.1 and, only if none exists, a Chromium. |
| `stack.sh up\|doctor\|down` | Starts, checks and stops one instance. Its pid files hold each process's start time, so `down` never signals a reused pid. |
| `walk.sh` | Runs the journeys in `walk.mjs` after `doctor` passes; exits 1 if any step fails or none ran. |
| `before-after.sh` | Starts two commits at once, walks both, and stops both on any exit. |
| `env.sh` | Sourced by the others: Node 24, `TMPDIR`, the Chromium path, instance settings. |

## Known quirks

- **Node 24.** Critiqs' consumer and framework checks require Node 24+ (CI's version); Node 22 / npm 9 fails
  them. `env.sh` finds Node 24+ from `CRITIQS_NODE24_BIN`, `PATH`, `~/.cache/verify-critiqs/node24/bin`, or
  `~/.nvm`.
- **Temporary files and Chromium socket limit.** `stack.sh` puts `TMPDIR` and `CONVEX_TMPDIR` in `<data>/tmp`
  so a small or RAM-backed `/tmp` doesn't fill up (errno -122). `walk.sh` keeps `CONVEX_TMPDIR` in `<data>/tmp`
  but switches Chromium's `TMPDIR` to `~/.cache/vc-tmp` (or `/tmp/vc-tmp-<uid>`) whenever `<data>/tmp` exceeds
  58 bytes, because Chromium creates `org.chromium.Chromium.XXXXXX/SingletonSocket` (+45 bytes) under `TMPDIR`
  and Linux caps Unix domain socket paths at 107 bytes (`before-after.sh` hits this with nested data folders).
- **Chromium on Ubuntu 26.04.** Playwright 1.56 refuses to download there ("does not support chromium on
  ubuntu26.04-x64"). The walks launch any Chromium in `~/.cache/ms-playwright` (or `$CRITIQS_CHROME`) by path
  with the sandbox off (AppArmor blocks its sandbox on Ubuntu 24.04+/26.04); `setup-tools.sh` downloads the
  Ubuntu 24.04 build only when none exists.
- **Development sign-in.** The code shows on screen only while `RESEND_API_KEY` is unset, so `stack.sh` never
  sets it. Clicking Continue in onboarding opens the sign-in window itself.
- **Starting several instances.** Every local deployment is named `anonymous-agent` and shares Convex's state in
  the home folder; each still talks to its own port. Start instances one at a time (`before-after.sh` does).
  Setting a variable while `convex dev` is still pushing can fail with a transient 503
  "OptimisticConcurrencyControlFailure"; `stack.sh` retries those steps.
- **Assert on text, never on elements.** Comparing a rendered DOM element in a failing `expect` prints the whole
  React tree and grew to many GB, killing helpers. Compare an element's text or attribute.

## Proven

At `2261179` (public `main`) and `8dcb71d`: `up`, `doctor` (including port ownership), both walks twice on
one instance (7/7 steps each), before/after pairs (4/4 steps each side, three runs, one alongside a third
instance), `down` with the evidence kept, and `down` leaving alone a process whose pid was reused. Not driven yet: the
setup page, plan and billing, and the Chrome extension, which has its own check in the repository (see the
feature map).

Keep the map honest as the app changes with **maintain-verification-skill**.
