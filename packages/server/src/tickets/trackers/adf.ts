import { type TicketMarkdown, webAddress } from "@critiqs/core";

// Critiqs's ticket Markdown as Atlassian Document Format (ADF), the JSON
// document Jira takes for an issue's description and comments
// (https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/).
//
// The converter reads the Markdown Critiqs writes and people edit in the
// Create dialog: headings, paragraphs, quotes, lists, code fences, rules,
// and inline code, emphasis, links, and escapes. Everything else (tables,
// HTML) stays as its text. It never drops text, never builds markup, and
// only ever writes nodes in the places ADF allows them, so Jira can't refuse
// the document: a heading inside a quote becomes a paragraph, a quote inside
// a list item becomes its paragraphs, and so on. Links are kept only to web
// and email addresses; any other address stays as the link's text.

export interface AdfMark {
  type: "strong" | "em" | "code" | "link";
  attrs?: { href: string };
}

export type AdfInline = { type: "text"; text: string; marks?: AdfMark[] } | { type: "hardBreak" };

export type AdfBlock =
  | { type: "paragraph"; content?: AdfInline[] }
  | { type: "heading"; attrs: { level: number }; content?: AdfInline[] }
  | { type: "codeBlock"; attrs?: { language: string }; content?: { type: "text"; text: string }[] }
  | { type: "blockquote"; content: AdfBlock[] }
  | { type: "bulletList"; content: AdfListItem[] }
  | { type: "orderedList"; attrs?: { order: number }; content: AdfListItem[] }
  | { type: "rule" };

export interface AdfListItem {
  type: "listItem";
  content: AdfBlock[];
}

export interface AdfDocument {
  version: 1;
  type: "doc";
  content: AdfBlock[];
}

/** Plain text as a document: one paragraph per paragraph, line breaks kept, nothing read as Markdown. */
export function plainAdf(text: string): AdfDocument {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
  return {
    version: 1,
    type: "doc",
    content: paragraphs.map((paragraph) => ({ type: "paragraph", content: withBreaks(paragraph.split("\n").map((line) => textNode(line, []))) })),
  };
}

/**
 * Ticket Markdown as an ADF document: only text Critiqs made
 * (`TicketMarkdown`), whose escapes become literal text, never a plain string.
 */
export function markdownToAdf(markdown: TicketMarkdown): AdfDocument {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  return { version: 1, type: "doc", content: parseBlocks(lines) };
}

// ---------------------------------------------------------------------------
// Blocks.

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const BULLET = /^( {0,3})([-*+])([ \t]+)(.*)$/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])([ \t]+)(.*)$/;
const EMPTY_ITEM = /^( {0,3})(?:[-*+]|\d{1,9}[.)])[ \t]*$/;

const blank = (line: string) => line.trim() === "";
const startsBlock = (line: string) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || BULLET.test(line) || ORDERED.test(line);

interface ListMarker {
  ordered: boolean;
  /** The bullet character, or the ordered list's delimiter. */
  char: string;
  start: number;
  /** Columns before the item's content. */
  indent: number;
  first: string;
}

function listMarker(line: string): ListMarker | null {
  const ordered = ORDERED.exec(line);
  if (ordered !== null) {
    const [, lead, number, delimiter, gap, rest] = ordered as unknown as [string, string, string, string, string, string];
    return { ordered: true, char: delimiter, start: Number(number), indent: lead.length + number.length + 1 + Math.min(gap.length, 4), first: rest };
  }
  const bullet = BULLET.exec(line);
  if (bullet !== null) {
    const [, lead, char, gap, rest] = bullet as unknown as [string, string, string, string, string];
    // A rule like `- - -` is a rule, not a list.
    if (RULE.test(line)) return null;
    return { ordered: false, char, start: 1, indent: lead.length + 1 + Math.min(gap.length, 4), first: rest };
  }
  const empty = EMPTY_ITEM.exec(line);
  if (empty !== null) {
    const char = /\d/.test(line) ? (line.trim().slice(-1) as string) : line.trim();
    return { ordered: /\d/.test(line), char, start: /\d/.test(line) ? Number.parseInt(line.trim(), 10) : 1, indent: line.length, first: "" };
  }
  return null;
}

/** Removes up to `columns` leading spaces (a tab counts as four). */
function dedent(line: string, columns: number): string {
  let index = 0;
  let removed = 0;
  while (index < line.length && removed < columns) {
    if (line[index] === " ") removed += 1;
    else if (line[index] === "\t") removed += 4;
    else break;
    index++;
  }
  return line.slice(index);
}

const leading = (line: string) => line.length - line.trimStart().length;

