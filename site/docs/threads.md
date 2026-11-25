# Threads and the sidebar

> Reply, use @mentions and #tags, resolve threads, track unread comments, filter the sidebar, and jump back to where a thread was left.

Every comment starts a thread with a shared status (**Open** or **Resolved**) and personal read and unread tracking for each reviewer.

## Reply, react, and edit

Click any pin on the page or any thread in the **Comments** sidebar to open its thread window.

- **Reply:** Write in the reply box and click **Reply** or press `Ctrl + Enter` (or `Cmd + Enter`). Replies posted by a coding agent through the MCP server show the author's name with `via coding agent`.
- **React:** Click **Add reaction** on any message to add or toggle an emoji reaction.
- **Edit or link:** Click **Message actions** to **Copy link to message** or, on your own messages, **Edit**. Edited messages show `(edited)`.

## Tag threads with #tags

Type `#` in a comment or reply to pick a project tag or create a new hashtag such as `#wording`. New projects start with four project tags: **Bug**, **UX copy change**, **Design change request**, and **User feedback**.

- A thread carries every hashtag used in any of its messages (up to 30 distinct hashtags per message and 200 per thread).
- Click any `#tag` chip on a thread or message to filter the sidebar to that tag.
- Project owners organize related tags into shared **Tag groups** under **Tags and AI** in the sidebar header. Every project includes a starter **Copy & wording** group. With AI enabled, new tags are grouped automatically without overriding manual choices.

## Mention reviewers with @mentions

Type `@` in a comment or reply to pick a participant (anyone who has commented in the project). Suggestions show display names and avatars, never email addresses.

- Mentioned people receive a notification email with the thread's capture, full discussion, and a link to the project's review address.
- Everyone else **in a thread** (who started it, replied in it, or was mentioned in it) receives reply emails unless they turn them off.
- Mentions and replies within one minute are grouped into one email per reviewer and thread.

Open **Email notifications…** from your avatar menu or the **Project** panel to toggle **Email me when someone mentions me**, toggle **Email me about new replies in threads I'm in**, or **Mute** the project.

## Resolve, reopen, and delete

- **Resolve:** Click **Resolve** in the thread header when feedback is addressed. A toast offers **Undo**, and resolved threads stay archived so you can **Reopen** them later.
- **Copy link:** Open **More actions** and click **Copy link** to share a link to the thread.
- **Delete:** Open **More actions** and click **Delete thread…**. Deleting removes the thread for everyone and makes links report it unavailable. The dialog offers **Resolve instead** to keep the history.

## Unread tracking

Read state is personal and does not change the thread's status for anyone else.

- Critiqs marks a thread read through the newest message visible inside the thread window while your browser tab is active.
- Opening an unread thread scrolls to the **New messages** divider.
- Edits, reactions, and status changes do not make a thread unread again.
- Open **More actions** and click **Mark unread** to close a thread and flag it for later.

The badge on the toolbar's panel button counts your unread threads, and unread threads display a dot in the sidebar.

## Browse, filter, search, and export in the sidebar

In **Comment mode**, the **Comments** sidebar groups threads by where their target is now, sorted newest activity first in each group:

1. **In this view:** Elements currently visible on screen.
2. **Other views on this screen:** Elements on the same screen, inside another tab, dialog, or record.
3. **Other screens:** Threads left on different screens.

Drag the sidebar's left edge to resize it, or double-click the edge to reset its width.

- **Filter:** Click **Filter** to filter by **Status** (**Open**, **Resolved**, **Open and resolved**), **Show** (**Unread only**, **This screen**, **All screens**), **Tag groups**, and **Tags**. Click **Reset** in the filter bar to clear changes.
- **Search:** Search by words or `#tags` at the top of the sidebar. With AI enabled, ask a plain-language question for matching threads and cited **Insights**. Without AI, search runs as **Basic search**.
- **Export:** Click **Select threads to export**, tick threads (or **Select all**), and click **Export…** to copy or download up to 200 threads as **Markdown, for people** or **JSON, for tools**.

## Go back to where a thread was left

Click a thread in the sidebar, open a shareable link, or click **Show in prototype** inside a thread to return to its original view.

When the host app provides `getContext` and `restoreContext`, Critiqs asks the app to switch to the thread's screen and view state, waits up to three seconds for the target element to appear, highlights it briefly, and opens the thread window beside its pin.

If the app does not restore views automatically, or if the element moved or disappeared in a newer build, the thread window docks beside the sidebar with **Saved context** open. When an element has been replaced, click **Reattach…** and select the replacement element while preserving the original capture and context.
