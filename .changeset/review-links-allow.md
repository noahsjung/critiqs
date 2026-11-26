---
"critiqs": patch
"critiqs-react": minor
---

Allow Critiqs: a site behind a bot wall or firewall can let one project's review links in. Its owners get a token for one exact origin (`reviewAllow:issue`, replaced with `rotate`), add a firewall rule matching the `Critiqs-Allow` header, publish the project's proof at `/.well-known/critiqs-allow.txt`, and **Check again** (`reviewAllow:check`) asks the review proxy to fetch the site with the token. Only after that does a review link send the token, and only to that origin. Onboarding now offers the ways to review without installing (a review link, sharing a build, Allow Critiqs) where the deployment's `/critiqs/config` reports them, sharing a build even before the prototype has an address, and a thread page's **Open in prototype** offers the project's review link for the comment's address.