function parseBlocks(lines: string[]): AdfBlock[] {
  const blocks: AdfBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (blank(line)) {
      index++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const [, marks, info] = fence as unknown as [string, string, string];
      const body: string[] = [];
      index++;
      while (index < lines.length && !new RegExp(`^ {0,3}${marks[0] === "`" ? "`" : "~"}{${marks.length},}\\s*$`).test(lines[index]!)) body.push(lines[index++]!);
      index++;
      const text = body.join("\n");
      blocks.push({ type: "codeBlock", ...(info === "" ? {} : { attrs: { language: unescapeText(info) } }), ...(text === "" ? {} : { content: [{ type: "text", text }] }) });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({ type: "heading", attrs: { level: heading[1]!.length }, ...inlineContent(heading[2] ?? "") });
      index++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      index++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (index < lines.length && !blank(lines[index]!)) {
        const quoted = QUOTE.exec(lines[index]!);
        // A line without `>` continues the quote's paragraph (lazy continuation), unless it starts a block.
        if (quoted === null && (startsBlock(lines[index]!) || inner.length === 0)) break;
        inner.push(quoted === null ? lines[index]! : quoted[1]!);
        index++;
      }
      const content = inQuote(parseBlocks(inner));
      // A quote holds at least one block; an empty paragraph where it had nothing.
      blocks.push({ type: "blockquote", content: content.length === 0 ? [{ type: "paragraph" }] : content });
      continue;
    }
    const marker = listMarker(line);
    if (marker !== null) {
      const [list, next] = parseList(lines, index, marker);
      blocks.push(list);
      index = next;
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && !blank(lines[index]!) && (paragraph.length === 0 || !startsBlock(lines[index]!))) paragraph.push(lines[index++]!);
    blocks.push({ type: "paragraph", ...inlineContent(paragraph.join("\n")) });
  }
  return blocks;
}

/** A list starting at `start`, its items, and the line after it. */
function parseList(lines: string[], start: number, first: ListMarker): [AdfBlock, number] {
  const items: AdfListItem[] = [];
  let index = start;
  let marker: ListMarker | null = first;
  while (marker !== null && marker.ordered === first.ordered && marker.char === first.char) {
    const body = [marker.first];
    index++;
    let sawBlank = false;
    while (index < lines.length) {
      const line = lines[index]!;
      if (blank(line)) {
        sawBlank = true;
        body.push("");
        index++;
        continue;
      }
      if (leading(line) >= marker.indent) {
        body.push(dedent(line, marker.indent));
        sawBlank = false;
        index++;
        continue;
      }
      // A line that isn't indented enough continues the item's paragraph, unless a blank line or a block came first.
      if (!sawBlank && !startsBlock(line)) {
        body.push(line.trim());
        index++;
        continue;
      }
      break;
    }
    while (body.length > 0 && blank(body.at(-1)!)) body.pop();
    const content = inListItem(parseBlocks(body));
    items.push({ type: "listItem", content: content.length === 0 ? [{ type: "paragraph" }] : content });
    // Blank lines between items stay inside the list.
    while (index < lines.length && blank(lines[index]!)) index++;
    marker = index < lines.length ? listMarker(lines[index]!) : null;
    if (marker !== null && leading(lines[index]!) > 3) marker = null;
  }
  // Blank lines skipped after the last item belong to what follows; nothing is lost.
  const list: AdfBlock = first.ordered
    ? { type: "orderedList", ...(first.start === 1 ? {} : { attrs: { order: first.start } }), content: items }
    : { type: "bulletList", content: items };
  return [list, index];
}

/** What a quote may hold in ADF: paragraphs, lists, and code. A heading becomes a paragraph of its text in bold, a rule is left out, and a quote in a quote gives its contents. */
function inQuote(blocks: AdfBlock[]): AdfBlock[] {
  return blocks.flatMap((block): AdfBlock[] => {
    switch (block.type) {
      case "paragraph":
      case "bulletList":
      case "orderedList":
      case "codeBlock":
        return [block];
      case "heading":
        return [{ type: "paragraph", ...(block.content === undefined ? {} : { content: block.content.map(bold) }) }];
      case "blockquote":
        return inQuote(block.content);
      case "rule":
        return [];
    }
  });
}

/** What a list item may hold in ADF: paragraphs, lists, and code. A quote gives its contents. */
function inListItem(blocks: AdfBlock[]): AdfBlock[] {
  return blocks.flatMap((block): AdfBlock[] => (block.type === "blockquote" ? inListItem(block.content) : inQuote([block])));
}

