import { describe, expect, test } from "bun:test";
import type { AddressCheck } from "@critiqs/core";
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
