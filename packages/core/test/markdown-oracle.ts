// Renders Markdown as a tracker would and reports what it made, for tests
// that check text from people and trackers renders exactly as written.
// Bun's renderer with GitHub's autolinks (web and email addresses) on,
// GitHub's own flavour (`renderGfm`), markdown-it with its linkifier
// (`renderLinkified`), or marked with GitHub's flavour (`renderMarked`).

import MarkdownIt from "markdown-it";
import { marked } from "marked";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

export interface Rendered {
  html: string;
  /** Every element the HTML has, by tag name, in order. */
  tags: string[];
  /** Every link's address, in order. */
  hrefs: string[];
  /** Every image's address, in order. */
  images: string[];
  /** The visible text, entities decoded, whitespace collapsed, without word joiners, which show nothing. */
  text: string;
}

const decode = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");

export function render(markdown: string): Rendered {
  return parsed(Bun.markdown.html(markdown, { autolinks: true }));
}

function parsed(html: string): Rendered {
  const tags = [...html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b/g)].map((match) => match[1]!.toLowerCase());
  const hrefs = [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((match) => decode(match[1]!));
  const images = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/g)].map((match) => decode(match[1]!));
  const text = decode(html.replace(/<[^>]*>/g, " ")).replace(/\u2060/g, "").replace(/\s+/g, " ").trim();
  return { html, tags, hrefs, images, text };
}

/** Elements Critiqs's own ticket Markdown makes: headings, paragraphs, lists, quotes, its own emphasis and code, rules, and its links. */
export const TICKET_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "blockquote", "strong", "code", "hr", "a", "br"]);

/**
 * Renders Markdown as GitHub does: micromark, the reference CommonMark
 * parser, with GitHub's extensions (tables, task lists, strikethrough,
 * autolinks, footnotes). Unlike Bun's renderer, it makes a table of one
 * column with no pipes, as GitHub does.
 */
export function renderGfm(markdown: string): Rendered {
  return parsed(micromark(markdown, { extensions: [gfm()], htmlExtensions: [gfmHtml()] }));
}

const linkified = new MarkdownIt({ linkify: true });

/** Renders Markdown as markdown-it does with its linkifier on, which finds addresses (`mailto:` ones too) that GitHub's autolinks don't. */
export function renderLinkified(markdown: string): Rendered {
  return parsed(linkified.render(markdown));
}

/** Renders Markdown as marked does with GitHub's flavour, which writes an `&` before word characters and `;` as it is, for the browser to read. */
export function renderMarked(markdown: string): Rendered {
  return parsed(marked.parse(markdown, { gfm: true, async: false }) as string);
}

/**
 * What GitHub would resolve in rendered HTML's text, outside code and links,
 * as its docs on autolinked references list and its Markdown endpoint shows
 * (backslashes stop none of them): a mention (`@name`, `@org/team`), an email
 * address, an issue or pull request (`#1`, `GH-1`, `owner#1`,
 * `owner/repo#1`, or its address's path, `owner/repo/issues/1`), and an
 * emoji (`:smile:`). Each match, as text.
 */
export function githubReferences(html: string): string[] {
  const text = decode(html.replace(/<(code|a)\b[^>]*>[\s\S]*?<\/\1>/g, " ").replace(/<[^>]*>/g, " "));
  const patterns = [/@[A-Za-z0-9]/g, /#[0-9]/g, /\bgh-[0-9]/gi, /\/(?:issues|pulls?|discussions)\/[0-9]/gi, /:[A-Za-z0-9_+-]+:/g];
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[0]));
}
