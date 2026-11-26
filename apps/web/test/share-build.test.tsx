import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import type { ReviewLinkSummary, ReviewOpen } from "../src/backend.ts";
import { type ReviewHost, ReviewHostContext, ReviewPage } from "../src/ui/ReviewPage.tsx";
import { ReviewLinksPage } from "../src/ui/ReviewLinks.tsx";
import { ShareBuildPanel } from "../src/ui/Ways.tsx";
import { act } from "react";
import { fakeAuth, fakeBackend, reload, render, settle, text } from "./render.tsx";

// Shared builds on the website: the review page for one, the address its
// comments keep (AT-30), and where owners find the command and their builds.

// One window per frame, so a message can come from the frame the page knows.
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
const BUILD = `https://b${"k".repeat(20)}.build.invalid`;
const EXPIRES = Date.UTC(2099, 11, 2, 12);
const opened: ReviewOpen = {
  kind: "ready",
  entry: { origin: FRAME, path: "/", leaseId: "lease-1", renewalSecret: "renewal-secret", expiresAt: Date.now() + 600_000, renewEveryMs: 300_000 },
  projectId: null,
  projectName: null,
  source: { kind: "share", origin: BUILD, expiresAt: EXPIRES },
};

function fakeHost() {
  const mounted: { options: Parameters<Awaited<ReturnType<ReviewHost["mountPanel"]>>>[1] }[] = [];
  const host: ReviewHost = {
    deployment: { backendUrl: "https://backend.convex.cloud", siteUrl: "https://backend.convex.site", signInUrl: "https://backend.convex.site", transport: "convex", signIn: null },
    session: { acceptPanelSignIn: () => undefined } as unknown as ReviewHost["session"],
    mountPanel: async () => (_container, options) => {
      mounted.push({ options });
      return { ready: Promise.resolve(), update: () => undefined, destroy: () => undefined };
    },
    signInClient: undefined,
    extensionUrl: "https://extension.example/critiqs",
    // The headers the website's host sends a review page, for these frames' domain.
    framePolicy: async () => "frame-ancestors 'none'; frame-src http://*.review.localhost:5960",
  };
  return { host, mounted };
}
const page = (host: ReviewHost, node: ReactNode = <ReviewPage linkKey={KEY} />) => <ReviewHostContext.Provider value={host}>{node}</ReviewHostContext.Provider>;

describe("a shared build's review page", () => {
  test("the bar names a shared build and its end date, never a frame host; the frame is the same sandboxed lease frame", async () => {
    const { host } = fakeHost();
    const container = await render(page(host), { backend: fakeBackend({ openReviewLink: async () => opened }), auth: fakeAuth(null) });
    await settle();
    await settle();
    expect(container.querySelector(".review-source strong")?.textContent).toMatch(/^Shared build · until Dec 2$/);
    expect(text(container)).not.toContain("build.invalid");
    const frame = container.querySelector("iframe")!;
    expect([frame.getAttribute("src"), frame.getAttribute("sandbox")]).toEqual([`${FRAME}/`, "allow-scripts allow-same-origin"]);
  });

  test("AT-30: comments keep the build's .build.invalid address, never the link's key or the frame host", async () => {
    const { host, mounted } = fakeHost();
    await render(page(host), { backend: fakeBackend({ openReviewLink: async () => opened }), auth: fakeAuth(null) });
    await settle();
    await settle();
    const mapped = mounted[0]!.options.review!.mapUrl(new URL(`${FRAME}/products/42?token=x#y`));
    expect(mapped).toBe(`${BUILD}/products/42`);
    expect(mapped).not.toContain(KEY);
    expect(mapped).not.toContain("review.localhost");
  });
});

const BUILD_LINK: ReviewLinkSummary = {
  linkId: "link-2",
  kind: "share",
  origin: BUILD,
  startPath: "/",
  assetOrigins: [],
  status: "active",
  paused: false,
  createdAt: 1,
  createdByName: "Dana",
  usageToday: { requests: 3, bytes: 100 },
  build: { buildId: "build-1", fileCount: 12, bytes: 300 * 1024, expiresAt: EXPIRES },
};

