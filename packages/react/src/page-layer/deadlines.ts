/**
 * How long the panel waits for the page layer while saving a comment. A frame
 * that loads a page without Critiqs never answers, and the comment must not
 * stay "Saving…" forever. A capture may copy a large page.
 */
export const PAGE_ANSWER_MS = 10_000;
export const PAGE_CAPTURE_MS = 30_000;
