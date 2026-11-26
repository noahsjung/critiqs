# Chrome extension side panel

The Critiqs extension (`packages/extension`) lets a reviewer comment on any page from Chrome's side panel, with
nothing installed in the prototype.

## Sub-features

- `side-panel`: open the panel on a page, sign in, start a site or add it to a project.
- `comment`: comment on an element of the page from the panel.

## How to get to it (user POV)

Load the built extension (not yet in the Chrome Web Store), open a site, open the Critiqs side panel.

## Driving it with walk.sh

Not driven by `walk.sh`. The repository has its own real-Chrome check,
`packages/extension/scripts/check-extension.ts` (with `packages/extension/MANUAL_TEST.md`). Run that against
this instance instead of writing a second one: set `CRITIQS_BACKEND=http://127.0.0.1:<BASE>`,
`CHROME_PATH` to `chrome_path` from `scripts/env.sh`, `PLAYWRIGHT_CORE` to
`~/.cache/verify-critiqs/tools/node_modules/playwright-core`, and `CRITIQS_EVIDENCE_DIR` to your evidence
folder. Read the script's header first; this kit hasn't run it yet.

## Gotchas

- The extension must be loaded into Chromium (`--load-extension`), with the sandbox off where AppArmor blocks
  Chromium's user-namespace sandbox.
- The development extension ID must be in the deployment's allowed list (`CRITIQS_EXTENSION_IDS`).
