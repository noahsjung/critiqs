import { describe, expect, test } from "bun:test";
import type { AddressCheck, BillingStatus } from "@critiqs/core";
import { act, useReducer } from "react";
import type { NewProject } from "../src/backend.ts";
import { type FlowState, flowReducer, initialFlow } from "../src/flow.ts";
import { defaultOrganization, Onboarding, OnboardingScreen } from "../src/ui/Onboarding.tsx";
import { button, click, fakeAuth, fakeBackend, fakeClipboard, labelled, render, rerender, settle, text, type } from "./render.tsx";

// The onboarding page with a fake backend: what each screen shows, where
// focus goes, and what reaches the backend.

const ME = "sam@acme.com";
const SAM = { id: "r1", email: ME };
const PROJECT_ID = "k57abcdefghijklmnop";

function Flow({ from }: { from: FlowState }) {
  const [state, dispatch] = useReducer(flowReducer, from);
  return <OnboardingScreen state={state} dispatch={dispatch} />;
}

const atWho = (text = "acme-proto.vercel.app"): FlowState => [{ type: "address-text", text } as const, { type: "address-continue" } as const].reduce(flowReducer, initialFlow(SAM));
const title = (page: Element) => page.querySelector("h1")?.textContent;
const created = (backend: ReturnType<typeof fakeBackend>) => backend.calls.filter((call) => call.name === "createProject").map((call) => call.args[0] as NewProject);
const I_WILL = /^I will/;
const MY_DEVELOPER = /^My developer will/;
const NO_ONE = /^No one, for now/;

describe("the first screen: the link", () => {
  test("one field, Continue, and a quiet It's not online yet; the heading has focus", async () => {
    const page = await render(<Flow from={initialFlow(SAM)} />);
    expect(title(page)).toBe("What should your team review?");
    expect(document.activeElement).toBe(page.querySelector("h1"));
    expect(page.querySelectorAll("input").length).toBe(1);
    expect(button(page, "Continue")?.className).toContain("primary");
    expect(button(page, "It's not online yet")?.className).toBe("quiet");
    expect(button(page, "Skip")).toBeUndefined();
  });

  test("an unusable link says how to write it and stays", async () => {
    const page = await render(<Flow from={initialFlow(SAM)} />);
    await type(labelled(page, "Prototype link"), "my prototype");
    await click(button(page, "Continue"));
    expect(title(page)).toBe("What should your team review?");
    expect(text(page)).toContain("That doesn't look like a link. Try something like your-app.vercel.app.");
    expect(labelled(page, "Prototype link")?.getAttribute("aria-invalid")).toBe("true");
  });

  test("someone signed out: Continue opens sign-in and says so; the link waits for it", async () => {
    let signIns = 0;
    const auth = { ...fakeAuth(null), signIn: () => (signIns++, new Promise<void>(() => {})) };
    const page = await render(<Flow from={initialFlow(null)} />, { auth });
    expect(text(page)).toContain("Next, you'll sign in with your email.");
    await type(labelled(page, "Prototype link"), "acme-proto.vercel.app");
    await click(button(page, "Continue"));
    expect(signIns).toBe(1);
    expect(text(page)).toContain("Finish signing in in the other window.");
    expect(title(page)).toBe("What should your team review?");
    // An unusable link doesn't open sign-in.
    const typo = await render(<Flow from={initialFlow(null)} />, { auth });
    await type(labelled(typo, "Prototype link"), "my prototype");
    await click(button(typo, "Continue"));
    expect(signIns).toBe(1);
  });

  test("a sign-in that fails says why, and the same button tries again", async () => {
    let signIns = 0;
    const auth = { ...fakeAuth(null), signIn: async () => (signIns++, Promise.reject(new Error("The sign-in window was closed."))) };
    const page = await render(<Flow from={initialFlow(null)} />, { auth });
    await click(button(page, "It's not online yet"));
    await settle();
    expect(page.querySelector("[role='alert']")?.textContent).toBe("The sign-in window was closed.");
    await click(button(page, "It's not online yet"));
    expect(signIns).toBe(2);
  });

  test("someone signed in moves on without signing in again", async () => {
    let signIns = 0;
    const page = await render(<Flow from={initialFlow(SAM)} />, { auth: { ...fakeAuth(), signIn: async () => void signIns++ } });
    expect(text(page)).not.toContain("you'll sign in");
    await type(labelled(page, "Prototype link"), "acme-proto.vercel.app");
    await click(button(page, "Continue"));
    expect(signIns).toBe(0);
    expect(title(page)).toBe("Who will add Critiqs to it?");
  });

  test("the preview shows the typed link", async () => {
    const page = await render(<Flow from={initialFlow(SAM)} />);
    expect(page.querySelector(".url-text")?.textContent).toBe("your-prototype.app");
    await type(labelled(page, "Prototype link"), "https://acme-proto.vercel.app/");
    expect(page.querySelector(".url-text")?.textContent).toBe("acme-proto.vercel.app");
    expect(page.querySelector(".preview")?.getAttribute("aria-label")).toBe("How acme-proto.vercel.app will look with Critiqs");
  });
});

