// The block structure of Markdown text, as CommonMark reads it, to the
// extent tickets need: the headings at the top level of a template, and
// whether a person's text ends inside a code fence or an HTML block that
// would swallow what Critiqs adds after it. A port of commonmark.js's block parser (its
// containers, code, HTML blocks, headings, and lazy continuation), without
// inline parsing. Lines end only at `\n`, `\r\n`, or `\r`. Internal: not
// exported from the package.

/** A heading at the top level of a document, not inside a quote or list. */
export interface MarkdownHeading {
  level: number;
  /** Its text, as written (Markdown), without the `#`s or underline. */
  text: string;
  /** Its first and last lines, by index: a setext heading's text can span lines before its underline. */
  start: number;
  end: number;
}

/** A code fence: its character, and how many of them, which its closing fence matches in kind and at least in length. */
export interface MarkdownFence {
  char: "`" | "~";
  length: number;
}

export interface MarkdownBlocks {
  /** The document's top-level headings, in order. */
  headings: MarkdownHeading[];
  /**
   * The code fence open at the end of the text at the top level, if any:
   * text added after a blank line would be code. A fence open inside a quote
   * or list ends with it, before such text.
   */
  openFence: MarkdownFence | null;
  /**
   * The line that ends the block open at the end of the text at the top
   * level, when text added after a blank line would otherwise be inside it: a
   * closing code fence, or the end of an HTML comment, `<pre>`, `<script>`,
   * `<style>`, or `<textarea>` block, processing instruction, declaration, or
   * CDATA section. Null when nothing open would swallow it.
   */
  openBlockEnd: string | null;
}

/**
 * What ends each of CommonMark's first five kinds of HTML block, which a
 * blank line doesn't (index 0 unused). The first kind ends with the closing
 * tag of the element it opened (`</script>` for `<script>`): CommonMark
 * would end it at any of the four, but HTML reads a script, style, or
 * textarea as text until its own.
 */
const HTML_ENDS = ["", "", "-->", "?>", ">", "]]>"];

type Kind = "document" | "quote" | "list" | "item" | "paragraph" | "fence" | "indented" | "html" | "heading" | "break";

interface ListData {
  type: "bullet" | "ordered";
  /** The bullet, or an ordered list's `.` or `)`. */
  char: string;
  markerOffset: number;
  padding: number;
}

interface Block {
  kind: Kind;
  parent: Block | null;
  last: Block | null;
  open: boolean;
  start: number;
  /** A paragraph's lines, for a setext heading's text. */
  lines: string[];
  list?: ListData;
  fence?: MarkdownFence & { offset: number };
  htmlType?: number;
  /** The tag a `<script>`, `<pre>`, `<style>`, or `<textarea>` block opened with, lower-case. */
  htmlTag?: string;
}

