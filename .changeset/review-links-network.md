---
"critiqs": patch
"critiqs-react": patch
---

The address check's public-address rules and its pinned connection now live in one shared module, which the review-link proxy also uses; every host check now compares one spelling of a host, so a trailing dot or an empty label (`localhost..`) no longer reads as a different host than DNS sees. Host apps don't need to do anything.
