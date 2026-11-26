---
"critiqs-react": patch
---

Setup emails to developers now check the project's organization name for web addresses, by the same rule as project and sender names (`Next.js` and versions such as `2.0` pass), whenever a new email would name it: the sender is an admin of the organization, whose send invites a developer who isn't a member yet, or the developer already has an invite to it. `sendDeveloperSetup` then refuses the whole request with an `invalid` error that tells an admin to rename the organization, or a member to ask an admin or copy the message. An email whose organization or sender was renamed to hold a web address after it was queued is settled `failed` instead of sent, so sending again says why. The per-person cap of 5 developer emails a UTC day counts each email on the day it was queued, whenever it is delivered.
