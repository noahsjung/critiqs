import { describe, expect, test } from "bun:test";
import type { PanelSignIn } from "@critiqs/core";
import { act, type ReactNode } from "react";
import { type Backend, type ReviewOpen, reviewLinksOf } from "../src/backend.ts";
import { reviewPathOf, routeOf } from "../src/route.ts";
import type { PanelOptions } from "../src/shared.ts";
import { type ReviewHost, ReviewHostContext, leaseOrigin, ReviewPage, prototypeUrl } from "../src/ui/ReviewPage.tsx";
import { button, click, fakeAuth, fakeBackend, render, settle, text, type } from "./render.tsx";

// A review link's page, /r/<key>: which states its link opens in, the frame
// it shows, and how it hands the panel the frame, its mode and sign-in.

// The test DOM loads no frames: each frame gets a window of its own that only takes messages.
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
const ready = (projectId: string | null = null, renewEveryMs = 300_000): ReviewOpen => ({
  kind: "ready",
  entry: { origin: FRAME, path: "/products/42", leaseId: "lease-1", renewalSecret: "renewal-secret", expiresAt: Date.now() + 600_000, renewEveryMs },
  projectId,
  projectName: projectId === null ? null : "Acme",
  source: { kind: "site", origin: "https://shop.example.com" },
});

/** A host whose panel is a fake that records how it was mounted and updated. */
function fakeHost(signInClient?: Partial<PanelSignIn>) {
  const mounted: { options: PanelOptions; updates: Partial<PanelOptions>[]; destroyed: boolean }[] = [];
  const accepted: unknown[] = [];
  const host: ReviewHost = {
    deployment: { backendUrl: "https://backend.convex.cloud", siteUrl: "https://backend.convex.site", signInUrl: "https://backend.convex.site", transport: "convex", signIn: null },
    session: { acceptPanelSignIn: (tokens: unknown) => void accepted.push(tokens) } as unknown as ReviewHost["session"],
    mountPanel: async () => (_container, options) => {
      const entry = { options, updates: [] as Partial<PanelOptions>[], destroyed: false };
      mounted.push(entry);
      return { ready: Promise.resolve(), update: (changes) => void entry.updates.push(changes), destroy: () => void (entry.destroyed = true) };
    },
    signInClient: signInClient as PanelSignIn | undefined,
    extensionUrl: "https://extension.example/critiqs",
  };
  return { host, mounted, accepted };
}

const page = (host: ReviewHost, node: ReactNode = <ReviewPage linkKey={KEY} />) => <ReviewHostContext.Provider value={host}>{node}</ReviewHostContext.Provider>;

describe("routes and addresses", () => {
  test("/r/<key> is a review link; /review-links/<id> a project's links", () => {
    expect(routeOf(`/r/${KEY}`)).toEqual({ page: "review", key: KEY });
    expect(routeOf(`/r/${KEY}/`)).toEqual({ page: "review", key: KEY });
    expect(routeOf("/review-links/nn7e93p965")).toEqual({ page: "review-links", projectId: "nn7e93p965" });
  });

  test("the path after # names a page on the prototype, nothing else", () => {
    expect(reviewPathOf("#/products/42")).toBe("/products/42");
    for (const hash of ["", "#", "#products", "#//evil.example/x", "#/__critiqs/a/x", "#/a b", `#/${"x".repeat(2100)}`, "#/x?y=1", "#javascript:alert(1)"]) expect(reviewPathOf(hash)).toBeNull();
  });

  test("a lease origin is a v-<label> host, https, or http only on .localhost", () => {
    expect(leaseOrigin(FRAME)).toBe(FRAME);
    expect(leaseOrigin(`https://v-${"a".repeat(26)}.critiqs-review.net`)).toBe(`https://v-${"a".repeat(26)}.critiqs-review.net`);
    for (const origin of [`http://v-${"a".repeat(26)}.critiqs-review.net`, "https://evil.example", `https://v-${"a".repeat(26)}.critiqs-review.net/path`, "javascript:alert(1)", "not a url"]) expect(leaseOrigin(origin)).toBeNull();
  });

  test("AT-24: frame addresses map to the prototype's path, without query or fragment, never the proxy's own paths", () => {
    expect(prototypeUrl("https://shop.example.com", new URL(`${FRAME}/products/42?token=secret#x`))).toBe("https://shop.example.com/products/42");
    expect(prototypeUrl("https://shop.example.com", new URL(`${FRAME}/__critiqs/leave?to=x`))).toBeNull();
  });

  test("the config's review links are read field by field", () => {
    expect(reviewLinksOf({ version: 1, live: true, builds: false, allowCritiqs: false })).toEqual({ version: 1, live: true, builds: false, allowCritiqs: false });
    for (const raw of [null, "yes", { version: 2, live: true }, { version: 1 }]) expect(reviewLinksOf(raw)).toBeNull();
  });
});

