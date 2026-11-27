// Builds the critiqs.app docs, blog, and standalone pages (such as /privacy)
// from content/docs/*.md, content/blog/*.md, and content/pages/*.md into
// ../site, which Vercel deploys as is.
//
//   bun build-pages.mjs           write the pages
//   bun build-pages.mjs --check   exit 1 if ../site differs from a fresh build
//
// Output is a pure function of the content files and this script: no dates,
// no randomness, so --check can compare byte for byte.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { Marked, Renderer } from "marked";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const ORIGIN = "https://critiqs.app";
const HERE = import.meta.dir;
const SITE = join(HERE, "..", "site");
const CONTENT = join(HERE, "content");

// Docs sections, in sidebar order. A doc's `section` must be one of these.
const SECTIONS = ["Get started", "Review", "Mockup mode", "Agents", "Teams and plans", "Guides", "Reference"];

const SUMMARY =
  "Critiqs is a React component that lets teams comment on staging and preview builds. " +
  "Reviewers click an element and comment on the real app; every thread keeps a capture and the screen it was left on, " +
  "for developers and coding agents.";

for (const [name, lang] of Object.entries({ bash, css, diff, javascript, json, markdown, plaintext, typescript, xml, yaml })) {
  hljs.registerLanguage(name, lang);
}
hljs.registerAliases(["sh", "shell", "zsh", "console"], { languageName: "bash" });
hljs.registerAliases(["js", "jsx", "mjs", "cjs"], { languageName: "javascript" });
hljs.registerAliases(["ts", "tsx", "mts"], { languageName: "typescript" });
hljs.registerAliases(["html", "svg"], { languageName: "xml" });
hljs.registerAliases(["md"], { languageName: "markdown" });
hljs.registerAliases(["yml"], { languageName: "yaml" });
hljs.registerAliases(["text", "txt"], { languageName: "plaintext" });

// ---------------------------------------------------------------------------
// Reading content

const errors = [];
const fail = (file, message) => errors.push(`${relative(HERE, file)}: ${message}`);

function readFolder(kind) {
  const dir = join(CONTENT, kind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => {
      const file = join(dir, name);
      const source = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      const match = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      if (!match) {
        fail(file, "starts without front matter (a --- block)");
        return null;
      }
      let data;
      try {
        data = Bun.YAML.parse(match[1]) ?? {};
      } catch (error) {
        fail(file, `front matter isn't valid YAML: ${error.message}`);
        return null;
      }
      return { file, kind, slug: name.slice(0, -3), data, body: match[2].trim() + "\n" };
    })
    .filter(Boolean);
}

// A real calendar date as YYYY-MM-DD: 2026-02-30 doesn't survive the round trip.
const isDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};
const isText = (value) => typeof value === "string" && value.trim() !== "";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function checkCommon(entry) {
  const { file, slug, data } = entry;
  if (!SLUG.test(slug)) fail(file, "file name must be lowercase words joined by hyphens");
  else if (slug === "index" && entry.kind !== "pages") fail(file, `\`index\` is reserved for the generated /${entry.kind} page; give the file another name`);
  if (!isText(data.title)) fail(file, "needs a `title`");
  if (!isText(data.description)) fail(file, "needs a `description`");
  else if (data.description.length > 160) fail(file, `\`description\` is ${data.description.length} characters; keep it to 160`);
}

function loadDocs() {
  const docs = readFolder("docs");
  for (const doc of docs) {
    checkCommon(doc);
    const { file, data } = doc;
    if (!SECTIONS.includes(data.section)) fail(file, `\`section\` must be one of: ${SECTIONS.join(", ")}`);
    if (typeof data.order !== "number") fail(file, "needs a numeric `order`");
    if (data.requires !== undefined && !(Array.isArray(data.requires) && data.requires.every(Number.isInteger))) {
      fail(file, "`requires` must be a list of pull request numbers");
    }
  }
  return docs.sort(
    (a, b) =>
      SECTIONS.indexOf(a.data.section) - SECTIONS.indexOf(b.data.section) ||
      a.data.order - b.data.order ||
      a.slug.localeCompare(b.slug),
  );
}

