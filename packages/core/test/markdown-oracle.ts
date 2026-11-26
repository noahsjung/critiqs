// Renders Markdown as a tracker would and reports what it made, for tests
// that check text from people and trackers renders exactly as written.
// Bun's renderer with GitHub's autolinks (web and email addresses) on.

export interface Rendered {
  html: string;
  /** Every element the HTML has, by tag name, in order. */
  tags: string[];
  /** Every link's address, in order. */
  hrefs: string[];
  /** Every image's address, in order. */
  images: string[];
  /** The visible text, entities decoded, whitespace collapsed. */
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
  const html = Bun.markdown.html(markdown, { autolinks: true });
  const tags = [...html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b/g)].map((match) => match[1]!.toLowerCase());
  const hrefs = [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((match) => decode(match[1]!));
  const images = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/g)].map((match) => decode(match[1]!));
  const text = decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  return { html, tags, hrefs, images, text };
}

/** Elements Critiqs's own ticket Markdown makes: headings, paragraphs, lists, quotes, its own emphasis and code, rules, and its links. */
export const TICKET_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "blockquote", "strong", "code", "hr", "a", "br"]);
