import { afterEach, describe, expect, test } from "bun:test";
import type { PanelSignIn } from "@critiqs/core";
import { act, type ReactNode } from "react";
import type { ReviewLinkSummary, ReviewOpen } from "../src/backend.ts";
import type { PanelOptions } from "../src/shared.ts";
import { ReviewLinksPage } from "../src/ui/ReviewLinks.tsx";
import { type ReviewHost, ReviewHostContext, ReviewPage } from "../src/ui/ReviewPage.tsx";
import { EXTENSION_GUIDE, extensionLink } from "../src/ui/Ways.tsx";
import { headerRules, readHostConfig, rewriteFor } from "../../../site-src/host-rules.ts";
import { reviewHeadersFor, reviewPageHeaders } from "../vite.config.ts";
import { button, click, fakeAuth, fakeBackend, render, settle, text } from "./render.tsx";

// The review page's smaller promises: what someone signed out is told, Copy
// and Share, the address bar, the narrow layout, the notice for a page that
// only partly loads, and the headers the website's host sends.

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
const ready = (): ReviewOpen => ({
  kind: "ready",
  entry: { origin: FRAME, path: "/products/42", leaseId: "lease-1", renewalSecret: "renewal-secret", expiresAt: Date.now() + 600_000, renewEveryMs: 300_000 },
  projectId: null,
  projectName: null,
  source: { kind: "site", origin: "https://shop.example.com" },
});

function fakeHost() {
  const mounted: { options: PanelOptions; updates: Partial<PanelOptions>[] }[] = [];
  const host: ReviewHost = {
    deployment: { backendUrl: "https://backend.convex.cloud", siteUrl: "https://backend.convex.site", signInUrl: "https://backend.convex.site", transport: "convex", signIn: null },
    session: { acceptPanelSignIn: () => undefined } as unknown as ReviewHost["session"],
    mountPanel: async () => (_container, options) => {
      const entry = { options, updates: [] as Partial<PanelOptions>[] };
      mounted.push(entry);
      return { ready: Promise.resolve(), update: (changes) => void entry.updates.push(changes), destroy: () => undefined };
    },
    signInClient: undefined as PanelSignIn | undefined,
    extensionUrl: "https://extension.example/critiqs",
    // The headers the website's host sends a review page (vite.config.ts), for these frames' domain.
    framePolicy: async () => "frame-ancestors 'none'; frame-src http://*.review.localhost:5960",
  };
  /** The review surface the panel has now: its first mount, with every update since. */
  const surface = () => {
    const last = mounted[0]!;
    return [last.options, ...last.updates].reduce<PanelOptions["review"]>((current, update) => update.review ?? current, undefined)!;
  };
  return { host, mounted, surface };
}

const page = (host: ReviewHost, node: ReactNode = <ReviewPage linkKey={KEY} />) => <ReviewHostContext.Provider value={host}>{node}</ReviewHostContext.Provider>;

async function openReview(host: ReviewHost) {
  const container = await render(page(host), { backend: fakeBackend({ openReviewLink: async () => ready() }), auth: fakeAuth(null) });
  await settle();
  await settle();
  return container;
}

const realReplace = window.history.replaceState;
const realMatchMedia = window.matchMedia;
const realClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  window.history.replaceState = realReplace;
  window.matchMedia = realMatchMedia;
  if (realClipboard !== undefined) Object.defineProperty(navigator, "clipboard", realClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
  localStorage.clear();
});

/** A clipboard that records what is written. */
function recordingClipboard(): string[] {
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => void written.push(value) } });
  return written;
}

describe("signed out", () => {
  test("a link that won't open signed out asks to sign in without claiming who it is for", async () => {
    const { host } = fakeHost();
    const container = await render(page(host), { backend: fakeBackend({ openReviewLink: async () => ({ kind: "sign-in" }) }), auth: fakeAuth(null) });
    await settle();
    expect(text(container)).not.toContain("is for the project's organization");
    expect(text(container)).toContain("Sign in to open this review link");
  });
});

describe("Copy link", () => {
  const link: ReviewLinkSummary = {
    linkId: "link-1",
    origin: "https://shop.example.com",
    startPath: "/",
    status: "active",
    paused: false,
    usageToday: { requests: 0, bytes: 0 },
    createdByName: "Dana",
    createdAt: 1,
  } as ReviewLinkSummary;
  test("copies on the first click", async () => {
    const written = recordingClipboard();
    const backend = fakeBackend({
      reviewLinks: { version: 1, live: true, builds: false, allowCritiqs: false },
      useReviewLinks: () => ({ status: "ready", data: [link] }),
      useProject: () => ({ status: "ready", data: { _id: "p1", name: "Acme", reviewUrl: "https://shop.example.com/" } }),
      copyReviewLink: async () => `http://localhost:5970/r/${KEY}`,
    } as never);
    const container = await render(<ReviewLinksPage projectId="p1" />, { backend });
    await settle();
    await click(button(container, "Copy link"));
    await settle();
    expect(written).toEqual([`http://localhost:5970/r/${KEY}`]);
    expect(text(container)).toContain("Copied");
  });
});

