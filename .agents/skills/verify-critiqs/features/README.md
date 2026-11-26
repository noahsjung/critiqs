# Critiqs verification map

The maintained source for proving Critiqs' user-facing behavior. Read this index, then use the matching
feature file as the recipe. Driven features have a journey in `../scripts/walk.mjs`.

| Feature | File | Driven by `walk.sh` |
| --- | --- | --- |
| Onboarding on the website | [onboarding.md](onboarding.md) | `--feature onboarding` |
| Commenting with the installed widget | [widget-comment.md](widget-comment.md) | `--feature comment` |
| Thread page on the website | [thread-page.md](thread-page.md) | `--feature comment` (last step) |
| Setup page | [setup-page.md](setup-page.md) | not yet |
| Chrome extension side panel | [extension.md](extension.md) | not yet |
| Plan and billing | [plan-and-billing.md](plan-and-billing.md) | not yet |

## Baseline

- One instance per run, started by `stack.sh up` with its own `--data` and `--ports`; `doctor: ready`.
- Each `up` gives an empty deployment, so journeys create the people and projects they need. Names carry a
  per-run suffix so repeated walks on one instance don't collide.
- Never drive an instance another agent started.

## Conventions

- Prefer roles and visible names (`getByRole("button", { name: "Continue" })`) over CSS. The widget lives in an
  open shadow root under `critiqs-root`; Playwright locators reach into it.
- Read visible text with the walk's `textOf`, which includes the widget's shadow root.
- Check saved data with `bunx convex data <table>` in `<data>/checkout/packages/backend`, not only the screen.

## Adding a feature

Add a journey function to `walk.mjs`, register it in the feature list at the bottom, write its file here with
the four sections (Sub-features, How to get to it, Driving it, Gotchas), and prove it once on a fresh instance.
A journey that needs data the empty deployment lacks creates it through the UI; if it can't, it fails and the
reason goes under Gotchas. Never weaken a journey to make it pass.
