---
"critiqs": patch
---

`critiqs sign-out` and the `critiqs_sign_out` tool hold this computer's sign-in lock for one request's time at most: the saved token and its saved replacement are ended together, and sessions kept aside after an interrupted renewal are ended after the lock is released, so another Critiqs process no longer gives up waiting while the sign-in service is slow. Sign-out now also reports a session another process kept aside while it ran, says "Forgot this computer's sign-in" rather than "Signed out" when the service had no session for it, and no longer says an older version's Critiqs Cloud sign-in was signed out when the service didn't confirm ending it. A command whose sign-in renewal is refused because another process signed out meanwhile now says this computer isn't signed in, instead of asking to try again.
