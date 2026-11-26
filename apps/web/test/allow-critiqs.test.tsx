import { describe, expect, test } from "bun:test";
import type { AddressCheck } from "@critiqs/core";
import type { AllowCritiqsSetup, ReviewLinksCapability } from "../src/backend.ts";
import { headerRules, readHostConfig, rewriteFor } from "../../../site-src/host-rules.ts";
import { routeOf } from "../src/route.ts";
import { AllowCritiqsPage } from "../src/ui/AllowCritiqs.tsx";
import { FreeWays } from "../src/ui/Onboarding.tsx";
import { button, click, fakeAuth, fakeBackend, render, settle, text } from "./render.tsx";

// Allow Critiqs on the website: its page, onboarding's ways to review
// without installing as the deployment offers them, and Check again.

const ALL: ReviewLinksCapability = { version: 1, live: true, builds: true, allowCritiqs: true };
const ORIGIN = "https://staging.acme.com";
const setupOf = (token: string, verifiedAt: number | null = null): AllowCritiqsSetup => ({
  projectId: "p1",
  origin: ORIGIN,
  header: "Critiqs-Allow",
  token,
  proofPath: "/.well-known/critiqs-allow.txt",
  proofLine: `critiqs-allow-proof=${"p".repeat(32)}`,
  userAgent: "Critiqs-Review/1",
  wellKnownUrl: "https://critiqs-review.net/.well-known/critiqs-review.json",
  verifiedAt,
  lastCheck: null,
});

test("/allow-critiqs names a project's origin in its query", () => {
  expect(routeOf("/allow-critiqs", `?project=p1&origin=${encodeURIComponent(ORIGIN)}`)).toEqual({ page: "allow-critiqs", projectId: "p1", origin: ORIGIN });
  expect(routeOf("/allow-critiqs/", "")).toEqual({ page: "allow-critiqs", projectId: null, origin: null });
});

test("the website's host serves /allow-critiqs from the app, with the rest of the site's headers", () => {
  const host = readHostConfig();
  expect(rewriteFor(host, "/allow-critiqs")).toBe("/app/index.html");
  // The page shows an owner's token: never framed by another site.
  expect(headerRules(host, "/allow-critiqs").get("x-frame-options")?.value).toBe("DENY");
  expect(headerRules(host, "/allow-critiqs").get("referrer-policy")?.value).toBe("strict-origin-when-cross-origin");
});

describe("the Allow Critiqs page", () => {
  test("anyone can read how it works and why a token, never a token; the owner's part needs sign-in", async () => {
    const backend = fakeBackend({ reviewLinks: ALL });
    const page = await render(<AllowCritiqsPage projectId="p1" origin={ORIGIN} />, { backend, auth: fakeAuth(null) });
    expect(text(page)).toContain("Every Critiqs customer's review links come from the same proxy");
    expect(text(page)).toContain("Sign in as one of the project's owners");
    expect(backend.calls.map((call) => call.name)).not.toContain("issueAllowCritiqs");
  });

  test("an owner sees the token, the rules, the proof file; Check again goes from blocked to allowed", async () => {
    const results = [{ result: "blocked", verified: false }, { result: "public", verified: true }] as const;
    let checks = 0;
    const backend = fakeBackend({ reviewLinks: ALL, useAllowCritiqs: () => ({ status: "ready", data: setupOf("t".repeat(43)) }), checkAllowCritiqs: async () => results[checks++]! });
    const page = await render(<AllowCritiqsPage projectId="p1" origin={ORIGIN} />, { backend, auth: fakeAuth() });
    await settle();
    expect(page.querySelector(".allow-token")?.textContent).toBe(`Critiqs-Allow: ${"t".repeat(43)}`);
    expect(text(page)).toContain(`(http.request.headers["critiqs-allow"][0] eq "${"t".repeat(43)}")`);
    expect(page.querySelector(".allow-proof")?.textContent).toBe(`critiqs-allow-proof=${"p".repeat(32)}`);
    expect(text(page)).toContain(`${ORIGIN}/.well-known/critiqs-allow.txt`);
    // What a site's owner needs beyond the rule: what to skip, what reads nginx's variable, one proof line per project, the hourly re-check.
    for (const line of ["Super Bot Fight Mode", "if ($critiqs_allowed = 0)", "one line per project", "again on its own every hour"]) expect([line, text(page).includes(line)]).toEqual([line, true]);
    await click(button(page, "Check again"));
    await settle();
    expect(page.querySelector(".allow-result")?.textContent).toContain("Still blocked");
    await click(button(page, "Check again"));
    await settle();
    expect(page.querySelector(".allow-result")?.textContent).toContain("Allowed.");
    expect(page.querySelector('.allow-result a')?.getAttribute("href")).toBe("/review-links/p1");
    expect(backend.calls.filter((call) => call.name === "checkAllowCritiqs").map((call) => call.args)).toEqual([["p1", ORIGIN], ["p1", ORIGIN]]);
  });

  test("opening the page from a link changes nothing: the token is made, and the address added, only when the owner presses the button", async () => {
    const backend = fakeBackend({ reviewLinks: ALL, issueAllowCritiqs: async () => setupOf("t".repeat(43)) });
    const page = await render(<AllowCritiqsPage projectId="p1" origin={ORIGIN} />, { backend, auth: fakeAuth() });
    await settle();
    expect(backend.calls.map((call) => call.name)).not.toContain("issueAllowCritiqs");
    expect(page.querySelector(".allow-token") === null).toBe(true);
    expect(text(page)).toContain(`Nothing changes until you press the button.`);
    await click(button(page, "Set up Allow Critiqs for this address"));
    await settle();
    expect(backend.calls.filter((call) => call.name === "issueAllowCritiqs").map((call) => call.args)).toEqual([["p1", ORIGIN]]);
    expect(page.querySelector(".allow-token")?.textContent).toBe(`Critiqs-Allow: ${"t".repeat(43)}`);
  });

  test("where the deployment doesn't offer it, nothing is issued", async () => {
    const backend = fakeBackend({ reviewLinks: { ...ALL, allowCritiqs: false } });
    const page = await render(<AllowCritiqsPage projectId="p1" origin={ORIGIN} />, { backend, auth: fakeAuth() });
    expect(text(page)).toContain("Open this page from a project you own");
    expect(backend.calls.map((call) => call.name)).not.toContain("issueAllowCritiqs");
  });
});

