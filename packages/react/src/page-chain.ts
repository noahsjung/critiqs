export interface Page {
  isDone: boolean;
  continueCursor: string;
}

/** Plan live page subscriptions from verified boundaries; discard stale tails. */
export function pageChain<T extends Page>(cursors: (string | null)[], results: Record<string, T | Error | undefined>) {
  const pages: T[] = [];
  const next: (string | null)[] = [null];
  let failure: Error | null = null;
  let complete = false;
  for (let i = 0; i < cursors.length; i++) {
    const result = results[String(i)];
    if (result instanceof Error) { failure = result; break; }
    if (result === undefined) break;
    pages.push(result);
    if (result.isDone) { complete = true; break; }
    if (result.continueCursor === "" || next.includes(result.continueCursor)) {
      failure = new Error("Pagination did not advance. Try again.");
      break;
    }
    next.push(result.continueCursor);
    // Inserts/deletions can change a live page's end. Do not combine the new
    // page with a downstream page requested from its former boundary.
    if (cursors[i + 1] !== result.continueCursor) break;
  }
  return { pages, next, failure, complete };
}
