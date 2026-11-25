import { afterEach, expect, jest, test } from "bun:test";
import type { BillingPrices, BillingStatus, OrganizationSummary, OrganizationUsage, PersonalAiSettingsView, PlanIncludes } from "@critiqs/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import { Session } from "../src/session.ts";
import { CritiqsRequestError, TransportContext } from "../src/transport.ts";
import { ARRIVAL_TIMEOUT_MS, BillingDialog } from "../src/ui/BillingDialog.tsx";
import { type FakeBackend, type FakeBilling, fakeTransport } from "./fake-transport.tsx";

// Plan and billing: an organization's Critiqs Cloud plan and usage for its
// members, and for its admins upgrading, switching, cancelling, the cap on
// extra credits, Pro's storage add-on, and Stripe's pages. Offered only where
// the deployment takes payment.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const originalUrl = window.location.href;
const SIGN_IN = "https://auth.example";
const PAGE = "https://prototype.example/pilot";
const RENEWS = Date.UTC(2027, 0, 1, 12);

const acme: OrganizationSummary = { id: "acme", name: "Acme", role: "admin", plan: "Free" };
const studio: OrganizationSummary = { id: "studio", name: "Studio", role: "member", plan: "Plus" };
const MB = 1024 ** 2;

/** Prices as Autumn's catalog sets them, which the backend reports with the status. */
const PRICES: BillingPrices = {
  plans: {
    free: { monthly: 0, extraCredits: null },
    plus: { monthly: 20, extraCredits: { amount: 1, credits: 100 } },
    pro: { monthly: 100, extraCredits: { amount: 1, credits: 100 } },
  },
  storageAddOn: { gb: 100, monthly: 10 },
};
const GB = 1024 ** 3;
const unlimited = (metric: PlanIncludes["limits"][number]["metric"], period: "total" | "month" | "day") => ({ metric, period, max: null });
/** What each plan includes as the backend's plan configuration sets it (its built-in plans), which the backend reports with the status. */
const PLAN_CONFIG: BillingStatus["plans"] = {
  free: {
    label: "Free",
    limits: [
      { metric: "aiCredits", period: "month", max: 200 },
      { metric: "projects", period: "total", max: 1 },
      { metric: "captureBytes", period: "total", max: 500 * MB },
      { metric: "reviewers", period: "month", max: 5 },
      { metric: "messages", period: "month", max: 500 },
      { metric: "mentionEmails", period: "day", max: 100 },
    ],
  },
  plus: {
    label: "Plus",
    limits: [
      { metric: "aiCredits", period: "month", max: 2_000 },
      { metric: "projects", period: "total", max: 10 },
      { metric: "captureBytes", period: "total", max: 10 * GB },
      { metric: "reviewers", period: "month", max: 25 },
      { metric: "messages", period: "month", max: 5_000 },
      unlimited("mentionEmails", "day"),
    ],
  },
  pro: {
    label: "Pro",
    limits: [
      { metric: "aiCredits", period: "month", max: 10_000 },
      unlimited("projects", "total"),
      { metric: "captureBytes", period: "total", max: 100 * GB, addOn: 100 * GB },
      unlimited("reviewers", "month"),
      unlimited("messages", "month"),
      unlimited("mentionEmails", "day"),
    ],
  },
};
const FREE_INCLUDES = "200 AI credits a month, 1 project, 500 MB of image storage, 5 reviewers a month, 500 comments a month, 100 mention emails a day";
const PLUS_INCLUDES = "2,000 AI credits a month, 10 projects, 10 GB of image storage, 25 reviewers a month, 5,000 comments a month; unlimited mention emails";
const PRO_INCLUDES = "10,000 AI credits a month, 100 GB of image storage; unlimited projects, reviewers, comments and mention emails";
const PAUSED = "Prices can't be shown right now, so plan changes are paused. Try again shortly.";
const free: BillingStatus = { plan: "free", subscription: null, storageAddOns: 0, canManage: true, prices: PRICES, plans: PLAN_CONFIG };
const plus: BillingStatus = {
  plan: "plus",
  subscription: { plan: "plus", status: "active", currentPeriodEnd: RENEWS, cancelAtPeriodEnd: false, scheduledPlan: null },
  storageAddOns: 0,
  canManage: true,
  prices: PRICES,
  plans: PLAN_CONFIG,
};
const pro: BillingStatus = { ...plus, plan: "pro", subscription: { ...plus.subscription!, plan: "pro" } };
const plusSetByCritiqs: BillingStatus = { plan: "plus", subscription: null, storageAddOns: 0, canManage: true, prices: PRICES, plans: PLAN_CONFIG };
const freeUsage: OrganizationUsage = {
  plan: "Free",
  rows: [
    { metric: "aiCredits", period: "month", used: 40, max: 200 },
    { metric: "projects", period: "total", used: 1, max: 1 },
    { metric: "captureBytes", period: "total", used: 12 * MB, max: 500 * MB },
  ],
};
const plusUsage: OrganizationUsage = {
  plan: "Plus",
  rows: [
    { metric: "aiCredits", period: "month", used: 2_300, max: 2_000, overage: { cap: 2_000 } },
    { metric: "projects", period: "total", used: 3, max: 10 },
    { metric: "captureBytes", period: "total", used: 1536 * MB, max: 10 * 1024 * MB },
  ],
  extraCredits: { defaultCap: 2_000, usesDefault: true },
};

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  jest.useRealTimers();
  faking = false;
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  localStorage.clear();
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(originalUrl);
});

const setUrl = (url: string) => (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);

function backend(billing: FakeBilling | undefined, overrides: Partial<FakeBackend> = {}): FakeBackend {
  return {
    project: { _id: "project", name: "Pilot", tags: [], createdAt: 1, reviewUrl: null, isOwner: true, organization: { id: "acme", name: "Acme", role: "admin" } },
    threads: [],
    organizations: [acme],
    billing,
    calls: [],
    ...overrides,
  };
}