describe("onboarding's ways to review without installing", () => {
  const ways = async (check: AddressCheck | null, reviewLinks: ReviewLinksCapability | null, who: "me" | "developer" = "developer", url: string | null = `${ORIGIN}/`, extra = {}) => {
    const backend = fakeBackend({ reviewLinks, ...extra });
    const page = await render(<FreeWays projectId="p1" who={who} url={url} reviewerId="r1" checkOf={async () => check} />, { backend, auth: fakeAuth() });
    await settle();
    return { page, backend, offered: [...page.querySelectorAll(".way-card")].map((card) => card.getAttribute("data-way")) };
  };

  test("a public prototype is offered a review link; one with no address, a shared build; none where the deployment has neither", async () => {
    expect((await ways({ kind: "public", stack: null }, ALL)).offered).toEqual(["review-link"]);
    const none = await ways(null, ALL, "developer", null);
    expect(none.offered).toEqual(["share-build"]);
    expect(none.page.querySelector(".command")?.textContent).toBe("npx critiqs share dist/ --project p1");
    expect((await ways({ kind: "local" }, ALL)).offered).toEqual(["share-build"]);
    expect((await ways({ kind: "public", stack: null }, null)).page.querySelector(".ways-free") === null).toBe(true);
    expect((await ways({ kind: "public", stack: null }, { ...ALL, live: false })).offered).toEqual([]);
  });

  test("a blocked prototype is offered Allow Critiqs; Check again once it's allowed offers the review link in its place", async () => {
    const { page, backend, offered } = await ways({ kind: "blocked" }, ALL, "developer", `${ORIGIN}/`, {
      issueAllowCritiqs: async () => setupOf("t".repeat(43)),
      checkAllowCritiqs: async () => ({ result: "public", verified: true }) as const,
    });
    expect(offered).toEqual(["allow-critiqs"]);
    expect(page.querySelector('[data-way="allow-critiqs"] a')?.getAttribute("href")).toBe(`/allow-critiqs?project=p1&origin=${encodeURIComponent(ORIGIN)}`);
    await click(button(page, "Check again"));
    await settle();
    expect([...page.querySelectorAll(".way-card")].map((card) => card.getAttribute("data-way"))).toEqual(["review-link"]);
    expect(backend.calls.filter((call) => call.name.endsWith("AllowCritiqs")).map((call) => call.name)).toEqual(["issueAllowCritiqs", "checkAllowCritiqs"]);
  });
});
