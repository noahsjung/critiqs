# Critiqs product glossary

Use these terms consistently across the [brief](brief.md),
[scope](first-release.md), [technical direction](technical-direction.md), and interface.
These definitions describe the intended product, not completed features.

## Product terms

| Term | Meaning |
| --- | --- |
| Prototype / host app | The interactive application being reviewed. Critiqs is installed inside it; it remains a separate library. |
| Critiqs project | The shared feedback space for one prototype. Any signed-in reviewer using the prototype can access it, unless its owners limit it to its organization. It belongs to an organization. |
| Who can review (review access) | A project's setting for who may read and add to its feedback: **Anyone who signs in** (the default; the project ID is enough) or **Organization members** (only members of the project's organization). Only the project's owners change it. |
| Project owner | Someone who can change a project's settings: an admin of its organization, or the person who created it while they are still a member. Before organizations, only the person who created it. |
| Project setup | What the sidebar shows before a prototype's project exists: sign-in and creating the project. |
| Critiqs Cloud | Critiqs's paid hosted service, with a free plan: backend, sign-in, and email run by Critiqs. The default. |
| Self-hosted | Running Critiqs's open-source server code on storage the team controls, with no Critiqs service involved. |
| Team-owned Convex | Self-hosting on the team's own Convex deployment, running Critiqs's Convex functions. |
| Embedded SQLite | Proposed later self-hosting inside the host app's own server, storing feedback in a SQLite file. |
| Organization | The group that owns Critiqs projects and holds their Critiqs Cloud plan and billing. Its people are admins and members; reviewers don't join it. Each person who had projects before organizations gets their own, holding those projects and their plan. |
| Admin | An organization role: manages its billing, plan, settings, and members, manages every project in it, and gets its alert emails about AI credits. |
| Member | An organization role: creates projects in it and uses them, and manages the projects they created. |
| Plan / limit | A Critiqs Cloud subscription level and the usage it allows, such as AI credits, projects, reviewers, or comments. Each organization has one plan. Self-hosted deployments have no plans. |
| Free / Plus / Pro | Critiqs Cloud's plans: Free, Plus at $20 a month, and Pro at $100 a month. Their limits are in [first release](first-release.md#plans-and-payment). |
| Reviewer | The signed-in person reading or leaving feedback. |
| Reviewer ID | Critiqs's permanent ID for a reviewer, independent of how they sign in. |
| Display name | The name a reviewer chooses to show on their comments. |
| Sign-in code | The one-time code Critiqs emails to verify a reviewer's address. |
| Setup code | The short code, such as `BCDF-GHJK`, that setup on another device shows; the person types it into Critiqs's sign-in pages in any browser to approve that setup. Not a sign-in code. |
| Allowed site | A prototype address (origin) a reviewer allowed to use their Critiqs sign-in. Critiqs asks the first time they sign in there. |
| Demo persona | The example person or role shown inside the prototype. It does not change the reviewer's identity or access. |
| Browse mode / Comment mode | Use the prototype normally / select an element to leave a comment. |
| Mockup mode | Freeze the current page into a page copy and ask Critiqs AI to change it, to show a proposed change during a review. The prototype can't be navigated until the reviewer leaves the mode. The interface labels it **Mockup**. |
| Toolbar | Critiqs's floating control at the bottom center of the prototype: modes, sidebar, sign-in, and setup. |
| Review address | The one page of the prototype that notification emails open, for every copy (local, preview, and deployed), such as the deployed prototype. The project's owner enters it in setup or later; nothing else sets or changes it. A local or private review address, such as `http://localhost:5173` or a Tailscale (`.ts.net`) address, opens only on one computer or private network. |
| Address list | The origins a project's prototype runs at, such as `https://acme-proto.vercel.app`, or patterns with one `*` in the leftmost part of the host, such as `https://*-acme.vercel.app`. The browser extension finds a page's project by it, among projects the person can already reach. Only the project's owners change it. Separate from the review address. |
| Screen (page) | A logical page type, such as user details. Different users' detail URLs can belong to the same screen. |
| Record | The specific item being shown, such as Alex's user account. |
| View state | Settings that affect visible content: selected tab, open dialog, filters, or step. |
| View | A screen showing particular records in a particular view state. The same URL can show several views. |
| Context | The screen, record/persona, view state, and version needed to understand feedback. |
| Thread | An initial comment and its replies, with one shared status. |
| Message / comment | One person's contribution to a thread. The first message starts it; later messages are replies. |
| Reaction | A quick response to a message, such as an emoji. |
| Mention | A reference to another reviewer in a message, which notifies them by email. |
| Notification | An email telling a reviewer they were mentioned, or that someone replied in a thread they are in, with the thread's capture, its discussion, and a link to the message. |
| In a thread | Having started a thread, replied in it, or been mentioned in it. People in a thread get reply emails unless they turn them off. |
| Agent reply | A reply a coding agent wrote for the signed-in reviewer (`critiqs_reply`), shown as theirs with "via coding agent". |
| Participant | Someone who has commented in a project; the people who can be mentioned. Not a member list. |
| Open / Resolved / Deleted | Thread statuses: needs review or action; addressed and hidden by default; removed from ordinary access. Resolved also serves as archive. |
| Read / unread | Whether one reviewer has viewed the thread's content or marked it unread for later. Independent of shared status. |
| Target | The interface element a thread refers to. |
| Anchor | The information Critiqs stores to locate a target in the right context. |
| Pin | A visible marker beside a target that can currently be located. |
| Thread window | The small window beside a pin showing a thread's discussion and reply box. Opens beside the sidebar when the target is unavailable. |
| Thread list | The sidebar's list of threads, its panel in Comment mode. |
| Thread page | One thread's page on Critiqs's website, with its capture, discussion, reply box, and **Open in prototype**, so a link works on phones and without the extension. Its link (`/t/<page key>`) carries a page key, never the thread's ID. It opens only for people in the project's organization or already in the thread. |
| Project panel | The sidebar in Browse mode: the project's name, open and unread threads, who has access, the reviewer's email notifications, plan usage for the owner, and the project ID. |
| Documentation panel | Opened from the Project panel: what each part of Critiqs does and how to use it, searchable. Its text lives in `packages/react/src/ui/docs.ts`. |
| Capture | The saved image and marked location from when feedback was left. It is evidence, not a working copy of the app. |
| Mockup | One proposed change to one page, made in its mockup thread, with its own page copies and versions, and any comments added for Critiqs AI to read. Anyone in the project can open and continue it. Not a working copy of the app. |
| Page copy | A frozen HTML copy of the page at one width, with the page's own stylesheets and no scripts, that a mockup changes. A mockup can hold copies at several widths, such as desktop and phone. Different from a capture, which is an image. |
| Mockup version | One saved state of a mockup's changes. Critiqs AI adds one for each change, and restoring an earlier version adds a new one that matches it; versions are never rewritten. |
| Mockup thread | The conversation that makes a mockup: started on the whole page or on one element of a page copy, its messages ask Critiqs AI for changes. Each mockup thread is its own mockup. Mockup threads appear only in Mockup mode, which lists every page's. |
| Critiqs AI reply | A reply Critiqs AI writes in a mockup thread, shown as "Critiqs AI", with the version it made. |
| Historical page snapshot | A proposed later representation of an earlier page that can be explored or scrolled. It does not restore the app's working state. |
| Revision / version | The prototype build a message refers to, such as a release label or Git commit. Different from Critiqs's own package version. |
| Shared / record-specific scope | Feedback about an element across compatible records, or only one record. Example: every user's department field versus Alex's department value. |
| Tag | A category attached to a thread, such as Bug or UX copy change. Different from an HTML tag such as `div`. |
| Project tag (preset) | A tag every reviewer is offered for a project, initially Bug, UX copy change, Design change request, and User feedback. The project's owner can add, rename, reorder, and remove them. |
| Hashtag | A tag written in a comment's text, such as `#wording`. The thread has it while one of its messages uses it. |
| Tag group | A shared, named set of related tags, such as Copy & wording. Filtering by a group shows threads with any of its tags. A tag may belong to several. |
| Automatic grouping | Background work that places new tags in tag groups using the project's AI. It never changes a person's choice. |
| AI connection | How a project, or a person, reaches an AI model: Critiqs-managed AI or their own provider. A project's AI can be turned off without changing this. |
| Critiqs-managed AI | AI that a deployment's operator configures for every project and person, such as on Critiqs Cloud, offered as a list of models chosen by name (for example Claude Opus 5.5 and GPT-6.2 Sol). Everyone's default. Also called Critiqs AI. |
| Own provider | A project's or a person's own AI account (OpenAI, Anthropic, Google Gemini, OpenRouter, Vercel AI Gateway, or an OpenAI-compatible endpoint), its key, and the models picked from the provider's list. |
| Your AI | A person's own AI connection, used in every project whose AI usage rule allows it. Only that person sees or changes it. |
| AI usage rule | Which connection the AI requests a person starts use, chosen by the project's owners: **Project pays** (the project's), **Each person pays** (the person's own: Critiqs AI on their home organization's plan unless they chose another), or **Project pays, personal allowed** (the person's own when they have one, otherwise the project's; the default). Background work such as automatic grouping always uses the project's connection. |
| Critiqs AI credits (credit) | What Critiqs-managed AI requests count in. One credit is one cent of what the customer pays. A request costs twice the provider's price for the tokens it used, rounded up to whole credits. Credits count against the project's organization when the project pays, or the person's home organization when they pay: the organization that pays for their own Critiqs AI. Own providers cost no credits. |
| Overage cap | How many credits past its plan's monthly credits a Plus or Pro organization may use, at $1 per 100. It starts equal to the plan's monthly credits, and admins can raise, lower, or remove it. Free has none: its requests stop when its credits run out. |
| Natural-language search | Searching feedback with a plain question, which the project's AI turns into words, tags, and filters. |
| Basic search | Search by the question's own words and `#tags`, used without AI or when AI fails, and labeled so. |
| Insight | A short finding from search results that cites the threads supporting it. |
| Hidden (Critiqs) | Critiqs's interface removed from view with Ctrl or Cmd + `\`, keeping drafts and open windows for when it is shown again. |
| Feedback collection | Selected threads grouped for a handoff, preserving each discussion. |
| Shareable link (deep link) | A URL that opens a specific thread or reply after sign-in and access checks. It may restore a live view or show saved context. |
| Reattachment | Connecting an existing thread to a replacement target while preserving its original context and evidence. |
| Restore context | Ask the host app to navigate and set relevant view state so a target becomes visible. This restores a live view, not a historical version or every internal variable. It is best effort. |