const billingOf = (status: BillingStatus, usage: OrganizationUsage | null, more: Partial<FakeBilling> = {}): FakeBilling => ({
  status: { acme: status },
  usage: { acme: usage },
  ...more,
});

async function mount(data: FakeBackend, { billing = true, url = PAGE } = {}) {
  setUrl(url);
  const payload = btoa(JSON.stringify({ sub: "dana", name: "Dana", email: "dana@example.com" }));
  localStorage.setItem(`critiqs:session:${SIGN_IN}`, JSON.stringify({ accessToken: `header.${payload}.signature`, refreshToken: "fixture", expiresAt: Date.now() + 900_000 }));
  host = document.createElement("critiqs-root");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const inner = document.createElement("div");
  shadow.append(inner);
  root = createRoot(inner);
  const session = new Session(SIGN_IN, localStorage, async () => new Response(null, { status: 204 }));
  const deployment = { backendUrl: "https://backend.convex.cloud", siteUrl: "https://backend.convex.site", signInUrl: SIGN_IN, transport: "convex", signIn: null, personalAi: true, billing } as const;
  await act(async () =>
    root!.render(
      <TransportContext.Provider value={fakeTransport(data)}>
        <App props={{ projectId: "project", getContext: () => ({ screen: "pilot" }) }} deployment={deployment} session={session} host={host!} />
      </TransportContext.Provider>,
    ),
  );
  await settle();
  return shadow;
}

async function renderDialog(data: FakeBackend, { organizationId = "acme" as string | null, awaiting = null as "plus" | "pro" | "storage" | null, toasts = [] as string[] } = {}) {
  setUrl(PAGE);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const draw = async () => {
    const transport = fakeTransport(data);
    await act(async () =>
      root!.render(
        <TransportContext.Provider value={transport}>
          <BillingDialog billing={transport.billing!} organizationId={organizationId} awaiting={awaiting} onClose={() => undefined} notify={(message) => toasts.push(message)} />
        </TransportContext.Provider>,
      ),
    );
  };
  await draw();
  await settle();
  return { page: host, redraw: draw };
}

let faking = false;

async function settle() {
  for (let i = 0; i < 3; i++) await act(async () => (faking ? void jest.advanceTimersByTime(10) : new Promise((resolve) => setTimeout(resolve, 10))));
}

const button = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text || candidate.getAttribute("aria-label") === text) ?? null;
const navRow = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button.ds-nav-row")].find((row) => row.querySelector(".label")?.textContent === label) ?? null;
const heading = (scope: ParentNode) => scope.querySelector(".ds-dialog-header h3")?.textContent ?? null;
const rows = (scope: ParentNode) => [...scope.querySelectorAll(".ds-row, .billing-usage-row, .ds-nav-row")].map(words);

function words(element: Element): string {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) parts.push(node.textContent ?? "");
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

async function click(element: Element | null | undefined) {
  if (element == null) throw new Error("Nothing to click");
  await act(async () => (element as HTMLElement).click());
  await settle();
}

function select(scope: ParentNode, label: string): HTMLButtonElement | null {
  return (
    [...scope.querySelectorAll<HTMLButtonElement>(".ds-select")].find((candidate) => {
      const [labelId] = candidate.getAttribute("aria-labelledby")!.split(" ");
      return scope.querySelector(`[id="${labelId}"]`)?.textContent === label;
    }) ?? null
  );
}

async function choose(scope: ParentNode, label: string, option: string) {
  await click(select(scope, label));
  await click([...scope.querySelectorAll('[role="menuitemradio"]')].find((item) => item.firstChild?.textContent === option || item.textContent?.startsWith(option)));
}

