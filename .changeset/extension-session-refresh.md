---
"critiqs-react": patch
---

Opening the Critiqs browser extension's side panel no longer renews a sign-in that is still good. With an updated sign-in service, the extension also keeps the reviewer signed in when a renewal's answer is lost (the side panel closed, Chrome stopped the extension's worker, or the network dropped). `panelSignIn(...).refresh` takes an optional `nextRefreshToken`, the replacement the panel chose and saved before asking, so sending the same pair again repeats the renewal; older services ignore it. A refresh the service refuses as malformed now fails with `invalid-request` instead of `unexpected`. Nothing changes for host apps.
