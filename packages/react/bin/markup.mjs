/**
 * Finds a page copy's elements by their `data-critiqs-node` number without a
 * DOM, so the command line stays dependency-free. Page copies are a browser's
 * own serialization (`outerHTML`): every attribute value is double-quoted with
 * `"` written as `&quot;`, and every element that isn't void has an end tag.
 * Comments and the raw text of elements such as style are skipped, so text
 * that only looks like markup is never matched.
 */

const VOID = new Set(["area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr"]);
/** Elements whose content is text up to their end tag, never markup. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"]);
/** Raw-text elements whose content a reader sees. */
const SHOWN_TEXT = new Set(["textarea", "title"]);

const START_TAG = /<([a-zA-Z][^\s/>]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const END_TAG = /<\/([a-zA-Z][^\s/>]*)[^>]*>/y;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A start tag as the code would have it: without Critiqs's element number, long values shortened. */
function shownTag(tag, attributes, selfClosing) {
  const parts = [`<${tag}`];
  for (const [name, value] of attributes) {
    if (name === "data-critiqs-node") continue;
    parts.push(value === null ? name : `${name}="${clip(value, 80).replace(/"/g, "&quot;")}"`);
  }
  return `${parts.join(" ")}${selfClosing ? " /" : ""}>`;
}

/**
 * The elements numbered `wanted` in a page copy's HTML, each with its start
 * tag (`markup`, without `data-critiqs-node`), its text (`textContent`,
 * whitespace collapsed, up to `textChars`), and the nearest `data-critiqs-id`
 * on it or around it. `highest` is the copy's highest element number; a change
 * may name a higher one, which an earlier change in its list added.
 */
export function findElements(html, wanted, { textChars = 120 } = {}) {
  const looking = new Set(wanted);
  const found = new Map();
  /** Elements open at this point, innermost last. */
  const stack = [];
  /** Found elements still collecting their text. */
  const collecting = [];
  let highest = 0;
  let index = 0;

  const addText = (raw) => {
    for (const entry of collecting) if (entry.text.length <= textChars) entry.text += decode(raw);
  };
  const finish = (entry) => {
    const text = entry.text.replace(/\s+/g, " ").trim();
    found.set(entry.node, { tag: entry.tag, markup: entry.markup, text: clip(text, textChars), purposeId: entry.purposeId });
    collecting.splice(collecting.indexOf(entry), 1);
  };
  const close = (tag) => {
    const at = stack.findLastIndex((open) => open.tag === tag);
    if (at === -1) return;
    for (const open of stack.splice(at)) if (open.entry !== null && collecting.includes(open.entry)) finish(open.entry);
  };

  while (index < html.length) {
    const lt = html.indexOf("<", index);
    const textEnd = lt === -1 ? html.length : lt;
    if (collecting.length > 0 && textEnd > index) addText(html.slice(index, textEnd));
    if (lt === -1) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt);
      index = end === -1 ? html.length : end + 1;
      continue;
    }
    END_TAG.lastIndex = lt;
    const end = html[lt + 1] === "/" ? END_TAG.exec(html) : null;
    if (end !== null) {
      close(end[1].toLowerCase());
      index = END_TAG.lastIndex;
      continue;
    }
    START_TAG.lastIndex = lt;
    const start = START_TAG.exec(html);
    if (start === null) {
      if (collecting.length > 0) addText("<");
      index = lt + 1;
      continue;
    }
    index = START_TAG.lastIndex;
    const tag = start[1].toLowerCase();
    const selfClosing = start[3] === "/";
    const attributes = [];
    for (const match of start[2].matchAll(ATTRIBUTE)) {
      const value = match[2] ?? match[3] ?? match[4];
      attributes.push([match[1].toLowerCase(), value === undefined ? null : decode(value)]);
    }
    const attribute = (name) => attributes.find(([key]) => key === name)?.[1] ?? null;
    const node = Number(attribute("data-critiqs-node"));
    if (Number.isSafeInteger(node) && node > 0) highest = Math.max(highest, node);
    const purposeId = attribute("data-critiqs-id") ?? stack.at(-1)?.purposeId ?? null;
    let entry = null;
    if (looking.has(node) && !found.has(node)) {
      looking.delete(node);
      entry = { node, tag, markup: shownTag(tag, attributes, selfClosing), text: "", purposeId };
      collecting.push(entry);
    }
    if (VOID.has(tag) || selfClosing) {
      if (entry !== null) finish(entry);
      continue;
    }
    stack.push({ tag, purposeId, entry });
    if (RAW_TEXT.has(tag)) {
      const closing = new RegExp(`</${tag}[\\s/>]`, "ig");
      closing.lastIndex = index;
      const after = closing.exec(html);
      const contentEnd = after === null ? html.length : after.index;
      if (SHOWN_TEXT.has(tag) && collecting.length > 0) addText(html.slice(index, contentEnd));
      index = contentEnd;
    }
  }
  for (const entry of [...collecting]) finish(entry);
  return { elements: found, highest };
}
