// Serves site/ on one local server the way site/vercel.json tells the host
// to: its rewrites (so /start, /setup/<id> and /t/<key> load the website app
// built into site/app/), clean URLs (a `.html` address redirects to its clean
// one, as the host does), no trailing slashes, and its headers.
// It reads the same file the host does, so a change there shows here.
//
//   bun --cwd apps/web run build:site      # the app, into site/app/
//   bun site-src/preview-site.ts [port]    # default 6560
//
// It covers only what site/vercel.json uses: `:name` segments and `(.*)`.

import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const SITE = join(import.meta.dir, "..", "site");
const config = JSON.parse(readFileSync(join(SITE, "vercel.json"), "utf8")) as {
  cleanUrls?: boolean;
  rewrites?: { source: string; destination: string }[];
  headers?: { source: string; headers: { key: string; value: string }[] }[];
};

/** A source pattern as the host reads it: `:name` is one segment, `(.*)` anything. */
function pattern(source: string): RegExp {
  const body = source
    .split(/(\(\.\*\)|:[A-Za-z]+)/)
    .map((part) => (part === "(.*)" ? "(.*)" : part.startsWith(":") ? "([^/]+)" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`);
}

const rewrites = (config.rewrites ?? []).map((rule) => ({ match: pattern(rule.source), destination: rule.destination }));
const headers = (config.headers ?? []).map((rule) => ({ match: pattern(rule.source), headers: rule.headers }));

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
      const rule = rewrites.find(({ match }) => match.test(url.pathname));
      if (rule !== undefined) file = fileFor(rule.destination);
    }
    const extra = new Headers();
    for (const rule of headers) if (rule.match.test(url.pathname)) for (const { key, value } of rule.headers) extra.set(key, value);
    if (file === null) {
      const missing = fileFor("/404.html");
      return new Response(missing === null ? "Not found" : Bun.file(missing), { status: 404, headers: { ...Object.fromEntries(extra), "Content-Type": TYPES[".html"]! } });
    }
    if (!extra.has("Content-Type")) extra.set("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
    return new Response(Bun.file(file), { headers: extra });
  },
});
console.log(`site/ with its host configuration on http://127.0.0.1:${port}`);