describe("what a shared build's review page says", () => {
  const tell = async (container: HTMLElement, message: Record<string, unknown>) => {
    const frame = container.querySelector("iframe")!;
    await act(async () => window.dispatchEvent(new MessageEvent("message", { data: { tag: "critiqs:review-frame", v: 1, ...message }, origin: FRAME, source: frame.contentWindow })));
  };
  // Each open replaces the page before it, so only one review page listens at a time.
  const open = async (source: ReviewOpen = opened) => {
    const { host } = fakeHost();
    const container = await reload(page(host), { backend: fakeBackend({ openReviewLink: async () => source }), auth: fakeAuth(null) });
    await settle();
    await settle();
    await settle();
    return container;
  };
  test("never points to the extension, which can't open a shared build", async () => {
    for (const message of [{ kind: "unsupported", feature: "form" }, { kind: "unsupported", feature: "password" }, { kind: "unsupported", feature: "load" }]) {
      const container = await open();
      await tell(container, message);
      // The notice itself still shows.
      expect([message.feature, text(container).includes("review link") || text(container).includes("forms")]).toEqual([message.feature, true]);
      // Booleans only: a failing expect that holds an element prints its whole object graph (gigabytes).
      expect([message.feature, text(container).includes("extension"), container.querySelector('a[href="https://extension.example/critiqs"]') === null]).toEqual([message.feature, false, true]);
    }
  });
  test("ends the session at the build's end date, without waiting for a renewal, and says it ended", async () => {
    const container = await open({ ...opened, source: { kind: "share", origin: BUILD, expiresAt: Date.now() + 80 } } as ReviewOpen);
    expect(container.querySelector("iframe") !== null).toBe(true);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 150)));
    expect(text(container)).toContain("This shared build has ended");
    expect(container.querySelector("iframe") === null).toBe(true);
  });
  test("a build that ran out says it ended, and when, instead of 'removed'", async () => {
    const { host } = fakeHost();
    const container = await render(page(host), { backend: fakeBackend({ openReviewLink: async () => ({ kind: "expired", expiredAt: Date.UTC(2026, 11, 2, 12) }) as ReviewOpen }), auth: fakeAuth(null) });
    await settle();
    expect(text(container)).toContain("This shared build has ended");
    expect(text(container)).toContain("Dec 2, 2026");
    expect(text(container)).not.toContain("removed");
  });
});

describe("owners' review links page", () => {
  test("with shared builds only, owners see their builds and the command to share one, without a live link form", async () => {
    const backend = fakeBackend({ reviewLinks: { version: 1, live: false, builds: true, allowCritiqs: false }, useReviewLinks: () => ({ status: "ready", data: [BUILD_LINK] }), project: { _id: "p1", name: "Pilot", reviewUrl: null } as never });
    const container = await render(<ReviewLinksPage projectId="p1" />, { backend, auth: fakeAuth() });
    await settle();
    expect(container.querySelector("form") === null).toBe(true);
    expect(container.querySelector(".review-link-row strong")?.textContent).toBe("Shared build · 12 files, 300 KB · until Dec 2");
    expect(container.querySelector(".share-build .command")?.textContent).toBe("npx critiqs share dist/ --project p1");
  });

  test("nothing is offered where the deployment has neither", async () => {
    const container = await render(<ReviewLinksPage projectId="p1" />, { backend: fakeBackend({ reviewLinks: null }), auth: fakeAuth() });
    expect(text(container)).toContain("doesn't offer review links");
    expect(container.querySelector(".share-build") === null).toBe(true);
  });
});

test("Share a build names the project, and the backend when it isn't Critiqs Cloud", async () => {
  const container = await render(<ShareBuildPanel projectId="p1" />, { backend: fakeBackend({ componentBackend: "https://team.convex.cloud" }) });
  expect(container.querySelector(".command")?.textContent).toBe("npx critiqs share dist/ --project p1 --backend https://team.convex.cloud");
  expect(text(container)).toContain("never the source");
});
