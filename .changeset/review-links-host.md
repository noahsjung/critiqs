---
---

Website hosting only: the review page (`/r/<key>`) and a project's review links (`/review-links/<id>`) are served from `site/vercel.json`, the landing site's host file that already serves the website app on its origin, with the headers the review page needs (`frame-ancestors 'none'`, `frame-src` naming the review proxy's frame hosts, no referrer, not indexed). `apps/web/vercel.json`, which nothing deployed, is gone. An operator whose review proxy isn't on `critiqs-review.net` changes the `frame-src` there, as `site-src/README.md` says. No Critiqs package changes.
