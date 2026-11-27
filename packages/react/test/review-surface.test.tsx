import { afterEach, expect, test } from "bun:test";
import { type ElementRef, type NewThread, PageLayerError, type PageMessage, type PageState, type ThreadSummary } from "@critiqs/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App, type ReviewSurface } from "../src/App.tsx";
import { PageLink } from "../src/page-layer/link.ts";
import { mapFrameUrl, reviewEndpoint } from "../src/page-layer/review.ts";
import { Session } from "../src/session.ts";
import { TransportContext } from "../src/transport.ts";
import { commentField, fieldText, typeInto } from "./comment-field.ts";
import { type FakeBackend, fakeTransport } from "./fake-transport.tsx";
import { measured, pageState, scriptedPage } from "./scripted-page.tsx";

// The panel in a review link's page: the reviewer picks and writes signed
// out, signs in inside the page on posting, and the draft survives it; what
// the frame reports is mapped and checked, and real thread IDs and names
// never reach it.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SIGN_IN = "https://auth.example";
const FRAME = "https://v-abcdefghijklmnopqrstuvwxyz.review.example";
const deployment = { backendUrl: "https://backend.convex.cloud", siteUrl: "https://backend.convex.site", signInUrl: SIGN_IN, transport: "convex", signIn: null } as const;
const tokens = () => {
  const payload = btoa(JSON.stringify({ sub: "dana", name: "Dana", email: "dana@example.com" }));
  return { accessToken: `header.${payload}.signature`, refreshToken: "fixture", expiresAt: Date.now() + 900_000 };
};

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  localStorage.clear();
});

const picked = (document = "page-a") => ({
  occurrence: { ref: "e1" as ElementRef, recordKey: null },
  target: { purposeId: "buy", recordKey: null, clues: { tagName: "button", role: null, label: "Buy", path: "main:1/button:1" } },
  context: pageState(document, 1).context,
});

function summary(id: string, width: number): ThreadSummary {
  return {
    _id: id,
    status: "open",
    anchor: {
      screen: "pilot",
      viewState: {},
      target: picked().target,
      scope: "shared",
      evidence: { url: "https://shop.example.com/pilot", viewport: { width, height: 800 }, marker: null, capturedAt: 1, revision: null, userAgent: null, persona: null },
    },
    location: null,
    tags: [],
    createdAt: 1,
    lastMessageAt: 1,
    messageCount: 1,
    unread: false,
    preview: { body: "Too small on phones", authorName: "Lee Reviewer", authorImageUrl: null },
  };
}

/** The panel in a review page, signed out, over a scripted page layer. */
async function reviewPanel(
  options: { backend?: Partial<FakeBackend>; signedIn?: boolean; answers?: Parameters<typeof scriptedPage>[0]; panel?: ReviewSurface["panel"]; connections?: boolean; withoutReview?: boolean } = {},
) {
  let shown = pageState("page-a", 1);
  const page = scriptedPage({ display: async () => shown, measure: measured, capture: async () => ({ status: "captured", image: new Blob(["png"]) }), reveal: async () => ({ status: "failed", reason: "not here", keepOccurrence: false }), ...options.answers });
  const link = new PageLink(page.endpoint, { initial: shown });
  const created: NewThread[] = [];
  if (options.signedIn) localStorage.setItem(`critiqs:session:${SIGN_IN}`, JSON.stringify(tokens()));
  const session = new Session(SIGN_IN, localStorage, async () => new Response(null, { status: 204 }));
  const backend: FakeBackend = { project: { _id: "project", name: "Acme", tags: [], createdAt: 1, reviewUrl: null, isOwner: false }, threads: [], ...options.backend };
  const transport = { ...fakeTransport(backend), createThread: async (thread: NewThread) => (created.push(thread), "thread-new") };
  const calls: string[] = [];
  let finishSignIn: (signedIn: boolean) => void = () => {};
  let mode: "browse" | "comment" = "comment";
  let projectId: string | null = options.signedIn ? "project" : null;
  const review: ReviewSurface = {
    get mode() {
      return mode;
    },
    onModeChange: (next) => {
      calls.push(`mode:${next}`);
      mode = next;
      render();
    },
    ensureReviewer: () => {
      calls.push("ensureReviewer");
      return new Promise<boolean>((resolve) => (finishSignIn = resolve));
    },
    onThreadOpened: async (width) => {
      calls.push(`width:${width}`);
    },
    ...(options.panel === undefined ? {} : { panel: options.panel }),
  };
  host = document.createElement("div");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const container = document.createElement("div");
  shadow.append(container);
  root = createRoot(container);
  const render = () =>
    root!.render(
      <TransportContext.Provider value={transport}>
        <App
          props={{ projectId: projectId ?? undefined }}
          deployment={{ ...deployment, connections: options.connections === true }}
          session={session}
          host={host!}
          page={link}
          review={options.withoutReview === true ? undefined : { ...review, mode }}
        />
      </TransportContext.Provider>,
    );
  await act(async () => render());
  return {
    shadow,
    page,
    created,
    calls,
    /** The review page signs the reviewer in and learns the project, as `ensureReviewer` does. */
    async signIn() {
      await act(async () => {
        session.acceptPanelSignIn(tokens());
        projectId = "project";
        render();
        finishSignIn(true);
      });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    },
    async cancelSignIn() {
      await act(async () => finishSignIn(false));
    },
    async navigate() {
      shown = pageState("page-b", 1);
      await act(async () => page.emit("state", shown));
    },
    async pick(document = "page-a") {
      await act(async () => page.emit("picked", picked(document)));
    },
    rerender: () => act(async () => render()),
  };
}

