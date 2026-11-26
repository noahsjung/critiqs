---
"critiqs": patch
"critiqs-react": patch
---

`critiqs sign-out` and the `critiqs_sign_out` tool no longer say the computer is signed out, or wasn't signed in, while a session they couldn't end stays saved: they say what is left and fail, so you can sign out again once the sign-in service is reachable. A sign-out that crosses another process's renewal now forgets the renewed sign-in too. A renewal answered after another process had already renewed again keeps that process's saved replacement, instead of dropping it and getting the session ended as stolen on the next renewal, and a renewal that lost a race ends its leftover session without keeping other processes waiting for the lock.
