import { afterEach, describe, expect, test } from "bun:test";
import type { PanelSignIn } from "@critiqs/core";
import { act, type ReactNode } from "react";
import type { ReviewOpen } from "../src/backend.ts";
import type { PanelOptions } from "../src/shared.ts";
import { type ReviewHost, ReviewHostContext, ReviewPage } from "../src/ui/ReviewPage.tsx";
import { button, click, fakeAuth, fakeBackend, render, settle, text } from "./render.tsx";

// What keeps a review page's frame where it belongs, and what the page says
// when something stops it: the frame policy the website's host must send,
// the notices a frame can raise (kept apart, each with its own Dismiss), a
// link that ends while the tab is open, and the bar on a phone.

const frameWindows = new WeakMap<HTMLIFrameElement, { postMessage(): void }>();
Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
  configurable: true,
  get(this: HTMLIFrameElement) {
    if (!frameWindows.has(this)) frameWindows.set(this, { postMessage() {} });
    return frameWindows.get(this);
  },
});

const KEY = "e3wpz767dgupur6kns2ox725mg";
const FRAME = `http://v-${"abcdefghijklmnopqrstuvwxyz"}.review.localhost:5960`;
const WALLED = "frame-ancestors 'none'; frame-src http://*.review.localhost:5960";
const ready = (): ReviewOpen => ({
  kind: "ready",
  entry: { origin: FRAME, path: "/products/42", leaseId: "lease-1", renewalSecret: "renewal-secret", expiresAt: Date.now() + 600_000, renewEveryMs: 300_000 },
  projectId: null,
  projectName: null,
  source: { kind: "site", origin: "https://shop.example.com" },
});

function fakeHost(policy: string | null = WALLED) {
  const host = {
    deployment: { backendUrl: "https://backend.convex.cloud", siteUrl: "https://backend.convex.site", signInUrl: "https://backend.convex.site", transport: "convex", signIn: null },
    session: { acceptPanelSignIn: () => undefined } as unknown as ReviewHost["session"],
    mountPanel: async () => (_container: HTMLElement, _options: PanelOptions) => ({ ready: Promise.resolve(), update: () => undefined, destroy: () => undefined }),
    signInClient: undefined as PanelSignIn | undefined,
    extensionUrl: "https://extension.example/critiqs",
    framePolicy: async () => policy,
  } as unknown as ReviewHost;
  return host;
}

const page = (host: ReviewHost, node: ReactNode = <ReviewPage linkKey={KEY} />) => <ReviewHostContext.Provider value={host}>{node}</ReviewHostContext.Provider>;

async function openReview(host: ReviewHost, backend = fakeBackend({ openReviewLink: async () => ready() })) {
  const container = await render(page(host), { backend, auth: fakeAuth(null) });
  await settle();
  await settle();
  await settle();
  return container;
}

const tell = async (container: HTMLElement, message: Record<string, unknown>) => {
  const frame = container.querySelector("iframe")!;
  await act(async () => window.dispatchEvent(new MessageEvent("message", { data: { tag: "critiqs:review-frame", v: 1, ...message }, origin: FRAME, source: frame.contentWindow })));
};

const realMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = realMatchMedia;
  localStorage.clear();
});

describe("the frame policy is the only wall that keeps a frame on the review proxy", () => {
  test("served without its frame policy, the review page shows no frame and says what is missing", async () => {
    for (const policy of [null, "frame-ancestors 'none'", "frame-ancestors 'none'; frame-src * blob:"]) {
      const container = await openReview(fakeHost(policy));
      expect([policy, container.querySelector("iframe")]).toEqual([policy, null]);
      expect(text(container)).toContain("can't show this prototype safely");
    }
  });
  test("with it, the frame shows", async () => {
    const container = await openReview(fakeHost());
    expect(container.querySelector("iframe")).not.toBeNull();
  });
});

describe("a frame's notices", () => {
  test("dismissing the extension banner leaves the partial-load notice its own quiet strip with its own Dismiss", async () => {
    const container = await openReview(fakeHost());
    await tell(container, { kind: "left", url: "https://accounts.google.com", signIn: true });
    expect(text(container)).toContain("The Critiqs extension reviews it in your own browser");
    await click(button(container, "Dismiss"));
    await tell(container, { kind: "unsupported", feature: "load" });
    expect(text(container)).toContain("Part of this page couldn't load");
    expect(container.querySelector('.review-strip.problem[role="alert"]')).toBeNull();
    await click(button(container, "Dismiss"));
    expect(text(container)).not.toContain("Part of this page couldn't load");
  });
  test("files held back by the viewer's budget say to wait and reload, not to get the extension", async () => {
    const container = await openReview(fakeHost());
    await tell(container, { kind: "unsupported", feature: "limit" });
    expect(text(container)).toMatch(/reload in a minute/i);
    expect(container.querySelector('a[href="https://extension.example/critiqs"]')).toBeNull();
  });
  test("each page the proxy can't show says what happened and what helps", async () => {
    const lines: Record<string, RegExp> = {
      busy: /waited.*turn.*reload/i,
      limited: /many pages.*more open as time passes/i,
      offline: /couldn't reach its own service.*reload/i,
    };
    for (const [reason, line] of Object.entries(lines)) {
      const container = await openReview(fakeHost());
      await tell(container, { kind: "failed", reason });
      expect([reason, line.test(text(container))]).toEqual([reason, true]);
    }
  });
});

describe("a link that ends while its tab is open", () => {
  test("shows the session's end as soon as the backend says the lease no longer serves, not at the next renewal", async () => {
    let state: { kind: "live" | "ended" } = { kind: "live" };
    const backend = fakeBackend({ openReviewLink: async () => ready(), useReviewLease: () => ({ status: "ready", data: state }) } as never);
    const container = await render(page(fakeHost()), { backend, auth: fakeAuth(null) });
    await settle();
    await settle();
    await settle();
    expect(container.querySelector("iframe")).not.toBeNull();
    state = { kind: "ended" };
    // The watch's next answer re-renders the page.
    await click(button(container, "Browse"));
    await settle();
    expect(text(container)).toContain("This review session ended");
    expect(container.querySelector("iframe")).toBeNull();
  });
});

describe("the bar on a phone", () => {
  test("the sheet's button says what it opens: the project in Browse, the comments in Comment", async () => {
    window.matchMedia = ((query: string) => ({ matches: query.includes("max-width"), addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    const container = await openReview(fakeHost());
    expect(container.querySelector(".review-comments")?.textContent).toBe("Comments");
    await click(button(container, "Browse"));
    expect(container.querySelector(".review-comments")?.textContent).toBe("Project");
  });
});
