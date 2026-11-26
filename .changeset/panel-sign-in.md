---
"critiqs-react": minor
---

Critiqs's own panels (its website and its browser extension's side panel) can sign reviewers in without a popup. The bundled backend adds JSON email-code routes (`/auth/panel/email`, `/auth/panel/code`, `/auth/panel/name`, and `/auth/panel/status` to check first) that answer only the exact origins a deployment lists in the new `CRITIQS_WEB_ORIGINS` and `CRITIQS_EXTENSION_IDS` settings, with the popup's code and rate limits; those origins also skip the allow page and need no site grant, and `/auth/refresh`, `/auth/profile`, and `/auth/sign-out` accept an allowed extension's origin. `/auth/sign-out` now lets a page on another origin read `Critiqs-Session-Ended`. Backends report this with `panelSignIn` in their configuration. Nothing changes for host apps: the popup, its routes, and every other site's allow rule work as before, and with neither setting the new routes refuse every request.
