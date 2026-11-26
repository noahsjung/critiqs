import type { ProjectInfo, ProjectUsage, TicketsConfig, TrackerAccountView } from "@critiqs/core";
import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TransportContext } from "../src/transport.ts";
import { OpenBillingContext } from "../src/ui/BillingDialog.tsx";
import { Setup } from "../src/ui/Setup.tsx";
import { fakeTransport } from "./fake-transport.tsx";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const MB = 1024 * 1024;
const project: ProjectInfo = { _id: "project", name: "Pilot", tags: [], createdAt: 1, reviewUrl: null, isOwner: true };
const free: ProjectUsage = {
  plan: "Free",
  rows: [
    { metric: "aiCredits", period: "month", used: 184, max: 200 },
    { metric: "projects", period: "total", used: 1, max: 1 },
    { metric: "messages", period: "month", used: 500, max: 500 },
    { metric: "captureBytes", period: "total", used: 12 * MB, max: 500 * MB },
  ],
};
const plus: ProjectUsage = {
  plan: "Plus",
  rows: [
    { metric: "aiCredits", period: "month", used: 3_000, max: 2_000, overage: { cap: 2_000 } },
    { metric: "projects", period: "total", used: 1, max: 10 },
    { metric: "messages", period: "month", used: 412, max: 5_000 },
  ],
  unlimited: [{ metric: "mentionEmails", period: "day", used: 12 }],
};

