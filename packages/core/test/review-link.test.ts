import { describe, expect, test } from "bun:test";
import {
  type ElementRef,
  INSTALLED_PAGE_LIMITS,
  PAGE_MESSAGE_TAG,
  PAGE_PROTOCOL,
  type PageState,
  type PageTransport,
  panelEndpoint,
  parsePageMessage,
  inReviewFrame,
  parseReviewFrameMessage,
  REVIEW_FRAME_MARK,
  REVIEW_FRAME_TAG,
  UNTRUSTED_PAGE_LIMITS,
} from "../src/index.ts";

// AT-16: a review link's page layer shares its window with the prototype's
// scripts, which can forge any message. Under UNTRUSTED_PAGE_LIMITS, an
// oversized message is refused before the panel uses it; installed Critiqs
// keeps taking what its host app reports.

const CHANNEL = "review-link";
const STATE: PageState = {
  document: "d1",
  version: 1,
  url: "https://prototype.example/users/42",
  context: { screen: "users/:id", viewState: { tab: "profile" }, persona: null },
  viewport: { width: 1280, height: 800 },
  restores: true,
  located: { t1: { status: "found", occurrences: [{ ref: "e1" as ElementRef, recordKey: "42" }] } },
};
const event = (data: unknown, name = "state") => ({ tag: PAGE_MESSAGE_TAG, v: PAGE_PROTOCOL, channel: CHANNEL, kind: "event", event: name, data });

describe("AT-16: untrusted page limits", () => {
  const forged: [string, unknown][] = [
    ["20 MB of text in a screen name", { ...STATE, context: { ...STATE.context, screen: "s".repeat(20 * 1024 * 1024) } }],
    ["20 MB of text in a view-state value", { ...STATE, context: { ...STATE.context, viewState: { filter: "x".repeat(20 * 1024 * 1024) } } }],
    ["500 view-state keys", { ...STATE, context: { ...STATE.context, viewState: Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`k${index}`, index])) } }],
    ["a 5,000-character address", { ...STATE, url: `https://prototype.example/${"a".repeat(5_000)}` }],
    ["3,000 located targets", { ...STATE, located: Object.fromEntries(Array.from({ length: 3_000 }, (_, index) => [`t${index}`, null])) }],
    ["3,000 occurrences", { ...STATE, located: { t1: { status: "found", occurrences: Array.from({ length: 3_000 }, (_, index) => ({ ref: `e${index}`, recordKey: null })) } } }],
    // F-H2-5: keys were unbounded, occurrences were bounded per target only, and file: or about: addresses passed.
    ["a 20 MB view-state key", { ...STATE, context: { ...STATE.context, viewState: { ["k".repeat(20_000_000)]: 1 } } }],
    ["a 20 MB located key", { ...STATE, located: { ["t".repeat(20_000_000)]: null } }],
    [
      "2,000 occurrences in each of 50 targets",
      { ...STATE, located: Object.fromEntries(Array.from({ length: 50 }, (_, target) => [`t${target}`, { status: "found", occurrences: Array.from({ length: 2_000 }, () => ({ ref: "e1", recordKey: null })) }])) },
    ],
    ["a file: address", { ...STATE, url: "file:///etc/passwd" }],
    ["an about: address", { ...STATE, url: "about:blank" }],
  ];
  for (const [name, data] of forged) {
    test(`refuses ${name}`, () => {
      expect(parsePageMessage(event(data), CHANNEL, UNTRUSTED_PAGE_LIMITS)).toMatchObject({ ok: false, code: "bad-request" });
    });
  }

  test("a normal state passes", () => {
    expect(parsePageMessage(event(STATE), CHANNEL, UNTRUSTED_PAGE_LIMITS).ok).toBe(true);
    const wide = { ...STATE, context: { ...STATE.context, viewState: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`k${index}`, "v".repeat(16_384)])) } };
    expect(parsePageMessage(event(wide), CHANNEL, UNTRUSTED_PAGE_LIMITS).ok).toBe(true);
  });

  test("installed Critiqs is unchanged: the same large values pass with the default limits", () => {
    expect(parsePageMessage(event(forged[1]![1]), CHANNEL).ok).toBe(true);
    expect(parsePageMessage(event(forged[2]![1]), CHANNEL, INSTALLED_PAGE_LIMITS).ok).toBe(true);
  });

  test("a panel endpoint with untrusted limits refuses an oversized capture and an oversized page copy", async () => {
    let listener: (message: unknown) => void = () => undefined;
    const sent: { id: number; method: string }[] = [];
    const transport: PageTransport = {
      send: (message) => sent.push(message as never),
      listen: (handler) => ((listener = handler), () => undefined),
      onClose: () => () => undefined,
      close: () => undefined,
    };
    const panel = panelEndpoint(transport, { channel: CHANNEL, limits: UNTRUSTED_PAGE_LIMITS });
    const answer = (result: unknown) => listener({ tag: PAGE_MESSAGE_TAG, v: PAGE_PROTOCOL, channel: CHANNEL, kind: "result", id: sent.at(-1)!.id, result });
    const capture = panel.request("capture", { marker: null, image: null });
    answer({ status: "captured", image: new Blob([new Uint8Array(11 * 1024 * 1024)], { type: "image/png" }) });
    await expect(capture).rejects.toMatchObject({ code: "bad-request" });
    const copy = panel.request("copyPage", {});
    answer({ html: "x".repeat(11 * 1024 * 1024), width: 1, height: 1, viewportWidth: 1, viewportHeight: 1, scrollY: 0, capturedAt: 0, url: STATE.url, context: STATE.context, recordKey: null });
    await expect(copy).rejects.toMatchObject({ code: "bad-request" });
    const small = panel.request("capture", { marker: null, image: null });
    answer({ status: "captured", image: new Blob([new Uint8Array(1024)], { type: "image/png" }) });
    await expect(small).resolves.toMatchObject({ status: "captured" });
  });
});

