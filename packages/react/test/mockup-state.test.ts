import { expect, test } from "bun:test";
import type { MockupDetail, PageDescription } from "@critiqs/core";
import { ConvexError } from "convex/values";
import { MAX_ROUNDS, runAiTurn, type TurnStatus, turnFailure } from "../src/mockup/ai-turn.ts";
import type { FrozenPage } from "../src/mockup/freeze.ts";
import { copyHint, editsAt, escapeTarget, type FrozenDraft, INITIAL_STATE, mockupReducer, type MockupState, needsOtherCopy, shownVersion, titleFrom } from "../src/mockup/state.ts";

const page: FrozenPage = { html: "<html></html>", width: 1440, height: 2000, viewportWidth: 1440, scrollY: 0, viewportHeight: 900, capturedAt: 1 };
const frozen: FrozenDraft = { page, source: { url: "https://proto.example/pilot", screen: "pilot", viewState: {}, revision: null, persona: null, recordKey: null } };
const choice = { node: 4, label: "button", rect: { x: 1, y: 2, width: 3, height: 4 } };

test("Escape puts down a chosen element, then closes the panel; it never leaves the mode or an open thread", () => {
  let state: MockupState = mockupReducer(INITIAL_STATE, { type: "frozen", frozen });
  state = mockupReducer(state, { type: "new-thread" });
  state = mockupReducer(state, { type: "select", choice });
  expect(escapeTarget(state)).toBe("selection");
  state = mockupReducer(state, { type: "escape" });
  expect(state).toEqual({ view: "list", frozen, drafting: true, selection: null, visit: null });
  expect(escapeTarget(state)).toBe("panel");

  state = mockupReducer(state, { type: "open", mockupId: "m", threadId: "t" });
  expect(escapeTarget(state)).toBe("panel");
  expect(mockupReducer(state, { type: "escape" })).toBe(state);
});

test("a new thread is drafted over the list's copy; elements are chosen only in it, and leaving it keeps the copy", () => {
  let state: MockupState = mockupReducer(INITIAL_STATE, { type: "frozen", frozen });
  expect(mockupReducer(state, { type: "select", choice })).toBe(state);
  state = mockupReducer(state, { type: "new-thread" });
  state = mockupReducer(state, { type: "select", choice });
  expect(state).toMatchObject({ view: "list", drafting: true, selection: choice });
  // A thread from another page can't be asked for while drafting: the list is hidden.
  const visit = { mockupId: "m", threadId: "t", screen: "settings", viewState: {}, recordKey: null };
  expect(mockupReducer(state, { type: "ask-visit", visit })).toBe(state);
  expect(mockupReducer(state, { type: "end-draft" })).toEqual({ view: "list", frozen, drafting: false, selection: null, visit: null });
});

test("a thread on another page waits for the reviewer to agree, and a new thread waits with it", () => {
  let state: MockupState = mockupReducer(INITIAL_STATE, { type: "frozen", frozen });
  state = mockupReducer(state, { type: "ask-visit", visit: { mockupId: "m", threadId: "t", screen: "settings", viewState: {}, recordKey: null } });
  expect(state).toMatchObject({ view: "list", selection: null, visit: { screen: "settings", status: "asking" } });
  expect(mockupReducer(state, { type: "new-thread" })).toBe(state);
  expect(mockupReducer(state, { type: "visit-going" })).toMatchObject({ visit: { status: "going" } });
  expect(mockupReducer(state, { type: "cancel-visit" })).toMatchObject({ view: "list", visit: null, frozen });
  // Once the prototype was asked to go there, it may show that page now, so the page is frozen again.
  const going = mockupReducer(state, { type: "visit-going" });
  expect(mockupReducer(going, { type: "cancel-visit" })).toEqual({ view: "list", visit: null, frozen: null, drafting: false, selection: null });
  expect(mockupReducer(state, { type: "open", mockupId: "m", threadId: "t" })).toEqual({ view: "thread", mockupId: "m", threadId: "t", snapshotId: null, viewing: "head" });
});

test("opening a thread shows its latest version; viewing an older one is kept until changed", () => {
  let state = mockupReducer(INITIAL_STATE, { type: "open", mockupId: "m", threadId: "t", snapshotId: "desktop" });
  expect(state).toMatchObject({ view: "thread", viewing: "head", threadId: "t", snapshotId: "desktop" });
  state = mockupReducer(state, { type: "view", version: 2 });
  expect(state).toMatchObject({ viewing: 2 });
  expect(mockupReducer(state, { type: "show-copy", snapshotId: "phone" })).toMatchObject({ snapshotId: "phone", viewing: 2 });
  // A copy arriving after the freeze, or an element chosen on it, can't change an open thread.
  expect(mockupReducer(state, { type: "frozen", frozen })).toBe(state);
  expect(mockupReducer(state, { type: "select", choice })).toBe(state);
});

