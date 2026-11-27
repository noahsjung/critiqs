---
---

The website host only: `site/vercel.json` sent `/start`, `/setup/<id>`, `/t`, `/r/<key>`, `/review-links/<id>` and `/allow-critiqs` to `/app/index.html`. With clean URLs on, Vercel serves that page only at `/app`, so every one of those paths answered with the 404 page. They now go to `/app`. No Critiqs package changes.