describe("the second screen: who adds Critiqs", () => {
  test("the recommended way first, marked, with why; the extension once there's a link", async () => {
    const page = await render(<Flow from={atWho()} />);
    await settle();
    const choices = [...page.querySelectorAll(".choice")];
    expect(choices.map((choice) => choice.querySelector(".choice-label")?.textContent)).toEqual(["I willRecommended", "My developer will", "No one, for now"]);
    expect(choices[0]?.className).toContain("recommended");
    expect(page.querySelectorAll(".badge").length).toBe(1);
    const why = page.querySelector(".choices")?.getAttribute("aria-describedby");
    expect(page.querySelector(`[id="${why}"]`)?.textContent).toBe("Adding Critiqs to the code is the main way: everyone who opens the prototype can comment, with nothing to install.");
    const offline = await render(<Flow from={flowReducer(initialFlow(SAM), { type: "address-none" })} />);
    expect(button(offline, NO_ONE)).toBeUndefined();
    expect(button(offline, I_WILL)).toBeDefined();
  });

  test("No one, for now creates the project without a code answer and shows how to get the extension, honestly", async () => {
    const backend = fakeBackend({ addressEdits: true });
    const page = await render(<Flow from={atWho()} />, { backend });
    await click(button(page, NO_ONE));
    await settle();
    expect(created(backend)[0]).toMatchObject({ name: "acme-proto", reviewUrl: "https://acme-proto.vercel.app/", answers: {} });
    expect(title(page)).toBe("Review it with the Critiqs extension");
    expect(text(page)).toContain("It isn't in the Chrome Web Store yet.");
    expect(page.querySelector("a")?.getAttribute("href")).toBe("https://github.com/noahsjung/critiqs/tree/main/packages/extension#build-and-load-it-unpacked");
    // The origin goes on the project's address list, so the extension finds the project there.
    expect(backend.calls.filter((call) => call.name === "addProjectAddress").map((call) => call.args)).toEqual([[PROJECT_ID, "https://acme-proto.vercel.app"]]);
    expect(text(page)).toContain("It finds acme-proto by its address, and you can comment.");
    // The other ways, best first.
    expect([...page.querySelectorAll(".other-ways button")].map((each) => each.textContent)).toEqual(["I'll add it myself", "Someone else will add it"]);
    await click(button(page, "Someone else will add it"));
    expect(title(page)).toBe("Send the steps to your developer");
    expect([...page.querySelectorAll(".other-ways button")].map((each) => each.textContent)).toEqual(["Review it with the extension instead", "I'll add it myself"]);
  });

  test("I will: the setup screen waits for Critiqs to load, then says Connected, live", async () => {
    const setup = { projectId: PROJECT_ID, projectName: "acme-proto", address: "https://acme-proto.vercel.app/", stack: null, installCommands: null };
    const backend = fakeBackend({ projectSetupState: { status: "ready", data: { ...setup, connected: null } } });
    const page = await render(<Flow from={atWho()} />, { backend });
    await click(button(page, I_WILL));
    await settle();
    expect(page.querySelector(".connection")?.textContent).toBe("Waiting for Critiqs to load on acme-proto.vercel.app…");
    const live = fakeBackend({ projectSetupState: { status: "ready", data: { ...setup, connected: { at: Date.UTC(2026, 10, 25), origin: "https://acme-proto.vercel.app" } } } });
    // The same screen, with the project's setup as it arrives.
    await rerender(<Flow from={atWho()} />, { backend: live });
    expect(title(page)).toBe("Add Critiqs to your prototype");
    expect(page.querySelector(".connection.connected")?.textContent).toStartWith("Connected. Critiqs loaded on acme-proto.vercel.app.");
  });

  test("My developer will: once an email went out, the owner sees Waiting for install, then Connected", async () => {
    const setup = { projectId: PROJECT_ID, projectName: "acme-proto", address: "https://acme-proto.vercel.app/", stack: null, installCommands: null, connected: null };
    const at = Date.UTC(2026, 10, 25, 15, 4);
    const backend = fakeBackend({ projectSetupState: { status: "ready", data: setup }, sends: [{ sendId: "s1", email: "dev@acme.com", status: "uncertain", lastSentAt: at }] });
    const page = await render(<Flow from={atWho()} />, { backend });
    await click(button(page, MY_DEVELOPER));
    await settle();
    expect(page.querySelector(".connection")?.textContent).toStartWith("Waiting for install. Sent to dev@acme.com, Nov 25, 2026");
    // Only a failed email: nothing is waiting.
    await rerender(<Flow from={atWho()} />, { backend: fakeBackend({ projectSetupState: { status: "ready", data: setup }, sends: [{ sendId: "s1", email: "dev@acme.com", status: "failed", lastSentAt: at }] }) });
    expect(page.querySelector(".connection")).toBeNull();
  });

  test("the extension's way without address edits, or when adding fails, says to add the site to the project in the extension", async () => {
    for (const backend of [fakeBackend(), fakeBackend({ addressEdits: true, addProjectAddress: async () => Promise.reject(new Error("forbidden")) })]) {
      const page = await render(<Flow from={atWho()} />, { backend });
      await click(button(page, NO_ONE));
      await settle();
      expect(text(page)).toContain("Choose Add to a project, then acme-proto, and you can comment.");
    }
  });

  test("on the team's own backend, the extension's way gives the build command for it", async () => {
    const backend = fakeBackend({ componentBackend: "https://happy-otter-123.convex.cloud" });
    const page = await render(<Flow from={atWho()} />, { backend });
    await click(button(page, NO_ONE));
    await settle();
    expect(text(page)).toContain("CRITIQS_BACKEND=https://happy-otter-123.convex.cloud bun run build");
  });

  test("two choices, and Back; the link is checked quietly, with https:// added, once", async () => {
    const backend = fakeBackend();
    const page = await render(<Flow from={atWho()} />, { backend });
    await settle();
    expect(title(page)).toBe("Who will add Critiqs to it?");
    expect(button(page, I_WILL)).toBeDefined();
    expect(button(page, MY_DEVELOPER)).toBeDefined();
    expect(backend.calls).toEqual([{ name: "checkAddress", args: ["https://acme-proto.vercel.app/"] }]);
    await click(button(page, "Back"));
    expect(title(page)).toBe("What should your team review?");
    expect(labelled(page, "Prototype link")?.value).toBe("acme-proto.vercel.app");
  });

  test("I will creates the project from the link, saying who adds it, with the stack the check found", async () => {
    const backend = fakeBackend({ checkAddress: async () => ({ kind: "public", stack: "next" }) as AddressCheck });
    const page = await render(<Flow from={atWho()} />, { backend });
    await click(button(page, I_WILL));
    await settle();
    expect(created(backend)).toEqual([{ name: "acme-proto", reviewUrl: "https://acme-proto.vercel.app/", organizationId: null, answers: { codeAccess: "self" }, stack: "next" }]);
    expect(title(page)).toBe("Add Critiqs to your prototype");
    expect(text(page)).toContain(`npx critiqs init ${PROJECT_ID}`);
  });

  test("My developer will saves that someone else adds it, and shows the email", async () => {
    const backend = fakeBackend();
    const page = await render(<Flow from={atWho()} />, { backend });
    await click(button(page, MY_DEVELOPER));
    await settle();
    expect(created(backend)[0]?.answers).toEqual({ codeAccess: "teammate" });
    expect(title(page)).toBe("Send the steps to your developer");
  });

  test("a check that fails, or a link on this computer, creates the project with no stack; a local link is never sent", async () => {
    const failing = fakeBackend({ checkAddress: async () => Promise.reject(new Error("Too many checks")) });
    const page = await render(<Flow from={atWho()} />, { backend: failing });
    await click(button(page, I_WILL));
    await settle();
    expect(created(failing)[0]?.stack).toBeNull();
    const local = fakeBackend();
    const here = await render(<Flow from={atWho("localhost:5173")} />, { backend: local });
    await click(button(here, I_WILL));
    await settle();
    expect(local.calls.map((call) => call.name)).toEqual(["createProject"]);
    expect(created(local)[0]).toMatchObject({ name: "localhost", reviewUrl: "http://localhost:5173/", stack: null });
  });

  test("the choice waits for a slow check, then creates with what it found", async () => {
    let answer: (check: AddressCheck) => void = () => {};
    const backend = fakeBackend({ checkAddress: () => new Promise<AddressCheck>((resolve) => (answer = resolve)) });
    const page = await render(<Flow from={atWho()} />, { backend });
    await click(button(page, I_WILL));
    expect(created(backend)).toEqual([]);
    expect(text(page)).toContain("Setting up your project…");
    expect(button(page, MY_DEVELOPER)?.disabled).toBe(true);
    await act(async () => answer({ kind: "public", stack: "react" }));
    await settle();
    expect(created(backend)[0]?.stack).toBe("react");
  });

  test("while the project is being created, a second choice or Back creates nothing more", async () => {
    let finish: (id: string) => void = () => {};
    const backend = fakeBackend({ createProject: () => new Promise<string>((resolve) => (finish = resolve)) });
    const page = await render(<Flow from={atWho()} />, { backend });
    await click(button(page, I_WILL));
    await settle();
    expect(button(page, I_WILL)?.getAttribute("aria-busy")).toBe("true");
    await click(button(page, MY_DEVELOPER));
    await click(button(page, "Back"));
    expect(created(backend)).toHaveLength(1);
    expect(title(page)).toBe("Who will add Critiqs to it?");
    await act(async () => finish(PROJECT_ID));
    await settle();
    expect(title(page)).toBe("Add Critiqs to your prototype");
  });

  test("It's not online yet: a project named My prototype, with no address and nothing checked", async () => {
    const backend = fakeBackend();
    const from = flowReducer(initialFlow(SAM), { type: "address-none" });
    const page = await render(<Flow from={from} />, { backend });
    await click(button(page, I_WILL));
    await settle();
    expect(backend.calls.map((call) => call.name)).toEqual(["createProject"]);
    expect(created(backend)[0]).toMatchObject({ name: "My prototype", reviewUrl: null, stack: null });
    expect(text(page)).toContain("Then open your prototype.");
  });

  test("a link Critiqs can't save as the review link says so before choosing, and isn't sent", async () => {
    const backend = fakeBackend();
    const page = await render(<Flow from={atWho("http://192.168.1.4:3000")} />, { backend });
    expect(text(page)).toContain("Critiqs can't save 192.168.1.4:3000 as the review link, because it isn't HTTPS. You can add a link later.");
    await click(button(page, I_WILL));
    await settle();
    expect(created(backend)[0]?.reviewUrl).toBeNull();
    const saved = await render(<Flow from={atWho()} />);
    expect(text(saved)).not.toContain("review link");
  });

  test("with several organizations, where the project goes is shown, starting on the home one", async () => {
    const organizations = [
      { id: "o1", name: "Client work", role: "member" as const, plan: "Plus", home: false },
      { id: "o2", name: "Sam's organization", role: "admin" as const, plan: "Free", home: true },
    ];
    expect(defaultOrganization(organizations)?.id).toBe("o2");
    expect(defaultOrganization([{ ...organizations[0]!, home: false }])?.id).toBe("o1");
    const backend = fakeBackend({ organizations });
    const page = await render(<Flow from={atWho()} />, { backend });
    expect(text(page)).toContain("Project goes in");
    expect(page.querySelector(".ds-select")?.textContent).toBe("Sam's organization");
    await click(page.querySelector(".ds-select"));
    await click([...document.querySelectorAll("[role='menuitemradio']")].find((item) => item.textContent?.includes("Client work")));
    await click(button(page, I_WILL));
    await settle();
    expect(created(backend)[0]?.organizationId).toBe("o1");
    // With one, nothing is shown, and the project goes there.
    const one = fakeBackend({ organizations: [organizations[1]!] });
    const single = await render(<Flow from={atWho()} />, { backend: one });
    expect(text(single)).not.toContain("Project goes in");
    await click(button(single, I_WILL));
    await settle();
    expect(created(one)[0]?.organizationId).toBe("o2");
  });

  test("an organization that leaves the list clears the choice: the choices wait until the person picks again", async () => {
    const acme = { id: "o1", name: "Acme", role: "admin" as const, plan: "Free", home: true };
    const client = { id: "o2", name: "Client work", role: "member" as const, plan: "Plus", home: false };
    const page = await render(<Flow from={atWho()} />, { backend: fakeBackend({ organizations: [acme, client] }) });
    const after = fakeBackend({ organizations: [client] });
    await rerender(<Flow from={atWho()} />, { backend: after });
    expect(page.querySelector(".ds-select")?.textContent).toBe("Choose");
    expect(text(page)).toContain("Acme is no longer one of yours. Choose where the project goes.");
    expect(button(page, I_WILL)?.disabled).toBe(true);
    await click(page.querySelector(".ds-select"));
    await click([...document.querySelectorAll("[role='menuitemradio']")].find((item) => item.textContent?.includes("Client work")));
    await click(button(page, I_WILL));
    await settle();
    expect(created(after).map((project) => project.organizationId)).toEqual(["o2"]);
  });

  test("organizations that can't be loaded say so, and the choices wait for them", async () => {
    const backend = fakeBackend({ organizationsState: { status: "error", code: "error", message: "Try again." } });
    const page = await render(<Flow from={atWho()} />, { backend });
    expect(text(page)).toContain("Your organizations couldn't be loaded, so the project can't be set up yet. Try again.");
    expect(button(page, I_WILL)?.disabled).toBe(true);
    expect(button(page, MY_DEVELOPER)?.disabled).toBe(true);
  });

  const LIMIT = "Your organization has reached the Free plan's limit of 1 project. An admin of the organization can upgrade the plan.";
  const limited = () => async (): Promise<string> => {
    throw Object.assign(new Error("x"), { data: { code: "limit", message: LIMIT } });
  };
  const old = { _id: "k57oldprojectidabcdef", name: "Old prototype", tags: [], createdAt: 0, reviewUrl: null, isOwner: true };

  test("a plan's project limit says so, stays, and offers a project the person already has, with its own name and stack", async () => {
    const backend = fakeBackend({
      createProject: limited(),
      organizations: [{ id: "o1", name: "Acme", role: "member", plan: "Free", home: true }],
      mine: [old],
      projectSetup: async (projectId) => ({ projectId, projectName: "Old prototype", address: "https://old.example/", stack: { id: "nuxt", label: "Nuxt", installable: false }, installCommands: null }),
    });
    const page = await render(<Flow from={atWho()} />, { backend });
    await click(button(page, MY_DEVELOPER));
    await settle();
    expect(page.querySelector("[role='alert']")?.textContent).toBe(LIMIT);
    expect(title(page)).toBe("Who will add Critiqs to it?");
    expect(text(page)).toContain("Or use a project you already have");
    // A member can't upgrade the organization's plan.
    expect(page.querySelector("a.btn")).toBeNull();
    await click(button(page, /^Old prototype/));
    await settle();
    expect(backend.calls.map((call) => call.name)).toEqual(["checkAddress", "createProject", "projectSetup"]);
    expect(title(page)).toBe("Send the steps to your developer");
  });

  test("at the limit, each project the person has shows its organization and address, or when it was created", async () => {
    const at = Date.UTC(2026, 10, 20, 12);
    const backend = fakeBackend({
      createProject: limited(),
      mine: [
        { ...old, _id: "k57firstprojectabcdef", name: "Prototype", createdAt: at, reviewUrl: "https://one.example/", organization: { id: "o1", name: "Acme", role: "member" } },
        { ...old, _id: "k57secondprojectabcde", name: "Prototype", createdAt: at, reviewUrl: null, organization: { id: "o2", name: "Client work", role: "admin" } },
      ],
    });
    const page = await render(<Flow from={atWho()} />, { backend });
    await click(button(page, I_WILL));
    await settle();
    expect([...page.querySelectorAll(".project-list button")].map((choice) => [...choice.children].map((part) => text(part)))).toEqual([
      ["Prototype", "Acme, one.example"],
      ["Prototype", "Client work, Created Nov 20, 2026"],
    ]);
  });

  test("at the limit, an admin gets the deployment's upgrade page, when it names one", async () => {
    const admin = [{ id: "o1", name: "Acme", role: "admin" as const, plan: "Free", home: true }];
    const page = await render(<Flow from={atWho()} />, { backend: fakeBackend({ createProject: limited(), organizations: admin, upgradeUrl: "https://critiqs.example/pricing" }) });
    await click(button(page, I_WILL));
    await settle();
    const upgrade = page.querySelector("a.btn");
    expect([upgrade?.textContent, upgrade?.getAttribute("href"), upgrade?.getAttribute("target")]).toEqual(["Upgrade the plan", "https://critiqs.example/pricing", "_blank"]);
  });
});

