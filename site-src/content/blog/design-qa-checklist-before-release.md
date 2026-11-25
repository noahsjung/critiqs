---
title: A design QA checklist before release for web apps
description: Run a structured pre-release design QA pass on staging or pull request previews covering layout, copy, states, responsiveness, and actionable bug handoff.
date: 2026-11-24
tags: [design-qa, checklist, staging-review, qa, visual-feedback]
---

A pre-release design QA pass checks a live staging or pull request build against the intended design across six areas: layout and spacing, typography and copy, interactive states, responsive breakpoints, dynamic views, and basic accessibility. Pinning each finding directly to the affected element on the build lets engineers fix the entire list in one pass instead of deciphering screenshots in chat.

Design QA is different from functional QA and user acceptance testing (UAT). Functional QA tests whether logic and APIs behave correctly, and UAT checks whether a workflow meets business requirements. Design QA checks whether the shipped interface actually matches the design system, reads clearly, and holds up under real data and varied screen widths.

## Before you start the pass

Spend two minutes verifying the test environment before logging a single issue:

- **Confirm the exact build.** Check that you are looking at the right pull request preview or staging URL, not production or an older branch.
- **Test with realistic data and roles.** Sign into representative accounts (for example, a brand-new user with empty tables, a power user with long names and dozens of rows, and a read-only role). Most visual bugs hide behind real data lengths.
- **Hard refresh once.** Run a hard reload (`Cmd + Shift + R` or `Ctrl + Shift + R`) if you recently checked an earlier build so stale CSS does not cause false alarms.
- **Agree on one place for notes.** Log every finding in one shared list on the build itself. Avoid splitting notes across Slack, Figma comments, and spreadsheets.

## 1. Layout, alignment, and spacing

Compare the live build side by side with the design spec or design system tokens:

- **Grid and alignment.** Check vertical and horizontal baselines across headers, form fields, table columns, and action buttons. Look for elements shifted by 2 to 4 pixels because of mismatched line heights or stray borders.
- **Padding and gaps.** Verify consistent spacing inside cards, dialogs, menus, and toolbars. Check that dividers sit only where groups separate and do not double up against container borders.
- **Overflow and truncation.** Test long names, long email addresses, and multi-digit numbers. Confirm whether text should wrap cleanly or truncate with an ellipsis, and make sure overflowing text never pushes buttons off screen.
- **Z-index and layering.** Open dropdowns, tooltips, sticky headers, and modals together to confirm nothing clips behind a scroll container or floats over a dialog backdrop.

## 2. Typography, icons, and copy

Read the interface as a first-time user rather than skimming familiar labels:

- **Type scale and weight.** Confirm headings, body copy, captions, and button labels use the intended font family, size, weight, and line height. Check monospace styling on code, IDs, or numeric tables.
- **Contrast and color tokens.** Verify primary text, muted secondary text, links, and status colors (accent, caution, danger, success) match the design system and remain legible against their backgrounds.
- **Icons and assets.** Check that SVGs are crisp, aligned vertically with adjacent text, and sized consistently. Confirm no broken images or unstyled fallback icons appear.
- **Copy accuracy.** Scan for leftover placeholder text, typos, inconsistent capitalization (sentence case vs title case), missing units on numbers (such as "12 of 50 credits" rather than "12/50"), and clear button verbs ("Save key" instead of vague "Submit").

## 3. Interactive states

Static screenshots look right while interactive states break. Click, hover, and trigger edge cases on every changed component:

- **Hover, active, and selected states.** Confirm buttons, rows, tabs, and menu items show clear visual feedback on hover and clearly mark the currently active selection.
- **Loading states.** Trigger slow actions (saving a form, switching pages, fetching search results). Check that spinners or skeletons hold layout space without jarring jumps, and that primary submit buttons disable while a request is in flight to stop double submissions.
- **Empty states.** View every list, search result, and table with zero items and with active filters that return zero matches. Each empty state should explain why nothing appears and offer the next action (such as clearing filters).
- **Error and warning states.** Submit invalid forms, trigger network errors if possible, and check inline field errors, banners, and toast notifications. Confirm errors appear near the relevant control and disappear once corrected.
- **Destructive confirmations.** Verify delete or remove actions ask for confirmation in plain language and visually distinguish destructive buttons from ordinary actions.

