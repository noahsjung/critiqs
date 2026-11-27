# Landing page clips

`record.mjs` makes the videos and stills in `site/media/` from the real Critiqs
UI. It runs Critiqs from source on a sample app ("Acme", made-up data),
against a local Convex backend, and drives it in headless Chrome as four
people with named cursors. Mockup mode's AI answers come from `mock-ai.ts`, a
local stand-in that returns scripted changes (`mock-answers.ts`), so no AI key
is needed.

```sh
bun install                                   # at the repository root: Critiqs's own packages
cd site-src && bun install                     # the sample app and recorder

# Terminal 2: a local Convex backend; keep it running
cd packages/backend && bunx convex dev         # choose a local deployment

# Back in terminal 1
cd packages/backend
bun run setup:local                            # development sign-in, codes shown on screen
bunx convex env set CRITIQS_MANAGED_AI enabled
bunx convex env set CRITIQS_MANAGED_AI_PROVIDER compatible
bunx convex env set CRITIQS_MANAGED_AI_BASE_URL http://127.0.0.1:4812/v1
bunx convex env set CRITIQS_MANAGED_AI_MODEL critiqs-demo

cd ../../site-src
echo "VITE_CRITIQS_BACKEND=http://127.0.0.1:3210" > app/.env.local
bun mock-ai.ts &                               # the AI stand-in
bun run app &                                  # the sample app on http://127.0.0.1:4811
node record.mjs                                # all clips, comment.jpg and og.png; or: node record.mjs collab og
```

The sample app has a dark theme so the light Critiqs panel stands out, and the
feature clips use a closer 1080 x 675 view (`CLOSE` in `lib.mjs`) because they
show at about half width on the page. Each clip creates a fresh project, so runs don't affect each other. Frames are
recorded with Chrome's screencast and encoded to H.264 with ffmpeg (set
`FFMPEG` to its path). `server.ts` is the self-hosted SQLite backend, which
works for comments but not Mockup mode.

# Docs and blog

`build-pages.mjs` turns the Markdown in `content/` into the docs and blog
pages in `site/`. Vercel still deploys `site/` as is, so commit what it
writes.

```sh
cd site-src && bun install
bun build-pages.mjs            # write the pages
bun build-pages.mjs --check    # exit 1 if site/ is out of date (CI runs this)
```

It writes `site/docs/` and `site/blog/` in full (anything else there is
removed), plus `site/sitemap.xml`, `site/robots.txt`, `site/llms.txt` and
`site/blog/feed.xml`. Each doc also gets a plain Markdown copy at
`site/docs/<slug>.md` for agents. Don't edit these files by hand; `--check`
fails on any difference. The pages' styles are `site/docs.css` and their
script `site/docs.js`, written by hand.

## Add a doc

Create `content/docs/<slug>.md`. The file name is the URL:
`content/docs/install.md` becomes `/docs/install`.

```md
---
title: Install Critiqs
description: Add Critiqs to a React app's staging build. At most 160 characters.
section: Get started
order: 1
requires: [412, 418]
---

Start with a paragraph, then use ## and ### headings.
```

- `section` is one of: Get started, Review, Mockup mode, Agents, Teams and
  plans, Guides, Reference. The sidebar and docs home list sections in that
  order, and pages by `order` within a section.
- `requires` is optional: the pull requests the page depends on. It isn't
  shown on the page.

## Add a post

Create `content/blog/<slug>.md`; it becomes `/blog/<slug>`.

```md
---
title: Why build review belongs on the build
description: One or two sentences for the blog list and search results.
date: 2026-11-24
updated: 2026-12-02
tags: [Review, Agents]
---
```

`updated` is optional. Posts are listed newest first, with a reading time
worked out from the text.

## Writing

- The title comes from front matter, so start headings at `##`, and don't
  skip a level. h2 and h3 headings make the "On this page" list.
- Link to another page by its file name (`[Install](install.md)`,
  `[Post](../blog/some-post.md)`) or its URL (`/docs/install`). A link to a
  page that doesn't exist stops the build.