test("signed out, the reviewer picks and writes; posting signs them in and keeps the draft, which is then posted", async () => {
  const panel = await reviewPanel();
  // No toolbar of the panel's own, and no sign-in popup on entering Comment mode.
  expect(panel.shadow.querySelector('button[aria-label="Comment mode"]') === null).toBe(true);
  await panel.pick();
  const form = panel.shadow.querySelector<HTMLFormElement>('form[aria-label="New comment"]')!;
  expect(form.textContent).toContain("You'll sign in with your email when you post");
  await typeInto(commentField(form)!, "The buy button is cut off");
  await act(async () => form.requestSubmit());
  expect(panel.calls).toContain("ensureReviewer");
  expect(panel.created).toEqual([]);
  // Signing in (null → reviewer) keeps the selection and the text.
  await panel.signIn();
  expect(panel.created.map((thread) => thread.body)).toEqual(["The buy button is cut off"]);
  expect(panel.created[0]!.projectId).toBe("project");
  expect(panel.calls).not.toContain("mode:browse");
});

test("a sign-in that's cancelled keeps the draft to post later", async () => {
  const panel = await reviewPanel();
  await panel.pick();
  const form = panel.shadow.querySelector<HTMLFormElement>('form[aria-label="New comment"]')!;
  await typeInto(commentField(form)!, "Keep me");
  await act(async () => form.requestSubmit());
  await panel.cancelSignIn();
  const still = panel.shadow.querySelector<HTMLFormElement>('form[aria-label="New comment"]')!;
  expect(fieldText(commentField(still)!)).toBe("Keep me");
  expect(still.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  expect(panel.created).toEqual([]);
});

test("AT-25: the frame navigating during sign-in drops the selection, keeps the text, and posts nothing about the old page", async () => {
  const panel = await reviewPanel();
  await panel.pick();
  const form = panel.shadow.querySelector<HTMLFormElement>('form[aria-label="New comment"]')!;
  await typeInto(commentField(form)!, "Price is wrong");
  await act(async () => form.requestSubmit());
  await panel.navigate();
  await panel.signIn();
  expect(panel.created).toEqual([]);
  expect(panel.shadow.querySelector('form[aria-label="New comment"]') === null).toBe(true);
  expect(panel.shadow.textContent).toContain("Your comment's text is kept");
  // Selecting again on the new page brings the text back with the new element.
  await panel.pick("page-b");
  const again = panel.shadow.querySelector<HTMLFormElement>('form[aria-label="New comment"]')!;
  expect(fieldText(commentField(again)!)).toBe("Price is wrong");
});

test("opening a thread from the list shows the frame at its width first", async () => {
  const panel = await reviewPanel({ signedIn: true, backend: { threads: [summary("t1", 390)] } });
  const item = [...panel.shadow.querySelectorAll<HTMLElement>("aside.sidebar button")].find((element) => element.textContent?.includes("Too small on phones"));
  expect(item).toBeDefined();
  await act(async () => item!.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(panel.calls).toContain("width:390");
});

test("the sidebar stays open with no close button", async () => {
  const panel = await reviewPanel();
  expect(panel.shadow.querySelector("aside.sidebar")).not.toBeNull();
  expect(panel.shadow.querySelector('button[aria-label="Close sidebar"]') === null).toBe(true);
});

test("on a narrow screen the sidebar is a sheet: shown while the page opens it, closed by its own button", async () => {
  const closed: string[] = [];
  const shut = await reviewPanel({ panel: { layout: "sheet", open: false, onClose: () => void closed.push("close") } });
  expect(shut.shadow.querySelector("aside.sidebar") === null).toBe(true);
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  const open = await reviewPanel({ panel: { layout: "sheet", open: true, onClose: () => void closed.push("close") } });
  const sheet = open.shadow.querySelector<HTMLElement>("aside.sidebar.sheet")!;
  expect(sheet).not.toBeNull();
  // The full width of the window, not the side panel's: no width of its own and no edge to drag.
  expect(sheet.style.width).toBe("");
  expect(open.shadow.querySelector(".sidebar-resize") === null).toBe(true);
  const close = open.shadow.querySelector<HTMLButtonElement>('button[aria-label="Close comments"]')!;
  await act(async () => close.click());
  expect(closed).toEqual(["close"]);
});

test("with the sheet down, a comment's composer has the window's whole width", async () => {
  const panel = await reviewPanel({ panel: { layout: "sheet", open: false, onClose: () => undefined } });
  await panel.pick();
  const composer = panel.shadow.querySelector<HTMLElement>('form[aria-label="New comment"]')!;
  expect(composer).not.toBeNull();
  // Centered in the whole window (${window.innerWidth} px here), not in the part left of a sidebar that isn't there.
  expect(Math.round(Number.parseFloat(composer.style.left) + 160)).toBe(Math.round(window.innerWidth / 2));
});

// ---------------------------------------------------------------------------
// The frame's side (reviewEndpoint)

const frameState = (url: string, located: PageState["located"] = {}): PageState => ({ ...pageState("doc", 1), url, located });
const frame = { frameOrigin: FRAME, mapUrl: (url: URL) => `https://shop.example.com${url.pathname}` };

test("AT-24: addresses the frame reports must be on its lease origin, and are mapped", () => {
  expect(mapFrameUrl(frame, `${FRAME}/products/42?secret=1#x`)).toBe("https://shop.example.com/products/42");
  for (const spoofed of ["https://evil.com/x", "file:///etc/passwd", "javascript:alert(1)", "about:blank", `${FRAME.replace("https", "http")}/x`, "https://v-abcdefghijklmnopqrstuvwxyz.review.example.evil.com/", "not a url"]) {
    expect(mapFrameUrl(frame, spoofed)).toBeNull();
  }
});

test("AT-24: a spoofed measurement fails the request; a spoofed state is ignored", async () => {
  const page = scriptedPage({ measure: async () => ({ ...(await measured()), url: "https://evil.com/x" }), connect: async () => ({ protocol: 1, state: frameState(`${FRAME}/`) }) });
  const endpoint = reviewEndpoint(page.endpoint, frame);
  await expect(endpoint.request("measure", { ref: null })).rejects.toBeInstanceOf(PageLayerError);
  const seen: string[] = [];
  endpoint.on("state", (state) => seen.push(state.url));
  page.emit("state", frameState("https://evil.com/x"));
  page.emit("state", frameState(`${FRAME}/ok`));
  expect(seen).toEqual(["https://shop.example.com/ok"]);
});

test("AT-23: threads reach the frame only as aliases with generic labels, and come back as themselves", async () => {
  const sent: unknown[] = [];
  const page = scriptedPage({ display: async (params) => (sent.push(params), frameState(`${FRAME}/`, { p1: { status: "not-found" }, p9: { status: "not-found" } })), reveal: async (params) => (sent.push(params), { status: "failed", reason: "x", keepOccurrence: false }) });
  const endpoint = reviewEndpoint(page.endpoint, frame);
  const location = { screen: "s", viewState: {}, target: picked().target, scope: "shared" as const };
  const state = await endpoint.request("display", {
    hidden: false,
    exposedRight: null,
    watch: [{ threadId: "jd7realthreadid", location }],
    pins: [{ threadId: "jd7realthreadid", authorName: "Lee Reviewer", unread: true, resolved: false }, { threadId: "jd7otherthread", authorName: "Dana Owner", unread: false, resolved: true }],
    selected: { threadId: "jd7realthreadid", ref: null },
    highlight: null,
    picking: null,
    picked: null,
  });
  await endpoint.request("reveal", { threadId: "jd7otherthread", location, chosen: null });
  const wire = JSON.stringify(sent);
  expect(wire).not.toContain("jd7");
  expect(wire).not.toContain("Lee Reviewer");
  expect(wire).not.toContain("Dana Owner");
  expect(wire.match(/"authorName":"Reviewer"/g)?.length).toBe(2);
  // Located comes back by real ID; an alias the panel never sent is dropped.
  expect(Object.keys(state.located)).toEqual(["jd7realthreadid"]);
  const pins: string[] = [];
  endpoint.on("pin", ({ threadId }) => pins.push(threadId));
  page.emit("pin", { threadId: "p2", occurrence: { ref: "e1" as ElementRef, recordKey: null } });
  page.emit("pin", { threadId: "p77", occurrence: { ref: "e1" as ElementRef, recordKey: null } });
  expect(pins).toEqual(["jd7otherthread"]);
});

// ---------------------------------------------------------------------------
// mountPanel for a review frame

/** A transport whose page layer answers `connect` with a state whose screen is `screenLength` characters. */
function answeringTransport(screenLength: number) {
  let receive: (message: unknown) => void = () => {};
  return {
    send(message: PageMessage) {
      if (message.kind !== "request" || message.method !== "connect") return;
      const state = { ...pageState("doc", 1), url: `${FRAME}/`, context: { screen: "s".repeat(screenLength), viewState: {}, persona: null } };
      queueMicrotask(() => receive({ tag: "critiqs:page-layer", v: 1, channel: message.channel, kind: "result", id: message.id, result: { protocol: 1, state } }));
    },
    listen(handler: (message: unknown) => void) {
      receive = handler;
      return () => {};
    },
    onClose: () => () => {},
    close() {},
  };
}

test("AT-16 in the review page: a review frame always gets the untrusted limits", async () => {
  const { mountPanel } = await import("../src/page-layer/mount.tsx");
  const connects = async (review: boolean) => {
    const container = document.body.appendChild(document.createElement("div"));
    const mounted = mountPanel(container, {
      transport: answeringTransport(20_000),
      channel: "review-link",
      backend: "https://backend.invalid",
      ...(review ? { review: { frameOrigin: FRAME, mapUrl: (url: URL) => `https://shop.example.com${url.pathname}`, mode: "comment" as const, onModeChange() {}, ensureReviewer: async () => false } } : {}),
    });
    const shown = await Promise.race([mounted.ready.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 150))]);
    mounted.destroy();
    container.remove();
    return shown;
  };
  // Installed limits take the host's 20,000-character screen; a review frame's are refused.
  expect(await connects(false)).toBe(true);
  expect(await connects(true)).toBe(false);
});

test("the review page's panel never reports Connected: the review page isn't the prototype's own page", async () => {
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  const originalUrl = window.location.href;
  const setUrl = (url: string) => (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);
  // The review page is an https page, as a prototype is: only the panel's place tells them apart.
  setUrl("https://critiqs.example/r/key");
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    const reported = () => asked.filter((url) => url === `${deployment.siteUrl}/critiqs/connected`).length;
    const review = await reviewPanel({ signedIn: true, connections: true });
    await review.rerender();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(reported()).toBe(0);
    // The same panel on a page of its own, as an install is, reports it.
    await act(async () => root?.unmount());
    host?.remove();
    await reviewPanel({ signedIn: true, connections: true, withoutReview: true });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(reported()).toBe(1);
  } finally {
    globalThis.fetch = realFetch;
    setUrl(originalUrl);
  }
});
