import { describe, expect, test } from "bun:test";
import { act } from "react";
import type { ThreadPageData } from "../src/backend.ts";
import { routeOf } from "../src/route.ts";
import type { QueryState } from "../src/shared.ts";
import { convexBackend } from "../src/backend.ts";
import { extensionWay, prototypeLink, ThreadPage, threadPeople } from "../src/ui/ThreadPage.tsx";
import { button, click, fakeAuth, fakeBackend, fakeClipboard, refusingClipboard, render, rerender, settle, text } from "./render.tsx";

// The thread page at /t/<key> in each state its link can open in.

const KEY = "Sp5fZsEobWkBBmdtnkjpzw";
const THREAD_ID = "ps76vrs8shr6nh0wzk70t2sx0x8jx9zn";
const HOUR = 3_600_000;
const now = Date.now();
const dana = { name: "Dana Park", imageUrl: null };
const lee = { name: "Lee Ortiz", imageUrl: null };

function message(id: string, author: typeof dana, body: string, ago: number, extra: Partial<ThreadPageData["messages"][number]> = {}): ThreadPageData["messages"][number] {
  return { _id: id, body, mentions: [], createdAt: now - ago, editedAt: null, revision: "4f2c1ab", author, isMine: false, ...extra };
}

const THREAD: ThreadPageData = {
  _id: THREAD_ID,
  projectId: "n57f2az354ae4vpx2dsmtwzdfd8jx3ct",
  status: "open",
  anchor: {
    screen: "checkout",
    viewState: {},
    target: { purposeId: null, recordKey: null, clues: { tagName: "button", role: "button", label: "Place order", path: "main:1/button:1" } },
    scope: "shared",
    evidence: {
      url: "http://localhost:5173/checkout?step=2",
      viewport: { width: 1440, height: 900 },
      marker: { x: 900, y: 520, width: 160, height: 44 },
      capturedAt: now - 3 * HOUR,
      revision: "4f2c1ab",
      persona: null,
      userAgent: null,
    },
  },
  tags: ["bug", "checkout"],
  textTags: ["bug", "checkout"],
  capture: { status: "captured" },
  createdAt: now - 3 * HOUR,
  lastMessageAt: now - HOUR,
  messageCount: 3,
  statusChangedByName: null,
  reattachedByName: null,
  readState: null,
  project: { name: "Acme checkout", reviewUrl: "https://acme-checkout.example/" },
  prototype: { pageUrl: "http://localhost:5173/checkout?step=2", screen: "checkout" },
  messages: [
    message("m1", dana, "The total doesn't drop when the coupon applies. #bug", 3 * HOUR),
    message("m2", lee, "Seeing it on mobile too.", 2 * HOUR, { editedAt: now - 2 * HOUR + 60_000 }),
    message("m3", dana, "Thanks @Lee Ortiz. Same with free shipping? #checkout", HOUR, {
      mentions: [{ _id: "u_lee", label: "Lee Ortiz", name: "Lee Ortiz" }],
    }),
  ],
};
const ready = (data: ThreadPageData): QueryState<ThreadPageData> => ({ status: "ready", data });

function typeInto(field: Element | null, value: string) {
  if (!(field instanceof HTMLTextAreaElement)) throw new Error("Not a text area.");
  return act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the route", () => {
  test("/t/<key> is a thread page; anything deeper is not", () => {
    expect(routeOf(`/t/${KEY}`)).toEqual({ page: "thread", key: KEY });
    expect(routeOf(`/t/${KEY}/`)).toEqual({ page: "thread", key: KEY });
    expect(routeOf(`/t/${KEY}/more`)).toEqual({ page: "start" });
    expect(routeOf("/t/")).toEqual({ page: "start" });
  });
});

