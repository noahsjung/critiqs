---
title: Keyboard shortcuts
description: Reference for every Critiqs keyboard shortcut across Browse mode, Comment mode, Mockup mode, commenting, and sidebar resizing.
section: Review
order: 4
---

Critiqs provides keyboard shortcuts for switching modes, hiding the overlay, posting comments, and comparing mockups. You can also view the main shortcuts inside the app by opening your avatar menu on the toolbar.

Single-key shortcuts (`C`, `V`, `M`, and `O`) work whenever your cursor is not inside a text field (`input`, `textarea`, `select`, or an editable comment box) and no Critiqs menu or dialog is open.

## Modes and visibility

| Shortcut | Action | Notes |
| --- | --- | --- |
| `C` | Toggle **Comment mode** | Switches straight to **Comment mode** from **Browse mode** or **Mockup mode**, or returns to **Browse mode** when already in **Comment mode**. Brings back a kept comment draft if you left **Comment mode** with unsent text. |
| `V` | Switch to **Browse mode** | Leaves **Comment mode** or **Mockup mode**. Cancels element reattachment and keeps any non-empty comment draft for `C`. |
| `M` | Toggle **Mockup mode** | Enters **Mockup mode** from **Browse mode** or **Comment mode**, or returns to **Browse mode** when already in **Mockup mode**, on backends that support mockups. |
| `Ctrl + \` (Windows/Linux) or `Cmd + \` (macOS) | Hide or show Critiqs | Works everywhere, even while typing. Also responds to `|` on keyboards where Shift produces pipe. Keeps drafts, open windows, dialogs, and focus intact; resets when you reload the page. |
| `Esc` | Close the innermost open item | Never changes your current mode. See the closing order below. |

### What Escape closes

Pressing `Esc` closes one layer at a time, starting with the innermost open control, without switching modes:

1. Hovered placement help tooltip (**This component** / **Matching components**)
2. Open suggestion list (`@mentions` or `#tags`) inside a comment box
3. Open menu or dialog
4. Active search results (when focus is in the search box)
5. Open new-comment composer (in **Comment mode**) or selected element composer (in **Mockup mode**)
6. Active element reattachment mode (**Reattach…**)
7. Open thread window
8. Open side panel (**Project**, **Comments**, or **Mockup**)

## Commenting, replying, and search

| Shortcut | Where it works | Action |
| --- | --- | --- |
| `Ctrl + Enter` or `Cmd + Enter` | New comment, reply box, message edit, Mockup composer | Post the comment, send the reply, save the edit, or send the Mockup request. |
| `ArrowUp` / `ArrowDown` | `@mention` or `#tag` suggestions | Move the highlight up or down in the suggestion list. |
| `Enter` or `Tab` | `@mention` or `#tag` suggestions | Insert the highlighted person or tag. |
| `Esc` | `@mention` or `#tag` suggestions | Dismiss the suggestion list without closing the comment box. |
| `Ctrl + Z` or `Cmd + Z` | Comment and reply editor | Undo text changes. |
| `Ctrl + Y`, `Ctrl + Shift + Z`, or `Cmd + Shift + Z` | Comment and reply editor | Redo text changes. |
| `Esc` | Search box (when results are shown) | Clear the search and return to the full thread list. |

## Mockup mode

| Shortcut | Action | Notes |
| --- | --- | --- |
| Hold `O` | Compare with the live page | Temporarily hides the frozen page copy to show the live page underneath, identical to pressing and holding **Hold to compare**. Works when the app is showing the mockup thread's page. |
| `Space` or `Enter` (held) | Compare with the live page | Works while keyboard focus is on the **Hold to compare** button. |

## Resizing the sidebar

Focus the vertical separator along the left edge of any open side panel (**Project**, **Comments**, or **Mockup**) to resize it from the keyboard:

| Shortcut | Action |
| --- | --- |
| `ArrowLeft` | Make the sidebar wider by 24 px. |
| `ArrowRight` | Make the sidebar narrower by 24 px. |
| `Home` | Set the sidebar to its minimum width (300 px, or the window width if narrower). |
| `End` | Set the sidebar to its maximum width (up to 720 px, leaving at least 160 px for the page on wider windows; on narrow windows the sidebar keeps its 300 px minimum width, so the page can get less than 160 px). |

Double-clicking the left edge separator resets the sidebar to its default width (360 px). Your chosen width is remembered across all panels in your browser.
