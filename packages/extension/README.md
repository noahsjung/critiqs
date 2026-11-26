# Critiqs for Chrome

The Critiqs extension lets a reviewer comment on any page they can open,
including logged-in apps, `localhost`, and VPN-only staging, without the team
installing anything. It runs in Chromium browsers (Chrome, Edge, Brave, Arc).
This workspace is private: it isn't published to npm.

## How it works

- **No site access at install.** The extension asks only for `activeTab`,
  `sidePanel`, `scripting`, and `storage`. Every site is optional and asked
  for one at a time.
- **Clicking the icon** (or Alt+Shift+C) runs the worker's `action.onClicked`,
  which opens Chrome's side panel for that tab and adds Critiqs's page layer
  to the page as a content script. Chrome grants the page to the extension
  for that click (`activeTab`). The icon doesn't open the panel by itself
  (`openPanelOnActionClick` is off), because Chrome grants nothing then.
- **The side panel** signs the reviewer in (email, code, and a name on a first
  sign-in, with no popup), finds the page's project by its origin among the
  projects the reviewer can already reach, then shows Critiqs's own panel for
  it. The panel and the page layer talk through a `chrome.runtime` port with
  the page layer protocol. The session is kept in `chrome.storage.local`.
- **Screenshots** use `chrome.tabs.captureVisibleTab` when Chrome allows it,
  which is after a click on the icon on that page, or with every site allowed.
  Otherwise the page layer's own capture is used, and the panel says once how
  to get real pixels.
- **Show comments here automatically** (in the panel's Settings) asks Chrome
  for that one site and registers the page layer for it, so pins show on later
  visits with no click. Turning it off removes both.
- **Sites with Critiqs installed** get nothing from the extension; the panel
  says **Built in**.
- **Mockup mode** isn't offered: its page copy is drawn over the page, which a
  side panel can't do yet.

| File | Runs in |
| --- | --- |
| `src/worker.ts` | The background service worker |
| `src/page.ts` | The page, as a content script: the page layer |
| `src/panel/` | The side panel |

## Build and load it unpacked

```sh
bun run build                                        # Critiqs Cloud
CRITIQS_BACKEND=http://127.0.0.1:3210 bun run build  # a local Convex deployment
```

Then open `chrome://extensions`, turn on **Developer mode**, choose **Load
unpacked**, and pick `packages/extension/dist`. Pin Critiqs to the toolbar
from the puzzle-piece menu.

The manifest's `key` gives the development build a stable ID:
`pfdpnmmiemejphfghkalofichdcoandg`. The sign-in service accepts the side
panel only when its deployment lists that ID:

```sh
bunx convex env set CRITIQS_EXTENSION_IDS pfdpnmmiemejphfghkalofichdcoandg
```

The Chrome Web Store assigns the published extension its own ID, which is
listed the same way.

## Checks

```sh
bun run test        # unit tests, with a fake chrome API
bun run typecheck
bun run check:chrome
```

`check:chrome` loads a test build in Chrome for Testing against a local Convex
deployment with development sign-in (`bun run setup:local` in
`packages/backend`) and `CRITIQS_EXTENSION_IDS` set. It needs
`CRITIQS_BACKEND`, `CHROME_PATH`, and `PLAYWRIGHT_CORE` (the path of a
`playwright-core` package); `CRITIQS_EVIDENCE_DIR` keeps screenshots.
Automation can't click the toolbar icon or open the side panel, so the test
build (`CRITIQS_TEST=1`) grants the test sites at install and lets the run
call the worker's click handler; the side panel's page opens in a window at
side panel width. The toolbar click, Chrome's side panel, and `activeTab`
are checked by hand: see [the manual test](MANUAL_TEST.md).
