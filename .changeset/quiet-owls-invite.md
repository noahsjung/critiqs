---
"critiqs-react": minor
---

Organizations get people: an Organization page in the avatar menu shows its name, members, and roles. Admins invite people by email as a member or an admin, withdraw pending invites, rename the organization, and change or remove members; an organization always keeps at least one admin. Invited people join when they sign in with the invited address. Someone in several organizations picks which one a new project goes in during setup. Backends report `organizationMembers` in `/critiqs/config`, and the component offers these only where they do.
