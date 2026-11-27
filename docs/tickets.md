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
comments added to a mockup; and, on Convex for Linear, drafting with Critiqs
AI, the team's Linear templates turned on per project by its owners, labels
suggested from tags, status updates from Linear's webhooks and from the check
when a thread opens, and **Resolve when done**. Not built yet: a project's
default destination, GitHub Issues, and Jira.

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
template is applied when an issue is created; how Jira proves and expires the
webhooks an app registers; and how GitHub renders issue-form answers.
Confirmed for Linear: an OAuth app's webhook is created for a workspace when
someone in it first authorizes the app, and covers that workspace's issues
([Linear's webhooks](https://linear.app/developers/webhooks)). A pasted token
brings no webhook in any tracker, so issues in a Linear workspace where
everyone pasted an API key get none. Where a webhook can't be had, status
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
status labels. An answer about a ticket must be about the ticket Critiqs asked
for, and a ticket's address must be the tracker's page for its key: Linear's
must be on Linear and name the issue's key. Critiqs adds a link back or a
comment only to a ticket it holds whose address still agrees with its key and
site, and goes to it by what Critiqs holds, never by an address a tracker
named.

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
comment; the Template choice, **Draft with Critiqs AI**, and labels suggested
from the thread's tags, each removable. The project's default destination is
not built.

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

Choosing another team drops a chosen template for the standard format;
until that draft loads, Create waits, and if it can't load, the dialog says why
and offers **Try again**.

The standard format is the thread's handoff, as the Markdown export writes it:
the first message as the summary, then the link, screen, target, scope,
revision, tags, and the whole discussion, with the capture where the tracker
accepts images.

Everything in ticket text that people or trackers wrote (comments, names,
tags, the page's details, a template's headings in a Critiqs AI draft) renders exactly as written, as Critiqs shows it:
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

The ticket is created with the text as the person left it. Critiqs adds the
capture and attribution after it; when the text ends inside a block that a
blank line doesn't end (a code fence, an HTML comment, a `<pre>`, `<script>`,
`<style>`, or `<textarea>` block, and the like), it first adds the line that
ends it, so they stay outside it, and changes nothing else.

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

A thread can link to more than one ticket, and a ticket can be linked to at
most 50 threads. Unlinking removes the link in Critiqs only; the ticket and
its link back stay in the tracker.

The thread's link in a ticket (in its text, its link back, and a link
comment) is, as in emails and **Copy link**: the thread's own page on the
Critiqs website (`/t/<key>`) when the deployment has a website (Critiqs Cloud
always does), which a teammate can open with nothing installed; otherwise the
thread on the project's review address. With neither, a ticket doesn't link to
the thread: its text says so, and nothing is added to the ticket as a link
back. Critiqs never links a ticket to the page a
thread was left on, since the thread's author sends that address and it could
name any site. Each person may search their tracker or list where tickets go
60 times a minute, and create or link 20 tickets a minute.

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