describe("the thread page", () => {
  test("signed out: one clear way to sign in, and nothing is asked of the backend", async () => {
    const backend = fakeBackend({ threadPageState: ready(THREAD) });
    const page = await render(<ThreadPage pageKey={KEY} />, { backend, auth: fakeAuth(null) });
    expect(page.querySelector("h1")?.textContent).toBe("Sign in to see this comment");
    expect(button(page, "Sign in with email")).toBeDefined();
    expect(text(page)).not.toContain("Acme");
    expect(backend.calls).toEqual([]);
  });

  test("not available: a missing thread, a refused one, and a malformed key read exactly the same", async () => {
    const shown: string[] = [];
    for (const [state, key] of [
      [{ status: "error", code: "not-found", message: "This thread doesn't exist, or you can't open it." }, KEY],
      [{ status: "error", code: "forbidden", message: "This project is limited to members of its organization." }, KEY],
      [ready(THREAD), "not-a-key"],
    ] as const) {
      const backend = fakeBackend({ threadPageState: state as QueryState<ThreadPageData> });
      const page = await render(<ThreadPage pageKey={key} />, { backend, auth: fakeAuth("omar@elsewhere.test") });
      shown.push(page.innerHTML);
      if (key === "not-a-key") expect(backend.calls.filter((call) => call.name.includes("Thread"))).toEqual([]);
    }
    expect(new Set(shown).size).toBe(1);
    const page = document.createElement("div");
    page.innerHTML = shown[0]!;
    expect(page.querySelector("h1")?.textContent).toBe("This comment isn't available");
    expect([...page.querySelectorAll("h1, p, li, button")].map((element) => element.textContent)).toEqual([
      "This comment isn't available",
      "It doesn't exist, or this email address can't open it.",
      "If you use Critiqs with another email address, sign in with that one.",
      "Otherwise, ask whoever shared the link to add you to their team on Critiqs.",
      "Signed in as omar@elsewhere.test.",
      "Use another email",
    ]);
  });

  test("not available: Use another email signs out, so the person can sign in again", async () => {
    let signedOut = false;
    const auth = { ...fakeAuth("omar@elsewhere.test"), signOut: async () => void (signedOut = true) };
    const page = await render(<ThreadPage pageKey={KEY} />, { backend: fakeBackend({ threadPageState: { status: "error", code: "not-found", message: "" } }), auth });
    await click(button(page, "Use another email"));
    expect(signedOut).toBe(true);
  });

  test("a deleted thread says so, as the backend tells only people who could open it", async () => {
    const page = await render(<ThreadPage pageKey={KEY} />, { backend: fakeBackend({ threadPageState: { status: "error", code: "unavailable", message: "This thread was deleted." } }) });
    expect(page.querySelector("h1")?.textContent).toBe("This comment was deleted");
  });

  test("with a capture: the image, the discussion with names and times, mentions and tags as the panel shows them", async () => {
    const backend = fakeBackend({ threadPageState: ready(THREAD) });
    const page = await render(<ThreadPage pageKey={KEY} />, { backend });
    await settle();
    expect(page.querySelector("h1")?.textContent).toBe("Comment on Acme checkout");
    expect(backend.calls.filter((call) => call.name === "loadThreadPageCapture").map((call) => call.args)).toEqual([[KEY]]);
    const image = page.querySelector(".thread-capture img");
    expect(image?.getAttribute("src")).toStartWith("blob:");
    expect(image?.getAttribute("alt")).toBe("The page when the comment was left");
    const rows = [...page.querySelectorAll(".thread-messages .message")];
    expect(rows.map((row) => [row.querySelector(".author")?.textContent, row.querySelector("time")?.textContent])).toEqual([
      ["Dana Park", "3h"],
      ["Lee Ortiz", "2h"],
      ["Dana Park", "1h"],
    ]);
    expect(rows[1]!.querySelector(".edited")?.textContent).toBe("(edited)");
    expect(rows[2]!.querySelector(".mention")?.textContent).toBe("@Lee Ortiz");
    expect([...page.querySelectorAll(".thread-messages .hashtag")].map((tag) => tag.textContent)).toEqual(["#bug", "#checkout"]);
    expect([...page.querySelectorAll(".thread-tags .tag-chip")].map((tag) => tag.textContent)).toEqual(["#bug", "#checkout"]);
    expect(page.querySelector(".resolved")).toBeNull();
  });

  test("Open in prototype opens the comment's page at the review address, in a new tab that isn't told where it came from", async () => {
    const page = await render(<ThreadPage pageKey={KEY} />, { backend: fakeBackend({ threadPageState: ready(THREAD) }) });
    const link = [...page.querySelectorAll("a")].find((anchor) => anchor.textContent === "Open in prototype");
    expect(link?.getAttribute("href")).toBe(`https://acme-checkout.example/checkout?step=2&critiqs=${THREAD_ID}`);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(text(page)).toContain("Opens acme-checkout.example/checkout?step=2");
  });

  test("without a review address: no Open in prototype, and it says why and where the comment was left", async () => {
    const thread = { ...THREAD, project: { name: "Acme admin (local)", reviewUrl: null } };
    const page = await render(<ThreadPage pageKey={KEY} />, { backend: fakeBackend({ threadPageState: ready(thread) }) });
    expect([...page.querySelectorAll("a")].some((anchor) => anchor.textContent === "Open in prototype")).toBe(false);
    expect(text(page)).toContain("This project has no review address, so there's no prototype to open. The comment was left on localhost:5173/checkout?step=2.");
  });

  test("with a review link for the comment's address, it's offered beside the installed prototype, or alone in its place", async () => {
    const REVIEW = "https://critiqs.example/r/e3wpz767dgupur6kns2ox725mg#/checkout";
    const asked: string[] = [];
    const useThreadReviewLink = (key: string) => {
      asked.push(key);
      return { status: "ready", data: REVIEW } as const;
    };
    const both = await render(<ThreadPage pageKey={KEY} />, { backend: fakeBackend({ threadPageState: ready(THREAD), useThreadReviewLink }) });
    const review = [...both.querySelectorAll("a")].find((anchor) => anchor.textContent === "Open in review link");
    expect([review?.getAttribute("href"), review?.getAttribute("rel")]).toEqual([REVIEW, "noopener noreferrer"]);
    expect(asked).toContain(KEY);
    const thread = { ...THREAD, project: { name: "Acme build", reviewUrl: null } };
    const alone = await render(<ThreadPage pageKey={KEY} />, { backend: fakeBackend({ threadPageState: ready(thread), useThreadReviewLink }) });
    expect([...alone.querySelectorAll("a")].find((anchor) => anchor.textContent === "Open in prototype")?.getAttribute("href")).toBe(REVIEW);
    expect(text(alone)).toContain("Opens the prototype in a review link, with nothing installed.");
    // Once the build stops being shared, the page says so rather than naming its .build.invalid address.
    const ended = { ...thread, prototype: { pageUrl: "https://bkkkkkkkkkkkkkkkkkkkk.build.invalid/pricing", screen: "/pricing" } };
    const gone = await render(<ThreadPage pageKey={KEY} />, { backend: fakeBackend({ threadPageState: ready(ended) }) });
    expect(text(gone)).toContain("The comment was left on a shared build, which only its review link opens.");
    expect(text(gone)).not.toContain("build.invalid");
    // However its host is spelled (case, the root's trailing dot), it is the same host to the one canonical-host rule.
    const spelled = { ...thread, prototype: { pageUrl: "https://BKKKKKKKKKKKKKKKKKKKK.Build.Invalid./pricing", screen: "/pricing" } };
    const same = await render(<ThreadPage pageKey={KEY} />, { backend: fakeBackend({ threadPageState: ready(spelled) }) });
    expect(text(same)).toContain("The comment was left on a shared build, which only its review link opens.");
  });

  test("Open in prototype goes only to a web address", () => {
    expect(prototypeLink("https://acme.example/app/", "http://localhost:5173/a?b=1#c", "t1")).toBe("https://acme.example/a?b=1&critiqs=t1#c");
    expect(prototypeLink("javascript:alert(1)", "http://localhost/", "t1")).toBeNull();
    expect(prototypeLink("not a url", "http://localhost/", "t1")).toBeNull();
    expect(prototypeLink("https://acme.example/", "//evil.example/x", "t1")).toBe("https://acme.example/x?critiqs=t1");
  });

  test("without a capture: says no image was saved and never asks for one", async () => {
    const backend = fakeBackend({ threadPageState: ready({ ...THREAD, capture: { status: "failed", failureReason: "The page blocked the capture." } }) });
    const page = await render(<ThreadPage pageKey={KEY} />, { backend });
    await settle();
    expect(page.querySelector(".thread-capture")).toBeNull();
    expect(text(page)).toContain("No image was saved with this comment.");
    expect(backend.calls.some((call) => call.name === "loadThreadPageCapture")).toBe(false);
  });

  test("an image the backend won't return reads as no image", async () => {
    const backend = fakeBackend({ threadPageState: ready(THREAD), loadThreadPageCapture: async () => null });
    const page = await render(<ThreadPage pageKey={KEY} />, { backend });
    await settle();
    expect(page.querySelector(".thread-capture img")).toBeNull();
    expect(text(page.querySelector(".thread-capture")!)).toBe("No image was saved with this comment.");
  });

  test("resolved: the heading and a line say who resolved it and when, and replies stay open", async () => {
    const at = now - HOUR;
    const thread: ThreadPageData = { ...THREAD, status: "resolved", statusChangedByName: "Dana Park", statusChangedAt: at };
    const page = await render(<ThreadPage pageKey={KEY} />, { backend: fakeBackend({ threadPageState: ready(thread) }) });
    expect(page.querySelector("h1")?.textContent).toBe("Resolved comment on Acme checkout");
    expect(page.querySelector(".resolved")?.textContent).toBe(`Resolved by Dana Park, ${new Date(at).toLocaleString()}.`);
    expect(page.querySelector("textarea")).not.toBeNull();
  });

  test("Copy link copies the page's own address", async () => {
    const clipboard = fakeClipboard();
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`https://critiqs.app/t/${KEY}?from=email#top`);
    const page = await render(<ThreadPage pageKey={KEY} />, { backend: fakeBackend({ threadPageState: ready(THREAD) }) });
    await click(button(page, "Copy link"));
    expect(clipboard.text).toBe(`https://critiqs.app/t/${KEY}`);
    expect(text(page)).toContain("Link copied");
  });

  test("a reply is sent from the page, the box empties, and the reply shows when the live page brings it", async () => {
    const backend = fakeBackend({ threadPageState: ready(THREAD) });
    const page = await render(<ThreadPage pageKey={KEY} />, { backend });
    const reply = button(page, "Reply")!;
    expect(reply.disabled).toBe(true);
    await typeInto(page.querySelector("textarea"), "Same with free shipping. #checkout");
    await click(button(page, "Reply"));
    expect(backend.calls.filter((call) => call.name === "replyOnThreadPage").map((call) => call.args)).toEqual([[THREAD_ID, "Same with free shipping. #checkout", []]]);
    expect(page.querySelector("textarea")?.value).toBe("");
    const live = { ...THREAD, messages: [...THREAD.messages, message("m4", lee, "Same with free shipping. #checkout", 0)] };
    await rerender(<ThreadPage pageKey={KEY} />, { backend: { ...backend, useThreadPage: () => ready(live) } });
    expect(page.querySelectorAll(".thread-messages .message").length).toBe(4);
    const added = page.querySelectorAll(".thread-messages .message")[3]!;
    expect([added.querySelector(".author")?.textContent, added.querySelector("time")?.textContent, added.querySelector(".body")?.textContent]).toEqual([
      "Lee Ortiz",
      "now",
      "Same with free shipping. #checkout",
    ]);
  });

  test("Ctrl or Cmd with Enter sends, as in the thread window", async () => {
    const backend = fakeBackend({ threadPageState: ready(THREAD) });
    const page = await render(<ThreadPage pageKey={KEY} />, { backend });
    const field = page.querySelector("textarea")!;
    await typeInto(field, "Looks fixed.");
    await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })));
    expect(backend.calls.filter((call) => call.name === "replyOnThreadPage").map((call) => call.args)).toEqual([[THREAD_ID, "Looks fixed.", []]]);
  });

  test("a refused reply says so in words and keeps the text", async () => {
    const backend = fakeBackend({
      threadPageState: ready(THREAD),
      replyOnThreadPage: async () => Promise.reject(Object.assign(new Error("refused"), { data: { code: "not-found", message: "This thread doesn't exist, or you can't open it." } })),
    });
    const page = await render(<ThreadPage pageKey={KEY} />, { backend });
    await typeInto(page.querySelector("textarea"), "One more thing");
    await click(button(page, "Reply"));
    expect(page.querySelector('[role="alert"]')?.textContent).toBe("Your reply wasn't sent. This email address can't reply to this comment.");
    expect(page.querySelector("textarea")?.value).toBe("One more thing");
    expect(button(page, "Reply")?.disabled).toBe(false);
  });

  test("a reply the backend turns down for another reason shows its reason", async () => {
    const backend = fakeBackend({
      threadPageState: ready(THREAD),
      replyOnThreadPage: async () => Promise.reject(Object.assign(new Error("limit"), { data: { code: "invalid", message: "This thread has reached its reply limit; start a new thread." } })),
    });
    const page = await render(<ThreadPage pageKey={KEY} />, { backend });
    await typeInto(page.querySelector("textarea"), "Again");
    await click(button(page, "Reply"));
    expect(page.querySelector('[role="alert"]')?.textContent).toBe("This thread has reached its reply limit; start a new thread.");
  });

  test("signing in accepts the person's pending invitations before the page asks for the thread", async () => {
    let finish!: () => void;
    const backend = fakeBackend({ threadPageState: ready(THREAD), syncReviewer: () => new Promise<void>((resolve) => (finish = resolve)) });
    const page = await render(<ThreadPage pageKey={KEY} />, { backend });
    expect(backend.calls.map((call) => call.name)).toEqual(["syncReviewer"]);
    expect(text(page)).toBe("Loading…");
    await act(async () => finish());
    expect(backend.calls.filter((call) => call.name === "useThreadPage").length).toBeGreaterThan(0);
    expect(page.querySelector("h1")?.textContent).toBe("Comment on Acme checkout");
    expect(backend.calls.filter((call) => call.name === "syncReviewer").length).toBe(1);
  });

  test("if accepting invitations fails, the page still opens with the access the person has", async () => {
    const backend = fakeBackend({ threadPageState: ready(THREAD), syncReviewer: async () => Promise.reject(new Error("offline")) });
    const page = await render(<ThreadPage pageKey={KEY} />, { backend });
    await settle();
    expect(page.querySelector("h1")?.textContent).toBe("Comment on Acme checkout");
  });

  test("text typed while a reply is sending stays in the box", async () => {
    let finish!: () => void;
    const backend = fakeBackend({ threadPageState: ready(THREAD), replyOnThreadPage: () => new Promise<void>((resolve) => (finish = resolve)) });
    const page = await render(<ThreadPage pageKey={KEY} />, { backend });
    await typeInto(page.querySelector("textarea"), "First");
    await click(button(page, "Reply"));
    await typeInto(page.querySelector("textarea"), "First, and a second thought");
    await act(async () => finish());
    expect(page.querySelector("textarea")?.value).toBe("First, and a second thought");
  });

  test("a saved page address that can't be read still shows the discussion, and opens the review address", async () => {
    const thread = { ...THREAD, prototype: { pageUrl: "http://[", screen: "checkout" } };
    const page = await render(<ThreadPage pageKey={KEY} />, { backend: fakeBackend({ threadPageState: ready(thread) }) });
    expect(page.querySelectorAll(".thread-messages .message").length).toBe(3);
    const link = [...page.querySelectorAll("a")].find((anchor) => anchor.textContent === "Open in prototype");
    expect(link?.getAttribute("href")).toBe(`https://acme-checkout.example/?critiqs=${THREAD_ID}`);
  });

  test("the browser tab's title never names the project", async () => {
    await render(<ThreadPage pageKey={KEY} />, { backend: fakeBackend({ threadPageState: ready(THREAD) }) });
    expect(document.title).toBe("Comment · Critiqs");
  });

  test("when the browser won't copy, Copy link shows the link to select", async () => {
    refusingClipboard();
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`https://critiqs.app/t/${KEY}`);
    const page = await render(<ThreadPage pageKey={KEY} />, { backend: fakeBackend({ threadPageState: ready(THREAD) }) });
    await click(button(page, "Copy link"));
    expect(page.querySelector<HTMLTextAreaElement>(".copy-fallback textarea")?.value).toBe(`https://critiqs.app/t/${KEY}`);
  });

  test("a thread resolved while someone types leaves them in the reply box", async () => {
    const backend = fakeBackend({ threadPageState: ready(THREAD) });
    const page = await render(<ThreadPage pageKey={KEY} />, { backend });
    const field = page.querySelector("textarea")!;
    await typeInto(field, "Half a thought");
    await act(async () => field.focus());
    const resolved: ThreadPageData = { ...THREAD, status: "resolved", statusChangedByName: "Dana Park", statusChangedAt: now };
    await rerender(<ThreadPage pageKey={KEY} />, { backend: { ...backend, useThreadPage: () => ready(resolved) } });
    expect(page.querySelector("h1")?.textContent).toBe("Resolved comment on Acme checkout");
    expect(document.activeElement).toBe(page.querySelector("textarea"));
    expect(page.querySelector("textarea")?.value).toBe("Half a thought");
  });

  test("an image that fails to download says so and can be tried again", async () => {
    let attempts = 0;
    const backend = fakeBackend({
      threadPageState: ready(THREAD),
      loadThreadPageCapture: async () => {
        attempts++;
        if (attempts === 1) throw new Error("offline");
        return new Blob([new Uint8Array([137])], { type: "image/png" });
      },
    });
    const page = await render(<ThreadPage pageKey={KEY} />, { backend });
    await settle();
    expect(text(page.querySelector(".thread-capture")!)).toBe("Couldn't load the image.Try again");
    await click(button(page, "Try again"));
    await settle();
    expect(page.querySelector(".thread-capture img")?.getAttribute("src")).toStartWith("blob:");
  });

  test("a failed download of a supplied screenshot shows Try again with nothing over it", async () => {
    const thread: ThreadPageData = { ...THREAD, capture: { status: "supplied", failureReason: "Blocked" } };
    const backend = fakeBackend({ threadPageState: ready(thread), loadThreadPageCapture: async () => Promise.reject(new Error("offline")) });
    const page = await render(<ThreadPage pageKey={KEY} />, { backend });
    await settle();
    const figure = page.querySelector<HTMLElement>(".thread-capture")!;
    expect(button(figure, "Try again")).toBeDefined();
    expect(figure.querySelector("figcaption")).toBeNull();
    expect(figure.style.aspectRatio).toBe("");
  });

  test("Try again keeps keyboard focus while it retries, and after another failure", async () => {
    const answers: { reject: (error: Error) => void }[] = [];
    const backend = fakeBackend({ threadPageState: ready(THREAD), loadThreadPageCapture: () => new Promise<Blob | null>((_, reject) => answers.push({ reject })) });
    const page = await render(<ThreadPage pageKey={KEY} />, { backend });
    await act(async () => answers[0]!.reject(new Error("offline")));
    const retry = button(page, "Try again")!;
    await act(async () => retry.focus());
    await click(retry);
    expect(answers.length).toBe(2);
    expect(document.activeElement).toBe(retry);
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    await click(retry);
    expect(answers.length).toBe(2);
    await act(async () => answers[1]!.reject(new Error("offline")));
    expect(document.activeElement).toBe(retry);
    expect(retry.getAttribute("aria-disabled")).toBe("false");
  });
});

