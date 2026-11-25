import type { PageDescription } from "@critiqs/core";
import { describeError, type MockupReply, type MockupTransport } from "../transport.ts";

/** Requests in one Critiqs AI turn: the first, then continuations further down the page. */
export const MAX_ROUNDS = 5;

/** What the thread shows while Critiqs AI works, and when it couldn't. */
export type TurnStatus =
  /**
   * `round` is 0 for the first request and counts continuations further down
   * the page after it. `step` is what the turn is doing now: reading the copy
   * to describe it, or waiting while Critiqs AI edits it. `since` is when the
   * turn started, in milliseconds since the epoch. `snapshotIds` are the
   * copies this request changes; a continuation can leave some out.
   */
  | { status: "working"; round: number; step: "reading" | "editing"; since: number; snapshotIds: readonly string[] }
  /** `setup-ai`: the project's AI usage rule needs the reviewer's own AI, which they haven't set up. */
  | { status: "failed"; message: string; kind: "moved" | "unavailable" | "setup-ai" | "other" };

/**
 * Describes one copy for Critiqs AI as it is at the latest version. `top` is
 * where, in page coordinates, to focus; null means where the copy is shown
 * (its scroll position). `round` is 0 for the first request.
 */
export type DescribeCopy = (args: { snapshotId: string; top: number | null; round: number }) => Promise<PageDescription>;

/**
 * Asks Critiqs AI to answer a mockup thread's latest message, changing the
 * given copies. While it reports that its request reaches past what it was
 * shown, asks again with the rest of each copy, from where the previous
 * description stopped, up to `MAX_ROUNDS` requests in all.
 */
export async function runAiTurn(args: {
  threadId: string;
  snapshotIds: readonly string[];
  describe: DescribeCopy;
  reply: MockupTransport["mockupReply"];
  /** The model the reviewer chose; without it, the connection's default. */
  model?: string;
  onProgress: (status: TurnStatus) => void;
}): Promise<{ rounds: number; replies: MockupReply[] }> {
  let tops: [string, number | null][] = args.snapshotIds.map((snapshotId) => [snapshotId, null]);
  const replies: MockupReply[] = [];
  const since = Date.now();
  for (let round = 0; round < MAX_ROUNDS && tops.length > 0; round++) {
    const snapshotIds = tops.map(([snapshotId]) => snapshotId);
    args.onProgress({ status: "working", round, step: "reading", since, snapshotIds });
    const described: [string, PageDescription][] = [];
    // One at a time: each may lay out a copy in its own frame.
    for (const [snapshotId, top] of tops) described.push([snapshotId, await args.describe({ snapshotId, top, round })]);
    args.onProgress({ status: "working", round, step: "editing", since, snapshotIds });
    const result = await args.reply({
      threadId: args.threadId,
      snapshots: described.map(([snapshotId, description]) => ({ snapshotId, description: description.text, complete: description.complete })),
      continuation: round > 0,
      ...(args.model === undefined ? {} : { model: args.model }),
    });
    replies.push(result);
    if (!result.remaining) break;
    // Copies described to their end have nothing more to show.
    tops = described.flatMap(([snapshotId, description]) => (description.nextTop === null ? [] : [[snapshotId, description.nextTop]]));
  }
  return { rounds: replies.length, replies };
}

/** How a failed turn reads in the thread. */
export function turnFailure(error: unknown): Extract<TurnStatus, { status: "failed" }> {
  const { code, message } = describeError(error);
  // The backend refuses an answer built on a version that is no longer the latest.
  if (code === "invalid" && /version/i.test(message)) {
    return { status: "failed", kind: "moved", message: "Someone changed this mockup meanwhile. Ask again." };
  }
  if (code === "unavailable") return { status: "failed", kind: "unavailable", message };
  if (code === "setup-ai") return { status: "failed", kind: "setup-ai", message };
  return { status: "failed", kind: "other", message };
}
