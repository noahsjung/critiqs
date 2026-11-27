---
---

The landing page and website hosting only: Get started opens onboarding at `/start`, the landing page names every framework package as the docs do, and `site/vercel.json` builds the website app into `site/app/` and serves `/start`, `/setup/<id>` and `/t/<key>` from it on the same origin. No Critiqs package changes.

Deploy order: deploy this host configuration before, or with, the backend that sends setup emails. Critiqs Cloud's backend already links setup emails to `https://critiqs.app/setup/<id>`, which exists only once this configuration is live, so an email sent earlier links to the 404 page. `site-src/README.md` says how to check it.
