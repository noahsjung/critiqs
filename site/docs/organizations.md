# Organizations and roles

> Manage Critiqs organizations, invite teammates by email, and see what admins, members, and reviewers can do.

An organization owns Critiqs projects and holds their [Critiqs Cloud plan](/docs/plans-and-limits), shared usage limits, and billing.

> **Note:** Reviewers do not join your organization. Anyone who can reach your staging or preview build and signs in with an email code can view threads, comment, and use Mockup mode without an organization invite. Organizations are for the team members who create projects, manage settings, and pay for Critiqs Cloud.

## How organizations work

When you set up your first Critiqs project, Critiqs creates a home organization for you (named `<Your name>'s organization`) and makes you its admin.

- **Multiple organizations:** You can belong to more than one organization. When creating a new project in Project setup, choose which organization owns it (it defaults to your home organization).
- **Home organization and personal AI:** When a project's AI usage rule is set to **Each person pays** (or when you save your own Critiqs AI choice in [Your AI](/docs/your-ai)), your Critiqs AI credits count against your home organization's plan while you belong to it. If you do not belong to an eligible home organization, Critiqs falls back to your own usage account on the default plan.
- **Self-hosted deployments:** Team-owned Convex deployments also use organizations and roles to manage who owns projects, while plans and billing stay off.

## Roles and permissions

Every person in an organization is either an **Admin** or a **Member**. A project's **owners** are all admins of its organization plus the member who created that project (while they remain in the organization).

| Action | Admin | Member | Reviewer (outside org) |
| --- | --- | --- | --- |
| Comment, reply, react, mention, resolve threads, export, use Mockup mode | Yes | Yes | Yes (on builds they can reach) |
| Create projects in the organization | Yes | Yes | No |
| Manage projects they created (review address, tags and groups, AI settings, plan usage) | Yes | Yes | No |
| Manage every project in the organization | Yes | No | No |
| View organization name, plan, and member names and roles | Yes | Yes | No |
| View members' email addresses and pending invites | Yes | No | No |
| Rename organization, invite people, withdraw invites, change roles, remove members | Yes | No | No |
| Manage plan, billing, overage cap, and extra storage | Yes | No | No |
| Receive alert emails when AI credits run out or hit the overage cap | Yes | No | No |
| Leave the organization | Yes (if another admin remains) | Yes | N/A |

## Open your organization settings

1. Click your avatar in the Critiqs toolbar.
2. Select **Organization…**.
3. If you belong to more than one organization, choose one from the **Organizations** list. The current project's organization appears first.

## Rename an organization

Only admins can rename an organization.

1. Open **Organization…** from your avatar menu.
2. Click **Name**.
3. Enter the new name (up to 80 characters) and click **Save name**.

## Invite teammates

Only admins can invite people to an organization.

1. Open **Organization…** from your avatar menu.
2. Under **Members**, click **Invite by email**.
3. Enter the person's email address.
4. Choose **Member** or **Admin** under **Role**.
5. Click **Send invite**.

When email is configured, Critiqs sends an invitation email (including a link to the current project's review address when it is not a local or private URL). The person joins the organization automatically the next time they sign in to Critiqs with that email address.

> **Note:** Pending invites appear under **Invited** for admins. Click **Withdraw** beside an email address to cancel an invite before it is accepted. An organization can send up to 50 invites per UTC day, and a single inbox can receive up to 5 invite emails per UTC day across organizations.

## Change a member's role or remove a member

Only admins can change roles or remove other members.

1. Open **Organization…** from your avatar menu.
2. Click the member's row under **Members**.
3. To change their role, pick **Admin** or **Member** in **Role**. The change saves immediately.
4. To remove them, click **Remove from organization** and confirm.

Rules to keep in mind:

- **At least one admin:** You cannot demote or remove the last admin of an organization. Make another member an admin first.
- **Projects stay with the organization:** If a member leaves or is removed, any projects they created remain in the organization and its admins continue managing them.
- **Leaving an organization:** Members (and admins when another admin remains) can open **Organization…** and choose **Leave organization**. If you leave your home organization, your personal Critiqs AI usage falls back to your own usage account on the default plan until Critiqs creates a new home organization for you the next time you create a project.