test("a new mockup is named after its thread's first message, on one line", () => {
  expect(titleFrom("  Make the\n save   button bigger ")).toBe("Make the save button bigger");
  const long = titleFrom("word ".repeat(40));
  expect(long.length).toBeLessThanOrEqual(80);
  expect(long.endsWith("…")).toBe(true);
});

const mockup = {
  versions: [
    { number: 1, edits: { desktop: [{ kind: "remove", node: 3 }] } },
    { number: 2, edits: { desktop: [{ kind: "remove", node: 3 }, { kind: "text", node: 4, text: "Hi" }] } },
  ],
} as unknown as MockupDetail;

test("each version holds every change from the original copy", () => {
  expect(shownVersion(mockup, "head")).toBe(2);
  expect(shownVersion(mockup, 9)).toBe(2);
  expect(editsAt(mockup, "desktop", 2)).toHaveLength(2);
  expect(editsAt(mockup, "desktop", 0)).toEqual([]);
  expect(editsAt(mockup, "phone", 2)).toEqual([]);
});

test("a copy at the window's width is offered once the width differs by 15% or crosses 768 px", () => {
  expect(needsOtherCopy(1440, 1440)).toBe(false);
  expect(needsOtherCopy(1300, 1440)).toBe(false);
  expect(needsOtherCopy(1224, 1440)).toBe(true);
  expect(needsOtherCopy(760, 800)).toBe(true);
  expect(needsOtherCopy(390, 400)).toBe(false);

  const desktop = { _id: "desktop", width: 1440, height: 1, capturedAt: 1, createdByName: "Dana" };
  const phone = { _id: "phone", width: 390, height: 1, capturedAt: 1, createdByName: "Dana" };
  expect(copyHint([desktop], desktop, 1400)).toBeNull();
  expect(copyHint([desktop], desktop, 400)).toEqual({ kind: "take", width: 400 });
  // A copy that already suits the window is offered instead of taking another.
  expect(copyHint([desktop, phone], desktop, 400)).toEqual({ kind: "switch", snapshot: phone });
});

const description = (nextTop: number | null): PageDescription => ({ text: "body #1", complete: nextTop === null, nextTop });

test("Critiqs AI continues down the page while its request reaches past what it was shown", async () => {
  const described: (number | null)[] = [];
  const continuations: boolean[] = [];
  const progress: TurnStatus[] = [];
  const result = await runAiTurn({
    threadId: "t",
    snapshotIds: ["desktop"],
    describe: async ({ top }) => {
      described.push(top);
      return description(top === null ? 900 : top + 900);
    },
    reply: async ({ continuation }) => {
      continuations.push(continuation);
      return { messageId: "m", version: continuations.length, remaining: continuations.length < 3 };
    },
    onProgress: (status) => progress.push(status),
  });
  expect(result.rounds).toBe(3);
  // Each request after the first starts where the previous description stopped.
  expect(described).toEqual([null, 900, 1800]);
  expect(continuations).toEqual([false, true, true]);
  // Each request reads the copy, then waits while Critiqs AI edits it, all timed from when the turn started.
  expect(progress.map((entry) => (entry.status === "working" ? `${entry.step} ${entry.round}` : entry.status))).toEqual([
    "reading 0",
    "editing 0",
    "reading 1",
    "editing 1",
    "reading 2",
    "editing 2",
  ]);
  expect(new Set(progress.map((entry) => (entry.status === "working" ? entry.since : null))).size).toBe(1);
  expect(progress.every((entry) => entry.status === "working" && entry.snapshotIds.join() === "desktop")).toBe(true);
});

test("Critiqs AI stops after five requests, or when nothing is left below", async () => {
  let asked = 0;
  const always = await runAiTurn({
    threadId: "t",
    snapshotIds: ["desktop"],
    describe: async ({ top }) => description((top ?? 0) + 900),
    reply: async () => ({ messageId: `m${++asked}`, version: asked, remaining: true }),
    onProgress: () => undefined,
  });
  expect(MAX_ROUNDS).toBe(5);
  expect(always.rounds).toBe(5);

  const ended = await runAiTurn({
    threadId: "t",
    snapshotIds: ["desktop", "phone"],
    describe: async () => description(null),
    reply: async () => ({ messageId: "m", version: 1, remaining: true }),
    onProgress: () => undefined,
  });
  expect(ended.rounds).toBe(1);
});

test("a turn refused because the mockup moved asks the reviewer to ask again", () => {
  const moved = new ConvexError({ code: "invalid", message: "Someone saved another version of this mockup while Critiqs AI was working." });
  expect(turnFailure(moved)).toEqual({ status: "failed", kind: "moved", message: "Someone changed this mockup meanwhile. Ask again." });
  const noAi = new ConvexError({ code: "unavailable", message: "AI isn't set up for this project." });
  expect(turnFailure(noAi)).toMatchObject({ kind: "unavailable", message: "AI isn't set up for this project." });
});