**Proposed, and built for Linear:** templates are turned on per project, by
its owners, because a template belongs to a team rather than one person. In
the project's settings (Tags and AI, then Tickets), **Use the team's ticket
templates** is off until turned on; then the owner turns on, one by one, the
templates of their own Linear teams to offer. Create ticket offers a team's
turned-on templates in a **Template** menu beside **Critiqs's standard format**,
reading them from Linear for each draft; choosing one fills the draft from it
(if its draft can't be read, the template and draft before it stay), and the
new issue is created from that template, so Linear applies its other
defaults, such as labels, under the person's title and text. Turning templates
off keeps the choice for next time, and doesn't stop a retry from finding an
issue Linear already created from one. Built: team templates only; a workspace's
templates, which belong to no team, aren't offered yet.

**Proposed:** a template can be matched to a tag, so a thread tagged Bug starts
from the team's bug template.

## AI drafting

Drafting is an AI request like search or a mockup change:

- It follows the project's [AI usage rule](glossary.md): the project's
  connection or the person's own.
- Critiqs AI counts credits ([plans and payment](first-release.md#plans-and-payment)).
  A person's own provider costs no credits.
- The draft shows its estimated cost before it is made, as the model menu does.
- When AI is off, out of credits, or fails, the draft is filled without AI and
  says so. Creating a ticket never depends on AI.

**Built for Linear:** the Create dialog opens with the draft filled without
AI; **Draft with Critiqs AI**, with the model's cost beside it, replaces the
title and text with Critiqs AI's draft from the thread and the chosen
template, for the person to edit. Critiqs AI writes plain text, never
Markdown: a short title, and text for each section the thread gives facts
for, named by one of the template's headings (without a template, or with one
that has no headings, Critiqs's standard sections: Summary, Steps to
reproduce, Expected, Actual, and Context), as paragraphs and a list, numbered
for steps. It is told never to invent facts, and the dialog asks the person to
check the draft before creating; Critiqs doesn't check the draft's claims
against the thread. Critiqs AI reads only the messages, tags, screen, target,
and scope: never the page's address, view state, or the thread's link, which
can carry a prototype's sign-in token.

Critiqs writes the draft's Markdown itself. The headings are the template's
top-level headings, either style, each once and in the template's order,
escaped as the AI's text is, so they render as the template writes them; a
section the AI left empty keeps its heading, a standard section it left empty
is left out, and text it wrote for a section the template doesn't have is
dropped. Under each heading goes the AI's text, with the line breaks inside a
paragraph made spaces and every ASCII punctuation character escaped except
`, ; ? ! ' " %`, which mean something only after a `[` or `<`. So nothing
Critiqs AI writes renders as a link, web or email address, image, HTML, code,
heading, list, quote, or table: it reads exactly as written. Critiqs ends the
text with the thread's link, the only link in it. Where the backend lists
models, **Draft with Critiqs AI** waits until the model and its cost show,
and says so when they can't load. When the project needs the person's own AI,
the notice offers **Set up your AI**, which opens Your AI.
Each person may ask for 10 drafts a minute.

**Proposed, and built for Linear:** labels are suggested from the thread's
tags: the team's and workspace's labels whose names match a tag, as Critiqs
compares tags, show under the text, each removable, and are added to the
ticket. At most five are suggested, and never two of one single-select label
group, which Linear refuses, so the suggestion as it is always creates.

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

**Built for Linear on Convex:**

- **Webhooks.** The operator's Linear app sends issue events to the backend,
  which reads at most 256 KB of each delivery and uses it only after checking
  Linear's signature over its exact bytes and that it was sent within the
  last minute. Each issue's new status reaches every thread linking it.
  Critiqs orders updates by Linear's own time of the issue's last change, so
  a late delivery never puts back an older status, and a repeated or
  replayed one changes nothing at all; linking or creating a ticket records
  that time for the status it read then. A deleted issue shows as
  **Deleted** and counts as canceled, as of when it was deleted, so an older
  update arriving afterwards doesn't bring it back, nor does an update with
  the same time. A delivery that arrives while a ticket is being linked is
  kept with the link and wins over what linking read when it is newer, so an
  issue deleted mid-link shows **Deleted** once linked. A delivery changes
  only links in the Linear workspace it names: each link keeps its
  workspace, and one being linked keeps its linker's, so a delivery that
  names no workspace, or another one, changes nothing, and so does one
  naming a workspace ID Critiqs can't keep. Status names longer than 100
  characters are cut. Each workspace's deliveries may change linked tickets
  **300** times a minute; past that the backend answers 429 and changes
  nothing, and the check when a thread opens catches up.
- **The check when a thread opens.** Opening a thread checks each linked
  ticket whose status is more than **5 minutes** old, at most once every 5
  minutes per ticket however many people open it, in the background. It reads
  the ticket with the token of the person who linked it, for the tracker
  account they linked it with, never anyone else's, and saves what it read on
  that link only: another thread's link to the same ticket keeps its own
  status. The check also catches a change whose webhook was missed. It reads
  the ticket by its permanent ID, so an issue moved to another team is the
  same ticket: the link takes its new key, page, and title, as long as the
  page is Linear's for that key, and the old key is never used again.
- **Whose token, and when.** Any background job that uses a person's stored
  token (the check above, and later webhook upkeep) names the projects it
  works in, and the step that reads the token checks first, in the same
  transaction, that the person may still review every one of them; a job
  that only removes what Critiqs registered at the tracker names none. In a
  person's own request, only that person's token is read.
- **Last known.** When that person has disconnected, connected another
  account, can no longer see the ticket, or may no longer review the project
  (such as when they leave its organization), the status stays, Critiqs stops
  using their token for it, and the chip
  adds "· last known"; hovering says when it was last read and why. It says
  so from the moment the person disconnects or loses access, before anything
  checks: whether a status is current is decided in one place, as Critiqs
  reads it, for every place that shows it (the thread window, the comment
  list's rows, the thread page, coding agents). A pin's mark names no status
  word, as before: the page layer takes only a ticket's tracker, key, and
  status. A webhook still updates the
  status, which stays marked while Critiqs can't check it as that person. A
  check that finds the ticket hidden marks it too; a webhook or a later check
  that works clears that, and a check refused after a webhook saved a newer
  status while it ran leaves that status current.

**Resolve when done:** a project setting that resolves a thread when every
ticket linked to it reaches the tracker's done state. **Built:** off by
default; only the project's owners change it, in **Tags and AI** under
**Tickets** ("Resolve threads when their tickets are done"). A status update
that makes the last unfinished ticket of an open thread done or canceled
resolves the thread; canceled counts, since the work is closed either way.
The thread says it was resolved when its tickets were done, naming no
person. Reopening a ticket does not reopen the thread, and a person who
reopens it keeps it open until a ticket finishes again. Turning the setting
on catches up: in the background, every open thread whose linked tickets are
all already done or canceled resolves, as if its last ticket had just
finished, except one whose status someone changed after the setting was
turned on, or one with a ticket whose status is only last known, which may
have been reopened since.
Only linked tickets count, not ones still being created.

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
   done** (built for Linear).
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
