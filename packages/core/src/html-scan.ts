// Reads a page's markup the way a browser's tokenizer splits it, for pages
// fetched from addresses anyone signed in can type. One pass: every search
// starts where the last one ended and stops at its first match, so the time
// grows with the page's length, whatever it holds.

/** An opening tag a browser would build an element from. */
export interface HtmlElement {
  /** Lowercase. */
  name: string;
  /** Lowercase names and decoded values. A repeated attribute keeps its first value, as browsers do. */
  attributes: ReadonlyMap<string, string>;
}

export interface ScannedHtml {
  /** Opening tags in order. A tag the page never closes isn't one. */
  elements: readonly HtmlElement[];
  /** The text of each inline script. */
  scripts: readonly string[];
  /** Whether the page has a doctype. */
  doctype: boolean;
}

/** Elements whose content is text up to their end tag, never markup. */
const RAW_TEXT = ["script", "style", "textarea", "title", "iframe", "noembed", "noframes", "xmp"];
const RAW_TEXT_END = new Map(RAW_TEXT.map((name) => [name, new RegExp(`</${name}(?=[\\t\\n\\f\\r />]|$)`, "gi")]));
const COMMENT_END = /--!?>/g;
/** SVG and MathML: inside them, `<![CDATA[` starts text that runs to `]]>`. */
const FOREIGN = new Set(["svg", "math"]);
/** HTML elements that close any SVG or MathML they start in (browsers add `font` with `color`, `face`, or `size`, not read here). */
const LEAVES_FOREIGN = new Set(
  "b big blockquote body br center code dd div dl dt em embed h1 h2 h3 h4 h5 h6 head hr i img li listing menu meta nobr ol p pre ruby s small span strong strike sub sup table tt u ul var".split(" "),
);

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
}

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

const NAMED_REFERENCES: Readonly<Record<string, string>> = { quot: '"', amp: "&", apos: "'", lt: "<", gt: ">", nbsp: " " };

/** Decodes character references: the common named ones, and every numeric one. */
function decode(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));?/gi, (reference, decimal?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED_REFERENCES[name.toLowerCase()] ?? reference;
    const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex!, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "�";
  });
}

/** Index of the first match of a global `pattern` at or after `from`, and where it ends; null when there is none. */
function find(pattern: RegExp, text: string, from: number): { start: number; end: number } | null {
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  return match === null ? null : { start: match.index, end: match.index + match[0].length };
}

export function scanHtml(html: string): ScannedHtml {
  const elements: HtmlElement[] = [];
  const scripts: string[] = [];
  let doctype = false;
  /** How many SVG or MathML elements are open. */
  let foreign = 0;
  const length = html.length;

  /** Reads a tag's attributes from `from`; returns them, the index after its `>`, and whether it ends `/>`, or null when the page ends first. */
  const readAttributes = (from: number): { attributes: Map<string, string>; end: number; selfClosing: boolean } | null => {
    const attributes = new Map<string, string>();
    let i = from;
    for (;;) {
      const skipped = i;
      while (i < length && (isSpace(html.charCodeAt(i)) || html[i] === "/")) i++;
      if (i >= length) return null;
      if (html[i] === ">") return { attributes, end: i + 1, selfClosing: i > skipped && html[i - 1] === "/" };
      // A name's first character may be `=`; after that `=` starts the value.
      const nameStart = i++;
      while (i < length && !isSpace(html.charCodeAt(i)) && html[i] !== "/" && html[i] !== ">" && html[i] !== "=") i++;
      const name = html.slice(nameStart, i).toLowerCase();
      let j = i;
      while (j < length && isSpace(html.charCodeAt(j))) j++;
      let value = "";
      if (html[j] === "=") {
        j++;
        while (j < length && isSpace(html.charCodeAt(j))) j++;
        const quote = html[j];
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, j + 1);
          if (close === -1) return null;
          value = html.slice(j + 1, close);
          i = close + 1;
        } else {
          const valueStart = j;
          while (j < length && !isSpace(html.charCodeAt(j)) && html[j] !== ">") j++;
          value = html.slice(valueStart, j);
          i = j;
        }
      }
      if (!attributes.has(name)) attributes.set(name, decode(value));
    }
  };

  let i = 0;
  while (i < length) {
    const open = html.indexOf("<", i);
    if (open === -1) break;
    i = open;
    const next = html.charCodeAt(i + 1);
    if (html.startsWith("<!--", i)) {
      // `<!-->` and `<!--->` close at once, as in browsers; any other comment, `<!--!>` included, runs to `-->` or `--!>`.
      if (html[i + 4] === ">") i += 5;
      else if (html.startsWith("->", i + 4)) i += 6;
      else i = find(COMMENT_END, html, i + 4)?.end ?? length;
    } else if (foreign > 0 && html.startsWith("<![CDATA[", i)) {
      const close = html.indexOf("]]>", i + 9);
      i = close === -1 ? length : close + 3;
    } else if (next === 33 /* ! */ || next === 63 /* ? */) {
      // A doctype, CDATA outside SVG and MathML, or a processing instruction: skipped to its `>`.
      if (html.slice(i + 2, i + 9).toLowerCase() === "doctype") doctype = true;
      const close = html.indexOf(">", i);
      i = close === -1 ? length : close + 1;
    } else if (next === 47 /* / */ && isLetter(html.charCodeAt(i + 2))) {
      let j = i + 2;
      while (j < length && !isSpace(html.charCodeAt(j)) && html[j] !== "/" && html[j] !== ">") j++;
      if (foreign > 0 && FOREIGN.has(html.slice(i + 2, j).toLowerCase())) foreign--;
      // An end tag's attributes are read so that a quoted `>` doesn't end it, then dropped.
      i = readAttributes(j)?.end ?? length;
    } else if (next === 47) {
      const close = html.indexOf(">", i);
      i = close === -1 ? length : close + 1;
    } else if (isLetter(next)) {
      let j = i + 1;
      while (j < length && !isSpace(html.charCodeAt(j)) && html[j] !== "/" && html[j] !== ">") j++;
      const name = html.slice(i + 1, j).toLowerCase();
      const tag = readAttributes(j);
      if (tag === null) break;
      elements.push({ name, attributes: tag.attributes });
      i = tag.end;
      if (FOREIGN.has(name) && !tag.selfClosing) foreign++;
      else if (LEAVES_FOREIGN.has(name)) foreign = 0;
      // Everything after `<plaintext>` is text.
      if (name === "plaintext") break;
      const rawEnd = RAW_TEXT_END.get(name);
      if (rawEnd !== undefined) {
        const end = find(rawEnd, html, i);
        if (name === "script") scripts.push(html.slice(i, end?.start ?? length));
        i = end?.start ?? length;
      }
    } else {
      i++;
    }
  }
  return { elements, scripts, doctype };
}
