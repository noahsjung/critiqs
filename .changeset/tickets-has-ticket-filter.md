---
"critiqs-react": minor
---

The thread list's filter menu offers **Has ticket** wherever the backend has tickets: it shows only threads linked to a ticket, together with the other filters, and the filter summary says "has ticket". `SidebarFilters` gains an optional `hasTicket`, and `SidebarThread` an optional `hasTicket`. No backend change.