function bold(node: AdfInline): AdfInline {
  if (node.type !== "text" || node.marks?.some((mark) => mark.type === "code" || mark.type === "strong")) return node;
  return { ...node, marks: [...(node.marks ?? []), { type: "strong" }] };
}

// ---------------------------------------------------------------------------
// Inline text.

const ASCII_PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

/** A paragraph's or heading's content; absent when it has no text, as ADF allows an empty paragraph but not an empty text node. */
function inlineContent(source: string): { content?: AdfInline[] } {
  const lines = source.split("\n");
  const parts = lines.map((line, index) => {
    const last = index === lines.length - 1;
    // A line ending in two spaces or a backslash breaks the line; any other line break is a space.
    const hard = !last && (/ {2,}$/.test(line) || /(?<!\\)(?:\\\\)*\\$/.test(line));
    const text = last ? line.trim() : hard ? line.replace(/\\$/, "").trimEnd() : `${line.trim()} `;
    return { nodes: parseInline(index === 0 ? text : text.trimStart(), []), hard };
  });
  const nodes: AdfInline[] = [];
  for (const part of parts) {
    nodes.push(...part.nodes);
    if (part.hard) nodes.push({ type: "hardBreak" });
  }
  const merged = merge(nodes);
  while (merged.at(-1)?.type === "hardBreak") merged.pop();
  return merged.length === 0 ? {} : { content: merged };
}

function withBreaks(lines: AdfInline[][]): AdfInline[] {
  return merge(lines.flatMap((line, index) => (index === 0 ? line : [{ type: "hardBreak" } as AdfInline, ...line])));
}

function textNode(text: string, marks: AdfMark[]): AdfInline[] {
  if (text === "") return [];
  return [marks.length === 0 ? { type: "text", text } : { type: "text", text, marks }];
}

/** Joins neighbouring text with the same marks, and drops empty text. */
function merge(nodes: AdfInline[]): AdfInline[] {
  const out: AdfInline[] = [];
  for (const node of nodes) {
    if (node.type === "text" && node.text === "") continue;
    const last = out.at(-1);
    if (last?.type === "text" && node.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])) {
      out[out.length - 1] = { ...last, text: last.text + node.text };
    } else out.push(node);
  }
  return out;
}

/** The marks a node may add to `marks`: code goes only with a link, as ADF requires. */
function addMark(marks: AdfMark[], mark: AdfMark): AdfMark[] {
  if (marks.some((each) => each.type === mark.type)) return marks;
  if (marks.some((each) => each.type === "code") && mark.type !== "link") return marks;
  if (mark.type === "code") return [...marks.filter((each) => each.type === "link"), mark];
  return [...marks, mark];
}

