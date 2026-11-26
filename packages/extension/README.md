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
- **Sharing a comment:** **⋯ → Copy link** in a comment copies its page on
  Critiqs's website (`<website>/t/<key>`) where the deployment has one, as on
  Critiqs Cloud. That page opens for people without the extension once they
  sign in. Without a website, the link is the page's own address with the
  comment in it.
- **Mockup mode** opens in a tab of its own beside the page, the Mockup tab,
  since its copy of the page covers a window and the side panel has no page
  beneath it. The tab freezes the page through a page layer of its own there
  and shows Critiqs's Mockup panel; Mockup threads are made there as when
  installed. Holding O to compare with the live page isn't offered there, and
  leaving Mockup mode (V) closes the tab and goes back to the page.

| File | Runs in |
| --- | --- |
| `src/worker.ts` | The background service worker |
| `src/page.ts` | The page, as a content script: the page layer |
| `src/panel/` | The side panel |
| `src/mockup/`, `src/mockup-tab.ts` | The Mockup tab, and opening it from the side panel |

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
bun run test             # unit tests, with a fake chrome API
bun run typecheck
bun run check:checklist  # the manual test, run in real Chrome
bun run check:chrome     # more lookup and screenshot cases, with a test build
```

`check:checklist` runs [the manual test](MANUAL_TEST.md) step by step in
Chrome for Testing with the real build: no test hooks and no site access at
install. Chrome DevTools' `Extensions.triggerAction` runs the extension's
action the way the toolbar icon does, so Chrome grants the page for that
click (`activeTab`) and opens the real side panel, which the run drives over
its own DevTools target. It writes `results.md`, with pass, fail, or "not
automatable" and the reason for every step, and a screenshot of the page and
the side panel for each, to `CRITIQS_EVIDENCE_DIR`. It needs
`CRITIQS_BACKEND`, a local Convex deployment with development sign-in
(`bun run setup:local` in `packages/backend`) and `CRITIQS_EXTENSION_IDS`
set. `CHROME_PATH` defaults to the newest Chromium Playwright installed;
branded Chrome no longer loads unpacked extensions from the command line.
`CRITIQS_EXTENSION_DIR` runs it against an extension built elsewhere, such as
from an older commit.

What it can't do: answer Chrome's own prompt for a site's access (it allows
the site through **Details → Site access** instead), press Chrome's keyboard
shortcut, or click the side panel's X. Those steps are still checked by hand.

What it measured in Chrome 151:

- A click inside the side panel doesn't grant the page: `executeScript` and
  `captureVisibleTab` are refused until the icon is clicked.
- The icon's grant lasts through reloads of the same site and ends when the
  tab opens another site. So after a reload the screenshots are still real
  pixels, though the panel still asks for a click to add the page layer again.
- A click on a pin opens the side panel on its comment.

`check:chrome` loads a test build (`CRITIQS_TEST=1`), which grants its test
sites at install and lets the run call the worker's click handler, with the
side panel's page in a window of its own. It covers several projects for one
site, an ambiguous origin, two people adding addresses at once, and real
pixels with every site allowed. It needs `CRITIQS_BACKEND`, `CHROME_PATH`, and
`PLAYWRIGHT_CORE` (the path of a `playwright-core` package).
