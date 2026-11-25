import { act } from "react";
import { readText } from "../src/ui/tag-text.ts";

/** A comment, reply or edit box by its label, inside a container or shadow root. */
export const commentField = (root: ParentNode, label?: string) =>
  root.querySelector<HTMLElement>(label === undefined ? ".tag-field" : `.tag-field[aria-label="${label}"]`);

/** The text in a comment box. */
export const fieldText = (field: Element) => readText(field);

/** Puts the caret in a comment box at a text offset, as clicking there would. */
export function placeCaret(field: HTMLElement, offset: number) {
  let remaining = offset;
  const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node !== null; node = walker.nextNode() as Text | null) {
    if (remaining <= node.data.length) return document.getSelection()!.setBaseAndExtent(node, remaining, node, remaining);
    remaining -= node.data.length;
  }
  document.getSelection()!.setBaseAndExtent(field, field.childNodes.length, field, field.childNodes.length);
}

/**
 * Edits a comment box as a browser would: the box's content becomes the text,
 * with the caret at its end unless given, and an input event follows.
 */
export async function typeInto(field: HTMLElement, text: string, caret = text.length) {
  await act(async () => {
    field.focus();
    field.textContent = text;
    placeCaret(field, caret);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
}
