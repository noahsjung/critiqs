import type { LocateResult, Scope, Target, TargetClues } from "./types.ts";

/** Critiqs-specific data attributes. They never replace the app's own HTML IDs. */
export const PURPOSE_ATTRIBUTE = "data-critiqs-id";
export const RECORD_ATTRIBUTE = "data-critiqs-record";

const MAX_LABEL_LENGTH = 80;

/**
 * Describes the element a reviewer selected. The target becomes the nearest
 * element with a purpose ID, so a click inside a labelled button targets the
 * button. Returns that element so the interface can highlight what will be stored.
 */
export function describeTarget(
  selected: Element,
  root: Element,
): { target: Target; element: Element } {
  const element = selected.closest(`[${PURPOSE_ATTRIBUTE}]`) ?? selected;
  return {
    element,
    target: {
      purposeId: element.getAttribute(PURPOSE_ATTRIBUTE),
      recordKey: recordKeyOf(element),
      clues: cluesOf(element, root),
    },
  };
}

/**
 * Locates a target in the live page. Uncertain matches are reported rather
 * than resolved to a nearby element, so callers can show saved context instead.
 * `isCandidate` can exclude elements, such as those the app keeps but hides.
 */
export function locateTarget(
  target: Target,
  scope: Scope,
  root: Element,
  isCandidate: (element: Element) => boolean = () => true,
): LocateResult {
  if (target.purposeId === null) return locateByClues(target, scope, root, isCandidate);

  const candidates = Array.from(root.querySelectorAll(`[${PURPOSE_ATTRIBUTE}]`)).filter(
    (element) => element.getAttribute(PURPOSE_ATTRIBUTE) === target.purposeId && isCandidate(element),
  );
  if (candidates.length === 0) return { status: "not-found" };
  if (scope === "shared") return { status: "found", elements: candidates };

  const sameRecord = candidates.filter((element) => recordKeyOf(element) === target.recordKey);
  if (sameRecord.length === 0) return { status: "wrong-record" };
  if (sameRecord.length > 1) return { status: "ambiguous", candidates: sameRecord.length };
  return { status: "found", elements: sameRecord };
}

function locateByClues(
  target: Target,
  scope: Scope,
  root: Element,
  isCandidate: (element: Element) => boolean,
): LocateResult {
  const atPath = resolvePath(target.clues.path, root);
  const element: Element | null =
    atPath !== null && isCandidate(atPath) && cluesAgree(target.clues, cluesOf(atPath, root)) ? atPath : null;
  if (element === null) return { status: "not-found" };
  if (scope === "record" && recordKeyOf(element) !== target.recordKey) {
    return { status: "wrong-record" };
  }
  return { status: "found", elements: [element] };
}

function cluesAgree(saved: TargetClues, live: TargetClues): boolean {
  return saved.tagName === live.tagName && saved.role === live.role && saved.label === live.label;
}

/** The record key of the record containing an element, if any. */
export function recordKeyOf(element: Element): string | null {
  return element.closest(`[${RECORD_ATTRIBUTE}]`)?.getAttribute(RECORD_ATTRIBUTE) ?? null;
}

function cluesOf(element: Element, root: Element): TargetClues {
  return {
    tagName: element.tagName.toLowerCase(),
    role: element.getAttribute("role"),
    label: labelOf(element),
    path: pathOf(element, root),
  };
}

function labelOf(element: Element): string | null {
  const text = element.getAttribute("aria-label") ?? element.textContent ?? "";
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized === "" ? null : normalized.slice(0, MAX_LABEL_LENGTH);
}

/** Path such as `main:1/section:2/button:1`: tag names with 1-based positions among same-tag siblings. */
function pathOf(element: Element, root: Element): string {
  const segments: string[] = [];
  let current: Element | null = element;
  while (current !== null && current !== root) {
    const tagName = current.tagName;
    const sameTag = current.parentElement
      ? Array.from(current.parentElement.children).filter((sibling) => sibling.tagName === tagName)
      : [current];
    segments.unshift(`${tagName.toLowerCase()}:${sameTag.indexOf(current) + 1}`);
    current = current.parentElement;
  }
  return segments.join("/");
}

function resolvePath(path: string, root: Element): Element | null {
  if (path === "") return root;
  let current: Element | null = root;
  for (const segment of path.split("/")) {
    const [tagName, position] = segment.split(":");
    if (current === null || tagName === undefined || position === undefined) return null;
    const sameTag: Element[] = Array.from(current.children).filter(
      (child) => child.tagName.toLowerCase() === tagName,
    );
    current = sameTag[Number(position) - 1] ?? null;
  }
  return current;
}
