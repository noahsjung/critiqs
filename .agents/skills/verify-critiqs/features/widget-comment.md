# Commenting with the installed widget

A reviewer signs in from the widget on a prototype, sets up a project for the page, and leaves a comment on an
element.

## Sub-features

- `sign-in`: the toolbar's "Sign in" opens the backend's sign-in window; afterwards a "Signed in as …" button.
- `project-setup`: "Set up Critiqs" → "Project name" → "Use this page" → "Create project" → "Project created"
  → "Start commenting".
- `comment`: "Comment mode", click an element, type, "Comment"; a thread window and the Comments list show it.

## How to get to it (user POV)

Open the sample app (`examples/pilot`, "Acme Admin", at `BASE+3`). The widget's toolbar sits at the bottom.

## Driving it with walk.sh

`walk.sh --feature comment` (its last step is [thread-page.md](thread-page.md)). End states:

- **widget-sign-in**: "Signed in as …" shows.
- **widget-project-created**: "Project created" showed; the toolbar is in commenting.
- **widget-comment-posted**: the thread window shows the comment's words. (The next step,
  [thread-page.md](thread-page.md), checks the saved `messages` row.)

## Gotchas

- The widget is `critiqs-root` (older builds: `critiq-root`) with an open shadow root.
- The comment targets the page's first heading ("Users"); click its center after moving the mouse onto it.
- The banner "This project is remembered only in this browser until its ID is in the prototype's code" is
  expected for a project made from the widget.
