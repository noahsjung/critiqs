# Mockup mode

> Freeze a page copy, ask Critiqs AI for HTML and CSS design changes, manage versions, compare with the live page, and add width copies.

Mockup mode lets you propose visual and copy changes directly on a page during a review. Instead of describing a layout change in a paragraph, you ask Critiqs AI to edit a frozen copy of the page so developers and coding agents see what you mean.

## How Mockup mode works

When you enter **Mockup mode**, Critiqs freezes the current page into a **page copy**. The copy keeps the page's HTML, collected CSS stylesheets, form values, scroll positions, and canvases converted to images. Scripts and event handlers are removed, and elements marked with `data-critiqs-mask` are covered.

Critiqs displays the page copy in a sandboxed iframe over your app. Critiqs AI edits only the copy's HTML and CSS, never your running app or source code. You cannot navigate the live app until you leave **Mockup mode** (`V`).

> **Note:** Mockup mode is available on Critiqs Cloud and team-owned Convex deployments.

## Start a mockup thread

Each mockup thread is its own proposal with its own page copies and versions. Anyone signed in to the project can open and continue it.

1. Navigate to the screen and state you want to change in **Browse mode**.
2. Press `M` or click **Mockup mode** on the toolbar. The **Mockup** panel lists **This page** first, followed by threads from other pages (click **Show more** to load 20 more).
3. Click **New thread**.
4. Type a request for the whole page in the bottom box, or click an element on the copy to ask about that element specifically.
5. Optionally click **+ Add existing comment** above the box to attach up to 20 project comments as chips (click `×` to remove one). With comments attached, you can click **Send** without typing text and Critiqs AI makes the changes those comments ask for.
6. If your AI connection offers multiple models, choose one in the **Model** menu beside **Send**. Critiqs remembers your choice per project.
7. Click **Send** or press `Ctrl + Enter` (or `Cmd + Enter`). A new thread is saved when you send its first message.

## Watching Critiqs AI work

Messages from people sit on the right, and Critiqs AI replies sit on the left. While Critiqs AI works:

- The thread shows live progress steps with a timer in seconds: **Read the page**, then **Change the HTML and CSS**. On long pages where a change extends past the visible viewport, Critiqs AI adds **Continue further down the page** and saves a version for each pass.
- A light sweeps over the frozen page copy with the indicator **Critiqs AI is editing this copy** until the new version swaps in.
- One Critiqs AI turn runs at a time so sequential changes never conflict.

If a project requires your own AI connection and you have not set one up, Critiqs AI shows **Set up your AI** beside **Try again**. See [Your AI](/docs/your-ai).

## Versions, View, Restore, and Hold to compare

Each Critiqs AI reply saves a new **mockup version** (Version 1, Version 2, and so on). Versions are never rewritten.

- **View:** Click **View** on any version card to preview that version on the copy. Click **Back to latest** in the top banner to return.
- **Restore:** Click **Restore** on an earlier version card to save a new latest version matching it while keeping the full history.
- **Hold to compare:** Press and hold **Hold to compare** in the thread header, or hold `O`, to reveal the live page underneath.

Live comparison works when the app behind the copy is on that thread's page. Opening a thread from another page asks **Go to \<screen\>?** so the app can navigate there via `restoreContext`. If the app cannot restore that view, the thread still opens on its saved copy without live comparison.

## Test multiple widths with width copies

A mockup can hold up to six page copies at different viewport widths, such as desktop and phone.

1. Open a mockup thread while your app shows that thread's page.
2. Resize your browser window to the width you want.
3. Click **Take a copy at \<width\> px** in the banner at the top of the panel.

Width tabs (such as `1440 px` and `390 px`) appear once a mockup has two or more copies. A new width copy starts from the live page without earlier edits; reply in the thread to bring existing changes to it. Later replies update every copy in the mockup.

## Good requests versus bad requests

Mockup mode edits static HTML and CSS. Ask for visual and content changes, not runtime behavior.

| Good requests (HTML and CSS) | Bad requests (app logic and data) |
| --- | --- |
| "Spell out Ops as Operations and make table headers uppercase." | "Fetch the customer's billing history from Stripe." |
| "Show seat usage as a progress bar next to the count." | "Make Save validate the form and call our API." |
| "Make Upgrade plan a quieter outline button with 16 px top spacing." | "Sort this table by date when someone clicks a column header." |
| "Stack these three stat cards into one column on mobile." | "Add role-based permissions so only admins see this tab." |

When the team agrees on a mockup, coding agents read its HTML and CSS edits and linked comments through the `critiqs_mockups` and `critiqs_mockup` MCP tools and build the change in your app's real components.