describe("loading a thread page's image from Convex", () => {
  const load = async (getToken: () => Promise<string | null>, answer: () => Promise<Response>) => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => answer()) as unknown as typeof fetch;
    try {
      return await convexBackend({} as never, null, { siteUrl: "https://site.example", getToken }, { createKeys: false, addressEdits: false, developerResends: false, reviewLinks: null }).loadThreadPageCapture(KEY);
    } finally {
      globalThis.fetch = original;
    }
  };
  const token = async () => "token";

  test("the page key goes in a request header, never in the image's address, which servers and their logs record", async () => {
    const original = globalThis.fetch;
    const asked: { url: string; headers: Headers }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      asked.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response(new Uint8Array([137]), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await convexBackend({} as never, null, { siteUrl: "https://site.example", getToken: token }, { createKeys: false, addressEdits: false, developerResends: false, reviewLinks: null }).loadThreadPageCapture(KEY);
    } finally {
      globalThis.fetch = original;
    }
    expect(asked.map((each) => each.url)).toEqual(["https://site.example/capture"]);
    expect(asked[0]!.headers.get("X-Critiqs-Thread-Page")).toBe(KEY);
    expect(asked[0]!.headers.get("Authorization")).toBe("Bearer token");
  });

  test("none to give (404) is no image; other failures, and a sign-in that can't refresh, can be tried again", async () => {
    expect(await load(token, async () => new Response("", { status: 404 }))).toBeNull();
    expect(await load(token, async () => new Response(new Uint8Array([137]), { status: 200 }))).toBeInstanceOf(Blob);
    await expect(load(token, async () => new Response("", { status: 503 }))).rejects.toThrow();
    await expect(load(token, async () => Promise.reject(new TypeError("offline")))).rejects.toThrow();
    await expect(load(async () => null, async () => new Response(new Uint8Array([137]), { status: 200 }))).rejects.toThrow();
  });
});

