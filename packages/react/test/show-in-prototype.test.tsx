import { afterEach, expect, test } from "bun:test";
import type { Anchor, ThreadDetail, ThreadSummary, ViewState } from "@critiqs/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import type { CritiqsProps, RestoreRequest } from "../src/host.ts";
import { Session } from "../src/session.ts";
import { TransportContext } from "../src/transport.ts";
import { type FakeBackend, fakeTransport } from "./fake-transport.tsx";

// Showing a thread where it was left: its saved screen and view state, then its
// target with the thread window beside the pin.

const originalUrl = window.location.href;
const SIGN_IN = "https://auth.example";
const target = { purposeId: "review", recordKey: null, clues: { tagName: "button", role: null, label: "Review", path: "main:1/button:1" } };
const SAVED_VIEW: ViewState = { programId: "program-123", tab: "course-library" };

function anchorFor(viewState: ViewState): Anchor {
  return {
    screen: "patient-engagement",
    viewState,
    scope: "shared",
    target,
    evidence: {
      url: "https://prototype.example/patient-education",
      capturedAt: 1,
      revision: "v1",
      persona: null,
      viewport: { width: 800, height: 600 },
      marker: { x: 0, y: 0, width: 10, height: 10 },
      userAgent: "Browser",
    },
  };
}

function summaryOf(anchor: Anchor, status: "open" | "resolved" = "open"): ThreadSummary {
  return {
    _id: "thread",
    status,
    anchor,
    location: null,
    tags: [],
    createdAt: 1,
    lastMessageAt: 1,
    messageCount: 1,
    unread: false,
    preview: { body: "Align the review button", authorName: "Dana", authorImageUrl: null },
  };
}

function detailOf(anchor: Anchor, status: "open" | "resolved" = "open"): ThreadDetail {
  return {
    _id: "thread",
    status,
    anchor,
    tags: [],
    capture: { status: "failed", failureReason: "Blocked by the browser." },
    createdAt: 1,
    lastMessageAt: 1,
    messageCount: 1,
    projectId: "project",
    statusChangedByName: null,
    reattachedByName: null,
    readState: { lastReadAt: 1, manualUnread: false },
    messages: [
      {
        _id: "message",
        body: "Align the review button",
        createdAt: 1,
        editedAt: null,
        revision: "v1",
        author: { name: "Dana", imageUrl: null },
        isMine: false,
        reactions: [],
        mentions: [],
      },
    ],
  };
}

const backend: FakeBackend = { project: { _id: "project", name: "Pilot", tags: [], createdAt: 1, reviewUrl: null, isOwner: true }, threads: [], thread: undefined };

function useThread(viewState: ViewState, status: "open" | "resolved" = "open") {
  const anchor = anchorFor(viewState);
  backend.threads = [summaryOf(anchor, status)];
  backend.thread = detailOf(anchor, status);
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let page: HTMLElement | null = null;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  page?.remove();
  page = null;
  localStorage.clear();
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(originalUrl);
});

const DEFAULT_PLACES = [
  { x: 40, y: 80, width: 120, height: 30 },
  { x: 40, y: 400, width: 120, height: 30 },
];

