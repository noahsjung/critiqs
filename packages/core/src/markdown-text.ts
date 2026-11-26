// Text that people or trackers wrote, as Markdown that renders exactly as
// written. Ticket text goes into a tracker the whole team reads, under the
// name of the person who created it, so nothing a reviewer typed (a comment,
// a name, a page's details) or a tracker sent (a template's heading) may form
// a link, image, HTML, or any other structure there. Ticket text is built
// only from Critiqs's own Markdown and these functions' output.

/**
 * Every ASCII punctuation character CommonMark or GitHub's Markdown gives a
 * meaning to, anywhere in a line: all but `, ; ? ! ' " %`, which mean
 * something only inside a link, image, or HTML tag, each of which needs a
 * `[` or `<`, both escaped. The rest escaped, no link, autolink, image, HTML,
 * entity, code, emphasis, heading, list, quote, or table can form.
 */
const MARKDOWN_PUNCTUATION = /[#$&()*+\-./:<=>@[\\\]^_`{|}~]/g;

/** Text on one line: every run of whitespace, line breaks included, one space. */
function oneLine(value: unknown): string {
  return String(value).replace(/\s+/g, " ").trim();
}

/**
 * Text as Markdown that renders exactly as written, on one line, as part of
 * a paragraph, list item, or heading: line breaks become spaces, and every
 * character that could form Markdown is escaped.
 */
export function markdownText(value: unknown): string {
  return oneLine(value).replace(MARKDOWN_PUNCTUATION, "\\$&");
}

/**
 * Text of several lines, such as a comment, as Markdown lines that render
 * exactly as written: each line is escaped as `markdownText`, without the
 * indentation that would make it code, and blank lines stay, separating
 * paragraphs.
 */
export function markdownLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/).map(markdownText);
}

/**
 * Text as an inline code span, on one line, for identifiers and addresses:
 * fenced by more backticks than any run inside it, so nothing in it ends it
 * early, and, when it starts or ends with a backtick, padded with a space
 * each side, which Markdown removes.
 */
export function markdownCode(value: unknown): string {
  const text = oneLine(value);
  if (text === "") return "";
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${padding}${text}${padding}${fence}`;
}

/**
 * A Markdown link: its text escaped as `markdownText`, and its destination
 * rendering exactly as given: in angle brackets, so ")" can't end it, with
 * "&" written as "&amp;" so no part of the address is read as a character
 * reference, and the characters that angle brackets can't hold
 * percent-encoded.
 */
export function markdownLink(text: string, url: string): string {
  const destination = url.replaceAll("&", "&amp;").replace(/[<>\\\s]/g, (character) => encodeURIComponent(character));
  return `[${markdownText(text)}](<${destination}>)`;
}