test("the website sends only its origin as the referrer, so a page key never leaves in one, even to its own address", async () => {
  // A host can keep /t/<key> out of its logs (docs/technical-direction.md, "Thread page links"), but the page's own
  // requests, such as its scripts, would still name the page in their Referer under the browser's default policy.
  const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
  expect(html).toContain('<meta name="referrer" content="strict-origin" />');
});

describe("Open in prototype and the extension", () => {
  test("only a thread left with the extension offers it, saying whether the project is installed; never on an older backend", () => {
    expect(extensionWay(null, "extension")).toBe("not-installed");
    expect(extensionWay(2_000, "extension")).toBe("made-with-extension");
    expect(extensionWay(null, "install")).toBeNull();
    expect(extensionWay(2_000, "install")).toBeNull();
    // From before threads recorded it: every thread was left with an install.
    expect(extensionWay(null, undefined)).toBeNull();
    expect(extensionWay(2_000, undefined)).toBeNull();
    expect(extensionWay(undefined, "extension")).toBeNull();
  });

  // Each check reads text, never an element: a failing match on a rendered element prints its whole React tree.
  const cardOf = async (project: Partial<ThreadPageData["project"]>, madeWith?: "install" | "extension") => {
    const prototype = { ...THREAD.prototype, ...(madeWith === undefined ? {} : { madeWith }) };
    const page = await render(<ThreadPage pageKey={KEY} />, { backend: fakeBackend({ threadPageState: ready({ ...THREAD, project: { ...THREAD.project, ...project }, prototype }) }) });
    await settle();
    return page;
  };
  const heading = (page: Element) => page.querySelector(".extension-way strong")?.textContent ?? null;

  test("left with the extension on a project not installed: Open in prototype, and how to see the comment there with the extension", async () => {
    const page = await cardOf({ connectedAt: null }, "extension");
    const way = page.querySelector(".extension-way");
    expect(way?.textContent).toBe("Not installed on the prototype yetOpen the prototype in Chrome and click Critiqs in the toolbar to see this comment there. Get the extension");
    expect(way?.querySelector("a")?.getAttribute("href")).toBe("https://github.com/noahsjung/critiqs/tree/main/packages/extension#build-and-load-it-unpacked");
    // The installed link stays: it opens the page the comment was left on.
    expect(page.querySelector("a.btn")?.textContent).toBe("Open in prototype");
  });

  test("left with the extension on a project installed since: both ways", async () => {
    expect(heading(await cardOf({ connectedAt: now - 10 * HOUR }, "extension"))).toBe("Left with the Critiqs extension");
    expect(heading(await cardOf({ connectedAt: now + HOUR }, "extension"))).toBe("Left with the Critiqs extension");
  });

  test("left with an install, or from before threads recorded it: only the installed link, whenever the project last loaded", async () => {
    // A project installed before Connected shipped first reports after every older thread, or not yet.
    for (const madeWith of [undefined, "install"] as const) {
      for (const connectedAt of [null, now - 10 * HOUR, now]) {
        const page = await cardOf({ connectedAt }, madeWith);
        expect([madeWith, connectedAt, heading(page), page.querySelector("a.btn")?.textContent ?? null]).toEqual([madeWith, connectedAt, null, "Open in prototype"]);
      }
    }
  });
});