describe("the third screen", () => {
  const atSetup = async (who: RegExp, backend = fakeBackend()) => {
    const page = await render(<Flow from={atWho()} />, { backend });
    await click(button(page, who));
    await settle();
    return page;
  };

  test("no Back once the project exists; a quiet link switches between the command and the email", async () => {
    const page = await atSetup(I_WILL);
    expect(button(page, "Back")).toBeUndefined();
    await click(button(page, "Someone else will add it"));
    expect(title(page)).toBe("Send the steps to your developer");
    await click(button(page, "I'll add it myself"));
    expect(title(page)).toBe("Add Critiqs to your prototype");
  });

  test("the team's cursors arrive on the preview", async () => {
    const page = await atSetup(I_WILL);
    expect(page.querySelector(".preview")?.classList.contains("live")).toBe(true);
    const before = await render(<Flow from={atWho()} />);
    expect(before.querySelector(".preview")?.classList.contains("live")).toBe(false);
  });

  test("team size, then role, show only after the command is copied; each tap saves just that answer", async () => {
    fakeClipboard();
    const backend = fakeBackend();
    const page = await atSetup(I_WILL, backend);
    expect(text(page)).not.toContain("How big is your team?");
    await click(button(page, "Copy command"));
    expect(text(page)).toContain("While you're here");
    expect(text(page)).toContain("How big is your team?");
    await click(button(page, "2–5"));
    expect(text(page)).toContain("What do you do?");
    await click(button(page, "Design"));
    expect(text(page)).toContain("Thanks, that helps.");
    expect(backend.calls.filter((call) => call.name === "saveAboutYou").map((call) => call.args[0])).toEqual([{ teamSize: "2-5" }, { role: "designer" }]);
  });

  test("Skip saves nothing and moves to the next question", async () => {
    fakeClipboard();
    const backend = fakeBackend();
    const page = await atSetup(MY_DEVELOPER, backend);
    await click(button(page, "Copy a message to send yourself"));
    await click(button(page, "Skip"));
    expect(text(page)).toContain("What do you do?");
    await click(button(page, "Skip"));
    expect(text(page)).toContain("Thanks, that helps.");
    expect(backend.calls.filter((call) => call.name === "saveAboutYou")).toEqual([]);
  });
});

