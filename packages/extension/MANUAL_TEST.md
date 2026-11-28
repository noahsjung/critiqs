# Manual test in real Chrome

`bun run check:acceptance` runs every acceptance case a script can drive in
Chrome for Testing and reports each one by its number (see the
[README](README.md#checks)). Three cases need a person, because a script can't
press Chrome's own keyboard shortcuts or answer Chrome's own permission
prompt. They take about five minutes.

## Before you start

1. Build for the backend to test against. For Critiqs Cloud: `bun run build`
   in `packages/extension`. For a local backend:
   `CRITIQS_BACKEND=http://127.0.0.1:<port> bun run build`.
2. Make sure that backend lists the extension ID
   `pfdpnmmiemejphfghkalofichdcoandg` in `CRITIQS_EXTENSION_IDS`.
3. In Chrome, open `chrome://extensions`, turn on **Developer mode**, choose
   **Load unpacked**, and pick `packages/extension/dist`.
4. Pin Critiqs to the toolbar (puzzle-piece menu → pin).
5. Pick a page to review that a project of yours lists, and sign in to
   Critiqs on it once (click the Critiqs icon and follow the card).

Page address: ________________

## Steps

| Case | Do | Expect | Result |
| --- | --- | --- | --- |
| A1.4 | Open the page in a new tab. Don't click anything. Press **Alt+Shift+C** (on a Mac, **Option+Shift+C**). If nothing happens, check `chrome://extensions/shortcuts`: Critiqs's shortcut may be unassigned, so assign it and try again. | Exactly what clicking the Critiqs icon does: Critiqs's toolbar appears at the bottom of the page. Pressing it again hides Critiqs; once more shows it again. | |
| A7.5 | With Critiqs showing on the page, open the menu behind your picture on the toolbar and choose **Show comments here automatically**. | Chrome asks whether Critiqs may read and change this one site (it names the site). Choose **Allow**. The menu shows the setting as on. | |
| A7.5 | Open the same page in a new tab. Don't click the icon. | Critiqs's toolbar and the comment pins appear by themselves within 3 seconds. | |
| A7.6 | In the menu, choose **Show comments here automatically** again to turn it off. Reload the page. | Nothing of Critiqs appears until you click the Critiqs icon. Chrome doesn't ask anything. | |
| A7.6 | Open `chrome://extensions`, find Critiqs, choose **Details**, and look at **Site access**. | The page's site is no longer listed. | |

Write down any case whose result differs, with a screenshot of the page.