describe("review frame messages", () => {
  test("parses each kind", () => {
    expect(parseReviewFrameMessage({ tag: REVIEW_FRAME_TAG, v: 1, kind: "failed", reason: "too-large" })).toEqual({ tag: REVIEW_FRAME_TAG, v: 1, kind: "failed", reason: "too-large" });
    expect(parseReviewFrameMessage({ tag: REVIEW_FRAME_TAG, v: 1, kind: "left", url: "https://accounts.google.com", signIn: true })?.kind).toBe("left");
    expect(parseReviewFrameMessage({ tag: REVIEW_FRAME_TAG, v: 1, kind: "unsupported", feature: "password" })?.kind).toBe("unsupported");
  });

  test("refuses anything else", () => {
    for (const raw of [
      null,
      "critiqs:review-frame",
      { tag: REVIEW_FRAME_TAG, v: 2, kind: "failed", reason: "timeout" },
      { tag: REVIEW_FRAME_TAG, v: 1, kind: "failed", reason: "exploded" },
      { tag: REVIEW_FRAME_TAG, v: 1, kind: "failed", reason: "timeout", extra: 1 },
      { tag: REVIEW_FRAME_TAG, v: 1, kind: "left", url: "https://accounts.google.com/o/oauth2?client_id=x", signIn: true },
      { tag: REVIEW_FRAME_TAG, v: 1, kind: "left", url: "javascript:alert(1)", signIn: false },
      { tag: REVIEW_FRAME_TAG, v: 1, kind: "left", url: "https://x.example", signIn: "yes" },
      { tag: REVIEW_FRAME_TAG, v: 1, kind: "navigate", url: "https://x.example" },
    ]) {
      expect(parseReviewFrameMessage(raw)).toBeNull();
    }
  });
});

describe("a review frame's own messages and mark", () => {
  test("part of the page couldn't load: one message the review page understands", () => {
    expect(parseReviewFrameMessage({ tag: REVIEW_FRAME_TAG, v: 1, kind: "unsupported", feature: "load" })).toEqual({ tag: REVIEW_FRAME_TAG, v: 1, kind: "unsupported", feature: "load" });
    expect(parseReviewFrameMessage({ tag: REVIEW_FRAME_TAG, v: 1, kind: "unsupported", feature: "load", url: "https://evil.example" })).toBeNull();
  });
  test("a window is a review frame only when the proxy's runtime marked it", () => {
    const scope = {};
    expect(inReviewFrame(scope)).toBe(false);
    Object.defineProperty(scope, REVIEW_FRAME_MARK, { value: true });
    expect(inReviewFrame(scope)).toBe(true);
    // The mark is one global symbol, so separately built copies of Critiqs agree on it.
    expect(REVIEW_FRAME_MARK === Symbol.for("critiqs.review-frame")).toBe(true);
  });
});
