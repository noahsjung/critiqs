// Serves site/ on one local server the way site/vercel.json tells the host
// to: its rewrites (so /start, /setup/<id>, /t/<key>, /r/<key> and
// /review-links/<id> load the website app built into site/app/), clean URLs
// (a `.html` address redirects to its clean one, as the host does), no
// trailing slashes, and its headers (host-rules.ts).
// It reads the same file the host does, so a change there shows here.
//
//   bun --cwd apps/web run build:site      # the app, into site/app/
//   bun site-src/preview-site.ts [port]    # default 6560
//
// With CRITIQS_REVIEW_FRAMES set, such as `http://*.review.localhost:5120`, the
// review pages' `frame-src` names those frame hosts in place of the
// deployed review proxy's, as `vite` does, so a local review proxy's frames
// show.

import { statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { headerRules, readHostConfig, rewriteFor } from "./host-rules.ts";

const SITE = join(import.meta.dir, "..", "site");
const config = readHostConfig(SITE);
const frames = process.env.CRITIQS_REVIEW_FRAMES?.trim() || null;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

/** The file a path names under site/, with clean URLs: `/docs/x` is `docs/x.html` or `docs/x/index.html`. */
function fileFor(path: string): string | null {
  const relative = normalize(decodeURIComponent(path)).replace(/^\/+/, "");
  if (relative.startsWith("..")) return null;
  for (const candidate of [relative, `${relative}.html`, join(relative, "index.html")]) {
    const full = join(SITE, candidate);
    try {
      if (statSync(full).isFile()) return full;
    } catch {
      // Not this one.
    }
  }
  return null;
}

const port = Number(process.argv[2] ?? 6560);
Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    // No trailing slashes, as `"trailingSlash": false` redirects them.
    if (url.pathname !== "/" && url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname.replace(/\/+$/, "")}${url.search}`, 308);
    // With clean URLs the host redirects an address ending in .html to its clean one: /docs/x.html to /docs/x, /x/index.html to /x.
    if (config.cleanUrls === true && url.pathname.endsWith(".html")) {
      const clean = url.pathname.replace(/(?:\/index)?\.html$/, "") || "/";
      return Response.redirect(`${url.origin}${clean}${url.search}`, 308);
    }
    // A file wins over a rewrite, as on the host.
    let file = fileFor(url.pathname);
    if (file === null) {
      const destination = rewriteFor(config, url.pathname);
      if (destination !== null) file = fileFor(destination);
    }
    const extra = new Headers();
    for (const [name, { value }] of headerRules(config, url.pathname)) {
      extra.set(name, frames !== null && name === "content-security-policy" ? value.replace(/frame-src [^;]+/, `frame-src ${frames}`) : value);
    }
    if (file === null) {
      const missing = fileFor("/404.html");
      return new Response(missing === null ? "Not found" : Bun.file(missing), { status: 404, headers: { ...Object.fromEntries(extra), "Content-Type": TYPES[".html"]! } });
    }
    if (!extra.has("Content-Type")) extra.set("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
    return new Response(Bun.file(file), { headers: extra });
  },
});
console.log(`site/ with its host configuration on http://127.0.0.1:${port}`);