async function renderSetup(
  backend: { project?: ProjectInfo; usage?: ProjectUsage | null },
  { billing = null, configured = true, reviewLinksAt = null }: { billing?: ((organizationId?: string) => void) | null; configured?: boolean; reviewLinksAt?: ((projectId: string) => string) | null } = {},
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const copied: string[] = [];
  const transport = fakeTransport({ project, threads: [], ...backend });
  await act(async () =>
    root.render(
      <TransportContext.Provider value={transport}>
        <OpenBillingContext.Provider value={billing === null ? null : { open: billing, organizationId: "acme" }}>
          <Setup
            backLabel="Back to comments"
            reviewer={{ id: "u_dana", name: "Dana", email: "dana@example.com", pictureUrl: null }}
            signedIn
            onSignIn={() => {}}
            configuredProjectId={configured ? "project" : null}
            browserProjectId={configured ? null : "project"}
            onUseProject={() => {}}
            onDone={() => {}}
            notify={(message) => copied.push(message)}
            reviewLinksAt={reviewLinksAt}
          />
        </OpenBillingContext.Provider>
      </TransportContext.Provider>,
    ),
  );
  const plan = () => host.querySelector<HTMLElement>('section[aria-label="Plan"]');
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === label);
  return {
    host,
    plan,
    button,
    copied,
    rows: () =>
      [...plan()!.querySelectorAll(".usage-meter, .usage-unlimited")].map((row) => {
        const meter = row.querySelector('[role="meter"]');
        return [row.textContent, meter?.className ?? null];
      }),
    meters: () => [...plan()!.querySelectorAll('[role="meter"]')].map((meter) => [meter.getAttribute("aria-label"), meter.getAttribute("aria-valuetext")]),
    click: async (target: HTMLElement) => await act(async () => target.click()),
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("the plan shows its credits and what is near its limit, leaving out projects and what has room", async () => {
  const setup = await renderSetup({ usage: free });
  expect(setup.plan()!.querySelector("strong")?.textContent).toBe("Free plan");
  expect(setup.rows()).toEqual([
    ["Critiqs AI credits this month184 of 200", "ds-meter high"],
    ["Comments this month500 of 500, limit reached", "ds-meter full"],
  ]);
  expect(setup.meters()).toEqual([
    ["Critiqs AI credits this month", "184 of 200"],
    ["Comments this month", "500 of 500, limit reached"],
  ]);
  expect(setup.plan()!.querySelector(".error")?.textContent).toBe("500 of 500, limit reached");
  await setup.done();
});

test("All usage lists every limit and what is unlimited, and hides them again", async () => {
  const setup = await renderSetup({ usage: plus });
  const all = setup.button("All usage")!;
  expect(all.getAttribute("aria-expanded")).toBe("false");
  expect(setup.rows()).toEqual([["Critiqs AI credits this month3,000 of 2,000 · 1,000 extra, 1,000 left", "ds-meter high"]]);
  await setup.click(all);
  expect(all.getAttribute("aria-expanded")).toBe("true");
  expect(all.textContent).toBe("Less");
  expect(setup.host.querySelector(`[id="${all.getAttribute("aria-controls")}"]`)).not.toBeNull();
  expect(setup.rows()).toEqual([
    ["Critiqs AI credits this month3,000 of 2,000 · 1,000 extra, 1,000 left", "ds-meter high"],
    ["Projects1 of 10", "ds-meter"],
    ["Comments this month412 of 5,000", "ds-meter"],
    ["Mention emails today12 · Unlimited", null],
  ]);
  expect(setup.plan()!.textContent).toContain("Projects, images, and Critiqs AI credits count for the whole organization.");
  await setup.click(all);
  expect(setup.rows()).toHaveLength(1);
  // No upgrade page named, no link.
  expect(setup.plan()!.querySelector("a")).toBeNull();
  await setup.done();
});

test("without billing, the plan links to the deployment's upgrade page when it names one", async () => {
  const setup = await renderSetup({ usage: { ...free, upgradeUrl: "https://critiqs.example/plans" } });
  const link = setup.plan()!.querySelector<HTMLAnchorElement>("a")!;
  expect(link.textContent).toBe("Upgrade");
  expect(link.getAttribute("href")).toBe("https://critiqs.example/plans");
  expect(link.getAttribute("target")).toBe("_blank");
  await setup.done();
});

test("with billing, Plan and billing opens it on the project's organization in place of Upgrade; All usage still lists the project's limits", async () => {
  const opened: (string | undefined)[] = [];
  const setup = await renderSetup({ usage: { ...plus, upgradeUrl: "https://critiqs.example/plans" } }, { billing: (organizationId) => opened.push(organizationId) });
  expect(setup.plan()!.querySelector("a")).toBeNull();
  await setup.click(setup.button("Plan and billing")!);
  expect(opened).toEqual([undefined]);
  await setup.click(setup.button("All usage")!);
  expect(setup.rows().map(([text]) => text)).toContain("Comments this month412 of 5,000");
  await setup.done();
});

test("extra credits say how many are left before the cap, warn in words near it, and say when AI stops, with billing on or off", async () => {
  const credits = plus.rows[0]!;
  const at = async (row: ProjectUsage["rows"][number], billing: (() => void) | null) => {
    const setup = await renderSetup({ usage: { plan: "Plus", rows: [row, ...plus.rows.slice(1)] } }, { billing });
    const summary = setup.rows()[0];
    await setup.click(setup.button("All usage")!);
    const all = setup.rows()[0];
    const text = setup.plan()!.querySelector(".usage-meter .row span:last-child")!;
    const seen = [all, setup.meters()[0]![1], text.className];
    await setup.done();
    expect(summary).toEqual(all!);
    return seen;
  };
  for (const billing of [null, () => {}]) {
    expect(await at({ ...credits, used: 1_500 }, billing)).toEqual([["Critiqs AI credits this month1,500 of 2,000", "ds-meter"], "1,500 of 2,000", "note"]);
    expect(await at({ ...credits, used: 2_000 }, billing)).toEqual([
      ["Critiqs AI credits this month2,000 of 2,000 · included credits used, extra allowed", "ds-meter high"],
      "2,000 of 2,000 · included credits used, extra allowed",
      "note",
    ]);
    expect(await at({ ...credits, used: 3_000 }, billing)).toEqual([
      ["Critiqs AI credits this month3,000 of 2,000 · 1,000 extra, 1,000 left", "ds-meter high"],
      "3,000 of 2,000 · 1,000 extra, 1,000 left",
      "note",
    ]);
    expect(await at({ ...credits, used: 3_950 }, billing)).toEqual([
      ["Critiqs AI credits this month3,950 of 2,000 · 1,950 extra, 50 left, near cap", "ds-meter high"],
      "3,950 of 2,000 · 1,950 extra, 50 left, near cap",
      "caution",
    ]);
    expect(await at({ ...credits, used: 4_000 }, billing)).toEqual([
      ["Critiqs AI credits this month4,000 of 2,000 · 2,000 extra, cap reached", "ds-meter full"],
      "4,000 of 2,000 · 2,000 extra, cap reached",
      "error",
    ]);
    expect(await at({ ...credits, used: 2_000, overage: { cap: 0 } }, billing)).toEqual([
      ["Critiqs AI credits this month2,000 of 2,000, cap reached", "ds-meter full"],
      "2,000 of 2,000, cap reached",
      "error",
    ]);
    expect(await at({ ...credits, used: 9_000, overage: { cap: null } }, billing)).toEqual([
      ["Critiqs AI credits this month9,000 of 2,000 · 7,000 extra, no cap", "ds-meter high"],
      "9,000 of 2,000 · 7,000 extra, no cap",
      "note",
    ]);
  }
});

test("an older backend's AI requests are always in the summary, like credits", async () => {
  const setup = await renderSetup({ usage: { plan: "Free", rows: [{ metric: "aiRequests", period: "day", used: 3, max: 50 }] } });
  expect(setup.rows()).toEqual([["Critiqs AI credits today3 of 50", "ds-meter"]]);
  await setup.done();
});

test("unlimited AI credits are in the summary, so it is never empty", async () => {
  const setup = await renderSetup({
    usage: {
      plan: "Pro",
      rows: [{ metric: "messages", period: "month", used: 12, max: 5_000 }],
      unlimited: [
        { metric: "aiCredits", period: "month", used: 1_234 },
        { metric: "mentionEmails", period: "day", used: 4 },
      ],
    },
  });
  expect(setup.rows()).toEqual([["Critiqs AI credits this month1,234 · Unlimited", null]]);
  await setup.done();
});

test("no plan without plans, or for people who don't manage the project", async () => {
  for (const backend of [{ usage: null }, { project: { ...project, isOwner: false }, usage: free }]) {
    const setup = await renderSetup(backend);
    expect(setup.plan()).toBeNull();
    expect(setup.host.textContent).toContain("Project is set up");
    await setup.done();
  }
});

test("a finished setup is one line; Details shows the project ID to copy", async () => {
  const setup = await renderSetup({ usage: null });
  expect(setup.host.querySelector("code")).toBeNull();
  const details = setup.button("Details")!;
  expect(details.getAttribute("aria-expanded")).toBe("false");
  expect(details.hasAttribute("aria-controls")).toBe(false);
  await setup.click(details);
  expect(details.getAttribute("aria-expanded")).toBe("true");
  expect(details.textContent).toBe("Hide details");
  const shown = setup.host.querySelector(`[id="${details.getAttribute("aria-controls")}"]`)!;
  expect(shown.querySelector("code")?.textContent).toBe("project");
  await setup.click(setup.button("Copy")!);
  expect(setup.copied).toEqual(["Project ID copied"]);
  await setup.done();
});

test("a project used only in this browser leads with adding its ID, by command or by the ID itself", async () => {
  const setup = await renderSetup({ usage: null }, { configured: false });
  expect([...setup.host.querySelectorAll("code")].map((code) => code.textContent)).toEqual(["npx critiqs init project", "project"]);
  expect(setup.button("Use a different project")).toBeDefined();
  expect([...setup.host.querySelectorAll(".step .num")].map((step) => step.textContent)).toEqual(["✓", "2"]);
  expect(setup.host.textContent).toContain("Until then, only this browser uses the project.");
  await setup.done();
});

test("an owner reaches the project's review links from setup when the deployment serves them; others don't see the way", async () => {
  const at = (id: string) => `https://critiqs.example/review-links/${id}`;
  const owner = await renderSetup({}, { reviewLinksAt: at });
  const link = [...owner.host.querySelectorAll<HTMLAnchorElement>("a")].find((entry) => entry.textContent === "Manage review links");
  expect(link?.href).toBe("https://critiqs.example/review-links/project");
  expect(link?.target).toBe("_blank");
  const member = await renderSetup({ project: { ...project, isOwner: false } }, { reviewLinksAt: at });
  expect(member.host.textContent).not.toContain("Manage review links");
  const off = await renderSetup({});
  expect(off.host.textContent).not.toContain("Manage review links");
});

test("project setup offers Your trackers once the project exists, saying which trackers are connected, where the backend has tickets", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const opened: string[] = [];
  const render = async (trackers: { offered: TicketsConfig; onOpen: () => void } | undefined, accounts: TrackerAccountView[]) => {
    const transport = fakeTransport({ project, threads: [], trackers: { accounts } });
    await act(async () =>
      root.render(
        <TransportContext.Provider value={transport}>
          <Setup
            backLabel="Back to comments"
            reviewer={{ id: "u_dana", name: "Dana", email: "dana@example.com", pictureUrl: null }}
            signedIn
            onSignIn={() => {}}
            configuredProjectId="project"
            browserProjectId={null}
            onUseProject={() => {}}
            onDone={() => {}}
            notify={() => {}}
            {...(trackers === undefined ? {} : { trackers })}
          />
        </TransportContext.Provider>,
      ),
    );
  };
  const offered: TicketsConfig = { trackers: [{ id: "linear", signIn: "oauth" }, { id: "github", signIn: "oauth" }, { id: "jira", signIn: "token" }], threadTickets: true };
  await render({ offered, onOpen: () => opened.push("your trackers") }, []);
  const section = () => host.querySelector('section[aria-label="Your trackers"]');
  expect(section()!.querySelector(".ds-nav-row")!.textContent).toBe("Your trackersNone connected");
  expect(section()!.textContent).toContain("Connect Linear, GitHub Issues, or Jira to turn comments into tickets, as you.");
  await act(async () => section()!.querySelector<HTMLButtonElement>(".ds-nav-row")!.click());
  expect(opened).toEqual(["your trackers"]);
  await render({ offered, onOpen: () => {} }, [{ tracker: "jira", method: "token", accountName: "Dana", site: "acme.atlassian.net", connectedAt: 1, attribution: true }, { tracker: "linear", method: "oauth", accountName: "Dana", site: "Acme", connectedAt: 1, attribution: true }]);
  expect(section()!.querySelector(".ds-nav-row .value")!.textContent).toBe("Linear, Jira");
  // Without tickets on the backend, no row.
  await render(undefined, []);
  expect(section()).toBeNull();
  await act(async () => root.unmount());
  host.remove();
});
