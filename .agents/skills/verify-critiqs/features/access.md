# Who has access in the project panel

The project panel's "Who has access" card: its organization's admins add people by email, remove members,
withdraw invites, and choose who can comment; members see the people and whom to ask.

## Sub-features

- `list`: the organization's members ("you", "project owner", "admin"), invites ("address · Invited"), and others
  who commented ("· commented").
- `add`: "Add people" field, Enter or "Add"; the row shows "· Invited" and a message under the field in the
  backend's words (locally: "… is invited and joins by signing in to Critiqs with that address").
- `remove`: "Remove <name>" asks "Remove <name> from <organization>?" with "Keep <name>" and "Remove".
- `who-can-comment`: the "Who can comment" select, "Anyone who can reach the prototype" or "Only people added
  here", saved as the project's `reviewAccess`.
- `member-view`: a member who isn't an admin sees "Ask an admin of <organization> to add or remove people."

## How to get to it (user POV)

On the sample app, sign in and set up a project from the widget, then Browse mode and the toolbar's "Project"
button open the side panel. The card is the second section.

## Driving it with walk.sh

`walk.sh --feature access`. Three people, each in their own browser. End states:

- **access-owner-card**: the owner's card has "Add people".
- **access-owner-adds-second**: the second person's row says "· Invited"; an `invites` row has their address.
- **access-second-is-member**: the second person signs in on the sample app, has one `memberships` row, and the
  owner's list shows them as a member without a reload.
- **access-owner-sees-member**, **access-narrowest-sidebar**: the owner's list; then the sidebar at 300 px
  with nothing wider than the card.
- **access-owner-only-people-added**: the project's `reviewAccess` is `organization` and the sentence changes.
- **access-third-refused**, **access-second-refused**: "No access to this project" for a third person, and
  for the second person after the owner removed them (**access-owner-confirms-removal**,
  **access-owner-removed-second**).

## Gotchas

- The sample app has no project ID in its code, so the second and third people open the owner's project as a
  browser that had it open before: the owner's `critiqs:project:<backend>` entry, copied before load.
- The card first shows the people it already knows and then the organization's members; wait for "Add people"
  before reading it.
- On a commit before this card the walk stops at its first step; its screenshot is the card as it was.