/** Text with backslash escapes and the entities Critiqs writes in link addresses read. */
function unescapeText(text: string): string {
  return decodeEntities(text.replace(/\\([!-/:-@[-`{-~])/g, "$1"));
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "�";
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** A link address ADF may carry: a checked web address, or an email address, so no other scheme reaches Jira as a link. */
function safeHref(raw: string): string | null {
  const href = unescapeText(raw.trim());
  if (/^mailto:[^\s<>@:/]+@[^\s<>@:/]+$/i.test(href) && href.length <= 320) return href;
  return webAddress(href);
}

/** The end of the bracketed text starting at `open` (`[`), with nested brackets and escapes; -1 without one. */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") index++;
    else if (char === "`") {
      const run = /^`+/.exec(text.slice(index))![0];
      const end = text.indexOf(run, index + run.length);
      if (end !== -1) index = end + run.length - 1;
    } else if (char === "[") depth++;
    else if (char === "]" && --depth === 0) return index;
  }
  return -1;
}

/** A link's `(destination "title")` starting at `open` (`(`): the address and where it ends; null when it isn't one. */
function linkDestination(text: string, open: number): { href: string; end: number } | null {
  if (text[open] !== "(") return null;
  let index = open + 1;
  while (text[index] === " ") index++;
  let href: string;
  if (text[index] === "<") {
    const close = text.indexOf(">", index);
    if (close === -1 || text.slice(index + 1, close).includes("\n")) return null;
    href = text.slice(index + 1, close);
    index = close + 1;
  } else {
    const start = index;
    let depth = 0;
    while (index < text.length && !/\s/.test(text[index]!)) {
      if (text[index] === "\\") index++;
      else if (text[index] === "(") depth++;
      else if (text[index] === ")") {
        if (depth === 0) break;
        depth--;
      }
      index++;
    }
    href = text.slice(start, index);
  }
  while (text[index] === " ") index++;
  const title = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/.exec(text.slice(index));
  if (title !== null) index += title[0].length;
  while (text[index] === " ") index++;
  return text[index] === ")" ? { href, end: index + 1 } : null;
}

const EMPHASIS = [
  { delimiter: "**", mark: "strong" },
  { delimiter: "__", mark: "strong" },
  { delimiter: "*", mark: "em" },
  { delimiter: "_", mark: "em" },
] as const;

function parseInline(text: string, marks: AdfMark[]): AdfInline[] {
  const nodes: AdfInline[] = [];
  let plain = "";
  const flush = () => {
    nodes.push(...textNode(plain, marks));
    plain = "";
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    const rest = text.slice(index);
    if (char === "\\" && index + 1 < text.length && ASCII_PUNCTUATION.test(text[index + 1]!)) {
      plain += text[index + 1];
      index += 2;
      continue;
    }
    if (char === "&") {
      const entity = /^&(?:#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/i.exec(rest);
      if (entity !== null) {
        plain += decodeEntities(entity[0]);
        index += entity[0].length;
        continue;
      }
    }
    if (char === "`") {
      const run = /^`+/.exec(rest)![0];
      const end = text.indexOf(run, index + run.length);
      if (end !== -1 && text[end + run.length] !== "`") {
        flush();
        let code = text.slice(index + run.length, end).replace(/\n/g, " ");
        if (/^ .* $/.test(code) && code.trim() !== "") code = code.slice(1, -1);
        nodes.push(...textNode(code, addMark(marks, { type: "code" })));
        index = end + run.length;
        continue;
      }
      plain += run;
      index += run.length;
      continue;
    }
    if (char === "<") {
      const auto = /^<([a-z][a-z0-9+.-]{1,31}:[^\s<>]*)>/i.exec(rest) ?? /^<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/.exec(rest);
      if (auto !== null) {
        flush();
        const address = auto[1]!;
        const href = safeHref(address.includes(":") ? address : `mailto:${address}`);
        nodes.push(...textNode(address, href === null ? marks : addMark(marks, { type: "link", attrs: { href } })));
        index += auto[0].length;
        continue;
      }
    }
    const image = char === "!" && text[index + 1] === "[";
    if (char === "[" || image) {
      const open = index + (image ? 1 : 0);
      const close = closingBracket(text, open);
      const destination = close === -1 ? null : linkDestination(text, close + 1);
      if (destination !== null) {
        flush();
        const label = text.slice(open + 1, close);
        const href = safeHref(destination.href);
        const linkMarks = href === null ? marks : addMark(marks, { type: "link", attrs: { href } });
        // An image's address is the link: ADF can't show an image from an address.
        const inner = image ? textNode(unescapeText(label) || "Image", linkMarks) : parseInline(label, linkMarks);
        nodes.push(...(inner.length === 0 ? textNode(href ?? unescapeText(destination.href), linkMarks) : inner));
        index = destination.end;
        continue;
      }
    }
    const emphasis = EMPHASIS.find(({ delimiter }) => rest.startsWith(delimiter));
    if (emphasis !== undefined) {
      const { delimiter, mark } = emphasis;
      const after = text[index + delimiter.length];
      const before = index === 0 ? " " : text[index - 1]!;
      // Opens only before text, and `_` only at a word's start, as CommonMark has it.
      const canOpen = after !== undefined && !/\s/.test(after) && (delimiter[0] !== "_" || !/[\p{L}\p{N}]/u.test(before));
      const close = canOpen ? findCloser(text, index + delimiter.length, delimiter) : -1;
      if (close !== -1) {
        flush();
        nodes.push(...parseInline(text.slice(index + delimiter.length, close), addMark(marks, { type: mark })));
        index = close + delimiter.length;
        continue;
      }
      plain += delimiter;
      index += delimiter.length;
      continue;
    }
    plain += char;
    index++;
  }
  flush();
  return nodes;
}

/** Where emphasis opened at `from` with `delimiter` closes on the same text: after text, not inside code; -1 when it doesn't. */
function findCloser(text: string, from: number, delimiter: string): number {
  for (let index = from + 1; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") {
      index++;
      continue;
    }
    if (char === "`") {
      const run = /^`+/.exec(text.slice(index))![0];
      const end = text.indexOf(run, index + run.length);
      if (end !== -1) index = end + run.length - 1;
      continue;
    }
    if (text.startsWith(delimiter, index) && !/\s/.test(text[index - 1]!)) {
      // `*` inside `**` isn't a closer for `*`.
      if (delimiter.length === 1 && text[index + 1] === delimiter) {
        index++;
        continue;
      }
      const next = text[index + delimiter.length];
      if (delimiter[0] === "_" && next !== undefined && /[\p{L}\p{N}]/u.test(next)) continue;
      return index;
    }
  }
  return -1;
}