const CODE_INDENT = 4;
const ATX = /^#{1,6}(?:[ \t]+|$)/;
// `[\s\S]`, not `.`: in a JavaScript pattern `.` stops at U+2028 and U+2029, which aren't line endings in Markdown.
const FENCE_OPEN = /^`{3,}(?![\s\S]*`)|^~{3,}/;
const FENCE_CLOSE = /^(?:`{3,}|~{3,})(?=[ \t]*$)/;
const SETEXT = /^(?:=+|-+)[ \t]*$/;
const BREAK = /^(?:\*[ \t]*){3,}$|^(?:_[ \t]*){3,}$|^(?:-[ \t]*){3,}$/;
const BULLET = /^[*+-]/;
const ORDERED = /^(\d{1,9})([.)])/;
const NON_SPACE = /[^ \t\f\v]/;

const SPACE = "[ \\t\\v\\f]";
const TAG_NAME = "[A-Za-z][A-Za-z0-9-]*";
const ATTRIBUTE = `(?:${SPACE}+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:${SPACE}*=${SPACE}*(?:[^"'=<>\`\\x00-\\x20]+|'[^']*'|"[^"]*"))?)`;
const OPEN_TAG = `<${TAG_NAME}${ATTRIBUTE}*${SPACE}*/?>`;
const CLOSE_TAG = `</${TAG_NAME}${SPACE}*>`;
const BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
/** How each of CommonMark's seven kinds of HTML block starts, by kind (index 0 unused). */
const HTML_OPEN = [
  /$^/,
  /^<(?:script|pre|textarea|style)(?:[ \t]|>|$)/i,
  /^<!--/,
  /^<[?]/,
  /^<![A-Za-z]/,
  /^<!\[CDATA\[/,
  new RegExp(`^</?(?:${BLOCK_TAGS})(?:[ \\t]|/?>|$)`, "i"),
  new RegExp(`^(?:${OPEN_TAG}|${CLOSE_TAG})${SPACE}*$`, "i"),
];
/** How the first five kinds end; the other two end at a blank line. */
const HTML_CLOSE = [/$^/, /<\/(?:script|pre|textarea|style)>/i, /-->/, /\?>/, />/, /\]\]>/];

const canContain = (parent: Kind, child: Kind) => (parent === "list" ? child === "item" : (parent === "document" || parent === "quote" || parent === "item") && child !== "item");
const acceptsLines = (kind: Kind) => kind === "paragraph" || kind === "fence" || kind === "indented" || kind === "html";
const isSpaceOrTab = (character: string | undefined) => character === " " || character === "\t";

class BlockParser {
  readonly document: Block = { kind: "document", parent: null, last: null, open: true, start: 0, lines: [] };
  readonly headings: MarkdownHeading[] = [];
  private tip = this.document;
  private oldTip = this.document;
  private lastMatched = this.document;
  private allClosed = true;
  private line = "";
  private index = 0;
  private offset = 0;
  private column = 0;
  private nextNonspace = 0;
  private nextNonspaceColumn = 0;
  private indent = 0;
  private indented = false;
  private blank = false;

  incorporate(line: string, index: number) {
    let container = this.document;
    this.oldTip = this.tip;
    this.line = line;
    this.index = index;
    this.offset = 0;
    this.column = 0;
    this.blank = false;
    // Each open block, outermost first, takes its part of the line's start, until one doesn't continue.
    let child: Block | null;
    while ((child = container.last) !== null && child.open) {
      container = child;
      this.findNextNonspace();
      const continued = this.continues(container);
      // A closing code fence: the line is used up.
      if (continued === "done") return;
      if (continued === "no") {
        container = container.parent!;
        break;
      }
    }
    this.allClosed = container === this.oldTip;
    this.lastMatched = container;
    // Then new blocks may start, unless the line is code or HTML already.
    let leaf = container.kind !== "paragraph" && acceptsLines(container.kind);
    while (!leaf) {
      this.findNextNonspace();
      const started = this.start(container);
      if (started === "none") {
        this.advanceNextNonspace();
        break;
      }
      container = this.tip;
      leaf = started === "leaf";
    }
    // The rest is text: a lazy continuation of an open paragraph, or a line of the block it's in.
    if (!this.allClosed && !this.blank && this.tip.kind === "paragraph") {
      this.tip.lines.push(this.line.slice(this.offset));
      return;
    }
    this.closeUnmatched();
    if (acceptsLines(container.kind)) {
      container.lines.push(this.line.slice(this.offset));
      const type = container.htmlType ?? 0;
      if (container.kind === "html" && type >= 1 && type <= 5 && HTML_CLOSE[type]!.test(this.line.slice(this.offset))) this.finalize(container);
    } else if (this.offset < line.length && !this.blank) {
      const paragraph = this.addChild("paragraph");
      this.advanceNextNonspace();
      paragraph.lines.push(this.line.slice(this.offset));
    }
  }

  /** Whether an open block continues on this line: `done` when the line closes a code fence. */
  private continues(block: Block): "yes" | "no" | "done" {
    switch (block.kind) {
      case "document":
      case "list":
        return "yes";
      case "quote":
        if (this.indented || this.line[this.nextNonspace] !== ">") return "no";
        this.advanceNextNonspace();
        this.advanceOffset(1, false);
        if (isSpaceOrTab(this.line[this.offset])) this.advanceOffset(1, true);
        return "yes";
      case "item": {
        const { markerOffset, padding } = block.list!;
        if (this.blank) {
          // An item can start with at most one blank line.
          if (block.last === null) return "no";
          this.advanceNextNonspace();
        } else if (this.indent >= markerOffset + padding) this.advanceOffset(markerOffset + padding, true);
        else return "no";
        return "yes";
      }
      case "fence": {
        const fence = block.fence!;
        const closing = this.indent <= 3 && this.line[this.nextNonspace] === fence.char ? FENCE_CLOSE.exec(this.line.slice(this.nextNonspace)) : null;
        if (closing !== null && closing[0].length >= fence.length) {
          this.finalize(block);
          return "done";
        }
        for (let skip = fence.offset; skip > 0 && isSpaceOrTab(this.line[this.offset]); skip--) this.advanceOffset(1, true);
        return "yes";
      }
      case "indented":
        if (this.indent >= CODE_INDENT) this.advanceOffset(CODE_INDENT, true);
        else if (this.blank) this.advanceNextNonspace();
        else return "no";
        return "yes";
      case "html":
        return this.blank && (block.htmlType === 6 || block.htmlType === 7) ? "no" : "yes";
      case "paragraph":
        return this.blank ? "no" : "yes";
      case "heading":
      case "break":
        return "no";
    }
  }

  /** A block starting on this line in the container: a container (`container`), whose content may start more, or a leaf. */
  private start(container: Block): "none" | "container" | "leaf" {
    const rest = this.line.slice(this.nextNonspace);
    let match: RegExpExecArray | null;
    if (!this.indented && rest[0] === ">") {
      this.advanceNextNonspace();
      this.advanceOffset(1, false);
      if (isSpaceOrTab(this.line[this.offset])) this.advanceOffset(1, true);
      this.closeUnmatched();
      this.addChild("quote");
      return "container";
    }
    if (!this.indented && (match = ATX.exec(rest)) !== null) {
      this.advanceNextNonspace();
      this.advanceOffset(match[0].length, false);
      this.closeUnmatched();
      const heading = this.addChild("heading");
      if (heading.parent === this.document) {
        const text = this.line.slice(this.offset).replace(/^[ \t]*#+[ \t]*$/, "").replace(/[ \t]+#+[ \t]*$/, "").trim();
        this.headings.push({ level: match[0].trim().length, text, start: this.index, end: this.index });
      }
      this.advanceOffset(this.line.length - this.offset, false);
      return "leaf";
    }
    if (!this.indented && (match = FENCE_OPEN.exec(rest)) !== null) {
      const length = match[0].length;
      this.closeUnmatched();
      this.addChild("fence").fence = { char: match[0][0] as MarkdownFence["char"], length, offset: this.indent };
      this.advanceNextNonspace();
      this.advanceOffset(length, false);
      return "leaf";
    }
    if (!this.indented && rest[0] === "<") {
      for (let type = 1; type <= 7; type++) {
        // The seventh kind can't interrupt a paragraph, a lazy one included.
        const interrupts = type < 7 || (container.kind !== "paragraph" && !(!this.allClosed && !this.blank && this.tip.kind === "paragraph"));
        if (HTML_OPEN[type]!.test(rest) && interrupts) {
          this.closeUnmatched();
          const block = this.addChild("html");
          block.htmlType = type;
          if (type === 1) block.htmlTag = /^<([A-Za-z]+)/.exec(rest)![1]!.toLowerCase();
          return "leaf";
        }
      }
    }
    if (!this.indented && container.kind === "paragraph" && SETEXT.test(rest) && withoutDefinitions(container.lines.join("\n")) !== "") {
      this.closeUnmatched();
      container.kind = "heading";
      if (container.parent === this.document) {
        this.headings.push({ level: rest.trimStart()[0] === "=" ? 1 : 2, text: withoutDefinitions(container.lines.join("\n")).trim(), start: container.start, end: this.index });
      }
      this.advanceOffset(this.line.length - this.offset, false);
      return "leaf";
    }
    if (!this.indented && BREAK.test(rest)) {
      this.closeUnmatched();
      this.addChild("break");
      this.advanceOffset(this.line.length - this.offset, false);
      return "leaf";
    }
    const list = !this.indented || container.kind === "list" ? this.listMarker(container) : null;
    if (list !== null) {
      this.closeUnmatched();
      const current = this.tip.list;
      if (this.tip.kind !== "list" || current === undefined || current.type !== list.type || current.char !== list.char) this.addChild("list").list = list;
      this.addChild("item").list = list;
      return "container";
    }
    if (this.indented && this.tip.kind !== "paragraph" && !this.blank) {
      this.advanceOffset(CODE_INDENT, true);
      this.closeUnmatched();
      this.addChild("indented");
      return "leaf";
    }
    return "none";
  }

  /** A list item's marker at the next non-space, which it moves past with the spaces after it; null without one. */
  private listMarker(container: Block): ListData | null {
    if (this.indent >= CODE_INDENT) return null;
    const rest = this.line.slice(this.nextNonspace);
    let match = BULLET.exec(rest);
    let type: ListData["type"] = "bullet";
    if (match === null) {
      match = ORDERED.exec(rest);
      // Only a list starting at 1 interrupts a paragraph.
      if (match === null || (container.kind === "paragraph" && Number(match[1]) !== 1)) return null;
      type = "ordered";
    }
    const after = this.line[this.nextNonspace + match[0].length];
    if (!(after === undefined || after === " " || after === "\t")) return null;
    // An empty item doesn't interrupt a paragraph.
    if (container.kind === "paragraph" && !NON_SPACE.test(this.line.slice(this.nextNonspace + match[0].length))) return null;
    const markerOffset = this.indent;
    this.advanceNextNonspace();
    this.advanceOffset(match[0].length, true);
    const [spacesColumn, spacesOffset] = [this.column, this.offset];
    do this.advanceOffset(1, true);
    while (this.column - spacesColumn < 5 && isSpaceOrTab(this.line[this.offset]));
    const spaces = this.column - spacesColumn;
    let padding = match[0].length + spaces;
    // Content indented 5 or more is code inside the item, which then starts 1 space after its marker; so does an empty item.
    if (spaces >= 5 || spaces < 1 || this.line[this.offset] === undefined) {
      padding = match[0].length + 1;
      [this.column, this.offset] = [spacesColumn, spacesOffset];
      if (isSpaceOrTab(this.line[this.offset])) this.advanceOffset(1, true);
    }
    return { type, char: type === "bullet" ? match[0][0]! : match[2]!, markerOffset, padding };
  }

  private findNextNonspace() {
    let [index, column] = [this.offset, this.column];
    let character: string | undefined;
    while ((character = this.line[index]) === " " || character === "\t") {
      column += character === " " ? 1 : 4 - (column % 4);
      index++;
    }
    this.blank = character === undefined;
    this.nextNonspace = index;
    this.nextNonspaceColumn = column;
    this.indent = column - this.column;
    this.indented = this.indent >= CODE_INDENT;
  }

  private advanceNextNonspace() {
    this.offset = this.nextNonspace;
    this.column = this.nextNonspaceColumn;
  }

  /** Moves past `count` characters, or columns, where a tab counts for the columns to its next stop. */
  private advanceOffset(count: number, columns: boolean) {
    let character: string | undefined;
    while (count > 0 && (character = this.line[this.offset]) !== undefined) {
      if (character === "\t") {
        const toTab = 4 - (this.column % 4);
        if (columns) {
          const partial = toTab > count;
          const advance = partial ? count : toTab;
          this.column += advance;
          if (!partial) this.offset++;
          count -= advance;
        } else {
          this.column += toTab;
          this.offset++;
          count--;
        }
      } else {
        this.offset++;
        this.column++;
        count--;
      }
    }
  }

  private addChild(kind: Kind): Block {
    while (!canContain(this.tip.kind, kind)) this.finalize(this.tip);
    const block: Block = { kind, parent: this.tip, last: null, open: true, start: this.index, lines: [] };
    this.tip.last = block;
    this.tip = block;
    return block;
  }

  private finalize(block: Block) {
    block.open = false;
    this.tip = block.parent!;
  }

  private closeUnmatched() {
    if (this.allClosed) return;
    while (this.oldTip !== this.lastMatched) {
      const parent = this.oldTip.parent!;
      this.finalize(this.oldTip);
      this.oldTip = parent;
    }
    this.allClosed = true;
  }
}

/**
 * One link reference definition at the start of a paragraph's text, such as
 * `[label]: /url "title"`, on one line or with its address or title on the
 * next. A paragraph's leading definitions aren't text, so a paragraph of
 * only definitions can't become a setext heading.
 */
const DEFINITION = /^ {0,3}\[(?=[^\]]*\S)(?:[^\]\\]|\\.){1,999}\]:[ \t]*\n?[ \t]*(?:<[^<>\n]*>|[^\s<][^\s]*)(?:(?:[ \t]+\n?[ \t]*|[ \t]*\n[ \t]*)(?:"[^"]*"|'[^']*'|\([^()]*\)))?[ \t]*(?:\n|$)/;

/** A paragraph's text without its leading link reference definitions. */
function withoutDefinitions(text: string): string {
  let rest = text;
  for (let match = DEFINITION.exec(rest); match !== null && match[0] !== ""; match = DEFINITION.exec(rest)) rest = rest.slice(match[0].length);
  return rest;
}

/** Markdown text's top-level headings, and the block it leaves open at the top level, if any. */
export function markdownBlocks(text: string): MarkdownBlocks {
  const lines = text.split(/\r\n|\r|\n/);
  // A final line ending ends the last line; it doesn't start another.
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const parser = new BlockParser();
  for (const [index, line] of lines.entries()) parser.incorporate(line, index);
  const last = parser.document.last;
  const openFence = last !== null && last.open && last.kind === "fence" ? { char: last.fence!.char, length: last.fence!.length } : null;
  const htmlType = last !== null && last.open && last.kind === "html" ? (last.htmlType ?? 0) : 0;
  const htmlEnd = htmlType === 1 ? `</${last!.htmlTag ?? "pre"}>` : HTML_ENDS[htmlType]!;
  const openBlockEnd = openFence !== null ? openFence.char.repeat(openFence.length) : htmlType >= 1 && htmlType <= 5 ? htmlEnd : null;
  return { headings: parser.headings, openFence, openBlockEnd };
}