describe("the review page", () => {
  test("a key that isn't one shows the same page as a removed link, without asking the backend", async () => {
    const { host } = fakeHost();
    const backend = fakeBackend();
    const container = await render(page(host, <ReviewPage linkKey="not-a-key" />), { backend, auth: fakeAuth(null) });
    expect(text(container)).toContain("This review link isn't available");
    expect(backend.calls.filter((call) => call.name === "openReviewLink")).toEqual([]);
  });

  test("an organization's link asks someone signed out to sign in, and shows no frame", async () => {
    const { host } = fakeHost();
    const container = await render(page(host), { backend: fakeBackend({ openReviewLink: async () => ({ kind: "sign-in" }) }), auth: fakeAuth(null) });
    await settle();
    expect(text(container)).toContain("Sign in to open this review link");
    expect(container.querySelector("iframe")).toBeNull();
  });

  test("ready: the sandboxed frame at the link's path, and the panel for it in Comment mode with no project yet", async () => {
    const { host, mounted } = fakeHost();
    const container = await render(page(host), { backend: fakeBackend({ openReviewLink: async () => ready() }), auth: fakeAuth(null) });
    await settle();
    await settle();
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(frame.getAttribute("src")).toBe(`${FRAME}/products/42`);
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(mounted.length).toBe(1);
    const options = mounted[0]!.options;
    expect(options.channel).toBe("review-link");
    expect(options.projectId).toBeUndefined();
    expect(options.review?.frameOrigin).toBe(FRAME);
    expect(options.review?.mode).toBe("comment");
    expect(options.review?.mapUrl(new URL(`${FRAME}/about`))).toBe("https://shop.example.com/about");
    // Browse in the bar reaches the panel.
    await click(button(container, "Browse"));
    expect(mounted[0]!.updates.at(-1)?.review?.mode).toBe("browse");
  });

  test("posting signed out signs in inside the page, adopts the lease and hands the panel the project", async () => {
    const tokens = { accessToken: "a.b.c", refreshToken: "r", expiresAt: Date.now() + 60_000, sessionEndsAt: Date.now() + 86_400_000, reviewer: { id: "u1", name: "Lee", email: "lee@example.com" } };
    const { host, mounted, accepted } = fakeHost({
      sendCode: async (email) => ({ attempt: "attempt-1", email, developmentCode: "123456" }),
      checkCode: async () => ({ status: "signed-in", ...tokens }),
    });
    const backend = fakeBackend({ openReviewLink: async () => ready(), adoptReviewLease: async () => ({ kind: "adopted", projectId: "project-1", projectName: "Acme" }) });
    const container = await render(page(host), { backend, auth: fakeAuth(null) });
    await settle();
    await settle();
    let signedIn = null as boolean | null;
    await act(async () => void mounted[0]!.options.review!.ensureReviewer().then((value) => (signedIn = value)));
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(text(dialog)).toContain("Sign in to post your comment");
    await type(dialog.querySelector('input[name="email"]'), "lee@example.com");
    await act(async () => dialog.querySelector("form")!.requestSubmit());
    await settle();
    expect(text(container.querySelector('[role="dialog"]')!)).toContain("Development code: 123456");
    await type(container.querySelector('input[name="code"]'), "123456");
    await act(async () => container.querySelector<HTMLFormElement>('[role="dialog"] form')!.requestSubmit());
    await settle();
    await settle();
    expect(accepted).toEqual([{ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt }]);
    expect(backend.calls.filter((call) => call.name === "adoptReviewLease").map((call) => call.args)).toEqual([["lease-1", "renewal-secret"]]);
    expect(signedIn).toBe(true);
    expect(mounted[0]!.updates.at(-1)?.projectId).toBe("project-1");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  test("a cancelled sign-in resolves false and adopts nothing", async () => {
    const { host, mounted } = fakeHost({});
    const backend = fakeBackend({ openReviewLink: async () => ready() });
    const container = await render(page(host), { backend, auth: fakeAuth(null) });
    await settle();
    await settle();
    let signedIn = null as boolean | null;
    await act(async () => void mounted[0]!.options.review!.ensureReviewer().then((value) => (signedIn = value)));
    await click(button(container.querySelector('[role="dialog"]')!, "Cancel"));
    await settle();
    expect(signedIn).toBe(false);
    expect(backend.calls.some((call) => call.name === "adoptReviewLease")).toBe(false);
  });

  test("the frame saying it reached a sign-in shows the extension banner; another window's message is ignored", async () => {
    const { host } = fakeHost();
    const container = await render(page(host), { backend: fakeBackend({ openReviewLink: async () => ready() }), auth: fakeAuth(null) });
    await settle();
    await settle();
    const frame = container.querySelector("iframe")!;
    const message = { tag: "critiqs:review-frame", v: 1, kind: "left", url: "https://accounts.google.com", signIn: true };
    await act(async () => window.dispatchEvent(new MessageEvent("message", { data: message, origin: FRAME, source: window })));
    expect(text(container)).not.toContain("extension");
    await act(async () => window.dispatchEvent(new MessageEvent("message", { data: message, origin: "https://evil.example", source: frame.contentWindow })));
    expect(text(container)).not.toContain("extension");
    await act(async () => window.dispatchEvent(new MessageEvent("message", { data: message, origin: FRAME, source: frame.contentWindow })));
    expect(text(container)).toContain("The Critiqs extension reviews it in your own browser");
    expect(container.querySelector('a[href="https://extension.example/critiqs"]')).not.toBeNull();
  });

  test("a lease the backend won't renew ends the session", async () => {
    const { host, mounted } = fakeHost();
    const backend = fakeBackend({ openReviewLink: async () => ready(null, 20), renewReviewLease: async () => ({ kind: "ended" }) });
    const container = await render(page(host), { backend, auth: fakeAuth(null) });
    await settle();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(text(container)).toContain("This review session ended");
    expect(container.querySelector("iframe")).toBeNull();
    expect(mounted[0]!.destroyed).toBe(true);
  });
});

// Keeps `Backend` in this file's types, for the fake's overrides.
export type { Backend };
