# Introduction

> Learn what Critiqs is, who uses it, and how feedback flows from a staging or preview build to developers and coding agents.

Critiqs is a toolbar and sidebar that you add to your staging, preview, or QA builds, with a package for React and Next.js (`critiqs-react`), Vue, Nuxt, Svelte, SvelteKit, Angular, Astro, Solid, Ruby on Rails, Django, and Flask, and a script tag for any other site. Product managers, designers, QA testers, and clients open your build in a browser, click any element on the page, and leave comments in threads.

Every comment keeps a capture of the screen, the page address, the element it points to, and any tab or view state your app reports. Developers and coding agents get the full context without chasing screenshots in chat.

## Who Critiqs is for

Critiqs fits teams where non-engineers and engineers review builds together before release.

- **Reviewers:** Product managers, designers, QA testers, stakeholders, and clients. They open the build link in a browser, sign in with a one-time email code, and comment without installing a browser extension or cloning a repository.
- **Developers and coding agents:** Engineers read threads directly on the build or export selected threads as Markdown or JSON. Coding agents connect through the Critiqs MCP server (`npx critiqs mcp`) to read threads, inspect captures and mockups, and post replies marked "via coding agent".
- **Project owners:** Developers who add `<Critiqs />` to the app, manage the project ID and review address, and configure tags, tag groups, and AI settings.

## What Critiqs adds to your app

When Critiqs is active on a build, it mounts inside its own shadow root above your app. Its styles, keyboard shortcuts, and UI stay isolated from your code.

The floating toolbar at the bottom of the screen gives reviewers three modes:

- **Browse mode:** Use the app as usual. Open the side panel to see the **Project** panel, including open and unread thread counts, recent participants, email notification settings, and the project ID.
- **Comment mode:** Click any element to start a thread. Open the side panel to browse, filter, search, or export threads. See [Comments](/docs/comments) and [Threads](/docs/threads).
- **Mockup mode:** Freeze the current page into an HTML and CSS copy and ask Critiqs AI to edit that copy so feedback includes a visual proposal. Your running app never changes. See [Mockup mode](/docs/mockup-mode).

## How a review flows

A typical review cycle runs in five steps:

1. **Deploy a build with Critiqs enabled.** Add `<Critiqs />` once in your app, set your project ID in staging, preview, and QA build settings, and leave it unset in production so customers never see Critiqs. See [Install Critiqs](/docs/install) and [Projects and project IDs](/docs/projects).
2. **Reviewers open the link and sign in.** Reviewers click **Sign in** on the toolbar, enter their email address, and type the six-digit code Critiqs emails them. Their first sign-in creates an account and asks for a display name.
3. **Reviewers pin comments or mock up changes.** In **Comment mode**, reviewers click elements, write comments with `@mentions` and `#tags`, and post. In **Mockup mode**, they ask Critiqs AI to try wording, spacing, or layout changes on a frozen page copy.
4. **People discuss and triage in threads.** Mentioned reviewers and people in a thread receive notification emails with the capture, the discussion, and a link back to the build. Reviewers reply, react, filter by tag or screen, and resolve threads when addressed.
5. **Developers or coding agents build the fixes.** Developers open threads on the build or export a collection as Markdown or JSON. Coding agents read open threads and mockup diffs through the MCP server, apply changes in the codebase, and post a reply asking reviewers to verify the next build.

## Hosting and AI choices

By default, Critiqs stores feedback and handles sign-in and email on Critiqs Cloud. Teams that must keep feedback on their own infrastructure can deploy Critiqs to their own Convex deployment instead. See [Backends](/docs/backends).

AI is optional. Commenting, threads, mentions, tags, filters, basic search, and exports work without AI. When enabled, AI powers Mockup mode, plain-language search with cited insights, and automatic tag grouping, using either Critiqs AI credits or your own AI provider key. See [AI models and credits](/docs/ai-models-and-credits) and [Your AI](/docs/your-ai).

## Next steps

- Follow [Install Critiqs](/docs/install) to add Critiqs to your app with `npx critiqs init`.
- Read [Projects and project IDs](/docs/projects) to share one feedback list across staging, preview, and QA builds.