async function type(field: HTMLInputElement | null, text: string) {
  if (field === null) throw new Error("No field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const calls = (data: FakeBackend, name: string) => data.calls!.filter((call) => call.name === name).map((call) => call.args);

test("the avatar menu offers Plan and billing where the deployment takes payment, on the project's organization", async () => {
  const data = backend(billingOf(free, freeUsage));
  const shadow = await mount(data);
  await click(shadow.querySelector('button[aria-label="Signed in as Dana"]'));
  await click(button(shadow, "Plan and billing…"));
  const dialog = shadow.querySelector('[role="dialog"][aria-label="Plan and billing"]')!;
  expect(heading(dialog)).toBe("Plan and billing");
  expect(rows(dialog)).toEqual([
    "Plan Free",
    "Upgrade",
    "Critiqs AI credits this month 40 of 200",
    "Projects 1 of 1, limit reached",
    "Images stored 12 MB of 500 MB",
  ]);
});

test("without billing, the menu has no Plan and billing and Upgrade still opens the deployment's page", async () => {
  const personal: PersonalAiSettingsView = {
    saved: false,
    enabled: true,
    mode: "managed",
    managedModel: null,
    provider: null,
    model: null,
    models: [],
    baseUrl: null,
    keyHint: null,
    deployment: { managed: true, managedModels: [{ id: "fast", label: "Fast", credits: 1 }], defaultProvider: null, keysStorable: true, allowedEndpoints: [] },
    status: { ready: true },
    lastTest: null,
  };
  const data = backend(undefined, {
    personalAiSettings: personal,
    personalAiUsage: { plan: "Free", rows: [{ period: "month", used: 3, max: 200 }], upgradeUrl: "https://critiqs.example/upgrade" },
  });
  const shadow = await mount(data, { billing: false });
  await click(shadow.querySelector('button[aria-label="Signed in as Dana"]'));
  expect(button(shadow, "Plan and billing…")).toBeNull();
  await click(button(shadow, "Your AI…"));
  const link = [...shadow.querySelectorAll("a")].find((anchor) => anchor.textContent === "Upgrade")!;
  expect(link.getAttribute("href")).toBe("https://critiqs.example/upgrade");
});

const home: OrganizationSummary = { id: "home", name: "Dana's organization", role: "admin", plan: "Free" };
const personalAi: PersonalAiSettingsView = {
  saved: false,
  enabled: true,
  mode: "managed",
  managedModel: null,
  provider: null,
  model: null,
  models: [],
  baseUrl: null,
  keyHint: null,
  deployment: { managed: true, managedModels: [{ id: "fast", label: "Fast", credits: 1 }], defaultProvider: null, keysStorable: true, allowedEndpoints: [] },
  status: { ready: true },
  lastTest: null,
};
const twoOrganizations = { status: { acme: free, home: free }, usage: { acme: freeUsage, home: freeUsage } };
const billingDialog = (scope: ParentNode) => scope.querySelector('[role="dialog"][aria-label="Plan and billing"]');

test("with billing, Upgrade in Your AI closes it and opens Plan and billing on the person's home organization", async () => {
  const data = backend(twoOrganizations, {
    organizations: [acme, home],
    personalAiSettings: personalAi,
    personalAiUsage: { plan: "Free", organizationId: "home", rows: [{ period: "month", used: 3, max: 200 }], upgradeUrl: "https://critiqs.example/upgrade" },
  });
  const shadow = await mount(data);
  await click(shadow.querySelector('button[aria-label="Signed in as Dana"]'));
  await click(button(shadow, "Your AI…"));
  expect([...shadow.querySelectorAll("a")].some((anchor) => anchor.textContent === "Upgrade")).toBe(false);
  await click(button(shadow.querySelector('[aria-label="Your AI"]')!, "Upgrade"));
  expect(shadow.querySelector('[aria-label="Your AI"]')).toBeNull();
  expect(heading(billingDialog(shadow)!)).toBe("Plan and billing");
  expect(select(billingDialog(shadow)!, "Organization")?.textContent).toBe("Dana's organization");
});

test("with billing, Upgrade in the project's AI settings closes them and opens Plan and billing on the project's organization", async () => {
  const data = backend(twoOrganizations, {
    organizations: [home, acme],
    aiSettings: { ...personalAi, rule: "either", allowedModels: [], managedModel: "fast" },
    usage: { plan: "Free", rows: [{ metric: "aiCredits", period: "month", used: 3, max: 200 }] },
  });
  localStorage.setItem("critiqs:sidebar-open", "true");
  const shadow = await mount(data);
  await click(shadow.querySelector('[aria-label="Comment mode"]'));
  await click(shadow.querySelector('button[aria-label="Tags and AI settings"]'));
  await click([...shadow.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "AI"));
  await click(button(shadow.querySelector('[role="dialog"][aria-label="Tags and AI"]')!, "Upgrade"));
  expect(shadow.querySelector('[role="dialog"][aria-label="Tags and AI"]')).toBeNull();
  expect(select(billingDialog(shadow)!, "Organization")?.textContent).toBe("Acme");
});

test("a Free admin upgrades on Stripe Checkout, which returns to this page", async () => {
  const data = backend(billingOf(free, freeUsage, { changePlan: async () => ({ url: "https://checkout.stripe.example/c/1" }) }));
  const { page } = await renderDialog(data);
  await click(navRow(page, "Upgrade"));
  expect(heading(page)).toBe("Change plan");
  expect(rows(page)).toEqual([
    `Free $0 a month · ${FREE_INCLUDES} Current plan`,
    `Plus $20 a month · ${PLUS_INCLUDES} Upgrade to Plus`,
    `Pro $100 a month · ${PRO_INCLUDES} Upgrade to Pro`,
  ]);
  await click(button(page, "Upgrade to Plus"));
  expect(calls(data, "changePlan")).toEqual([{ organizationId: "acme", from: "free", plan: "plus", returnUrl: `${PAGE}?critiqs-billing=acme.plus` }]);
  expect(window.location.href).toBe("https://checkout.stripe.example/c/1");
});

test("back from Stripe, the page says it is updating the plan until the payment arrives, and says so plainly when it takes long", async () => {
  jest.useFakeTimers();
  faking = true;
  const data = backend(billingOf(free, freeUsage));
  const toasts: string[] = [];
  const { page, redraw } = await renderDialog(data, { awaiting: "plus", toasts });
  expect(page.querySelector('[role="status"]')?.textContent).toBe("Updating your plan… You can change it again once it arrives.");
  expect(navRow(page, "Upgrade")?.disabled).toBe(true);
  await act(async () => jest.advanceTimersByTime(ARRIVAL_TIMEOUT_MS));
  expect(page.querySelector('[role="status"]')?.textContent).toBe("Plus hasn't reached Critiqs yet. Payments can take a few minutes; this page updates when it arrives.");
  data.billing!.status.acme = plus;
  data.billing!.usage.acme = plusUsage;
  await redraw();
  expect(page.querySelector('[role="status"]')).toBeNull();
  expect(rows(page)[0]).toBe("Plan Plus · $20 a month");
  expect(toasts).toEqual(["Acme is on Plus"]);
});

test("the page reopens after Stripe from the address it returned to, and the address loses the parameter", async () => {
  const data = backend(billingOf(plus, plusUsage));
  const shadow = await mount(data, { url: `${PAGE}?view=2&critiqs-billing=acme.plus` });
  expect(heading(shadow.querySelector('[role="dialog"][aria-label="Plan and billing"]')!)).toBe("Plan and billing");
  expect(window.location.href).toBe(`${PAGE}?view=2`);
});

test("moving up between paid plans says what it charges before anything is charged, and charges once", async () => {
  let finish = (_: { url: null }) => {};
  const data = backend(billingOf(plus, plusUsage, { changePlan: () => new Promise((resolve) => (finish = resolve)) }));
  const toasts: string[] = [];
  const { page } = await renderDialog(data, { toasts });
  expect(rows(page).slice(0, 2)).toEqual(["Plan Plus · $20 a month", "Renews Jan 1, 2027"]);
  await click(navRow(page, "Change plan"));
  await click(button(page, "Upgrade to Pro"));
  expect(heading(page)).toBe("Upgrade to Pro");
  expect(page.querySelector(".billing-confirm")?.textContent).toBe(
    "Acme moves to Pro now, at $100 a month. You'll be charged a prorated amount now for the rest of this billing period, on the card on file.",
  );
  expect(calls(data, "changePlan")).toEqual([]);
  const confirm = button(page, "Upgrade to Pro")!;
  await click(confirm);
  await click(confirm);
  expect(confirm.disabled).toBe(true);
  expect(confirm.textContent).toBe("Working…");
  await act(async () => finish({ url: null }));
  await settle();
  expect(calls(data, "changePlan")).toEqual([{ organizationId: "acme", from: "plus", plan: "pro", returnUrl: `${PAGE}?critiqs-billing=acme.pro` }]);
  expect(toasts).toEqual(["Upgraded to Pro"]);
  expect(heading(page)).toBe("Plan and billing");
});

test("moving down waits for the end of the period, and says when", async () => {
  const data = backend(billingOf({ ...pro, storageAddOns: 1 }, plusUsage));
  const { page } = await renderDialog(data);
  await click(navRow(page, "Change plan"));
  expect(button(page, "Upgrade to Pro")).toBeNull();
  await click(button(page, "Switch to Plus"));
  expect(page.querySelector(".billing-confirm")?.textContent).toBe(
    `Acme changes to Plus on Jan 1, 2027. Pro stays until then; from then Plus is $20 a month, with ${PLUS_INCLUDES}. Extra storage ends with Pro.`,
  );
  await click(button(page, "Back"));
  await click(button(page, "Switch to Free"));
  expect(page.querySelector(".billing-confirm")?.textContent).toBe(
    `Pro ends on Jan 1, 2027, then Acme moves to Free: ${FREE_INCLUDES}. You won't be charged for the plan again; extra credits used before then are on the last invoice. Extra storage ends with Pro.`,
  );
  await click(button(page, "Switch to Free"));
  expect(calls(data, "changePlan")).toEqual([{ organizationId: "acme", from: "pro", plan: "free", returnUrl: `${PAGE}?critiqs-billing=acme` }]);
});

test("a pending cancel or change says when it happens, and Keep my plan undoes it", async () => {
  const cancelling: BillingStatus = { ...plus, subscription: { ...plus.subscription!, cancelAtPeriodEnd: true, scheduledPlan: "free" } };
  const data = backend(billingOf(cancelling, plusUsage));
  const { page, redraw } = await renderDialog(data);
  expect(page.querySelector(".warning")?.textContent).toBe("Plus cancels on Jan 1, 2027.Keep my plan");
  expect(rows(page)[1]).toBe("Period ends Jan 1, 2027");
  await click(button(page, "Keep my plan"));
  expect(calls(data, "changePlan")).toEqual([{ organizationId: "acme", from: "plus", plan: "plus", returnUrl: `${PAGE}?critiqs-billing=acme` }]);
  data.billing!.status.acme = { ...pro, subscription: { ...pro.subscription!, scheduledPlan: "plus" } };
  await redraw();
  expect(page.querySelector(".warning")?.textContent).toBe("Pro changes to Plus on Jan 1, 2027.Keep my plan");
  await click(navRow(page, "Change plan"));
  expect(rows(page)[1]).toBe(`Plus $20 a month · ${PLUS_INCLUDES} From Jan 1, 2027`);
});

test("a failed renewal warns, and Manage billing opens Stripe's portal", async () => {
  const data = backend(billingOf({ ...plus, subscription: { ...plus.subscription!, status: "past_due" } }, plusUsage));
  const { page } = await renderDialog(data);
  const warning = page.querySelector(".warning")!;
  expect(warning.textContent).toBe("The last payment for Plus didn't go through. Update the payment method to keep Plus.Manage billing");
  await click(button(warning, "Manage billing"));
  expect(calls(data, "openPortal")).toEqual([{ organizationId: "acme", returnUrl: `${PAGE}?critiqs-billing=acme` }]);
  expect(window.location.href).toBe("https://billing.stripe.example/portal");
});

test("members see the plan, usage, and cap, and change nothing", async () => {
  const cancelling: BillingStatus = { ...plus, canManage: false, subscription: { ...plus.subscription!, cancelAtPeriodEnd: true, scheduledPlan: "free" } };
  const data = backend({ status: { studio: cancelling }, usage: { studio: plusUsage } }, { organizations: [studio] });
  const { page } = await renderDialog(data, { organizationId: "studio" });
  expect(rows(page)).toEqual([
    "Plan Plus · $20 a month",
    "Period ends Jan 1, 2027",
    "Critiqs AI credits this month 2,300 of 2,000 · 300 extra ($3), 1,700 left",
    "Projects 3 of 10",
    "Images stored 1.5 GB of 10.0 GB",
    "Cap on extra credits 2,000 · up to $20",
  ]);
  expect(page.querySelector(".warning")?.textContent).toBe("Plus cancels on Jan 1, 2027.");
  expect(page.querySelectorAll("button.ds-nav-row, .btn").length).toBe(0);
  expect(page.textContent).toContain("Only admins of Studio can change its plan.");
});

test("usage at its cap says so in words, and the meter's value says the same", async () => {
  const at = async (credits: OrganizationUsage["rows"][number]) => {
    const data = backend({ status: { studio: { ...plus, canManage: false } }, usage: { studio: { ...plusUsage, rows: [credits] } } }, { organizations: [studio] });
    const { page } = await renderDialog(data, { organizationId: "studio" });
    const row = page.querySelector(".billing-usage-row")!;
    const seen = [words(row), row.querySelector(".error")?.textContent ?? null, row.querySelector('[role="meter"]')!.getAttribute("aria-valuetext")];
    await act(async () => root?.unmount());
    root = null;
    return seen;
  };
  const credits = plusUsage.rows[0]!;
  expect(await at({ ...credits, used: 4_000 })).toEqual([
    "Critiqs AI credits this month 4,000 of 2,000 · 2,000 extra ($20), cap reached",
    "4,000 of 2,000 · 2,000 extra ($20), cap reached",
    "4,000 of 2,000 · 2,000 extra ($20), cap reached",
  ]);
  expect(await at({ ...credits, used: 2_000 })).toEqual([
    "Critiqs AI credits this month 2,000 of 2,000 · included credits used, extra allowed",
    null,
    "2,000 of 2,000 · included credits used, extra allowed",
  ]);
  expect(await at({ ...credits, used: 2_000, overage: { cap: 0 } })).toEqual([
    "Critiqs AI credits this month 2,000 of 2,000, cap reached",
    "2,000 of 2,000, cap reached",
    "2,000 of 2,000, cap reached",
  ]);
});

test("someone in several organizations picks which one's plan to see", async () => {
  const data = backend({ status: { acme: free, studio: { ...plus, canManage: false } }, usage: { acme: freeUsage, studio: plusUsage } }, { organizations: [acme, studio] });
  const { page } = await renderDialog(data, { organizationId: null });
  expect(select(page, "Organization")?.textContent).toBe("Acme");
  expect(rows(page)[1]).toBe("Plan Free");
  await choose(page, "Organization", "Studio");
  expect(rows(page)[1]).toBe("Plan Plus · $20 a month");
});

test("admins set the cap on extra credits as a number, none, or the plan's, seeing what it costs at most", async () => {
  const data = backend(billingOf(plus, plusUsage));
  const { page } = await renderDialog(data);
  await click(navRow(page, "Cap on extra credits"));
  expect(heading(page)).toBe("Cap on extra credits");
  expect(page.querySelector('.ds-page form [role="status"], form [role="status"]')?.textContent).toBe("Up to 2,000 extra credits, at most $20 a month.");
  await choose(page, "Cap", "Set a number");
  await type(page.querySelector<HTMLInputElement>("input.billing-cap-field"), "5000");
  expect(page.querySelector('form [role="status"]')?.textContent).toBe("Up to 5,000 extra credits, at most $50 a month.");
  await click(button(page, "Save cap"));
  expect(calls(data, "setOverageCap")).toEqual([{ organizationId: "acme", cap: 5000 }]);
  expect(heading(page)).toBe("Plan and billing");

  await click(navRow(page, "Cap on extra credits"));
  await choose(page, "Cap", "Set a number");
  await type(page.querySelector<HTMLInputElement>("input.billing-cap-field"), "lots");
  expect(page.querySelector('form [role="status"]')?.textContent).toBe("Enter a whole number of credits, such as 5000.");
  expect(button(page, "Save cap")?.disabled).toBe(true);
  await choose(page, "Cap", "No cap");
  expect(page.querySelector('form [role="status"]')?.textContent).toBe("Extra credits have no cap; each 100 cost $1.");
  await click(button(page, "Save cap"));
  expect(calls(data, "setOverageCap").at(-1)).toEqual({ organizationId: "acme", cap: null });
});

test("Pro admins add the storage add-on after seeing its price, and remove it at the end of the period", async () => {
  const data = backend(billingOf(pro, plusUsage));
  const toasts: string[] = [];
  const { page, redraw } = await renderDialog(data, { toasts });
  expect(navRow(page, "Extra storage")?.textContent).toBe("Extra storageOff");
  await click(navRow(page, "Extra storage"));
  expect(heading(page)).toBe("Add extra storage");
  expect(page.querySelector(".billing-confirm")?.textContent).toBe(
    "Adds 100 GB of image storage to Acme for $10 a month. You'll be charged a prorated amount now for the rest of this billing period, on the card on file.",
  );
  await click(button(page, "Add extra storage"));
  expect(calls(data, "setStorageAddOn")).toEqual([{ organizationId: "acme", enabled: true, returnUrl: `${PAGE}?critiqs-billing=acme.storage` }]);
  data.billing!.status.acme = { ...pro, storageAddOns: 1 };
  await redraw();
  expect(navRow(page, "Extra storage")?.textContent).toBe("Extra storage100 GB · $10 a month");
  await click(navRow(page, "Extra storage"));
  await click(button(page, "Remove extra storage"));
  expect(calls(data, "setStorageAddOn").at(-1)).toEqual({ organizationId: "acme", enabled: false, returnUrl: `${PAGE}?critiqs-billing=acme` });
  expect(toasts).toEqual(["Extra storage added", "Extra storage ends at the end of this billing period"]);
});

test("a refused change says why and lets the admin try again", async () => {
  const data = backend(
    billingOf(plus, plusUsage, {
      changePlan: async () => {
        throw new CritiqsRequestError("unavailable", "Too many billing changes for this organization in the last minute. Wait a minute, then try again.");
      },
    }),
  );
  const { page } = await renderDialog(data);
  await click(navRow(page, "Change plan"));
  await click(button(page, "Upgrade to Pro"));
  await click(button(page, "Upgrade to Pro"));
  expect(page.querySelector('[role="alert"]')?.textContent).toBe("Too many billing changes for this organization in the last minute. Wait a minute, then try again.");
  expect(button(page, "Upgrade to Pro")?.disabled).toBe(false);
  expect(heading(page)).toBe("Upgrade to Pro");
});

test("the page says while it loads and when it can't load", async () => {
  const loading = backend({ status: {}, usage: {} });
  const first = await renderDialog(loading);
  expect(first.page.querySelector(".note")?.textContent).toBe("Loading…");
  await act(async () => root?.unmount());
  host?.remove();
  const failing = backend({ status: { acme: "Only members of the organization can see its plan." }, usage: { acme: null } });
  const second = await renderDialog(failing);
  expect(second.page.querySelector(".error")?.textContent).toBe("Only members of the organization can see its plan.");
});

test("while a payment is on its way, the plan can't be changed from the plan shown before it", async () => {
  const data = backend(billingOf(free, freeUsage));
  const { page } = await renderDialog(data, { awaiting: "plus" });
  expect(navRow(page, "Upgrade")?.disabled).toBe(true);
  await click(navRow(page, "Upgrade"));
  expect(heading(page)).toBe("Plan and billing");
  expect(calls(data, "changePlan")).toEqual([]);
});

test("a plan Critiqs set says so, and paying for a plan goes to Stripe Checkout as from Free", async () => {
  const data = backend(billingOf(plusSetByCritiqs, plusUsage, { changePlan: async () => ({ url: "https://checkout.stripe.example/c/2" }) }));
  const { page } = await renderDialog(data);
  expect(rows(page).slice(0, 2)).toEqual(["Plan Plus · set by Critiqs", "Change plan"]);
  expect(page.textContent).toContain("Critiqs set this plan for Acme, at no charge. Buying a plan starts a subscription, paid on Stripe Checkout, that replaces it.");
  expect(navRow(page, "Manage billing")).toBeNull();
  await click(navRow(page, "Change plan"));
  expect(rows(page)).toEqual([
    `Free $0 a month · ${FREE_INCLUDES}`,
    `Plus $20 a month · ${PLUS_INCLUDES} Set by Critiqs`,
    `Pro $100 a month · ${PRO_INCLUDES} Upgrade to Pro`,
  ]);
  await click(button(page, "Upgrade to Pro"));
  expect(calls(data, "changePlan")).toEqual([{ organizationId: "acme", from: "free", plan: "pro", returnUrl: `${PAGE}?critiqs-billing=acme.pro` }]);
  expect(window.location.href).toBe("https://checkout.stripe.example/c/2");
});

test("Pro set by Critiqs offers no storage add-on, which needs a Pro subscription", async () => {
  const data = backend(billingOf({ ...plusSetByCritiqs, plan: "pro" }, plusUsage));
  const { page } = await renderDialog(data);
  expect(rows(page)[0]).toBe("Plan Pro · set by Critiqs");
  expect(navRow(page, "Extra storage")).toBeNull();
  expect(page.textContent).not.toContain("Extra storage");
});

test("Keep Pro before adding storage while Pro is set to end", async () => {
  const leaving: BillingStatus = { ...pro, subscription: { ...pro.subscription!, scheduledPlan: "plus" } };
  const data = backend(billingOf(leaving, plusUsage));
  const { page } = await renderDialog(data);
  await click(navRow(page, "Extra storage"));
  expect(page.querySelector(".billing-confirm")?.textContent).toBe("Pro changes to Plus on Jan 1, 2027. Keep Pro first, then add storage.");
  expect(button(page, "Add extra storage")).toBeNull();
});

test("two clicks in the same moment make one change, and one cap save", async () => {
  let finish = (_: { url: null }) => {};
  const data = backend(billingOf(plus, plusUsage, { changePlan: () => new Promise((resolve) => (finish = resolve)) }));
  const { page } = await renderDialog(data);
  await click(navRow(page, "Change plan"));
  await click(button(page, "Upgrade to Pro"));
  const confirm = button(page, "Upgrade to Pro")!;
  await act(async () => {
    confirm.click();
    confirm.click();
  });
  await act(async () => finish({ url: null }));
  await settle();
  expect(calls(data, "changePlan")).toHaveLength(1);

  await click(navRow(page, "Cap on extra credits"));
  const form = page.querySelector("form")!;
  await act(async () => {
    form.requestSubmit();
    form.requestSubmit();
  });
  await settle();
  expect(calls(data, "setOverageCap")).toHaveLength(1);
});

test("going back to the plan clears a refused change's message", async () => {
  const data = backend(
    billingOf(plus, plusUsage, {
      changePlan: async () => {
        throw new CritiqsRequestError("unavailable", "Billing isn't available right now. Try again in a few minutes.");
      },
    }),
  );
  const { page } = await renderDialog(data);
  await click(navRow(page, "Change plan"));
  await click(button(page, "Upgrade to Pro"));
  await click(button(page, "Upgrade to Pro"));
  expect(page.querySelector('[role="alert"]')).not.toBeNull();
  await click(button(page, "Back"));
  await click(button(page, "Back"));
  expect(heading(page)).toBe("Plan and billing");
  expect(page.querySelector('[role="alert"]')).toBeNull();
});

test("dates are the day Autumn's period ends in UTC, wherever the admin is", async () => {
  const zone = process.env.TZ;
  process.env.TZ = "America/Chicago";
  try {
    const data = backend(billingOf({ ...plus, subscription: { ...plus.subscription!, currentPeriodEnd: Date.UTC(2027, 1, 1) } }, plusUsage));
    const { page } = await renderDialog(data);
    expect(rows(page)[1]).toBe("Renews Feb 1, 2027");
  } finally {
    process.env.TZ = zone;
  }
});

test("a confirm page acts only on the organization it opened for, and goes back when that organization is gone", async () => {
  const data = backend({ status: { acme: pro, studio: { ...plus, canManage: true } }, usage: { acme: plusUsage, studio: plusUsage } }, { organizations: [acme, { ...studio, role: "admin" }] });
  const { page, redraw } = await renderDialog(data);
  await click(navRow(page, "Change plan"));
  await click(button(page, "Switch to Free"));
  expect(page.querySelector(".billing-confirm")?.textContent).toContain("then Acme moves to Free");
  data.organizations = [{ ...studio, role: "admin" }];
  await redraw();
  await settle();
  expect(heading(page)).toBe("Plan and billing");
  expect(button(page, "Switch to Free")).toBeNull();
  expect(rows(page)[0]).toBe("Plan Plus · $20 a month");
  expect(calls(data, "changePlan")).toEqual([]);
});

test("prices are the ones the backend reports from Autumn's catalog", async () => {
  const raised: BillingPrices = {
    plans: {
      free: { monthly: 0, extraCredits: null },
      plus: { monthly: 25, extraCredits: { amount: 2, credits: 100 } },
      pro: { monthly: 120, extraCredits: { amount: 3, credits: 50 } },
    },
    storageAddOn: { gb: 200, monthly: 15 },
  };
  const data = backend(billingOf({ ...plus, prices: raised }, plusUsage));
  const { page, redraw } = await renderDialog(data);
  expect(rows(page)).toEqual([
    "Plan Plus · $25 a month",
    "Renews Jan 1, 2027",
    "Change plan",
    "Manage billing Payment method and invoices",
    "Critiqs AI credits this month 2,300 of 2,000 · 300 extra ($6), 1,700 left",
    "Projects 3 of 10",
    "Images stored 1.5 GB of 10.0 GB",
    "Cap on extra credits 2,000 · up to $40",
  ]);
  await click(navRow(page, "Cap on extra credits"));
  expect(page.querySelector("form .note")?.textContent).toBe("The plan includes 2,000 credits a month. Past them, each 100 credits cost $2, up to the cap.");
  expect(page.querySelector('form [role="status"]')?.textContent).toBe("Up to 2,000 extra credits, at most $40 a month.");
  await click(button(page, "Back"));
  await click(navRow(page, "Change plan"));
  expect(rows(page)).toEqual([
    `Free $0 a month · ${FREE_INCLUDES} Switch to Free`,
    `Plus $25 a month · ${PLUS_INCLUDES} Current plan`,
    `Pro $120 a month · ${PRO_INCLUDES} Upgrade to Pro`,
  ]);
  await click(button(page, "Upgrade to Pro"));
  expect(page.querySelector(".billing-confirm")?.textContent).toContain("Acme moves to Pro now, at $120 a month.");

  data.billing!.status.acme = { ...pro, storageAddOns: 1, prices: raised };
  await redraw();
  await click(button(page, "Back"));
  await click(button(page, "Back"));
  expect(rows(page)).toContain("Extra storage 100 GB · $15 a month");
  expect(rows(page)).toContain("Critiqs AI credits this month 2,300 of 2,000 · 300 extra ($18), 1,700 left");
  expect(calls(data, "loadPrices")).toEqual([]);
});

test("without prices, every page shows the plans and their limits but no price, and asks the backend for them once", async () => {
  const unpriced = { ...pro, storageAddOns: 1, prices: null };
  const data = backend(billingOf(unpriced, plusUsage));
  const { page } = await renderDialog(data);
  const seen: string[] = [page.textContent!];
  expect(rows(page)).toEqual([
    "Plan Pro",
    "Renews Jan 1, 2027",
    "Change plan",
    "Manage billing Payment method and invoices",
    "Critiqs AI credits this month 2,300 of 2,000 · 300 extra, 1,700 left",
    "Projects 3 of 10",
    "Images stored 1.5 GB of 10.0 GB",
    "Cap on extra credits 2,000",
    "Extra storage 100 GB",
  ]);
  await click(navRow(page, "Cap on extra credits"));
  seen.push(page.textContent!);
  expect(page.querySelector("form .note")?.textContent).toBe("The plan includes 2,000 credits a month. Past them, extra credits are billed, up to the cap.");
  expect(page.querySelector('form [role="status"]')?.textContent).toBe("Up to 2,000 extra credits a month.");
  await choose(page, "Cap", "No cap");
  expect(page.querySelector('form [role="status"]')?.textContent).toBe("Extra credits have no cap.");
  seen.push(page.textContent!);
  await click(button(page, "Back"));
  await click(navRow(page, "Change plan"));
  seen.push(page.textContent!);
  expect(rows(page)).toEqual([`Free ${FREE_INCLUDES} Switch to Free`, `Plus ${PLUS_INCLUDES} Switch to Plus`, `Pro ${PRO_INCLUDES} Current plan`]);
  await click(button(page, "Switch to Free"));
  seen.push(page.textContent!);
  expect(page.querySelector(".billing-confirm")?.textContent).toBe(
    `Pro ends on Jan 1, 2027, then Acme moves to Free: ${FREE_INCLUDES}. You won't be charged for the plan again; extra credits used before then are on the last invoice. Extra storage ends with Pro.`,
  );
  await click(button(page, "Back"));
  await click(button(page, "Back"));
  await click(navRow(page, "Extra storage"));
  seen.push(page.textContent!);
  expect(page.querySelector(".billing-confirm")?.textContent).toBe(
    "Acme's extra storage stays until the end of this billing period, then image storage goes back to 100 GB. You won't be charged for it again.",
  );
  for (const text of seen) expect(text).not.toContain("$");
  expect(calls(data, "loadPrices")).toEqual([{}]);
});

test("without prices, changes that would charge the card on file are paused, and cancelling and removing storage still work", async () => {
  const data = backend(billingOf({ ...pro, prices: null }, plusUsage));
  const { page, redraw } = await renderDialog(data);
  expect(page.textContent).toContain(PAUSED);
  expect(navRow(page, "Extra storage")?.disabled).toBe(true);
  await click(navRow(page, "Change plan"));
  expect(button(page, "Switch to Plus")?.disabled).toBe(true);
  expect(page.textContent).toContain(PAUSED);
  await click(button(page, "Switch to Free"));
  await click(button(page, "Switch to Free"));
  expect(calls(data, "changePlan")).toEqual([{ organizationId: "acme", from: "pro", plan: "free", returnUrl: `${PAGE}?critiqs-billing=acme` }]);

  data.billing!.status.acme = { ...plus, prices: null };
  await redraw();
  await click(navRow(page, "Change plan"));
  expect(button(page, "Upgrade to Pro")?.disabled).toBe(true);
  await click(button(page, "Back"));

  data.billing!.status.acme = { ...pro, storageAddOns: 1, prices: null };
  await redraw();
  await click(navRow(page, "Extra storage"));
  await click(button(page, "Remove extra storage"));
  expect(calls(data, "setStorageAddOn")).toEqual([{ organizationId: "acme", enabled: false, returnUrl: `${PAGE}?critiqs-billing=acme` }]);
  expect(calls(data, "changePlan")).toHaveLength(1);
});

test("prices that go away while a change waits to be confirmed pause it", async () => {
  const data = backend(billingOf(plus, plusUsage));
  const { page, redraw } = await renderDialog(data);
  await click(navRow(page, "Change plan"));
  await click(button(page, "Upgrade to Pro"));
  expect(button(page, "Upgrade to Pro")).not.toBeNull();
  data.billing!.status.acme = { ...plus, prices: null };
  await redraw();
  expect(page.querySelector(".billing-confirm")?.textContent).toBe(PAUSED);
  expect(button(page, "Upgrade to Pro")).toBeNull();

  data.billing!.status.acme = { ...pro, prices: PRICES };
  await redraw();
  await click(button(page, "Back"));
  await click(button(page, "Back"));
  await click(navRow(page, "Extra storage"));
  data.billing!.status.acme = { ...pro, prices: null };
  await redraw();
  expect(page.querySelector(".billing-confirm")?.textContent).toBe(PAUSED);
  expect(button(page, "Add extra storage")).toBeNull();
  expect(calls(data, "changePlan")).toEqual([]);
  expect(calls(data, "setStorageAddOn")).toEqual([]);
});

test("without prices, buying from Free still goes to Stripe Checkout, which shows the price", async () => {
  const data = backend(billingOf({ ...free, prices: null }, freeUsage));
  const { page } = await renderDialog(data);
  expect(page.textContent).not.toContain(PAUSED);
  await click(navRow(page, "Upgrade"));
  expect(page.textContent).toContain("Prices can't be shown right now. Stripe Checkout shows the price before you pay.");
  expect(button(page, "Upgrade to Pro")?.disabled).toBe(false);
  await click(button(page, "Upgrade to Plus"));
  expect(calls(data, "changePlan")).toEqual([{ organizationId: "acme", from: "free", plan: "plus", returnUrl: `${PAGE}?critiqs-billing=acme.plus` }]);
});

test("what each plan includes is what the backend's plan configuration says", async () => {
  const configured: BillingStatus["plans"] = {
    ...PLAN_CONFIG,
    plus: {
      label: "Plus",
      limits: [
        { metric: "aiCredits", period: "month", max: 3_000 },
        { metric: "projects", period: "total", max: 20 },
        { metric: "captureBytes", period: "total", max: 20 * GB },
        unlimited("reviewers", "month"),
        { metric: "messages", period: "day", max: 300 },
        unlimited("mentionEmails", "day"),
      ],
    },
    pro: { ...PLAN_CONFIG.pro, limits: PLAN_CONFIG.pro.limits.map((limit) => (limit.metric === "captureBytes" ? { ...limit, max: 200 * GB, addOn: 50 * GB } : limit)) },
  };
  const data = backend(billingOf({ ...pro, storageAddOns: 2, plans: configured }, plusUsage));
  const { page } = await renderDialog(data);
  expect(rows(page)).toContain("Extra storage 100 GB · $20 a month");
  await click(navRow(page, "Change plan"));
  expect(rows(page)).toEqual([
    `Free $0 a month · ${FREE_INCLUDES} Switch to Free`,
    "Plus $20 a month · 3,000 AI credits a month, 20 projects, 20 GB of image storage, 300 comments a day; unlimited reviewers and mention emails Switch to Plus",
    "Pro $100 a month · 10,000 AI credits a month, 200 GB of image storage; unlimited projects, reviewers, comments and mention emails Current plan",
  ]);
  await click(button(page, "Switch to Plus"));
  expect(page.querySelector(".billing-confirm")?.textContent).toContain(
    "from then Plus is $20 a month, with 3,000 AI credits a month, 20 projects, 20 GB of image storage, 300 comments a day; unlimited reviewers and mention emails.",
  );
  await click(button(page, "Back"));
  await click(button(page, "Back"));
  await click(navRow(page, "Extra storage"));
  expect(page.querySelector(".billing-confirm")?.textContent).toBe(
    "One of Acme's 2 storage add-ons stays until the end of this billing period, then image storage goes down to 250 GB. You won't be charged for that one again.",
  );
});

test("with several storage add-ons, the page counts the ones that renew, and Remove ends one", async () => {
  const data = backend(billingOf({ ...pro, storageAddOns: 2 }, plusUsage));
  const { page, redraw } = await renderDialog(data);
  expect(rows(page)).toContain("Extra storage 200 GB · $20 a month");
  await click(navRow(page, "Extra storage"));
  expect(heading(page)).toBe("Remove extra storage");
  expect(page.querySelector(".billing-confirm")?.textContent).toBe(
    "One of Acme's 2 storage add-ons stays until the end of this billing period, then image storage goes down to 200 GB. You won't be charged for that one again.",
  );
  await click(button(page, "Remove extra storage"));
  expect(calls(data, "setStorageAddOn")).toEqual([{ organizationId: "acme", enabled: false, returnUrl: `${PAGE}?critiqs-billing=acme` }]);
  data.billing!.status.acme = { ...pro, storageAddOns: 1 };
  await redraw();
  expect(rows(page)).toContain("Extra storage 100 GB · $10 a month");
  await click(navRow(page, "Extra storage"));
  expect(page.querySelector(".billing-confirm")?.textContent).toBe(
    "Acme's extra storage stays until the end of this billing period, then image storage goes back to 100 GB. You won't be charged for it again.",
  );
});
