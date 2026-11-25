---
title: Leaving comments
description: Switch between Browse mode and Comment mode, pick an element, choose This component or Matching components, post feedback, and use pins.
section: Review
order: 1
---

Critiqs lets you pin feedback directly to any element on a running build. Each comment starts a thread and saves a capture of what you saw so nobody has to explain which screen or button they meant.

## Browse mode and Comment mode

Use the floating toolbar at the bottom of the screen to switch modes:

- **Browse mode (`V`):** Interact with the app normally. Click links, fill forms, open tabs, and navigate to the screen you want to review. Opening the side panel in **Browse mode** shows the **Project** panel.
- **Comment mode (`C`):** Pick elements to comment on. Your cursor turns into a crosshair, and hovering outlines elements on the page. While you pick an element, Critiqs intercepts clicks and keystrokes so buttons, links, and forms in the app do not fire. Opening the side panel in **Comment mode** shows the **Comments** list.

You can drag the toolbar's grip handle to move it sideways, or click **Collapse toolbar** to tuck it into a compact button. If the toolbar would cover the element you are commenting on, it moves to the top of the screen automatically.

## Leave a comment

1. Navigate to the screen, tab, or dialog you want to review in **Browse mode**.
2. Press `C` or click **Comment mode** on the toolbar.
3. Hover over the element you want to comment on and click it. Critiqs outlines the element and opens a comment box beside it.
4. If you are not signed in yet, click **Sign in** inside the comment box. Your element selection stays in place while you sign in with your email code.
5. Type your comment. Type `@` to mention another reviewer who has commented in the project, or type `#` to add a tag.
6. If the composer shows placement options, choose **This component** or **Matching components** (explained below).
7. Click **Comment** or press `Ctrl + Enter` (or `Cmd + Enter` on macOS).

Critiqs automatically takes a capture of the visible screen with the element outlined and opens your new thread beside its pin.

> **Note:** If you leave **Comment mode** (for example by pressing `V`) while you have text typed in a new comment, Critiqs keeps your draft. Press `C` to return to it beside the element.

## This component versus Matching components

When you click an element inside a repeated record (such as one customer's row in a table or one order's details, marked by your app with `data-critiqs-record`), the comment box offers two placement options:

- **This component** (default): Attaches the feedback to this component on this record only. Use it for feedback tied to one specific item, such as a wrong value on one customer's account or spacing on one specific card.
- **Matching components:** Shares one discussion across every record where your app renders the same component. Use it for feedback that applies everywhere that component appears, such as renaming a button label or changing a column heading.

Your app determines which components match (through `data-critiqs-id`). Choosing **Matching components** does not change who can see the comment; everyone with access to the project can see all threads.

Hover over or click the info icon beside either choice in the composer to read its short explanation in place.

## Working with pins

After you post a comment, Critiqs places a pin showing the author's initials on the top-right corner of the target element.

- **Click a pin** to open its thread window beside the element without changing your current view.
- **Click anywhere in the app** (or press `Esc`) to close the thread window. Any reply text you typed stays saved in the reply box until you send or clear it.
- **Multiple threads on one element** fan out into rows along the element's edge so every pin remains clickable.
- **Live layout tracking:** Pins move with the element as you scroll or resize the window, hide when the element is clipped inside a scroll container, and stay left of an open sidebar.
- **Shared threads** (**Matching components**) can display a pin on each matching element currently visible. Clicking a specific pin opens the thread window beside that pin.

Viewing a pin on the page does not mark its thread read. A thread is marked read only when you open it and view its messages.

## When an element is not on screen

If an element lives on another screen, inside a closed tab or dialog, or was removed in a newer build, no live pin appears on the current view. The thread remains in the **Comments** sidebar under **Other views on this screen** or **Other screens** with its saved capture and context. See [Threads](/docs/threads) to learn how to jump back to it or reattach it to a replacement element.