## 4. Responsive breakpoints

Do not assume a layout that works on a 1440 px monitor survives a laptop or phone:

- **Narrow desktop and tablet widths.** Drag the browser window smoothly from 1440 px down to 768 px. Watch for cramped navigation bars, wrapping button groups, and awkward sidebars.
- **Mobile widths (375 px to 430 px).** Check for unintended horizontal scrollbars, touch targets that are too small or packed too tightly, modals taller than the viewport, and fixed footers covering content.
- **Browser zoom.** Test at 125% and 150% zoom to confirm text reflows cleanly without overlapping controls.

## 5. Dynamic views, tabs, and modals

Web apps rarely stay on one flat screen. Walk through stateful transitions:

- **Tabs and multi-step flows.** Switch between tabs and move forward and back through multi-step dialogs. Confirm state persists where expected and resets when a dialog closes.
- **Record switching.** Open two different customer accounts or items on the same screen template to verify layout holds up across both sparse and dense records.
- **Scroll behavior.** Test long pages and tall dialogs to ensure the outer page does not scroll behind an open modal and sticky headers stay aligned.

## 6. Basic accessibility checks

Catch high-impact accessibility regressions before release without waiting for a full audit:

- **Keyboard navigation.** Tab through every interactive element on the page. Confirm focus order matches the visual layout, focus rings are clearly visible, and you can open and close menus and dialogs using Enter, Space, and Escape without getting trapped.
- **Form labels and error announcements.** Click every field label to confirm it focuses its input. Check that icon-only buttons have readable accessible names.
- **Motion and contrast.** Confirm status is never communicated by color alone and animations stay subtle.

## How to report design QA findings so developers fix them once

Even a thorough checklist stalls if feedback arrives as vague messages in chat. Every design QA note should answer four things automatically: what element it is about, what screen and tab were open, what the reviewer saw, and what it should look like instead.

On React staging and preview builds, [Critiqs](/docs/install) captures the first three automatically: switch to Comment mode (press `C`), click the element, and tag the thread (`Design change request`, `UX copy change`, or `Bug`). Critiqs pins the comment to the element, saves a capture with the element outlined, and records the page, viewport, and view state (when wired with `getContext` and `restoreContext`) so developers can jump straight back to that tab or dialog.

For the fourth part, showing what it should look like instead, open [Mockup mode](/docs/mockup-mode) (press `M`). Describe the spacing, typography, color, or copy adjustment in plain words and let Critiqs AI edit a frozen HTML and CSS copy of the page. Save the version in the thread, check it against the live build with **Hold to compare**, and hand the thread to a developer or a coding agent over [Critiqs MCP](/docs/mcp).

## Frequently asked questions

### When should a team run design QA in the release cycle?

Run design QA on pull request previews before code merges for feature work, and run a final pass on staging before a major release. Catching spacing, state, and copy issues on a branch preview is much cheaper than opening follow-up tickets after code reaches staging or production.

### Who should run the design QA checklist?

Usually the designer who owns the feature pairs with a product manager or frontend engineer. Letting designers comment directly on the preview build in a browser removes the need for them to pull code locally or sit on a screen-share call while an engineer clicks through every state.

### How do you keep design QA notes from getting lost across builds?

Use a feedback tool that stores threads against a project rather than a single ephemeral URL. In Critiqs, giving your pull request preview, staging build, and QA environment the same [project ID](/docs/projects) keeps every thread in one list, with its original capture and build version preserved even after elements move or change.

### Do I need to run every item on the checklist for a small UI change?

No. For a small pull request, focus on the changed component, its interactive states (hover, loading, empty, error), its behavior at mobile and desktop widths, and keyboard navigation inside the changed area. Run the full checklist before larger feature launches or design-system updates.
