# Tickets from comments: plan and status

This plan covers turning a thread into a ticket in a team's tracker (Linear,
GitHub Issues, or Jira), or linking it to a ticket that already exists, and
showing that link wherever the thread appears. Behavior is summarized in
[first-release scope](first-release.md#tickets); the technical choices are in
[technical direction](technical-direction.md#tickets). Terms are in the
[glossary](glossary.md).

Status words: **Agreed** means the owner asked for it; **Proposed** means it
still needs agreement; **built** means it is in this repository with local
tests. **Built:** the core ticket types, ticket text filled from a thread
without AI, encrypted tracker tokens, ticket storage on Convex with shared
backend tests, **Your trackers** on Convex for Linear, through Linear's
sign-in or a pasted API key, and, on Convex for Linear, creating a ticket from
a thread (with the capture uploaded into it) or linking an existing one, and
showing linked tickets on pins, the thread list, the thread window, and
comments added to a mockup. Not built yet: AI drafting, templates, labels, a
project's default destination, status updates, GitHub Issues, and Jira.

## Outcomes

| Outcome | Status |
| --- | --- |
| From a thread, a reviewer creates a ticket in Linear, GitHub Issues, or Jira, or links the thread to an existing ticket. | Agreed (2026-11-25). |
| Each person connects their own tracker account in **Your trackers**. Tickets are created as that person, and searching for an existing ticket shows only tickets they can already see in the tracker. | Agreed (2026-11-25). |
| A team can import or use the ticket templates it already has in its tracker. Templates are off by default when a tracker is first connected; until turned on, tickets use Critiqs's standard format. | Agreed (2026-11-25). |
| Critiqs AI drafts the ticket from the thread, following the project's AI usage rule and counting credits. Without AI, Critiqs fills the ticket from the thread directly. | Agreed (2026-11-25). |
| A linked ticket shows on the thread's pin, its row in the thread list, the thread window, and mockup threads, with the ticket's key and status, to everyone in the project. | Agreed (2026-11-25). |
| The ticket's status comes back to Critiqs. Resolving the thread when its ticket is done is an option. | Agreed (2026-11-25). |
| Tickets say they came from Critiqs, with a link to the thread, by default. A person can turn that off. | Agreed (2026-11-25). |
| Available on every Critiqs Cloud plan. Only AI drafting uses credits. | Agreed (2026-11-25). |
| Works on Critiqs Cloud and when self-hosted: team-owned Convex, and Postgres once it replaces SQLite. | Agreed (2026-11-25). |
| Comments are not copied between Critiqs and the tracker in the first version. | Agreed (2026-11-25). |

## Trackers

Linear comes first, then GitHub Issues, then Jira Cloud, in order of how much
each one asks of Critiqs.

| | Linear | GitHub Issues | Jira Cloud |
| --- | --- | --- | --- |
| Where a ticket goes | A team | A repository | A project and issue type |
| Ticket text | Markdown | Markdown | Atlassian Document Format, converted from Critiqs's Markdown |
| Capture | Uploaded into the issue | Not in the issue: GitHub has no API to upload images, and Critiqs's captures need sign-in, so the issue links to the thread to view it | Uploaded as an attachment |
| Link back to the thread | Link attachment on the issue | Line in the issue's text | Remote link on the issue |
| Team templates | The team's issue templates | The repository's `.github/ISSUE_TEMPLATE` files, including issue forms | No built-in templates; an issue type's fields, and a description the team pastes in |
| Fields Critiqs must ask for | Team; optionally labels, priority, assignee | Repository; optionally labels, assignee | Project, issue type, and any field that issue type requires |
| Status updates | Webhook to the Critiqs app | Webhook, through the Critiqs GitHub App | Webhook registered through Jira sign-in and renewed before it expires |
| One-time setup by the team | None, unless the workspace requires an admin to approve apps | A GitHub organization admin installs the Critiqs GitHub App | None, unless the site's admin restricts apps |

To confirm while building, against each tracker's current API: how a Linear
template is applied when an issue is created; whether Linear sends an app's
webhooks for every person who connects, or only after a workspace admin
installs it; how Jira proves and expires the webhooks an app registers; and
how GitHub renders issue-form answers. With a pasted token there is no
webhook in any tracker. Where a webhook can't be had, status
comes from the check when a thread opens (see
[Status from the tracker](#status-from-the-tracker)).

## Your trackers

Each person connects their own Linear, GitHub, or Jira account. Critiqs offers
it in three places:

- **Your trackers…** in the avatar menu, beside **Your AI…**.
- Project setup, and the onboarding planned for the Critiqs website (being
  designed separately), after the prototype is set up.
- The first time someone chooses **Create ticket** or **Link ticket** without a
  connected account.

Connecting opens the tracker's sign-in in a window served by the Critiqs
backend, never inside the prototype's page, as Critiqs sign-in does today.
Only that person sees or changes their connections. Disconnecting removes the
stored token; tickets already linked keep their links and their last known
status. It also cancels that person's sign-ins to the tracker still under way:
a sign-in window that finishes afterwards connects nothing, and the tokens it
got are revoked.

Signing in connects a tracker account only when it uses the same email address
as the person's Critiqs account; letter case doesn't matter. Critiqs can't
tell who finishes a sign-in in that window, so without this rule someone could
start a sign-in on their own Critiqs account and get another person to finish
it, connecting that person's tracker account to theirs. When the addresses
differ, nothing is saved, and the window says to sign in to the tracker with
the Critiqs account's email address or to connect with an API key instead.
Where sign-in is set up, Your trackers also offers **Use an API key instead**,
and offers it again when the prototype's page doesn't allow the sign-in
window (its content security policy blocks the form that opens it).
A pasted API key needs no such check: the person pastes it into Critiqs while
signed in to their own account. Each person may start 10 sign-ins and paste
10 keys a minute.

Disconnecting also ends what Critiqs holds at the tracker, where an API call
can, right after the stored token is removed, and Your trackers says what
happened there:

- **Linear sign-in:** its refresh and access tokens are revoked at Linear
  (`POST /oauth/revoke`). Linear answers 400 both for a token it couldn't
  revoke and for one already revoked, so Critiqs counts a token as ended only
  when Linear revoked it or no longer accepts it: an access token Linear's
  API refuses, a refresh token Linear won't refresh with (one that still
  works is spent, and its new tokens revoked).
- **When the tracker can't be told** (unreachable, or it refused), Your
  trackers says that Critiqs can still reach the account and how to end it in
  the tracker; Critiqs tries again a minute, ten minutes, and an hour later.
- **A pasted API key:** no tracker lets another caller revoke a personal key,
  so it stays valid until the person deletes it in the tracker, and Your
  trackers says so.

Critiqs calls a tracker only at the tracker's own address or at a public
HTTPS address the tracker names, such as where it takes an upload: never at
this computer or a private network. It doesn't follow redirects, waits at
most 15 seconds for an answer, and reads at most 2 MB of one. It keeps no ID,
key, or address longer than it can show, and cuts long names, titles, and
status labels.

What this settles:

- **Who can send feedback to a tracker:** only people with an account there.
  Reviewers outside the company can read linked tickets' keys and status in
  Critiqs, but can't create or search tickets.
- **Whose name is on the ticket:** the person who created it, in every tracker.
- **What search reveals:** only tickets the person can already see in the
  tracker.

## Creating or linking a ticket

**Proposed:** the flows in this section. The agreed outcomes are in the table
above. **Built for Linear:** the menu items, Create ticket with its team
(remembered per person and project), title, text filled without AI, and
**Created from Critiqs**; and Link ticket with search and the optional
comment. Templates, labels, and the project's default destination are not
built.

The thread window's **⋯** menu offers **Create ticket…** and **Link ticket…**.
Each shows the trackers the person has connected; with none, it offers to
connect one.

**Create ticket** opens a draft:

- **Destination:** the team, repository, or project, defaulting to the project's
  choice and then to the person's last one.
- **Template:** when templates are turned on, the template to fill;
  otherwise Critiqs's standard format.
- **Title and text:** drafted by Critiqs AI from the thread, or filled directly
  from the thread without AI. Both can be edited before creating: the person
  reviews the draft before it is created.
- **Labels:** suggested from the thread's tags.
- **Created from Critiqs:** on by default; see [Attribution](#attribution).

The standard format is the thread's handoff, as the Markdown export writes it:
the first message as the summary, then the link, screen, target, scope,
revision, tags, and the whole discussion, with the capture where the tracker
accepts images.

Everything in ticket text that people or trackers wrote (comments, names,
tags, the page's details) renders exactly as written, as Critiqs shows it:
Critiqs escapes it, so none of it can form a link, image, HTML, code block,
heading, or other structure in the tracker. A character is escaped only where
Markdown would read it (a full stop after a number at the start of a line, a
`*` that could start emphasis, a dot inside an address), so ordinary sentences
show no backslashes in the Create dialog. A line of a comment can't become a
table either, which in GitHub's Markdown needs no pipe (a line such as `:-`
under another line). Nor can that text mention anyone, reference an issue, or
make an emoji, which GitHub resolves even when escaped: Critiqs puts an
invisible word joiner after the `@` of `@name`, the `#` of `#12`, and the like,
so they read the same and stay text, in the ticket's title too. Linear and Jira
make mentions only from a profile's address or a mention node, which ticket
text never forms. Text the person writes in the Create dialog is theirs: it
goes to the tracker as they wrote it. The thread's link is the only
link Critiqs writes. The page's address leaves out its query
and fragment, which can carry a prototype's sign-in token. The Markdown
export, a file the team downloads, keeps comments' own Markdown.

Built for Linear: each draft creates at most one ticket, however often the
person retries it. When a ticket the person started didn't finish, such as
when its answer was lost or Linear stopped accepting their connection, the
next **Create ticket** on that thread finishes it: the dialog says
"Finishing the ticket you started earlier", and Critiqs links the ticket if
Linear made it, even if it was archived since, instead of creating another.
Until it is finished, they can't start another ticket on that thread with
that Linear account. When Linear creates the ticket but doesn't add the link
back to the thread, Critiqs says so, and the ticket's chip offers **Add link
back** to the person who created it.

**Link ticket** searches the person's tracker by key or words and links the
chosen ticket. On Linear and Jira, Critiqs adds a link back to the thread on
the ticket (see [Attribution](#attribution)). On GitHub, where the link would
otherwise mean editing someone else's issue text, the link goes in a comment
instead. The person can also add a comment with the thread's summary.

A thread can link to more than one ticket. Unlinking removes the link in
Critiqs only; the ticket and its link back stay in the tracker.

**Proposed:** an **Also create a ticket** choice in the new-comment composer,
and **Create tickets** for a selected feedback collection, one ticket per
thread.

## Templates

Many teams already have templates for new tickets. Critiqs can use them, and
they are off until turned on.

- **Off (the default):** tickets use Critiqs's standard format.
- **On:** the chosen tracker templates are offered in the draft. For Linear and GitHub, Critiqs reads the templates from
  the tracker each time a draft is made, so edits there apply without
  re-importing. For Jira, a team pastes its description template into
  Critiqs, and Critiqs reads the issue type's required fields from Jira.
- **Filling a template:** Critiqs AI fills each section or issue-form field
  from the thread. Without AI, Critiqs puts the thread's summary and context
  into the template's first section and leaves the rest for the person.

**Proposed:** templates are turned on per project, by its owners, because a
template belongs to a team rather than one person; and a template can be
matched to a tag, so a thread tagged Bug starts from the team's bug template.

## AI drafting

Drafting is an AI request like search or a mockup change:

- It follows the project's [AI usage rule](glossary.md): the project's
  connection or the person's own.
- Critiqs AI counts credits ([plans and payment](first-release.md#plans-and-payment)).
  A person's own provider costs no credits.
- The draft shows its estimated cost before it is made, as the model menu does.
- When AI is off, out of credits, or fails, the draft is filled without AI and
  says so. Creating a ticket never depends on AI.

## Showing linked tickets

A linked ticket shows its tracker, key, and status, such as `ENG-123 · In
Progress`, to everyone who can see the thread, on its pin, its row in the
thread list, the thread window, and mockup threads (agreed). **Proposed, and
built as listed:** how each place shows it:

- **Pin:** a small tracker mark, with the key and status on hover or focus.
- **Thread list:** the key and status on the thread's row.
- **Thread window:** the ticket chip under the header, which opens the ticket.
- **Mockup threads:** the chip for tickets linked to the mockup thread, and to
  comments added to the mockup. Whether tickets can be created or linked from
  inside a mockup thread, and how their text is built, is open. Built: the
  keys and status on the chips of comments added to a mockup; Critiqs refuses
  to create or link tickets from a mockup thread until that is decided.

A thread links to at most 20 tickets. A ticket being created or linked holds
its place before anything is written to the tracker. One whose creation or
link Critiqs couldn't confirm stops counting toward that after 10 minutes, and
can still be finished later, so a thread can show a few more. A thread holds
at most 40, and all of them always show.

**Proposed:** a **Has ticket** filter in the thread list, and the ticket's
key, status, and link in notification emails, the Markdown and JSON export,
and coding agents' `critiqs_thread` answer.

## Status from the tracker

Critiqs keeps each linked ticket's status and when it last changed:

- Where the tracker sends Critiqs webhooks for that ticket, they update it.
  That needs a backend the tracker can reach (Critiqs Cloud, team-owned Convex,
  or a self-hosted server reachable from the internet) and a webhook
  subscription for the ticket's workspace, repository, or site.
- Otherwise, Critiqs checks the ticket when someone opens the thread, at most
  once every few minutes, using the token of the person who linked it.
- If that person has disconnected, the chip shows the last status Critiqs knew,
  marked as such.

**Resolve when done:** a project setting that resolves a thread when every
ticket linked to it reaches the tracker's done state. **Proposed:** off by
default, and reopening a ticket does not reopen the thread.

## Attribution

By default, a new ticket ends with "Created from Critiqs by *name*" and a link
to the thread. The person can turn it off in the draft, and set their own
default in **Your trackers** (the per-ticket choice and personal default are
proposed).

**Proposed:** turning it off removes Critiqs's text from the ticket. On Linear
and Jira, the link back to the thread stays as a link attachment or remote
link, so developers can still find the comment and its context. GitHub has no
separate link field, so there the link goes with the text. Status updates
don't depend on this link: Critiqs matches them by the ticket's ID.

## Self-hosting

Self-hosted deployments get the same features:

- **Sign-in to trackers:** when the operator registers their own Linear,
  Atlassian, and GitHub apps and sets their keys, people connect through the
  trackers' sign-in. Without them, each person pastes a personal token: a
  Linear API key, a GitHub fine-grained token, or a Jira API token with their
  email and the Jira site's address.
- **Storage:** team-owned Convex, and Postgres once it replaces SQLite (agreed
  2026-11-23, not built; see
  [technical direction](technical-direction.md#stack)). SQLite doesn't get
  tickets.
- **Status:** webhooks where the server is reachable and has a webhook
  subscription for the ticket; otherwise the check when a thread opens.

## Order of work

Each step is its own pull request.

1. This plan, the glossary, scope, and technical direction.
2. Core types, the template model, and ticket text without AI.
3. Storage on Convex, with the shared backend tests. Postgres storage follows
   the Postgres store, or joins it if that lands first.
4. **Your trackers**, with Linear sign-in and token paste.
5. Linear: create and link, and the display on pins, the thread list, the
   thread window, and mockup threads.
6. AI drafting and templates.
7. Status updates: webhooks, the check when a thread opens, and **Resolve when
   done**.
8. GitHub Issues, with repository templates and issue forms.
9. Jira Cloud, with Atlassian Document Format and required fields.
10. The onboarding step, and whichever proposals above are agreed, such as bulk
    creation, the export, and coding agents' tools.

## Open questions

- Whether **Also create a ticket** in the composer and bulk creation are wanted.
- Whether matching templates to tags is wanted.
- Creating or linking tickets from inside a mockup thread.
- Copying comments between Critiqs and the tracker, later.
- Jira Data Center and Server, which use different sign-in and APIs.