describe("@ suggestions on the thread page", () => {
  const PEOPLE_THREAD: ThreadPageData = {
    ...THREAD,
    messages: [
      message("m1", dana, "The total doesn't drop. #bug", 3 * HOUR, { authorId: "u_dana", isMine: true }),
      message("m2", lee, "Seeing it on mobile too.", 2 * HOUR, { authorId: "u_lee" }),
      message("m3", dana, "@Kim Ray can you check?", HOUR, { authorId: "u_dana", isMine: true, mentions: [{ _id: "u_kim", label: "Kim Ray", name: "Kim Ray" }] }),
    ],
  };

  test("the people in the thread: who wrote and who was mentioned, once each, never the signed-in person", () => {
    expect(threadPeople(PEOPLE_THREAD.messages).map((person) => [person._id, person.name])).toEqual([
      ["u_lee", "Lee Ortiz"],
      ["u_kim", "Kim Ray"],
    ]);
  });

  test("two people outside the team in one thread are each offered the other", () => {
    const mo = { name: "Mo Diaz", imageUrl: null };
    const asSeenBy = (me: string) => [
      message("m1", lee, "Lee's thread", 3 * HOUR, { authorId: "u_lee", isMine: me === "u_lee" }),
      message("m2", mo, "Mo here", 2 * HOUR, { authorId: "u_mo", isMine: me === "u_mo" }),
    ];
    expect(threadPeople(asSeenBy("u_lee")).map((person) => person.name)).toEqual(["Mo Diaz"]);
    expect(threadPeople(asSeenBy("u_mo")).map((person) => person.name)).toEqual(["Lee Ortiz"]);
  });

  test("typing @ suggests only people in the thread; choosing one mentions them in the reply", async () => {
    const backend = fakeBackend({ threadPageState: ready(PEOPLE_THREAD) });
    const page = await render(<ThreadPage pageKey={KEY} />, { backend });
    await settle();
    const box = page.querySelector("textarea")!;
    await typeInto(box, "Thanks @");
    expect([...page.querySelectorAll("[role='option']")].map((option) => option.textContent)).toEqual(["LOLee Ortiz", "KRKim Ray"]);
    expect(box.getAttribute("aria-expanded")).toBe("true");
    await typeInto(box, "Thanks @le");
    expect([...page.querySelectorAll("[role='option']")].map((option) => option.textContent)).toEqual(["LOLee Ortiz"]);
    await act(async () => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(box.value).toBe("Thanks @Lee Ortiz ");
    expect(page.querySelector("[role='listbox']")).toBeNull();
    await typeInto(box, "Thanks @Lee Ortiz, fixed now.");
    await click(button(page, "Reply"));
    await settle();
    expect(backend.calls.filter((call) => call.name === "replyOnThreadPage").map((call) => call.args)).toEqual([
      [THREAD_ID, "Thanks @Lee Ortiz, fixed now.", [{ userId: "u_lee", label: "Lee Ortiz" }]],
    ]);
  });

  test("no one matches, or Escape: no list; a mention whose text was deleted isn't sent", async () => {
    const backend = fakeBackend({ threadPageState: ready(PEOPLE_THREAD) });
    const page = await render(<ThreadPage pageKey={KEY} />, { backend });
    await settle();
    const box = page.querySelector("textarea")!;
    await typeInto(box, "@zz");
    expect(page.querySelector("[role='listbox']")).toBeNull();
    await typeInto(box, "@k");
    await act(async () => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(page.querySelector("[role='listbox']")).toBeNull();
    // A new @ elsewhere suggests again; the arrow keys move through the list.
    await typeInto(box, "ok @");
    await act(async () => box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await act(async () => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(box.value).toBe("ok @Kim Ray ");
    await typeInto(box, "Never mind.");
    await click(button(page, "Reply"));
    await settle();
    expect(backend.calls.filter((call) => call.name === "replyOnThreadPage").map((call) => call.args)).toEqual([[THREAD_ID, "Never mind.", []]]);
  });
});