- Code blocks are highlighted when the page is built. Name the language
  (`sh`, `tsx`, `ts`, `js`, `json`, `css`, `html`, `yaml`, `diff`, `md`);
  each block gets a Copy button.
- Callouts are a quote that starts with a bold label:
  `> **Note:** Reviewers don't install anything.` or
  `> **Plan:** Plus and Pro only.`
- Tables use GitHub's pipe syntax and scroll sideways on phones.

The build stops with a list of problems if front matter is missing or wrong,
a date isn't a real calendar day, a description is over 160 characters, a
file is named `index.md` (that name belongs to the generated list page), a
heading is `#` or skips a level, or a link points nowhere. A link with a
`#fragment`, including a same-page `#link`, must name a heading on its target
page: heading ids are the heading text in lowercase, with punctuation dropped
and spaces turned into hyphens.

# The website app beside the landing page

The landing page's **Get started** goes to `/start`, the website app's
onboarding (`apps/web`), on the same origin as the landing page. Setup links
(`/setup/<id>`), thread pages (`/t/<key>`), review links (`/r/<key>`), a
project's review links (`/review-links/<id>`) and Allow Critiqs
(`/allow-critiqs`) are served there too, because a backend with
`CRITIQS_WEB_URL=https://critiqs.app` links to them.

`site/vercel.json` does it: its build command builds the app into `site/app/`
(`bun run --cwd apps/web build:site`, with `--base=/app/`), and its rewrites
send those paths to `site/app/index.html`. Files still win over rewrites, so
every other page is the static site as before. `site/app/` is built at deploy
time and not committed. It is the website's only host file.

For `/r/*` and `/review-links/*` it also sends the headers the review page
needs (`docs/technical-direction.md`, "The review page"):
`Content-Security-Policy: frame-ancestors 'none'; frame-src https://*.critiqs-review.net`,
`Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex, nofollow`. The
review page shows no frame without that `frame-src`, so an operator whose
review proxy runs on another domain changes `critiqs-review.net` in both rules
to that domain before deploying (`https://*.<domain>`). The rest of the site
keeps `Referrer-Policy: strict-origin-when-cross-origin`; no header is set by
two rules for one path, so which one the host sends never depends on their
order. `apps/web/test/review-page-details.test.tsx` checks this file against
the headers `vite` sends.

Try it on one local server, which applies the same file's rewrites, clean
URLs, and headers (`host-rules.ts`):

```sh
VITE_CRITIQS_BACKEND=http://127.0.0.1:3210 bun run --cwd apps/web build:site   # omit the variable for Critiqs Cloud
bun site-src/preview-site.ts 6560                                               # http://127.0.0.1:6560
```

With a local review proxy, set `CRITIQS_REVIEW_FRAMES` to its frame hosts (as
for `vite`, such as `http://*.review.localhost:5120`) when starting the
preview, so the review pages' `frame-src` names them.

At the host, the Vercel project that serves `site/` needs:

- **Root Directory** `site`, as now, with **Include files outside the root
  directory in the Build Step** on, since the build reads `apps/web` and
  `packages/`.
- Bun available to the build (the build command runs `bun install` at the
  repository root). Vercel's build image has it; otherwise set the install
  command to install Bun first.
- `VITE_CRITIQS_BACKEND` left unset, so the app talks to Critiqs Cloud, or set
  to another backend's Convex URL.
- On that backend, `CRITIQS_WEB_URL=https://critiqs.app`, so setup emails and
  thread links point here.

## Deploy this host first

Deploy this host configuration before, or together with, the backend that
sends setup emails. Critiqs Cloud's backend already links setup emails to
`https://critiqs.app/setup/<id>` when `CRITIQS_WEB_URL` is unset, and that
address exists only once this configuration is live: a developer who opens
an email sent before then gets the site's 404 page, and nothing sends the
email again. Thread page links (`/t/<key>`) need `CRITIQS_WEB_URL` set, so
they wait for it. To check, open `https://critiqs.app/start` and a made-up
`https://critiqs.app/setup/x` after the host deploys: both load the website
app, not the 404 page.