describe("the suggested plan", () => {
  const atSetup = async (who: RegExp, backend = fakeBackend()) => {
    const page = await render(<Flow from={atWho()} />, { backend });
    await click(button(page, who));
    await settle();
    return page;
  };
  const limits = (reviewers: number | null, projects: number | null) => [
    { metric: "aiCredits" as const, period: "month" as const, max: 200 },
    { metric: "projects" as const, period: "total" as const, max: projects },
    { metric: "reviewers" as const, period: "month" as const, max: reviewers },
  ];
  const billing = (plan: "free" | "plus" | "pro", canManage = true): BillingStatus => ({
    plan,
    subscription: null,
    storageAddOns: 0,
    canManage,
    prices: { plans: { free: { monthly: 0, extraCredits: null }, plus: { monthly: 19, extraCredits: null }, pro: { monthly: 49, extraCredits: null } }, storageAddOn: { gb: 100, monthly: 10 } },
    plans: { free: { label: "Free", limits: limits(5, 1) }, plus: { label: "Plus", limits: limits(25, 10) }, pro: { label: "Pro", limits: limits(null, null) } },
  });
  const project = (role: "admin" | "member") => ({ _id: PROJECT_ID, name: "acme-proto", tags: [], createdAt: 1, reviewUrl: null, isOwner: true, organization: { id: "o1", name: "Acme", role } });
  const answer = async (backend: ReturnType<typeof fakeBackend>, size: string) => {
    fakeClipboard();
    const page = await atSetup(I_WILL, backend);
    await click(button(page, "Copy command"));
    await click(button(page, size));
    return page;
  };

  test("a team size answered: the smallest plan whose reviewers fit, what it includes and costs, and See plans for an admin", async () => {
    const backend = fakeBackend({ project: project("admin"), billing: { status: "ready", data: billing("free") }, upgradeUrl: "https://critiqs.app/pricing" });
    const page = await answer(backend, "6–20");
    const card = page.querySelector(".plan");
    expect(card?.textContent).toBe("Suggested planPlus fits a team this sizeUp to 25 reviewers a month, and 10 projects. US$19 a month.See plans");
    expect(card?.querySelector("a")?.getAttribute("href")).toBe("https://critiqs.app/pricing");
    // Questions go on; the suggestion stays.
    expect(text(page)).toContain("What do you do?");
  });

  test("a plan that already fits says so; a member is told an admin changes it; larger teams get Pro", async () => {
    const fits = await answer(fakeBackend({ project: project("admin"), billing: { status: "ready", data: billing("plus") } }), "2–5");
    expect(fits.querySelector(".plan")?.textContent).toBe("Suggested planAcme's Plus plan fits a team this size.");
    const member = await answer(fakeBackend({ project: project("member"), billing: { status: "ready", data: billing("free", false) } }), "100+");
    expect(member.querySelector(".plan")?.textContent).toBe("Suggested planPro fits a team this sizeAny number of reviewers, and any number of projects. US$49 a month.An admin of Acme can change its plan.");
    const justMe = await answer(fakeBackend({ project: project("admin"), billing: { status: "ready", data: billing("free") } }), "Just me");
    expect(justMe.querySelector(".plan")?.textContent).toBe("Suggested planAcme's Free plan fits a team this size.");
  });

  test("where the deployment takes no payment, or the team size was skipped, nothing is suggested", async () => {
    const off = await answer(fakeBackend({ project: project("admin") }), "6–20");
    expect(off.querySelector(".plan")).toBeNull();
    fakeClipboard();
    const skipped = await atSetup(I_WILL, fakeBackend({ project: project("admin"), billing: { status: "ready", data: billing("free") } }));
    await click(button(skipped, "Copy command"));
    await click(button(skipped, "Skip"));
    expect(skipped.querySelector(".plan")).toBeNull();
  });
});