/** Matching buttons laid out at fixed places, as a tab of the prototype renders them. */
function renderTargets(count: number, at: { x: number; y: number; width: number; height: number }[] = DEFAULT_PLACES) {
  page?.remove();
  page = document.createElement("main");
  const places = at.slice(0, count);
  for (const place of places) {
    const button = document.createElement("button");
    button.setAttribute("data-critiqs-id", "review");
    button.textContent = "Review";
    button.getBoundingClientRect = () => new DOMRect(place.x, place.y, place.width, place.height);
    button.getClientRects = () => [new DOMRect(place.x, place.y, place.width, place.height)] as unknown as DOMRectList;
    (button as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true;
    page.append(button);
  }
  document.body.append(page);
  return Array.from(page.querySelectorAll("button"));
}

/** A small app whose screen and view state Critiqs reads, as a host's router would hold them. */
function prototypeState(initial: { screen: string; viewState: ViewState }) {
  const state = { ...initial, viewState: { ...initial.viewState } };
  return {
    state,
    getContext: () => ({ screen: state.screen, viewState: { ...state.viewState } }),
  };
}

/** Dana's sign-in, as the sign-in window or another tab stores it. */
function storeSignIn() {
  const payload = btoa(JSON.stringify({ sub: "dana", name: "Dana", email: "dana@example.com" }));
  localStorage.setItem(
    `critiqs:session:${SIGN_IN}`,
    JSON.stringify({ accessToken: `header.${payload}.signature`, refreshToken: "fixture-token", expiresAt: Date.now() + 900_000 }),
  );
}

async function mount(
  integration: Partial<CritiqsProps>,
  { sidebarOpen = true, signedIn = true, openThread, url }: { sidebarOpen?: boolean; signedIn?: boolean; openThread?: string; url?: string } = {},
) {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(
    url ?? (window.location.href.includes("critiqs=") ? window.location.href : "https://prototype.example/patient-education"),
  );
  if (signedIn) storeSignIn();
  localStorage.setItem("critiqs:sidebar-open", JSON.stringify(sidebarOpen));
  host = document.createElement("critiqs-root");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const container = document.createElement("div");
  shadow.append(container);
  root = createRoot(container);
  const session = new Session(SIGN_IN, localStorage, async () => new Response(null, { status: 204 }));
  await act(async () =>
    root!.render(
      <TransportContext.Provider value={fakeTransport(backend)}>
        <App
          props={{ projectId: "project", ...integration }}
          deployment={{ backendUrl: "https://backend.convex.cloud", siteUrl: "https://backend.convex.site", signInUrl: SIGN_IN, transport: "convex", signIn: null }}
          session={session}
          host={host!} shadow={host!.shadowRoot!}
          openThread={openThread}
        />
      </TransportContext.Provider>,
    ),
  );
  await frames();
  // The comments list is Comment mode's side panel; Browse mode's shows the project.
  if (sidebarOpen && signedIn) await act(async () => shadow.querySelector<HTMLButtonElement>('[aria-label="Comment mode"]')!.click());
  return shadow;
}

async function frames(count = 3) {
  for (let i = 0; i < count; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
}

/** Waits, in real time, for something that happens after Critiqs's restore timeout or an async host. */
async function until(check: () => boolean, ms = 4000) {
  const started = Date.now();
  while (!check() && Date.now() - started < ms) await frames(1);
}

const threadWindow = (shadow: ShadowRoot) => shadow.querySelector<HTMLElement>('section[aria-label="Comment thread"]');
const isDocked = (shadow: ShadowRoot) => threadWindow(shadow)?.classList.contains("docked") === true;
const pins = (shadow: ShadowRoot) => Array.from(shadow.querySelectorAll<HTMLButtonElement>(".pin"));
const highlighted = (shadow: ShadowRoot) => shadow.querySelector(".highlight") !== null;
const openFromList = (shadow: ShadowRoot) => act(async () => shadow.querySelector<HTMLButtonElement>(".entry")!.click());
const showButton = (shadow: ShadowRoot) =>
  Array.from(threadWindow(shadow)!.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === "Show in prototype")!;

test("a restore handler switches to the saved tab, then the thread opens beside its pin", async () => {
  useThread(SAVED_VIEW);
  const app = prototypeState({ screen: "patient-engagement", viewState: { programId: "program-123", tab: "content" } });
  const requests: RestoreRequest[] = [];
  const shadow = await mount({
    getContext: app.getContext,
    restoreContext: (request) => {
      requests.push(request);
      app.state.viewState = { ...request.viewState };
      renderTargets(2);
      return true;
    },
  });
  await openFromList(shadow);
  await frames();

  expect(requests.map(({ screen, viewState, scope }) => ({ screen, viewState, scope }))).toEqual([
    { screen: "patient-engagement", viewState: SAVED_VIEW, scope: "shared" },
  ]);
  expect(app.state.viewState.tab).toBe("course-library");
  expect(pins(shadow).length).toBe(2);
  expect(pins(shadow).filter((pin) => pin.getAttribute("aria-expanded") === "true").length).toBe(1);
  expect(highlighted(shadow)).toBe(true);
  expect(isDocked(shadow)).toBe(false);
  expect(threadWindow(shadow)!.textContent).toContain("Align the review button");
});

test("a matching element shown in a different view doesn't count: the saved view is restored", async () => {
  useThread(SAVED_VIEW);
  const app = prototypeState({ screen: "patient-engagement", viewState: { programId: "program-123", tab: "content" } });
  renderTargets(1);
  let restores = 0;
  const shadow = await mount({
    getContext: app.getContext,
    restoreContext: (request) => {
      restores++;
      app.state.viewState = { ...request.viewState };
      renderTargets(2);
      return true;
    },
  });
  await openFromList(shadow);
  await frames();

  expect(restores).toBe(1);
  expect(app.state.viewState.tab).toBe("course-library");
  expect(isDocked(shadow)).toBe(false);
  expect(highlighted(shadow)).toBe(true);
});

test("Show in prototype restores the saved view after the thread was opened from a pin elsewhere", async () => {
  useThread(SAVED_VIEW);
  const app = prototypeState({ screen: "patient-engagement", viewState: { programId: "program-123", tab: "content" } });
  renderTargets(1);
  let restores = 0;
  const shadow = await mount(
    {
      getContext: app.getContext,
      restoreContext: (request) => {
        restores++;
        app.state.viewState = { ...request.viewState };
        renderTargets(2);
        return true;
      },
    },
    { sidebarOpen: false },
  );
  // Clicking the pin in this view opens the thread here, without restoring.
  await act(async () => pins(shadow)[0]!.click());
  await frames();
  expect(restores).toBe(0);
  expect(isDocked(shadow)).toBe(false);

  await act(async () => showButton(shadow).click());
  await frames();
  expect(restores).toBe(1);
  expect(app.state.viewState.tab).toBe("course-library");
  expect(isDocked(shadow)).toBe(false);
  expect(highlighted(shadow)).toBe(true);
});

test("in the saved view, Show in prototype keeps the clicked pin of a shared thread", async () => {
  useThread(SAVED_VIEW);
  const app = prototypeState({ screen: "patient-engagement", viewState: SAVED_VIEW });
  renderTargets(2);
  let restores = 0;
  const shadow = await mount(
    { getContext: app.getContext, restoreContext: () => void restores++ },
    { sidebarOpen: false },
  );
  const second = pins(shadow).find((pin) => Number.parseFloat(pin.style.top) > 300)!;
  await act(async () => second.click());
  await frames();
  await act(async () => showButton(shadow).click());
  await frames();

  expect(restores).toBe(0);
  const expanded = pins(shadow).filter((pin) => pin.getAttribute("aria-expanded") === "true");
  expect(expanded.length).toBe(1);
  expect(Number.parseFloat(expanded[0]!.style.top)).toBeGreaterThan(300);
  expect(Number.parseFloat(threadWindow(shadow)!.style.top)).toBeGreaterThan(300);
});

test("a restore that leaves the app on another screen is reported, not shown on a lookalike", async () => {
  useThread(SAVED_VIEW);
  const app = prototypeState({ screen: "insights", viewState: {} });
  // Opened from a link, since the list shows this screen's threads.
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://prototype.example/insights?critiqs=thread");
  const shadow = await mount({
    getContext: app.getContext,
    // Claims success and renders a matching element, but the app never leaves Insights.
    restoreContext: () => {
      renderTargets(1);
      return true;
    },
  });
  await until(() => threadWindow(shadow)?.textContent?.includes("didn't open") === true);

  expect(threadWindow(shadow)!.textContent).toContain("The prototype didn't open patient-engagement.");
  expect(threadWindow(shadow)!.textContent).toContain("The saved context is shown above.");
  expect(highlighted(shadow)).toBe(false);
  expect(isDocked(shadow)).toBe(true);
}, 10_000);

test("a restore that keeps the wrong tab is reported, even when a matching element is shown", async () => {
  useThread(SAVED_VIEW);
  const app = prototypeState({ screen: "patient-engagement", viewState: { programId: "program-123", tab: "content" } });
  renderTargets(1);
  const shadow = await mount({ getContext: app.getContext, restoreContext: () => true });
  await openFromList(shadow);
  await until(() => threadWindow(shadow)?.textContent?.includes("didn't open") === true);

  expect(threadWindow(shadow)!.textContent).toContain("The prototype didn't open the saved view (programId: program-123, tab: course-library).");
  expect(highlighted(shadow)).toBe(false);
  expect(isDocked(shadow)).toBe(true);
}, 10_000);

test("a thread saved before the host reported a key is restored, then shown in the host's reading of it", async () => {
  // Saved before the host recorded the selected item; the app now reports one.
  useThread(SAVED_VIEW);
  const app = prototypeState({ screen: "patient-engagement", viewState: { ...SAVED_VIEW, contentItemId: "item-2" } });
  renderTargets(1);
  const requests: RestoreRequest[] = [];
  const shadow = await mount({
    getContext: app.getContext,
    restoreContext: (request) => {
      requests.push(request);
      // The host reads the missing key as its first item.
      app.state.viewState = { ...request.viewState, contentItemId: "item-1" };
      return true;
    },
  });
  await openFromList(shadow);
  await frames();

  // The lookalike in item 2 didn't count; the view was restored before the pin was shown.
  expect(requests.map((request) => request.viewState)).toEqual([SAVED_VIEW]);
  expect(app.state.viewState.contentItemId).toBe("item-1");
  expect(highlighted(shadow)).toBe(true);
  expect(isDocked(shadow)).toBe(false);
});

test("after restoring, every key the thread names must match, null included", async () => {
  const saved: ViewState = { ...SAVED_VIEW, contentItemId: "item-1", contentPanel: null };
  useThread(saved);
  const app = prototypeState({ screen: "patient-engagement", viewState: { ...SAVED_VIEW, contentItemId: "item-2", contentPanel: null } });
  renderTargets(1);
  const shadow = await mount({
    getContext: app.getContext,
    // Selects the item but leaves a panel open that the thread recorded as closed.
    restoreContext: () => {
      app.state.viewState = { ...SAVED_VIEW, contentItemId: "item-1", contentPanel: "edit" };
      return true;
    },
  });
  await openFromList(shadow);
  await until(() => threadWindow(shadow)?.textContent?.includes("didn't open") === true);

  expect(threadWindow(shadow)!.textContent).toContain(
    "The prototype didn't open the saved view (programId: program-123, tab: course-library, contentItemId: item-1).",
  );
  expect(highlighted(shadow)).toBe(false);
  expect(isDocked(shadow)).toBe(true);
}, 10_000);

test("without a restore handler, a lookalike in another view isn't shown; the saved view is named", async () => {
  useThread(SAVED_VIEW);
  const app = prototypeState({ screen: "patient-engagement", viewState: { programId: "program-123", tab: "content" } });
  renderTargets(1);
  const shadow = await mount({ getContext: app.getContext });
  await openFromList(shadow);
  await frames();

  expect(threadWindow(shadow)!.textContent).toContain(
    "This comment was left in another view (programId: program-123, tab: course-library), and this prototype doesn't restore views automatically.",
  );
  expect(highlighted(shadow)).toBe(false);
  expect(isDocked(shadow)).toBe(true);
  expect(app.state.viewState.tab).toBe("content");
});

test("content that loads after the restore resolves is waited for", async () => {
  useThread(SAVED_VIEW);
  const app = prototypeState({ screen: "patient-engagement", viewState: { tab: "content" } });
  const shadow = await mount({
    getContext: app.getContext,
    restoreContext: async (request) => {
      // The router updates on its next render, and the tab's content loads later still.
      setTimeout(() => {
        app.state.viewState = { ...request.viewState };
      }, 80);
      setTimeout(() => renderTargets(1), 250);
      return true;
    },
  });
  await openFromList(shadow);
  expect(threadWindow(shadow)!.textContent).toContain("Restoring the view…");
  await until(() => highlighted(shadow));

  expect(highlighted(shadow)).toBe(true);
  expect(isDocked(shadow)).toBe(false);
  expect(pins(shadow).length).toBe(1);
});

test("a target missing from the restored view is reported with the saved context", async () => {
  useThread(SAVED_VIEW);
  const app = prototypeState({ screen: "patient-engagement", viewState: { tab: "content" } });
  const shadow = await mount({
    getContext: app.getContext,
    restoreContext: (request) => {
      app.state.viewState = { ...request.viewState };
      return true;
    },
  });
  await openFromList(shadow);
  await until(() => threadWindow(shadow)?.textContent?.includes("couldn't be found") === true);

  expect(threadWindow(shadow)!.textContent).toContain("The element couldn't be found after restoring the view.");
  expect(isDocked(shadow)).toBe(true);
  expect(highlighted(shadow)).toBe(false);
}, 10_000);

test("a host that declines, such as to keep unsaved work, keeps its view and the saved context is shown", async () => {
  useThread(SAVED_VIEW);
  const app = prototypeState({ screen: "patient-engagement", viewState: { tab: "content" } });
  const shadow = await mount({ getContext: app.getContext, restoreContext: () => false });
  await openFromList(shadow);
  await frames();

  expect(app.state.viewState.tab).toBe("content");
  expect(threadWindow(shadow)!.textContent).toContain("The prototype couldn't show this view right now.");
  expect(isDocked(shadow)).toBe(true);
});

test("closing the thread cancels a restore in progress, and its late result changes nothing", async () => {
  useThread(SAVED_VIEW);
  const app = prototypeState({ screen: "patient-engagement", viewState: { tab: "content" } });
  let finish: (shown: boolean) => void = () => undefined;
  let signal: AbortSignal | null = null;
  const shadow = await mount({
    getContext: app.getContext,
    restoreContext: (request) => {
      signal = request.signal;
      return new Promise<boolean>((resolve) => {
        finish = resolve;
      });
    },
  });
  await openFromList(shadow);
  await frames();
  expect(threadWindow(shadow)!.textContent).toContain("Restoring the view…");

  await act(async () => {
    threadWindow(shadow)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(threadWindow(shadow)).toBeNull();
  expect(signal!.aborted).toBe(true);

  // The host finishes anyway; Critiqs neither reopens nor highlights the thread.
  app.state.viewState = { ...SAVED_VIEW };
  renderTargets(1);
  await act(async () => finish(true));
  await frames();
  expect(threadWindow(shadow)).toBeNull();
  expect(highlighted(shadow)).toBe(false);
});

test("opening the thread again supersedes an earlier restore", async () => {
  useThread(SAVED_VIEW);
  const app = prototypeState({ screen: "patient-engagement", viewState: { tab: "content" } });
  const signals: AbortSignal[] = [];
  const shadow = await mount({
    getContext: app.getContext,
    restoreContext: (request) => {
      signals.push(request.signal);
      if (signals.length === 1) return new Promise<boolean>(() => undefined);
      app.state.viewState = { ...request.viewState };
      renderTargets(1);
      return true;
    },
  });
  await openFromList(shadow);
  await frames();
  await openFromList(shadow);
  await frames();

  expect(signals.length).toBe(2);
  expect(signals[0]!.aborted).toBe(true);
  expect(signals[1]!.aborted).toBe(false);
  expect(highlighted(shadow)).toBe(true);
  expect(isDocked(shadow)).toBe(false);
});

test("a link to a resolved thread restores its view and shows its pin, despite the open-only filter", async () => {
  useThread(SAVED_VIEW, "resolved");
  const app = prototypeState({ screen: "patient-engagement", viewState: { tab: "content" } });
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(
    "https://prototype.example/patient-education?critiqs=thread",
  );
  const shadow = await mount(
    {
      getContext: app.getContext,
      restoreContext: (request) => {
        app.state.viewState = { ...request.viewState };
        renderTargets(1);
        return true;
      },
    },
    { sidebarOpen: false },
  );
  await frames();

  expect(app.state.viewState.tab).toBe("course-library");
  expect(threadWindow(shadow)!.textContent).toContain("Resolved");
  expect(pins(shadow).length).toBe(1);
  expect(pins(shadow)[0]!.getAttribute("aria-expanded")).toBe("true");
  expect(isDocked(shadow)).toBe(false);
});

test("a link to the review page opens the thread on its saved screen, keeping the page's path and hash route", async () => {
  // Emails link to the project's review page, not the screen the comment was left on.
  useThread(SAVED_VIEW);
  const app = prototypeState({ screen: "home", viewState: {} });
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://prototype.example/app/?env=demo&critiqs=thread.message#/home");
  const requests: RestoreRequest[] = [];
  const shadow = await mount(
    {
      getContext: app.getContext,
      restoreContext: (request) => {
        requests.push(request);
        app.state.screen = request.screen;
        app.state.viewState = { ...request.viewState };
        renderTargets(1);
        return true;
      },
    },
    { sidebarOpen: false },
  );
  await frames();

  expect(requests.map((request) => [request.screen, request.viewState])).toEqual([["patient-engagement", SAVED_VIEW]]);
  expect(pins(shadow)[0]!.getAttribute("aria-expanded")).toBe("true");
  expect(isDocked(shadow)).toBe(false);
  expect(window.location.href).toBe("https://prototype.example/app/?env=demo#/home");
});

test("a link opened while signed out waits for sign-in, then restores the thread's view", async () => {
  useThread(SAVED_VIEW);
  const app = prototypeState({ screen: "home", viewState: {} });
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://prototype.example/app/?critiqs=thread.message");
  const requests: RestoreRequest[] = [];
  const restoreContext = (request: RestoreRequest) => {
    requests.push(request);
    app.state.screen = request.screen;
    app.state.viewState = { ...request.viewState };
    renderTargets(1);
    return true;
  };
  const shadow = await mount({ getContext: app.getContext, restoreContext }, { sidebarOpen: false, signedIn: false });
  expect(shadow.textContent).toContain("Sign in to open the linked comment");
  expect(requests).toEqual([]);
  expect(window.location.href).toBe("https://prototype.example/app/?critiqs=thread.message");

  storeSignIn();
  await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: `critiqs:session:${SIGN_IN}` })));
  await frames();
  expect(requests.map((request) => request.screen)).toEqual(["patient-engagement"]);
  expect(pins(shadow)[0]!.getAttribute("aria-expanded")).toBe("true");
  expect(window.location.href).toBe("https://prototype.example/app/");
});

