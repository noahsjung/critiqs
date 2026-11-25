import { parseHashtags } from "@critiqs/core";

/**
 * The editable text box behind comment inputs. Its content is plain text: the
 * box shows each hashtag as a padded pill element around the same characters,
 * so pills take real space in the layout while the text, and what is posted,
 * stays exactly what the reviewer typed.
 */

/** A run of text: plain, or a hashtag shown as a pill. */
export interface TextRun {
  text: string;
  tag: boolean;
}

export function textRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  let end = 0;
  for (const tag of parseHashtags(text)) {
    if (tag.start > end) runs.push({ text: text.slice(end, tag.start), tag: false });
    runs.push({ text: text.slice(tag.start, tag.end), tag: true });
    end = tag.end;
  }
  if (end < text.length) runs.push({ text: text.slice(end), tag: false });
  return runs;
}

export const PILL_CLASS = "tag-pill";
const BLOCK = /^(DIV|P|LI|PRE|BLOCKQUOTE|H[1-6])$/;

/**
 * Reads the box's text, and where each of its nodes starts and ends in it.
 * Besides the box's own content, this reads what a browser may have put there
 * while editing: line breaks, blocks, or other elements.
 */
function read(root: Node): { text: string; before: Map<Node, number>; after: Map<Node, number> } {
  let text = "";
  const before = new Map<Node, number>();
  const after = new Map<Node, number>();
  let lastBreak: Node | null = null;
  const visit = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE && BLOCK.test(child.nodeName) && text !== "" && !text.endsWith("\n")) text += "\n";
      before.set(child, text.length);
      lastBreak = null;
      if (child.nodeType === Node.TEXT_NODE) text += (child as Text).data;
      else if (child.nodeName === "BR") {
        text += "\n";
        lastBreak = child;
      } else if (child.nodeType === Node.ELEMENT_NODE) visit(child);
      after.set(child, text.length);
    }
  };
  visit(root);
  after.set(root, text.length);
  // A line break that ends the box only holds its last line open.
  if (lastBreak !== null) text = text.slice(0, -1);
  return { text, before, after };
}

export function readText(root: Node): string {
  return read(root).text;
}

/** Whether the box shows exactly this text, with pills exactly around its hashtags. */
export function showsText(root: Element, text: string): boolean {
  const nodes = Array.from(root.childNodes);
  const runs = textRuns(text);
  const trailing = text.endsWith("\n") ? 1 : 0;
  if (nodes.length !== runs.length + trailing) return false;
  if (trailing === 1 && nodes.at(-1)!.nodeName !== "BR") return false;
  return runs.every((run, index) => {
    const node = nodes[index]!;
    if (!run.tag) return node.nodeType === Node.TEXT_NODE && (node as Text).data === run.text;
    return (
      node instanceof HTMLElement &&
      node.className === PILL_CLASS &&
      node.childNodes.length === 1 &&
      node.firstChild!.nodeType === Node.TEXT_NODE &&
      (node.firstChild as Text).data === run.text
    );
  });
}

/** Replaces the box's content with the text, its hashtags as pills. */
export function showText(root: Element, text: string) {
  const document = root.ownerDocument;
  root.replaceChildren(
    ...textRuns(text).map((run) => {
      if (!run.tag) return document.createTextNode(run.text);
      const pill = document.createElement("span");
      pill.className = PILL_CLASS;
      pill.textContent = run.text;
      return pill;
    }),
  );
  // Without it, a final line break would show no empty line to type on.
  if (text.endsWith("\n")) root.append(document.createElement("br"));
}

/** The text offset of a position in the box. */
function offsetOf(root: Node, node: Node, offset: number, map = read(root)): number {
  let position: number | undefined;
  if (node.nodeType === Node.TEXT_NODE) position = (map.before.get(node) ?? 0) + offset;
  else {
    const child = node.childNodes[offset];
    position = child === undefined ? map.after.get(node) : map.before.get(child);
  }
  return Math.min(position ?? map.text.length, map.text.length);
}

/** A position in the box for a text offset, outside a pill when it is at the pill's edge. */
function positionAt(root: Element, offset: number): [Node, number] {
  let start = 0;
  let afterPill: [Node, number] | null = null;
  const nodes = Array.from(root.childNodes);
  for (const [index, node] of nodes.entries()) {
    const text = node.nodeType === Node.TEXT_NODE ? (node as Text) : node.firstChild?.nodeType === Node.TEXT_NODE ? (node.firstChild as Text) : null;
    if (text === null) continue;
    const end = start + text.data.length;
    if (offset >= start && offset <= end) {
      if (text === node || (offset > start && offset < end)) return [text, offset - start];
      // At a pill's edge: before or after it, so typing there starts no tag.
      if (offset === start) return [root, index];
      afterPill = [root, index + 1];
    }
    start = end;
  }
  return afterPill ?? [root, 0];
}

/** The selection in a document or shadow root. */
function selectionOf(root: Node): Selection | null {
  const scope = root.getRootNode() as Document | (ShadowRoot & { getSelection?: () => Selection | null });
  return (typeof scope.getSelection === "function" ? scope.getSelection() : null) ?? document.getSelection();
}

type ComposedSelection = Selection & { getComposedRanges?: (...args: unknown[]) => StaticRange[] };

