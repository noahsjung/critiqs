# Best practices for build reviews

> Practical patterns for configuring projects, naming builds, tagging threads, using Mockup mode, and handing work to coding agents.

These patterns keep build reviews focused, prevent feedback from fragmenting across environments, and give developers and coding agents clean context.

## 1. Use one project ID across staging, preview, and QA

Give every review environment for the same app the same Critiqs project ID. Staging, pull request previews, and QA builds then share one thread list instead of splitting comments by URL.

- Set the app's environment variable (`VITE_CRITIQS_PROJECT_ID` or `NEXT_PUBLIC_CRITIQS_PROJECT_ID`) to the same project ID in your staging, preview, and QA build settings.
- Point the project's review address to your main staging build so mention and reply emails open a stable URL for everyone:

  ```sh
  npx critiqs-react init --review-url https://staging.example.com
  ```

- In a monorepo, keep one separate Critiqs project per app (for example `VITE_CRITIQS_PROJECT_ID_WEB` and `VITE_CRITIQS_PROJECT_ID_ADMIN`). Do not share one project ID across different apps.

## 2. Keep production clean and invite clients to staging

Use `requireProjectId` on `<Critiqs />` (added automatically by `critiqs init` in Vite and Next.js apps) and leave the project ID environment variable unset in production builds:

```tsx
import { Critiqs } from "critiqs-react";

<Critiqs projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID} requireProjectId />
```

When the variable is unset, Critiqs renders nothing on the page and makes zero network requests.

To run a client or stakeholder review, share your staging or preview URL. Reviewers need no browser extension, repository access, or organization invite: they open the link and sign in with an email code. Because anyone who can open a build with a project ID can see that project's feedback, guard access to your staging or preview environment itself.

## 3. Name builds clearly and pass view context

Pass the `version` prop so every comment records the build or commit it came from, and pass `getContext` and `restoreContext` so clicking a thread brings back its tab, dialog, or record:

```tsx
<Critiqs
  projectId={import.meta.env.VITE_CRITIQS_PROJECT_ID}
  requireProjectId
  version={import.meta.env.VITE_BUILD_VERSION}
  getContext={getContext}
  restoreContext={restoreContext}
/>
```

Good `version` labels include a branch name plus short commit SHA (such as `pr-482-a1b2c3d`) or a staging build tag (`staging-2026.11.24`). Avoid generic labels like `dev` that hide whether feedback predates a fix.

## 4. Use `#tags` for triage

Critiqs starts every project with four preset tags (**Bug**, **UX copy change**, **Design change request**, and **User feedback**) and turns any inline `#hashtag` (such as `#wording`, `#a11y`, or `#blocker`) into a filterable tag.

- Agree on two or three lightweight triage tags for your team (for example `#blocker`, `#copy`, `#polish`).
- Group related tags in **Tags and AI** so everyone can filter by one shared group (Critiqs includes **Copy & wording** as a starter group and groups new tags automatically when AI is on).
- Click any posted tag on a thread to filter the list to matching threads.

## 5. Comment on the element and resolve when shipped

Point at the specific element your feedback is about rather than leaving a general note on the outer container:

1. Press `C` to enter Comment mode and click the exact button, label, or cell.
2. On repeated items (such as table rows or customer cards), choose **This component** for feedback about one record or **Matching components** for feedback about the component across every record.
3. Keep threads open while work is in progress. Have a developer or coding agent reply with what changed, then resolve the thread only after verifying the fix on a deployed build.

If your staging build shows real or sensitive customer data, add `data-critiqs-mask` to a containing element so automatic captures and mockup copies cover that region. Put `data-critiqs-mask` on a wrapper rather than directly on a `<canvas>`, `<video>`, or `<iframe>`.

## 6. Use Mockup mode for visual changes only

[Mockup mode](/docs/mockup-mode) (`M`) freezes a static HTML and CSS copy of the current page so reviewers can explore wording, spacing, colors, or layout ideas with Critiqs AI.

- Use Mockup mode for visual and copy tweaks where showing the result is faster than writing a paragraph.
- Do not expect Mockup mode to run interactive JavaScript flows, form submissions, or API calls; scripts do not run inside page copies.
- Link existing comments with **+ Add existing comment** so Critiqs AI addresses open review feedback in one visual proposal.

## 7. Add `data-critiqs-id` for reliable pins and coding agents

When you connect a coding agent through [MCP](/docs/mcp), Critiqs gives the agent each thread's `context.target.purposeId` and each mockup change's nearest `data-critiqs-id`. Adding stable `data-critiqs-id` attributes to key components helps in two ways:

1. Pins survive DOM restructuring and styling changes across builds.
2. Coding agents can jump straight to the right component by grepping for the `data-critiqs-id` value.

```tsx
<div data-critiqs-record={`customer:${customer.id}`}>
  <span data-critiqs-id="customer.department">{customer.department}</span>
  <button data-critiqs-id="customer.upgrade-plan">Upgrade plan</button>
</div>
```

- Use semantic names (`customer.department`, `billing.invoice-date`) rather than CSS class names or layout positions.
- Add `data-critiqs-record` on repeating containers so Critiqs distinguishes one record from another and never places a record-specific pin on the wrong item.
- Pair `data-critiqs-id` with the [Critiqs MCP server](/docs/mcp) and [agent skill](/docs/agent-skill) so agents read threads, fix components, and reply "via coding agent" without extra prompting.
