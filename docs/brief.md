# Critiqs product brief

Working product definition. See [first-release scope](first-release.md),
[technical direction](technical-direction.md), and [glossary](glossary.md).

## Purpose and problem

Critiqs brings feedback into the prototype being reviewed. People select an
interface element, leave a comment, discuss it, and resolve the thread.
Developers can collect related threads into a handoff for implementation.

Today, feedback often arrives as screenshots and messages in tools such as Teams.
Developers must reconstruct the screen, selected data, and interaction state.
Replies become scattered, and outstanding feedback is hard to track.

The initial setting is a team sharing prototypes through GitHub while external
review services face a cumbersome approval process. Critiqs runs on Critiqs Cloud
by default; a team that must use services it is permitted to use can self-host
Critiqs's open-source code on its own storage instead.
Internal development does not itself establish organizational approval.

One page can show different tabs, dialogs, records, or demo user roles. Prototypes
also change quickly: elements move, change type, or disappear. Feedback must
remain understandable even when its original element is unavailable.

## Users

- **Reviewers:** product managers, designers, stakeholders, and developers who
  leave and discuss feedback.
- **Implementers:** developers and coding agents who use feedback to make changes.
- **Project owners:** developers and prototype builders who install Critiqs and
  set up its project. They may also connect their own backend.

A reviewer's sign-in identifies the real author. A demo person or role displayed
inside the prototype is context, not the author's identity or permissions.

## Product principles

- Preserve the original visual, view state, and prototype version.
- Keep feedback findable in the sidebar when a live pin is unavailable.
- Keep collaboration simple: shared thread status, personal read/unread state.
- Use Figma's familiar comment sidebar and thread interactions as the design reference.
- Reuse proven competitor patterns. When an interaction is commonly used, well
  implemented, or offers a good user experience in Lucidly, Pastel, Liveblocks,
  or Markup, implement similar or the same behavior where it fits Critiqs.
- Make installation a drop-in: add the package and one component, and complete
  setup inside Critiqs. Host developers should not need to configure services.
- Keep both ways of running Critiqs short: Critiqs Cloud needs no service setup;
  self-hosting asks only for the keys its services need, and coding agents can
  complete either through Critiqs's command line, MCP server, and instructions.
- Let projects configure services through adapters, keeping the experience as
  consistent as each service allows.
- Make threads easy to share and combine into a handoff without losing their history.

## Initial product and success

Start with an open-source npm package for React, developed separately from the
host app, running on Critiqs Cloud by default.
Other frameworks, a browser extension, and a standalone review app come later.

The pilot succeeds when two reviewers can discuss an element in a hidden view,
find it again, and understand its context after a prototype update. A developer
can export the feedback without reconstructing separate messages.

## Product references

[Lucidly](https://www.lucidly.so/), [Pastel](https://usepastel.com/),
[Liveblocks Comments](https://liveblocks.io/comments), and
[Markup](https://www.markup.io/) inform visual feedback and interaction design.
[Figma comments](https://help.figma.com/hc/en-us/articles/360041547593-View-and-manage-comments)
inform the interaction and sidebar design.
