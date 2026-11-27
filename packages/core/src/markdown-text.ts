import type { WebAddress } from "./web-address.ts";

// Text that people or trackers wrote, as Markdown that renders exactly as
// written. Ticket text goes into a tracker the whole team reads, under the
// name of the person who created it, so nothing a reviewer typed (a comment,
// a name, a page's details) or a tracker sent (a template's heading) may form
// a link, image, HTML, or any other structure there. Ticket text is built
// only from Critiqs's own Markdown and these functions' output.

/** Text on one line: every run of whitespace, line breaks included, one space. */
function oneLine(value: unknown): string {
  return String(value).replace(/\s+/g, " ").trim();
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/u;

/**
 * Characters that open something wherever they are: code spans, links and
 * images, tables, and GitHub's math. Each is escaped everywhere.
 */
const ALWAYS = new Set(["`", "[", "]", "|", "$"]);

/**
 * Where the line's first character starts a block, the index to escape:
 * a heading (`#`), a quote (`>`), a list item (`-`, `+`, `*`, or digits and
 * `.` or `)`), a rule, Linear's collapsed section (`+++`), or a line that
 * means something under the line above it: a heading's underline (`---`,
 * `===`), or a table's delimiter row, which in GitHub's Markdown needs no
 * pipe (`:-`, `-:`, `:-:`). Any line of only `-`, `:` and spaces counts.
 * Escaping the first character is enough, since none of these takes a
 * backslash. -1 otherwise.
 */
function blockStart(text: string): number {
  if (/^#{1,6}(?:\s|$)/.test(text) || text.startsWith(">") || /^[-+*](?:\s|$)/.test(text) || text.startsWith("+++") || /^[-:\s]*-[-:\s]*$/.test(text) || /^=+$/.test(text)) return 0;
  const ordered = /^\d{1,9}[.)](?:\s|$)/.exec(text);
  return ordered === null ? -1 : ordered[0].trimEnd().length - 1;
}

/**
 * Whether the character at `index` can mean something to a Markdown
 * renderer there (CommonMark, GitHub's Markdown, and the common linkifiers),
 * so it must be escaped. The text's ends count as anything, since Critiqs's
 * own Markdown sits around it.
 */
function opens(chars: string[], index: number): boolean {
  const char = chars[index]!;
  const before = chars[index - 1];
  const after = chars[index + 1];
  const space = (neighbour: string | undefined) => neighbour !== undefined && SPACE.test(neighbour);
  const word = (neighbour: string | undefined) => neighbour !== undefined && WORD.test(neighbour);
  if (ALWAYS.has(char)) return true;
  switch (char) {
    // An escape, or a line break at the end of a line.
    case "\\":
      return after === undefined || ASCII_PUNCTUATION.test(after);
    // Emphasis and strikethrough open and close inside words too; between spaces they are text.
    case "*":
    case "~":
      return !(space(before) && space(after));
    // `_` is text inside a word and between spaces.
    case "_":
      return !((word(before) && word(after)) || (space(before) && space(after)));
    // An HTML tag, comment, declaration, or instruction, or an autolink.
    case "<":
      return after === undefined || /[A-Za-z/!?]/.test(after);
    // A character reference; and `&` before word characters and `;`, which marked writes as it is, so a browser reads `&amp_x;` as `&_x;`.
    case "&":
      return /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,31})(?:;|$)|^&#?\w+;/.test(chars.slice(index).join(""));
    // A domain's dot, which turns a word into a web or email address, and the dot of `www.`.
    case ".":
      return word(after) || after === "-" || after === "_" || /www$/i.test(chars.slice(Math.max(0, index - 3), index).join(""));
    // An address's scheme, such as `https:` or `mailto:`; at the end, one whose address follows straight after it.
    case ":":
      return before !== undefined && /[A-Za-z]/.test(before) && (after === undefined ? /(?:mailto|xmpp)$/i.test(chars.slice(Math.max(0, index - 6), index).join("")) : !space(after));
    // A scheme-relative address.
    case "/":
      return after === "/";
    // An email address.
    case "@":
      return before !== undefined && !space(before) && (word(after) || after === "-" || after === "_" || after === ".");
    // A link's address after its text, which some renderers read even when the brackets are escaped.
    case "(":
      return before === "]";
    // A heading's closing `#`s, at the end.
    case "#":
      return (before === undefined || space(before)) && chars.slice(index).every((each) => each === "#");
    default:
      return false;
  }
}

/** A word joiner: it shows nothing and never breaks a line. */
const JOINER = "\u2060";

/**
 * Whether the character at `index` is the sign of something a tracker
 * resolves after rendering, whatever the backslashes, so a word joiner goes
 * after it. GitHub resolves (its docs on autolinked references, and its
 * Markdown endpoint): a mention (`@name`, `@org/team`), an email address,
 * an issue or pull request (`#1`, `GH-1`, `owner/repo#1`, or its address's
 * path, `owner/repo/issues/1`), and an emoji (`:smile:`). With the joiner
 * between the sign and the rest, none of them matches, and the text reads
 * the same.
 */
function resolves(chars: string[], index: number): boolean {
  const after = chars[index + 1];
  if (after === undefined) return false;
  const behind = (length: number) => chars.slice(Math.max(0, index - length), index).join("");
  switch (chars[index]) {
    case "@":
      return /[A-Za-z0-9]/.test(after);
    case "#":
      return /[0-9]/.test(after);
    case "-":
      return /[0-9]/.test(after) && /gh$/i.test(behind(2));
    case "/":
      return /[0-9]/.test(after) && /(?:issues|pulls?|discussions)$/i.test(behind(11));
    // An emoji's name runs to its closing `:`, or to the end, where Critiqs's own text may close it.
    case ":":
      return /^[A-Za-z0-9_+-]+(?::|$)/.test(chars.slice(index + 1, index + 66).join(""));
    default:
      return false;
  }
}

/**
 * Plain text that a tracker shows as text, such as a ticket's title, as
 * written, with a word joiner after each sign it would resolve
 * (`resolves`), so a reviewer's line can't mention anyone or reference an
 * issue there either.
 */
export function unresolvedText(value: string): string {
  const chars = Array.from(value);
  return chars.map((char, index) => (resolves(chars, index) ? `${char}${JOINER}` : char)).join("");
}

/**
 * Text as Markdown that renders exactly as written, on one line, as part of
 * a paragraph, list item, or heading: line breaks become spaces, and a
 * character is escaped only where a Markdown renderer would give it a
 * meaning (`opens`, `blockStart`), so ordinary sentences have no
 * backslashes. No link, autolink, image, HTML, entity, code, emphasis,
 * heading, list, quote, rule, or table can form. Nor can a mention, issue
 * reference, or emoji, which a tracker resolves in the rendered text: a word
 * joiner, which shows nothing, follows their sign (`resolves`).
 */
export function markdownText(value: unknown): string {
  const chars = Array.from(oneLine(value));
  const start = blockStart(chars.join(""));
  // `blockStart` counts UTF-16 units; it only ever points at ASCII at the line's start, before any other character.
  return chars.map((char, index) => `${index === start || opens(chars, index) ? `\\${char}` : char}${resolves(chars, index) ? JOINER : ""}`).join("");
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
 * percent-encoded. Only a checked address (`webAddress`) can be a link.
 */
export function markdownLink(text: string, url: WebAddress): string {
  const destination = url.replaceAll("&", "&amp;").replace(/[<>\\\s]/g, (character) => encodeURIComponent(character));
  return `[${markdownText(text)}](<${destination}>)`;
}
