---
"critiqs-react": minor
---

Project owners can choose where each tracker's new tickets go by default: in Tags and AI, under Tickets, each connected tracker now has its own titled section with **Default team**, **Default repository**, or **Default project and issue type** (among the owner's own, or None), above that tracker's templates. Create ticket starts there unless the person chose another destination in that project before. The backend saves it with `tickets:setDefaultDestination` (owners only; the destination must be one the owner's tracker account lists, and its name comes from the tracker), reports it in `ticketStatus:settings` (`defaults`) and in each draft (`projectDestinationId`), and says so in `/critiqs/config` (`tickets.defaultDestinations`); older components ignore it. Deploy the matching backend.