describe("the page", () => {
  test("another reviewer signing in gets a fresh flow, and signing out removes the draft", async () => {
    sessionStorage.clear();
    const page = await render(<Onboarding />, { auth: fakeAuth(ME, "r1") });
    await type(labelled(page, "Prototype link"), "acme-proto.vercel.app");
    await click(button(page, "Continue"));
    expect(title(page)).toBe("Who will add Critiqs to it?");
    expect(sessionStorage.getItem("critiqs:onboarding:v3")).toContain("acme-proto");
    await rerender(<Onboarding />, { auth: fakeAuth("lee@acme.com", "r2") });
    expect(title(page)).toBe("What should your team review?");
    expect(labelled(page, "Prototype link")?.value).toBe("");
    await rerender(<Onboarding />, { auth: fakeAuth(null) });
    expect(sessionStorage.getItem("critiqs:onboarding:v3")).toBeNull();
  });

  test("someone signed out who continues moves on once sign-in finishes, keeping the link", async () => {
    sessionStorage.clear();
    const page = await render(<Onboarding />, { auth: { ...fakeAuth(null), signIn: () => new Promise<void>(() => {}) } });
    await type(labelled(page, "Prototype link"), "acme-proto.vercel.app");
    await click(button(page, "Continue"));
    await rerender(<Onboarding />, { auth: fakeAuth(ME, "r1") });
    expect(title(page)).toBe("Who will add Critiqs to it?");
    expect(page.querySelector(".url-text")?.textContent).toBe("acme-proto.vercel.app");
  });

  test("a create that finishes after another reviewer signed in doesn't land in their flow", async () => {
    sessionStorage.clear();
    let finish: (id: string) => void = () => {};
    const backend = fakeBackend({ createProject: () => new Promise<string>((resolve) => (finish = resolve)) });
    const page = await render(<Onboarding />, { backend, auth: fakeAuth(ME, "r1") });
    await click(button(page, "It's not online yet"));
    await click(button(page, I_WILL));
    await rerender(<Onboarding />, { backend, auth: fakeAuth("lee@acme.com", "r2") });
    await act(async () => finish(PROJECT_ID));
    await settle();
    expect(title(page)).toBe("What should your team review?");
  });

  test("a reload comes back to the same screen", async () => {
    sessionStorage.clear();
    const first = await render(<Onboarding />);
    await type(labelled(first, "Prototype link"), "acme-proto.vercel.app");
    await click(button(first, "Continue"));
    const again = await render(<Onboarding />);
    expect(title(again)).toBe("Who will add Critiqs to it?");
  });
});