describe("the address bar and Share", () => {
  test("a frame path starting with // never reaches the bar or Share as one", async () => {
    const { host, surface } = fakeHost();
    const written = recordingClipboard();
    const container = await openReview(host);
    await act(async () => surface().onState!({ url: `${FRAME}//evil.example/x`, viewport: { width: 1000 } } as never));
    // Shown as the proxy writes it, `/.//…`: a path on the prototype, never an address of another site.
    const shown = container.querySelector(".review-source span")!.textContent!;
    expect(shown.startsWith("//")).toBe(false);
    expect(new URL(shown, "https://shop.example.com").host).toBe("shop.example.com");
    expect(window.location.hash.startsWith("#//")).toBe(false);
    await click(button(container, "Share"));
    await settle();
    expect(written.length).toBe(1);
    expect(written[0]!.includes("#//")).toBe(false);
  });
  test("the proxy's own pages leave the bar on the last page", async () => {
    const { host, surface } = fakeHost();
    const container = await openReview(host);
    await act(async () => surface().onState!({ url: `${FRAME}/about`, viewport: { width: 1000 } } as never));
    await act(async () => surface().onState!({ url: `${FRAME}/__critiqs/leave?to=x`, viewport: { width: 1000 } } as never));
    expect(container.querySelector(".review-source")!.textContent).toContain("/about");
  });
  test("a browser refusing to change the address doesn't break the page's state updates", async () => {
    const { host, surface } = fakeHost();
    const container = await openReview(host);
    window.history.replaceState = () => {
      throw new DOMException("Too many calls", "SecurityError");
    };
    await act(async () => surface().onState!({ url: `${FRAME}/checkout`, viewport: { width: 1000 } } as never));
    expect(container.querySelector(".review-source")!.textContent).toContain("/checkout");
  });
});

describe("a narrow screen", () => {
  const narrow = () => {
    window.matchMedia = ((query: string) => ({ matches: query.includes("max-width"), media: query, addEventListener() {}, removeEventListener() {} })) as never;
  };
  test("the frame takes the width; the panel is a sheet the bar opens and its own button closes", async () => {
    narrow();
    const { host, surface } = fakeHost();
    const container = await openReview(host);
    expect(container.querySelector<HTMLElement>(".review")!.style.right).toBe("0px");
    expect(surface().panel).toMatchObject({ layout: "sheet", open: false });
    await click(button(container, "Comments"));
    expect(surface().panel).toMatchObject({ layout: "sheet", open: true });
    await act(async () => (surface().panel as { onClose(): void }).onClose());
    expect(surface().panel).toMatchObject({ layout: "sheet", open: false });
  });
  test("choosing Comment puts the sheet down, so the frame can be picked from", async () => {
    narrow();
    const { host, surface } = fakeHost();
    const container = await openReview(host);
    await click(button(container, "Browse"));
    // In Browse the sheet shows the project, and its button says so.
    await click(button(container, "Project"));
    expect(surface().panel).toMatchObject({ open: true });
    await click(button(container, "Comment"));
    expect(surface().panel).toMatchObject({ open: false });
  });
  test("a wide screen keeps the panel beside the frame", async () => {
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as never;
    const { host, surface } = fakeHost();
    const container = await openReview(host);
    expect(surface().panel ?? { layout: "side" }).toMatchObject({ layout: "side" });
    expect(container.querySelector(".review-comments") === null).toBe(true);
  });
});

describe("a page that only partly loads", () => {
  test("one quiet notice, with the extension as the way to see all of it", async () => {
    const { host } = fakeHost();
    const container = await openReview(host);
    const frame = container.querySelector("iframe")!;
    const message = { tag: "critiqs:review-frame", v: 1, kind: "unsupported", feature: "load" };
    for (let index = 0; index < 3; index++) await act(async () => window.dispatchEvent(new MessageEvent("message", { data: message, origin: FRAME, source: frame.contentWindow })));
    expect(text(container)).toContain("Part of this page couldn't load through the review link");
    expect(container.querySelectorAll(".review-strip").length).toBe(1);
    expect(container.querySelector('a[href="https://extension.example/critiqs"]')).not.toBeNull();
  });
});

test("without a store listing, Get the extension goes to how to build and load it, as onboarding and thread pages say", () => {
  for (const unset of [undefined, null, "", "  "]) expect(extensionLink(unset)).toBe(EXTENSION_GUIDE);
  expect(extensionLink(" https://chromewebstore.google.com/detail/critiqs ")).toBe("https://chromewebstore.google.com/detail/critiqs");
});

describe("the website's host sends the review pages' headers", () => {
  // The app is served from the landing site's host, on its origin: site/vercel.json is the one host file.
  const host = readHostConfig();
  test("the dev server covers /r/ and /review-links/, nothing else", () => {
    for (const path of [`/r/${KEY}`, "/review-links/p1"]) expect(reviewHeadersFor(path, undefined)).toEqual(reviewPageHeaders(undefined));
    for (const path of ["/start", "/t/abc", "/setup/p1"]) expect(reviewHeadersFor(path, undefined)).toBeNull();
  });
  for (const path of [`/r/${KEY}`, "/review-links/p1"]) {
    test(`site/vercel.json serves ${path} from the app with the same headers, frames from the review proxy only, each set by one rule`, () => {
      expect(rewriteFor(host, path)).toBe("/app/index.html");
      const sent = headerRules(host, path);
      const frames = /frame-src ([^;]+)/.exec(sent.get("content-security-policy")?.value ?? "")?.[1];
      expect(frames).toMatch(/^https:\/\/\*\.[a-z0-9.-]+$/);
      for (const [key, value] of Object.entries(reviewPageHeaders(frames))) expect(sent.get(key.toLowerCase())?.value).toBe(value);
      // Two rules setting one header would leave which one the host sends to its own order.
      expect([...sent].filter(([, { sources }]) => sources.length > 1).map(([key]) => key)).toEqual([]);
    });
  }
  test("the rest of the site keeps its own referrer rule", () => {
    for (const path of ["/", "/start", "/t/abc", "/docs/install", "/r", "/review-linksx/p1"]) {
      expect(headerRules(host, path).get("referrer-policy")?.value).toBe("strict-origin-when-cross-origin");
      expect(headerRules(host, path).has("content-security-policy")).toBe(false);
    }
  });
});