test("a link to the review page in a prototype that can't restore views shows the saved context", async () => {
  useThread(SAVED_VIEW);
  const app = prototypeState({ screen: "home", viewState: {} });
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://prototype.example/app/?critiqs=thread");
  const shadow = await mount({ getContext: app.getContext }, { sidebarOpen: false });
  await frames();

  expect(threadWindow(shadow)!.textContent).toContain("This comment is on patient-engagement, and this prototype doesn't restore views automatically.");
  expect(isDocked(shadow)).toBe(true);
  expect(window.location.href).toBe("https://prototype.example/app/");
});

test("the revealed target is scrolled into view", async () => {
  useThread(SAVED_VIEW);
  const app = prototypeState({ screen: "patient-engagement", viewState: { tab: "content" } });
  const scrolled: Element[] = [];
  const shadow = await mount({
    getContext: app.getContext,
    restoreContext: (request) => {
      app.state.viewState = { ...request.viewState };
      for (const button of renderTargets(1)) button.scrollIntoView = () => void scrolled.push(button);
      return true;
    },
  });
  await openFromList(shadow);
  await frames();

  expect(scrolled.length).toBe(1);
  expect(scrolled[0]!.isConnected).toBe(true);
});

for (const closeWhileMoving of [false, true]) {
  test(`a restored preview finishes moving before scrolling${closeWhileMoving ? ", and closing cancels it" : ""}`, async () => {
    useThread(SAVED_VIEW);
    const app = prototypeState({ screen: "patient-engagement", viewState: { tab: "content" } });
    let finishMotion!: () => void;
    const finished = new Promise<void>((resolve) => { finishMotion = resolve; });
    const scrolled: ScrollIntoViewOptions[] = [];
    const shadow = await mount({
      getContext: app.getContext,
      restoreContext: (request) => {
        app.state.viewState = { ...request.viewState };
        const [button] = renderTargets(1);
        button!.scrollIntoView = (options) => { scrolled.push(options as ScrollIntoViewOptions); };
        Object.assign(page!, { getAnimations: () => [{ playState: "running", effect: { getComputedTiming: () => ({ endTime: 300 }) }, finished }] });
        return true;
      },
    });
    await openFromList(shadow);
    await frames();
    expect(scrolled).toEqual([]);
    if (closeWhileMoving) {
      const close = threadWindow(shadow)!.querySelector<HTMLButtonElement>('button[aria-label="Close comment"]')!;
      await act(async () => close.click());
    }
    await act(async () => finishMotion());
    await frames();
    expect(scrolled).toEqual(closeWhileMoving ? [] : [{ block: "center", inline: "nearest", behavior: "instant" }]);
  });
}

