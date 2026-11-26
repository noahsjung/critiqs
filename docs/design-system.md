# Design system

Critiqs draws its interface inside a shadow root on top of someone else's
prototype. It has to read as one calm, quiet layer: the prototype is the
subject, not Critiqs. This page lists the rules and the shared pieces every
screen is built from. The pieces live in `packages/react/src/ui/ds.tsx`
(components) and `packages/react/src/styles.ts` (tokens and `ds-` styles).

Status: started 2026-11-23 with settings dialogs. Older screens use the same
colors but not yet every piece; move them over when they change.

## Rules

1. **One job per page.** A dialog page asks for one thing. Setup that needs
   several answers becomes steps, one answer per step, with Back.
2. **Rows, not cards.** A setting is a row: its name on the left, its control
   on the right. Space separates groups; a divider only where two groups meet.
   No boxed cards, side rails, or colored panels around settings.
3. **Let the control speak.** No description under each option. A page gets at
   most one short line of help, and only when the controls can't explain
   themselves. Details such as a model's cost go in the open menu, not on the
   button. Errors, limits, and anything that costs money are always in words.
4. **One primary action per page,** bottom right, named for what it does
   ("Save key", "Continue"). Settings that are a single choice take effect at
   once, with a toast, and need no Save button.
5. **Same control, same job.** A choice among options is a `Select`; on or off
   is a `Switch`; going deeper is a `NavRow`; going back is the header's Back.
6. **Quiet until it matters.** Color means state: the accent for the chosen
   or active thing, amber near a limit, red at a limit or for an error.
   Destructive actions are plain text buttons until confirmed.

## Tokens

Defined on `:host` in `styles.ts`. Use the token, never the raw value.

| Group | Tokens |
| --- | --- |
| Color | `--text`, `--muted`, `--faint`, `--surface`, `--hover`, `--border`, `--accent`, `--accent-soft`, `--accent-strong`, `--success`, `--caution`, `--danger`, `--switch-off`, `--warning-bg`, `--warning-text` |
| Space (4px grid) | `--space-1` 4, `--space-2` 8, `--space-3` 12, `--space-4` 16, `--space-6` 24 |
| Radius | `--radius-s` 6 (small buttons), `--radius-m` 8 (fields, selects, rows), `--radius-l` 12 (dialogs, popovers) |
| Type | `--text-xs` 11, `--text-s` 12 (secondary), `--text-m` 13 (body), `--text-l` 15 (dialog titles); weights 400, 500 for controls, 600 for titles |
| Size | `--control-height` 32, `--row-height` 40 |

## Components

| Component | Use |
| --- | --- |
| `DialogHeader` | A dialog's title with Close, plus Back and step dots in a multi-step flow. |
| `SettingRow` | One setting: name left, control right. |
| `NavRow` | Opens the next page of a dialog, or does one thing, showing the current value. |
| `Select` | One choice from a menu. The button shows the name; the menu adds each option's detail. |
| `Switch` | On or off, at once. |
| `Meter` | Part of a limit used, with its amount as `valueText`. Where extra past the limit is allowed, `ceiling` is the most allowed: amber past the limit, red only at the ceiling. `valueText` puts its state in words, as `usageText` writes it: "limit reached", what is left before the cap, "near cap" (amber text), or "cap reached" (red). |
| `.ds-group-label` | A short name above a group of rows that lists things, such as an organization's Members. |
| `.ds-section`, `.ds-section-title` | A titled part of a settings page that holds its own groups, such as each tracker in the Tickets tab with its teams under it: the title at body size, in the text color, and a divider above each section after the first, so the groups inside read as part of it. |
| `.ds-person` | A person in a row: their picture, name, and a quiet second line such as their address. |
| `StepDots` | Where a multi-step flow is (inside `DialogHeader`). |
| `SidebarResizer`, `useSidebarWidth` | The right-hand sidebar's left edge, dragged (or moved with arrow keys) to resize every panel between 300 and 720 px; the width is remembered in the browser, and pins, the thread window, and mockup copies stay clear of it. |
| `usePageFocus` | Moves focus into a dialog page when the page changes, since the control that changed it is gone. Every multi-page dialog uses it. |
| `Menu`, `MenuItem` | Menus; `MenuItem` takes `selected` for a select's options and `detail` for quiet trailing text. Arrow keys, Home, and End move between items. |
| `.btn` (`primary`, `ghost`, `danger`, `danger solid`, `small`) | Buttons. One `primary` per page; `danger solid` only to confirm removing something. |
| `.field` | Text inputs. |
| `.warning`, `.caution`, `.error`, `.note` | Notices: a problem to act on, text near a limit, a failure, and quiet secondary text. |

## Patterns

**Settings dialog.** `DialogHeader` with Close; a `ds-page` of `ds-group`s of
`SettingRow`s and `NavRow`s; no footer. Each change saves at once and says so
in a toast; a failed save shows its error at the top and puts the control back.

**Side panel.** Sections one above the other, each a bold name with its one
action on the right as a text button, and a line of quiet text or a `Meter`
under it; a divider between sections, no boxes. Finished steps collapse to one
line whose details open in place. A plan shows its credits and anything near
its limit; All usage opens the rest in place.

**Step flow.** A sequence of pages in the same dialog, each with
`DialogHeader` (Back, step dots), one question, and one primary action in a
`ds-actions` row. The last step's action saves and returns to where the flow
started.

## Writing

- Sentence case. Name things by what people recognize: "Your own API key",
  not "BYOK connection".
- Labels are nouns ("Model", "Who pays"); buttons are verbs ("Save key").
- Numbers carry their unit: "12 of 50 credits used today".
- No "Ready to use", "No setup needed", or other reassurance; a screen that
  works says nothing about it.