/** The selected range in the box as text offsets, or null when the selection is elsewhere. */
export function selectionIn(root: Element): [number, number] | null {
  const selection = selectionOf(root) as ComposedSelection | null;
  if (selection === null || selection.rangeCount === 0) return null;
  let range: AbstractRange = selection.getRangeAt(0);
  const scope = root.getRootNode();
  // Browsers that keep shadow roots out of the selection's range give them back on request.
  if (!root.contains(range.startContainer) && scope instanceof ShadowRoot && typeof selection.getComposedRanges === "function") {
    let composed: StaticRange[] = [];
    try {
      composed = selection.getComposedRanges({ shadowRoots: [scope] });
    } catch {
      composed = selection.getComposedRanges(scope);
    }
    if (composed[0] !== undefined) range = composed[0];
  }
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const map = read(root);
  return [offsetOf(root, range.startContainer, range.startOffset, map), offsetOf(root, range.endContainer, range.endOffset, map)];
}

/** Selects text offsets in the box. */
export function selectIn(root: Element, [start, end]: [number, number]) {
  const selection = selectionOf(root);
  if (selection === null) return;
  const [startNode, startOffset] = positionAt(root, start);
  const [endNode, endOffset] = start === end ? [startNode, startOffset] : positionAt(root, end);
  selection.setBaseAndExtent(startNode, startOffset, endNode, endOffset);
  // Script-driven edits don't get the browser's normal caret scrolling.
  // Measure the focus edge, including the BR holding a final blank line open,
  // and scroll only this editor rather than moving the prototype around it.
  const range = root.ownerDocument.createRange();
  range.setStart(endNode, endOffset);
  range.collapse(true);
  let caret = range.getBoundingClientRect();
  if (caret.height === 0) {
    const next = endNode === root ? root.childNodes[endOffset] : endNode.nextSibling;
    if (next instanceof Element && next.tagName === "BR") caret = next.getBoundingClientRect();
    else if (endNode.nodeType === Node.ELEMENT_NODE) {
      // Keep the real caret outside the pill, but measure the text immediately
      // next to it. The first/last text endpoint also picks the right line of
      // a wrapped pill; its whole bounding box would include other lines.
      const following = endNode.childNodes[endOffset];
      const adjacent = following ?? endNode.childNodes[endOffset - 1];
      if (adjacent !== undefined) {
        const walker = root.ownerDocument.createTreeWalker(adjacent, NodeFilter.SHOW_TEXT);
        let text: Node | null = adjacent.nodeType === Node.TEXT_NODE ? adjacent : walker.nextNode();
        if (following === undefined && text !== null && text !== adjacent) {
          for (let next = walker.nextNode(); next !== null; next = walker.nextNode()) text = next;
        }
        if (text !== null) {
          range.setStart(text, following === undefined ? text.textContent!.length : 0);
          range.collapse(true);
          caret = range.getBoundingClientRect();
        }
      }
    }
  }
  if (caret.height === 0) return;
  const box = root.getBoundingClientRect();
  const style = getComputedStyle(root);
  const top = box.top + root.clientTop + (parseFloat(style.paddingTop) || 0);
  const bottom = box.top + root.clientTop + root.clientHeight - (parseFloat(style.paddingBottom) || 0);
  if (caret.bottom > bottom) root.scrollTop += caret.bottom - bottom;
  else if (caret.top < top) root.scrollTop -= top - caret.top;
}

/** Text with a selection, as kept for undo. */
export interface Snapshot {
  text: string;
  selection: [number, number];
}

/** How long consecutive typing or deleting counts as one step to undo. */
const MERGE_MS = 1000;
const MAX_STEPS = 200;

/**
 * Undo and redo for the box. Changing its content from script clears a
 * browser's own undo, so the box keeps its own: consecutive typing or
 * deleting is one step, and a paste, line break, chosen suggestion or caret
 * move starts a new one.
 */
export class EditHistory {
  private steps: Snapshot[];
  private index = 0;
  private merging: string | null = null;
  private at = 0;

  constructor(initial: Snapshot) {
    this.steps = [initial];
  }

  reset(initial: Snapshot) {
    this.steps = [initial];
    this.index = 0;
    this.merging = null;
  }

  /** Records a change; `kind` names changes that merge with the one before, if any. */
  record(next: Snapshot, kind: string | null, now = Date.now()) {
    const current = this.steps[this.index]!;
    if (next.text === current.text) {
      current.selection = next.selection;
      return;
    }
    if (kind !== null && kind === this.merging && now - this.at < MERGE_MS && this.index > 0) {
      this.steps[this.index] = next;
    } else {
      this.steps = [...this.steps.slice(Math.max(0, this.index + 2 - MAX_STEPS), this.index + 1), next];
      this.index = this.steps.length - 1;
    }
    this.merging = kind;
    this.at = now;
  }

  /** Notes where the caret moved, which is where an undo puts it back. */
  moved(selection: [number, number]) {
    const current = this.steps[this.index]!;
    if (current.selection[0] === selection[0] && current.selection[1] === selection[1]) return;
    current.selection = selection;
    this.merging = null;
  }

  undo(): Snapshot | null {
    if (this.index === 0) return null;
    this.merging = null;
    return this.steps[--this.index]!;
  }

  redo(): Snapshot | null {
    if (this.index === this.steps.length - 1) return null;
    this.merging = null;
    return this.steps[++this.index]!;
  }
}