test("a resolved thread opened from search shows its pin while the list shows open threads", async () => {
  useThread(SAVED_VIEW, "resolved");
  const app = prototypeState({ screen: "patient-engagement", viewState: SAVED_VIEW });
  renderTargets(1);
  backend.search = async () => ({
    mode: "basic",
    notice: null,
    query: { terms: ["review"], tags: [], groupIds: [], status: "all", screen: null, since: null, until: null },
    results: [
      { threadId: "thread", status: "resolved", screen: "patient-engagement", tags: [], lastMessageAt: 1, messageCount: 1, preview: { body: "Align the review button", authorName: "Dana" }, matches: [] },
    ],
    truncated: false,
    insights: [],
    insightNotice: null,
  });
  try {
    const shadow = await mount({ getContext: app.getContext, restoreContext: () => true });
    // The default filter shows open threads only, so the resolved thread has no pin yet.
    expect(pins(shadow).length).toBe(0);
    const field = shadow.querySelector<HTMLInputElement>('input[aria-label="Search feedback"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "review");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => field.form!.requestSubmit());
    await frames();
    await act(async () => shadow.querySelector<HTMLButtonElement>(".sidebar .entry")!.click());
    await frames();

    expect(pins(shadow).length).toBe(1);
    expect(pins(shadow)[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(isDocked(shadow)).toBe(false);
    expect(threadWindow(shadow)!.textContent).toContain("Resolved");
  } finally {
    backend.search = undefined;
  }
});

test("a pin stays left of the open sidebar when its target reaches under it", async () => {
  useThread(SAVED_VIEW);
  const app = prototypeState({ screen: "patient-engagement", viewState: { ...SAVED_VIEW } });
  renderTargets(1, [{ x: 560, y: 80, width: 200, height: 30 }]);
  const shadow = await mount({ getContext: app.getContext });
  await openFromList(shadow);
  await frames();

  const exposedRight = window.innerWidth - 360;
  const pin = pins(shadow).find((candidate) => candidate.getAttribute("aria-expanded") === "true")!;
  expect(shadow.querySelector("aside.sidebar")).not.toBeNull();
  expect(Number.parseFloat(pin.style.left)).toBeLessThanOrEqual(exposedRight - 16);
  expect(Number.parseFloat(pin.style.left)).toBeGreaterThanOrEqual(560);
});

test("revealing a target entirely behind the open sidebar closes the sidebar, so its pin and thread show", async () => {
  useThread(SAVED_VIEW);
  const app = prototypeState({ screen: "patient-engagement", viewState: { ...SAVED_VIEW } });
  renderTargets(1, [{ x: window.innerWidth - 200, y: 80, width: 120, height: 30 }]);
  const shadow = await mount({ getContext: app.getContext });
  await openFromList(shadow);
  await frames();

  expect(shadow.querySelector("aside.sidebar")).toBeNull();
  expect(JSON.parse(localStorage.getItem("critiqs:sidebar-open")!)).toBe(false);
  const pin = pins(shadow).find((candidate) => candidate.getAttribute("aria-expanded") === "true")!;
  expect(Number.parseFloat(pin.style.left)).toBeLessThanOrEqual(window.innerWidth - 16);
  expect(isDocked(shadow)).toBe(false);
});

test("replacement motion is settled before the current target is scrolled", async () => {
  useThread(SAVED_VIEW);
  const app = prototypeState({screen: "patient-engagement", viewState: {tab: "content"}});
  let finishOld!: () => void;
  let finishNew!: () => void;
  const oldFinished = new Promise<void>(resolve => {finishOld = resolve;});
  const newFinished = new Promise<void>(resolve => {finishNew = resolve;});
  const scrolled: Element[] = [];
  const shadow = await mount({
    getContext: app.getContext,
    restoreContext: request => {
      app.state.viewState = {...request.viewState};
      renderTargets(1);
      Object.assign(page!, {getAnimations: () => [{playState:"running", effect:{getComputedTiming:() => ({endTime:300})}, finished: oldFinished}]});
      return true;
    }
  });
  await openFromList(shadow);
  await frames();
  const [newButton] = renderTargets(1);
  newButton!.scrollIntoView = () => {scrolled.push(newButton!);};
  Object.assign(page!, {getAnimations: () => [{playState:"running", effect:{getComputedTiming:() => ({endTime:300})}, finished:newFinished}]});
  await act(async () => finishOld());
  await frames();
  const premature = scrolled.length;
  await act(async () => finishNew());
  await frames();
  expect(premature).toBe(0);
  expect(scrolled.map((element) => element === newButton)).toEqual([true]);
});

test("a panel asked to open a comment, as the extension's is after a pin's click, opens it like a link, without touching the page's address", async () => {
  useThread(SAVED_VIEW);
  const app = prototypeState({ screen: "patient-engagement", viewState: { ...SAVED_VIEW } });
  renderTargets(1);
  // An address whose query a rewrite would change: the app's own encoding must stay as it is.
  const address = "https://prototype.example/patient-education?q=red%20shoes&sig=hash~value";
  const shadow = await mount({ getContext: app.getContext, restoreContext: () => true }, { openThread: "thread", url: address });
  await until(() => threadWindow(shadow) !== null);
  await frames();
  expect(window.location.href).toBe(address);
}, 10_000);
