export interface CopyElement {
  /** The tag name, lowercase. */
  tag: string;
  /** The start tag as the copy has it, without `data-critiqs-node`; long attribute values are shortened. */
  markup: string;
  /** Its text content, whitespace collapsed and shortened. */
  text: string;
  /** The nearest `data-critiqs-id` on the element or around it. */
  purposeId: string | null;
}

export declare function findElements(
  html: string,
  wanted: Iterable<number>,
  options?: { textChars?: number },
): { elements: Map<number, CopyElement>; highest: number };