function loadPosts() {
  const posts = readFolder("blog");
  for (const post of posts) {
    checkCommon(post);
    const { file, data } = post;
    if (!isDate(data.date)) fail(file, "needs a `date` that is a real calendar date as YYYY-MM-DD");
    if (data.updated !== undefined && !isDate(data.updated)) fail(file, "`updated` must be a real calendar date as YYYY-MM-DD");
    if (!Array.isArray(data.tags) || !data.tags.every(isText)) fail(file, "needs `tags` as a list");
  }
  return posts.sort((a, b) => b.data.date.localeCompare(a.data.date) || a.slug.localeCompare(b.slug));
}

// A page is served at /<slug> from site/<slug>.html. With clean URLs the host
// serves a file before any rewrite, so a page must not take a path the
// website app's rewrites in site/vercel.json own, nor the landing page, the
// 404 page, or a folder the site already has.
function reservedPagePaths() {
  const host = JSON.parse(readFileSync(join(SITE, "vercel.json"), "utf8"));
  const rewritten = (host.rewrites ?? []).map((rule) => rule.source.split("/")[1]).filter(Boolean);
  return new Set(["index", "404", "docs", "blog", "app", "media", "skills", ...rewritten]);
}

function loadPages() {
  const pages = readFolder("pages");
  const reserved = reservedPagePaths();
  for (const page of pages) {
    checkCommon(page);
    if (reserved.has(page.slug)) fail(page.file, `/${page.slug} belongs to another part of the site; give the file another name`);
    if (page.data.updated !== undefined && !isDate(page.data.updated)) fail(page.file, "`updated` must be a real calendar date as YYYY-MM-DD");
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Markdown

const escapeHtml = (text) =>
  String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const stripTags = (html) =>
  html.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const slugify = (text) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-") || "section";

const CALLOUTS = { Note: "note", Plan: "plan" };
const ICON = (name, extra = "") => `<svg class="icon${extra}" aria-hidden="true"><use href="/icons.svg#${name}"></use></svg>`;

// Renders one Markdown file. Returns its HTML, its h2/h3 outline, every
// heading id, and the links with a #fragment, which build() checks once all
// pages have their ids. `links` maps "docs/<slug>" and "blog/<slug>" to their
// URLs, to check and rewrite links between pages.
function renderMarkdown(entry, links) {
  const toc = [];
  const ids = new Set();
  const fragments = [];
  const used = new Map();
  let lastLevel = 1;
  const renderer = new Renderer();

  renderer.heading = function ({ tokens, depth }) {
    const html = this.parser.parseInline(tokens);
    const text = stripTags(html);
    if (depth === 1) fail(entry.file, `"# ${text}": the title comes from front matter, so start headings at ##`);
    if (depth > lastLevel + 1) fail(entry.file, `"${"#".repeat(depth)} ${text}" skips a heading level`);
    lastLevel = depth;
    const base = slugify(text);
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    const id = count ? `${base}-${count + 1}` : base;
    ids.add(id);
    if (depth === 2 || depth === 3) toc.push({ depth, id, text });
    return (
      `<h${depth} id="${id}">${html}<a class="anchor" href="#${id}">` +
      `<span class="visually-hidden">Link to this section</span><span aria-hidden="true">#</span></a></h${depth}>\n`
    );
  };

  renderer.code = function ({ text, lang }) {
    const name = (lang || "").trim().split(/\s+/)[0].toLowerCase();
    const known = name && hljs.getLanguage(name);
    const body = known ? hljs.highlight(text, { language: name, ignoreIllegals: true }).value : escapeHtml(text);
    const label = name && name !== "plaintext" && name !== "text" ? `<span class="code-lang caption-4">${escapeHtml(name)}</span>` : "<span></span>";
    return (
      `<div class="code-block">` +
      `<div class="code-head">${label}<button class="code-copy caption-3" type="button">${ICON("copy", " i-copy")}${ICON("check", " i-check")}<span class="copy-label">Copy</span></button></div>` +
      `<pre><code class="hljs${known ? ` language-${name}` : ""}">${body}</code></pre>` +
      `</div>\n`
    );
  };

  renderer.blockquote = function ({ tokens }) {
    const first = tokens[0];
    const strong = first?.type === "paragraph" ? first.tokens?.[0] : null;
    const label = strong?.type === "strong" ? strong.text.replace(/:$/, "") : null;
    if (label && CALLOUTS[label]) {
      // Drop the "**Note:**" label, and a colon written outside the bold.
      const rest = first.tokens.slice(1);
      if (rest[0]?.type === "text") {
        rest[0] = { ...rest[0], text: rest[0].text.replace(/^:?\s*/, ""), raw: rest[0].raw.replace(/^:?\s*/, "") };
        if (rest[0].tokens) rest[0].tokens = undefined;
      }
      const lead = `<p>${this.parser.parseInline(rest)}</p>\n`;
      const more = this.parser.parse(tokens.slice(1));
      const kind = CALLOUTS[label];
      return (
        `<div class="callout callout-${kind}" role="note">` +
        `<p class="callout-label caption-3">${ICON(kind === "plan" ? "signoff" : "chat")}${label}</p>${lead}${more}</div>\n`
      );
    }
    return `<blockquote>\n${this.parser.parse(tokens)}</blockquote>\n`;
  };

  renderer.table = function (token) {
    return `<div class="table-wrap">${Renderer.prototype.table.call(this, token)}</div>\n`;
  };

  renderer.link = function (token) {
    const html = Renderer.prototype.link.call(this, token);
    return /^https?:\/\//.test(token.href) && !token.href.startsWith(ORIGIN) ? html.replace("<a ", '<a rel="noopener" ') : html;
  };

  const marked = new Marked({
    gfm: true,
    renderer,
    // Point links between Markdown files at the built pages, and catch links
    // to pages that don't exist.
    walkTokens(token) {
      if (token.type !== "link") return;
      const href = token.href;
      const own = href.match(/^#(.+)$/);
      if (own) {
        fragments.push({ href, target: `${entry.kind}/${entry.slug}`, id: own[1] });
        return;
      }
      const md = href.match(/^(?:\.\.?\/)*(?:(docs|blog)\/)?([a-z0-9-]+)\.md(?:#(.*))?$/);
      if (md) {
        const target = `${md[1] ?? entry.kind}/${md[2]}`;
        const url = links.get(target);
        if (!url) fail(entry.file, `links to ${href}, which has no page`);
        else {
          token.href = url + (md[3] ? `#${md[3]}` : "");
          if (md[3]) fragments.push({ href, target, id: md[3] });
        }
        return;
      }
      const page = href.match(/^\/(docs|blog)\/([a-z0-9-]+)(?:#(.*))?$/);
      if (!page) return;
      const target = `${page[1]}/${page[2]}`;
      if (!links.has(target)) fail(entry.file, `links to ${href}, which has no page`);
      else if (page[3]) fragments.push({ href, target, id: page[3] });
    },
  });

  return { html: marked.parse(entry.body), toc, ids, fragments };
}

const WPM = 230;
const readingMinutes = (body) => Math.max(1, Math.round(body.replace(/```[\s\S]*?```/g, " ").split(/\s+/).filter(Boolean).length / WPM));

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT = MONTHS.map((m) => m.slice(0, 3));
function longDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}
function rfc822(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const day = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${day}, ${String(d).padStart(2, "0")} ${SHORT[m - 1]} ${y} 00:00:00 GMT`;
}

// ---------------------------------------------------------------------------
// Page shell

// Pages, not sections of the landing page: sections are reached by scrolling, and from the footer.
const NAV = [
  ["Pricing", "/#pricing"],
  ["Docs", "/docs"],
  ["Blog", "/blog"],
];

function current(href, area, isIndex) {
  if (href !== `/${area}`) return "";
  return isIndex ? ' aria-current="page"' : ' aria-current="true"';
}

function jsonLd(data) {
  return `<script type="application/ld+json">\n${JSON.stringify(data, null, 2).replace(/</g, "\\u003c")}\n</script>`;
}

const ORG = { "@type": "Organization", name: "Critiqs", url: `${ORIGIN}/`, logo: `${ORIGIN}/apple-touch-icon.png` };

function breadcrumbs(items) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map(([name, path], index) => ({ "@type": "ListItem", position: index + 1, name, item: ORIGIN + path })),
  };
}

function page({ title, description, path, area, isIndex, ogType = "article", head = "", structured, body, bodyClass }) {
  const url = ORIGIN + path;
  const links = () =>
    NAV.map(([label, href]) => `<a href="${href}"${current(href, area, isIndex)}>${label}</a>`).join(`\n      `);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${url}">
  <meta name="theme-color" content="#fbfbfa">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
${head}
  <meta property="og:type" content="${ogType}">
  <meta property="og:url" content="${url}">
  <meta property="og:site_name" content="Critiqs">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:image" content="${ORIGIN}/og.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Critiqs running in a customer accounts app, with comments from Priya, Mei and Daniel on the same page">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${ORIGIN}/og.png">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap">
  <link rel="stylesheet" href="/styles.css">
  <link rel="stylesheet" href="/docs.css">
  <script>document.documentElement.classList.add("js")</script>
  <script src="/main.js" defer></script>
  <script src="/docs.js" defer></script>

${structured.map(jsonLd).join("\n")}
</head>
<body class="${bodyClass}">
  <a class="skip-link button-sm" href="#main">Skip to content</a>

  <header>
    <nav class="nav" aria-label="Main">
      <a class="brand title-3" href="/" aria-label="Critiqs home">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 1 0 20H4a2 2 0 0 1-2-2v-8A10 10 0 0 1 12 2Z" fill="#0d63f3"/><circle cx="12" cy="12" r="3.5" fill="#fff"/></svg>
        Critiqs
      </a>
      <div class="nav-links body-5">
      ${links()}
      </div>
      <a class="btn btn-primary button-sm nav-cta" href="/start">Get started</a>
      <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="mobile-menu" aria-label="Open menu">
        <span class="bar"></span><span class="bar"></span>
      </button>
    </nav>
    <div class="mobile-menu heading-5" id="mobile-menu" hidden>
      ${links()}
      <a href="/start">Get started</a>
    </div>
  </header>

${body}

  <footer>
    <div class="wrap body-6">
      <div class="foot-groups">
        <nav aria-label="Product">
          <p class="foot-title title-4">Product</p>
          <a href="/#compare">Why Critiqs</a>
          <a href="/#mockups">Mockup mode</a>
          <a href="/#pricing">Pricing</a>
          <a href="/#faq">FAQ</a>
        </nav>
        <nav aria-label="Resources">
          <p class="foot-title title-4">Resources</p>
          <a href="/docs">Docs</a>
          <a href="/docs/install">Install guide</a>
          <a href="/docs/agent-skill">Agent skill</a>
          <a href="/blog">Blog</a>
        </nav>
        <nav aria-label="Elsewhere">
          <p class="foot-title title-4">Elsewhere</p>
          <a href="https://www.npmjs.com/package/critiqs-react">npm package</a>
          <a href="/blog/feed.xml">RSS feed</a>
          <a href="/llms.txt">llms.txt</a>
        </nav>
      </div>
      <p class="foot-legal">© 2026 Critiqs · <a href="/privacy">Privacy policy</a></p>
    </div>
  </footer>

  <p class="visually-hidden" role="status" aria-live="polite" id="copy-status"></p>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Docs

function docSidebar(docs, active) {
  const groups = SECTIONS.map((section) => {
    const items = docs.filter((d) => d.data.section === section);
    if (!items.length) return "";
    const list = items
      .map((d) => `<li><a href="/docs/${d.slug}"${d === active ? ' aria-current="page"' : ""}>${escapeHtml(d.data.title)}</a></li>`)
      .join("\n            ");
    return `
          <p class="docs-group title-4">${section}</p>
          <ul class="body-6">
            ${list}
          </ul>`;
  }).join("");
  return `<aside class="docs-sidebar">
        <button class="docs-menu-button button-sm" type="button" aria-expanded="false" aria-controls="docs-nav">
          ${ICON("list")}Docs menu<span class="docs-menu-current body-6">${active ? escapeHtml(active.data.title) : ""}</span>
        </button>
        <nav class="docs-nav" id="docs-nav" aria-label="Docs">
          <a class="docs-home body-5" href="/docs">Docs home</a>${groups}
        </nav>
      </aside>`;
}

function docPage(doc, docs, index) {
  const { title, description, section } = doc.data;
  const path = `/docs/${doc.slug}`;
  const prev = docs[index - 1];
  const next = docs[index + 1];
  const toc = doc.toc.length
    ? `<nav class="toc" aria-labelledby="toc-title">
          <p class="toc-title title-4" id="toc-title">On this page</p>
          <ul class="body-6">
            ${doc.toc.map((h) => `<li class="toc-h${h.depth}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`).join("\n            ")}
          </ul>
        </nav>`
    : "";
  const pager = `<nav class="pager" aria-label="Previous and next">
          ${prev ? `<a class="pager-link prev" href="/docs/${prev.slug}"><span class="caption-4">Previous</span><span class="title-3">${escapeHtml(prev.data.title)}</span></a>` : "<span></span>"}
          ${next ? `<a class="pager-link next" href="/docs/${next.slug}"><span class="caption-4">Next</span><span class="title-3">${escapeHtml(next.data.title)}</span></a>` : "<span></span>"}
        </nav>`;

  return page({
    title: `${title} · Critiqs docs`,
    description,
    path,
    area: "docs",
    isIndex: false,
    bodyClass: "docs-page",
    head: `  <link rel="alternate" type="text/markdown" href="${path}.md">\n`,
    structured: [
      {
        "@context": "https://schema.org",
        "@type": "TechArticle",
        headline: title,
        description,
        url: ORIGIN + path,
        mainEntityOfPage: ORIGIN + path,
        articleSection: section,
        inLanguage: "en",
        image: `${ORIGIN}/og.png`,
        author: ORG,
        publisher: ORG,
      },
      breadcrumbs([["Critiqs", "/"], ["Docs", "/docs"], [title, path]]),
    ],
    body: `  <div class="docs-layout">
      ${docSidebar(docs, doc)}
      <main id="main" class="docs-main">
        <article class="prose">
          <header class="doc-header">
            <nav class="crumbs caption-4" aria-label="Breadcrumb"><ol><li><a href="/docs">Docs</a></li><li>${section}</li></ol></nav>
            <h1 class="heading-3">${escapeHtml(title)}</h1>
            <p class="doc-lede title-2">${escapeHtml(description)}</p>
          </header>
${doc.html}        </article>
        ${pager}
      </main>
      <div class="docs-aside">
        ${toc}
        <a class="md-link caption-4" href="${path}.md">View as Markdown</a>
      </div>
    </div>`,
  });
}

function docsHome(docs) {
  const sections = SECTIONS.map((section) => {
    const items = docs.filter((d) => d.data.section === section);
    if (!items.length) return "";
    const id = slugify(section);
    return `
      <section class="docs-section" aria-labelledby="${id}">
        <h2 class="heading-5" id="${id}">${section}</h2>
        <ul class="card-grid">
          ${items
            .map(
              (d) => `<li><a class="card" href="/docs/${d.slug}"><h3 class="title-2">${escapeHtml(d.data.title)}</h3><p class="body-6">${escapeHtml(d.data.description)}</p></a></li>`,
            )
            .join("\n          ")}
        </ul>
      </section>`;
  }).join("");
  const description = "How to add Critiqs to a staging or preview build, review with your team, use Mockup mode, and hand threads to coding agents.";
  return page({
    title: "Critiqs documentation",
    description,
    path: "/docs",
    area: "docs",
    isIndex: true,
    ogType: "website",
    bodyClass: "docs-index",
    structured: [
      { "@context": "https://schema.org", "@type": "CollectionPage", name: "Critiqs documentation", description, url: `${ORIGIN}/docs`, publisher: ORG },
      breadcrumbs([["Critiqs", "/"], ["Docs", "/docs"]]),
    ],
    body: `  <main id="main" class="listing">
    <div class="wrap">
      <header class="listing-head">
        <h1 class="heading-2">Documentation</h1>
        <p class="title-2">${escapeHtml(description)}</p>
      </header>${sections}
    </div>
  </main>`,
  });
}

function docMarkdown(doc) {
  return `# ${doc.data.title}\n\n> ${doc.data.description}\n\n${doc.body}`;
}

// ---------------------------------------------------------------------------
// Blog

const dateLine = (post) =>
  `<time datetime="${post.data.date}">${longDate(post.data.date)}</time>` +
  (post.data.updated ? `<span aria-hidden="true">·</span><span>Updated <time datetime="${post.data.updated}">${longDate(post.data.updated)}</time></span>` : "") +
  `<span aria-hidden="true">·</span><span>${post.minutes} min read</span>`;

function postPage(post) {
  const { title, description, date, updated, tags } = post.data;
  const path = `/blog/${post.slug}`;
  return page({
    title: `${title} · Critiqs blog`,
    description,
    path,
    area: "blog",
    isIndex: false,
    bodyClass: "post-page",
    head:
      `  <link rel="alternate" type="application/rss+xml" title="Critiqs blog" href="/blog/feed.xml">\n` +
      `  <meta property="article:published_time" content="${date}">\n` +
      (updated ? `  <meta property="article:modified_time" content="${updated}">\n` : "") +
      tags.map((t) => `  <meta property="article:tag" content="${escapeHtml(t)}">\n`).join(""),
    structured: [
      {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        headline: title,
        description,
        url: ORIGIN + path,
        mainEntityOfPage: ORIGIN + path,
        datePublished: date,
        dateModified: updated ?? date,
        keywords: tags,
        inLanguage: "en",
        image: `${ORIGIN}/og.png`,
        author: ORG,
        publisher: ORG,
      },
      breadcrumbs([["Critiqs", "/"], ["Blog", "/blog"], [title, path]]),
    ],
    body: `  <main id="main" class="post">
    <div class="wrap">
      <article class="prose">
        <header class="post-header">
          <nav class="crumbs caption-4" aria-label="Breadcrumb"><ol><li><a href="/blog">Blog</a></li><li>${escapeHtml(tags[0] ?? "Article")}</li></ol></nav>
          <h1 class="heading-3">${escapeHtml(title)}</h1>
          <p class="post-meta body-6">${dateLine(post)}</p>
        </header>
${post.html}      </article>
      <aside class="post-cta" aria-labelledby="cta-title">
        <h2 class="heading-5" id="cta-title">Add Critiqs to your next staging build</h2>
        <p class="body-3">Free to start on Critiqs Cloud, or host it yourself under the MIT license.</p>
        <a class="btn btn-primary button-md" href="/start">Get started</a>
      </aside>
    </div>
  </main>`,
  });
}

function blogIndex(posts) {
  const description = "Notes from the Critiqs team on reviewing builds, Mockup mode, and working with coding agents.";
  const items = posts
    .map(
      (p) => `
        <li class="post-item">
          <p class="post-meta body-6">${dateLine(p)}</p>
          <h2 class="heading-5"><a href="/blog/${p.slug}">${escapeHtml(p.data.title)}</a></h2>
          <p class="body-3">${escapeHtml(p.data.description)}</p>
        </li>`,
    )
    .join("");
  return page({
    title: "Critiqs blog",
    description,
    path: "/blog",
    area: "blog",
    isIndex: true,
    ogType: "website",
    bodyClass: "blog-index",
    head: `  <link rel="alternate" type="application/rss+xml" title="Critiqs blog" href="/blog/feed.xml">\n`,
    structured: [
      {
        "@context": "https://schema.org",
        "@type": "Blog",
        name: "Critiqs blog",
        description,
        url: `${ORIGIN}/blog`,
        publisher: ORG,
        blogPost: posts.map((p) => ({ "@type": "BlogPosting", headline: p.data.title, url: `${ORIGIN}/blog/${p.slug}`, datePublished: p.data.date })),
      },
      breadcrumbs([["Critiqs", "/"], ["Blog", "/blog"]]),
    ],
    body: `  <main id="main" class="listing">
    <div class="wrap">
      <header class="listing-head">
        <h1 class="heading-2">Blog</h1>
        <p class="title-2">${escapeHtml(description)}</p>
      </header>
      <ol class="post-list">${items}
      </ol>
    </div>
  </main>`,
  });
}

function feed(posts) {
  const items = posts
    .map(
      (p) => `    <item>
      <title>${escapeHtml(p.data.title)}</title>
      <link>${ORIGIN}/blog/${p.slug}</link>
      <guid isPermaLink="true">${ORIGIN}/blog/${p.slug}</guid>
      <pubDate>${rfc822(p.data.date)}</pubDate>
      <description>${escapeHtml(p.data.description)}</description>
${p.data.tags.map((t) => `      <category>${escapeHtml(t)}</category>\n`).join("")}    </item>
`,
    )
    .join("");
  const latest = posts.map((p) => p.data.updated ?? p.data.date).sort().at(-1);
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Critiqs blog</title>
    <link>${ORIGIN}/blog</link>
    <atom:link href="${ORIGIN}/blog/feed.xml" rel="self" type="application/rss+xml"/>
    <description>Notes from the Critiqs team on reviewing builds, Mockup mode, and working with coding agents.</description>
    <language>en</language>
${latest ? `    <lastBuildDate>${rfc822(latest)}</lastBuildDate>\n` : ""}${items}  </channel>
</rss>
`;
}

// ---------------------------------------------------------------------------
// Standalone pages

function standalonePage(entry) {
  const { title, description, updated } = entry.data;
  const path = `/${entry.slug}`;
  const meta = updated ? `\n          <p class="post-meta body-6">Updated <time datetime="${updated}">${longDate(updated)}</time></p>` : "";
  return page({
    title: `${title} · Critiqs`,
    description,
    path,
    area: null,
    isIndex: false,
    ogType: "website",
    bodyClass: "standalone-page",
    structured: [
      {
        "@context": "https://schema.org",
        "@type": "WebPage",
        name: title,
        description,
        url: ORIGIN + path,
        inLanguage: "en",
        publisher: ORG,
        ...(updated ? { dateModified: updated } : {}),
      },
      breadcrumbs([["Critiqs", "/"], [title, path]]),
    ],
    body: `  <main id="main" class="post">
    <div class="wrap">
      <article class="prose">
        <header class="post-header">
          <h1 class="heading-3">${escapeHtml(title)}</h1>
          <p class="doc-lede title-2">${escapeHtml(description)}</p>${meta}
        </header>
${entry.html}      </article>
    </div>
  </main>`,
  });
}

// ---------------------------------------------------------------------------
// Site-wide files

function sitemap(docs, posts, pages) {
  const urls = [
    ["/"],
    ...pages.map((p) => [`/${p.slug}`, p.data.updated]),
    ["/docs"],
    ...docs.map((d) => [`/docs/${d.slug}`]),
    ["/blog"],
    ...posts.map((p) => [`/blog/${p.slug}`, p.data.updated ?? p.data.date]),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([path, mod]) => `  <url><loc>${ORIGIN}${path}</loc>${mod ? `<lastmod>${mod}</lastmod>` : ""}</url>`).join("\n")}
</urlset>
`;
}

const robots = () => `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`;

function llms(docs, posts) {
  const oneLine = (text) => text.replace(/\s+/g, " ").trim();
  const docSections = SECTIONS.map((section) => {
    const items = docs.filter((d) => d.data.section === section);
    if (!items.length) return "";
    return `## ${section}\n\n${items.map((d) => `- [${d.data.title}](${ORIGIN}/docs/${d.slug}.md): ${oneLine(d.data.description)}`).join("\n")}\n\n`;
  }).join("");
  const blog = posts.length
    ? `## Blog\n\n${posts.map((p) => `- [${p.data.title}](${ORIGIN}/blog/${p.slug}): ${oneLine(p.data.description)}`).join("\n")}\n`
    : "";
  return `# Critiqs

> ${SUMMARY}

Critiqs is installed with the package for the app's framework (\`critiqs-react\` for React and Next.js, \`critiqs-vue\`, \`critiqs-nuxt\`, \`critiqs-svelte\`, \`critiqs-angular\`, \`critiqs-astro\`, \`critiqs-solid\`, \`critiqs-rails\`, \`django-critiqs\`, or \`flask-critiqs\`), or a script tag on any other site, and set up with \`npx critiqs init\`. It runs on Critiqs Cloud or a team's own Convex deployment, under the MIT license. Coding agents read threads through the Critiqs MCP server (\`npx critiqs mcp\`). Each doc below links to a plain Markdown copy.

${docSections}${blog}`;
}

// ---------------------------------------------------------------------------
// Build

function build() {
  const docs = loadDocs();
  const posts = loadPosts();
  const pages = loadPages();
  const all = [...docs, ...posts, ...pages];

  const links = new Map([...docs.map((d) => [`docs/${d.slug}`, `/docs/${d.slug}`]), ...posts.map((p) => [`blog/${p.slug}`, `/blog/${p.slug}`])]);
  for (const entry of all) {
    Object.assign(entry, renderMarkdown(entry, links));
    entry.minutes = readingMinutes(entry.body);
  }
  // A #fragment must name a heading id on the page it points to.
  const ids = new Map(all.map((e) => [`${e.kind}/${e.slug}`, e.ids]));
  for (const entry of all) {
    for (const { href, target, id } of entry.fragments) {
      let decoded = id;
      try {
        decoded = decodeURIComponent(id);
      } catch {}
      if (!ids.get(target).has(decoded)) fail(entry.file, `links to ${href}, but ${target} has no heading with the id "${decoded}"`);
    }
  }
  if (errors.length) return null;

  const out = new Map();
  out.set("docs/index.html", docsHome(docs));
  docs.forEach((doc, index) => {
    out.set(`docs/${doc.slug}.html`, docPage(doc, docs, index));
    out.set(`docs/${doc.slug}.md`, docMarkdown(doc));
  });
  out.set("blog/index.html", blogIndex(posts));
  for (const post of posts) out.set(`blog/${post.slug}.html`, postPage(post));
  out.set("blog/feed.xml", feed(posts));
  for (const entry of pages) out.set(`${entry.slug}.html`, standalonePage(entry));
  out.set("sitemap.xml", sitemap(docs, posts, pages));
  out.set("robots.txt", robots());
  out.set("llms.txt", llms(docs, posts));
  return out;
}

// site/docs and site/blog are generated in full; anything else in them is stale.
// So is any HTML file at the site's root other than the hand-written landing
// and 404 pages: the root's other pages come from content/pages.
const OWNED_DIRS = ["docs", "blog"];
const HAND_WRITTEN = new Set(["index.html", "404.html"]);
const listOwned = () => [
  ...readdirSync(SITE, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html") && !HAND_WRITTEN.has(entry.name))
    .map((entry) => entry.name),
  ...OWNED_DIRS.flatMap((dir) =>
    existsSync(join(SITE, dir))
      ? readdirSync(join(SITE, dir), { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => relative(SITE, join(entry.parentPath, entry.name)))
      : [],
  ),
];

const out = build();
if (!out) {
  console.error(`Content has ${errors.length} problem${errors.length === 1 ? "" : "s"}:\n${errors.map((e) => `  ${e}`).join("\n")}`);
  process.exit(1);
}

const check = process.argv.includes("--check");
const changed = [...out].filter(([file, text]) => !existsSync(join(SITE, file)) || readFileSync(join(SITE, file), "utf8") !== text).map(([f]) => f);
const stale = listOwned().filter((f) => !out.has(f));

if (check) {
  if (changed.length || stale.length) {
    console.error("site/ is out of date with site-src/content. Run `bun build-pages.mjs` in site-src and commit the result.");
    for (const f of changed) console.error(`  differs: site/${f}`);
    for (const f of stale) console.error(`  not generated: site/${f}`);
    process.exit(1);
  }
  console.log(`site/ is up to date (${out.size} generated files).`);
} else {
  for (const f of changed) {
    mkdirSync(dirname(join(SITE, f)), { recursive: true });
    writeFileSync(join(SITE, f), out.get(f));
  }
  for (const f of stale) rmSync(join(SITE, f));
  console.log(`Wrote ${changed.length} of ${out.size} files${stale.length ? `, removed ${stale.length} stale` : ""}.`);
}
