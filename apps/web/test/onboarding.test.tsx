import { describe, expect, test } from "bun:test";
import type { AddressCheck } from "@critiqs/core";
import { act, useReducer } from "react";
import { type FlowState, flowReducer, initialFlow } from "../src/flow.ts";
import { defaultOrganization, Onboarding, OnboardingStep } from "../src/ui/Onboarding.tsx";
import type { NewProject } from "../src/backend.ts";
import { button, click, fakeAuth, fakeBackend, labelled, render, rerender, settle, text, type } from "./render.tsx";

// The onboarding page with a fake backend: what each step shows, where focus
// goes, and what reaches the backend.

const ME = "sam@acme.com";
const SAM = { id: "r1", email: ME };

function Flow({ from }: { from: FlowState }) {
  const [state, dispatch] = useReducer(flowReducer, from);
  return <OnboardingStep state={state} dispatch={dispatch} />;
}

const at = (step: FlowState["step"], overrides: Partial<FlowState> = {}): FlowState => ({ ...initialFlow(SAM), step, ...overrides });
const title = (page: Element) => page.querySelector("h1")?.textContent;
const focused = () => document.activeElement;

describe("each step", () => {
  test("focus moves to the new step's title, and Back returns with the answer kept", async () => {
    const page = await render(<Flow from={at("role")} />);
    await click(labelled(page, "Founder"));
    await click(button(page, "Continue"));
    expect(title(page)).toBe("How big is your team?");
    expect(focused()).toBe(page.querySelector("h1"));
    await click(button(page, "Back"));
    expect(title(page)).toBe("What's your role?");
    expect(labelled(page, "Founder")?.checked).toBe(true);
  });

  test("Skip is a quiet button beside Continue on each question, and nothing calls a question optional", async () => {
    const page = await render(<Flow from={at("team-size")} />);
    expect(button(page, "Skip")?.className).toBe("btn ghost");
    expect(button(page, "Continue")?.disabled).toBe(true);
    expect(text(page).toLowerCase()).not.toContain("optional");
    await click(button(page, "Skip"));
    expect(title(page)).toBe("Can you change the prototype's code?");
  });

  test("Escape keeps every answer", async () => {
    const page = await render(<Flow from={at("code-access", { answers: { codeAccess: "nobody" } })} />);
    await type(labelled(page, "Developer 1 email"), "dev@acme.com");
    await act(async () => void labelled(page, "Developer 1 email")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(title(page)).toBe("Can you change the prototype's code?");
    expect(labelled(page, "Developer 1 email")?.value).toBe("dev@acme.com");
    expect(labelled(page, "No")?.checked).toBe(true);
  });

  test("engineers see Yes already chosen and no email fields", async () => {
    const page = await render(<Flow from={at("code-access", { answers: { role: "engineer" } })} />);
    expect(labelled(page, "Yes")?.checked).toBe(true);
    expect(labelled(page, "Developer 1 email")).toBeUndefined();
    await click(labelled(page, "Someone on my team can"));
    expect(labelled(page, "Developer 1 email")).toBeDefined();
    expect(text(page)).toContain("Next, you can email them how to add Critiqs, or copy a message to send yourself.");
  });

  test("who leaves feedback takes any of its answers", async () => {
    const page = await render(<Flow from={at("feedback-from")} />);
    await click(labelled(page, "Test users"));
    await click(labelled(page, "My team"));
    expect([labelled(page, "My team")?.checked, labelled(page, "Clients or stakeholders")?.checked, labelled(page, "Test users")?.checked]).toEqual([true, false, true]);
    expect(button(page, "Continue")?.disabled).toBe(false);
  });
});

describe("the address step", () => {
  const check = async (answer: AddressCheck, typed = "acme-proto.vercel.app") => {
    const backend = fakeBackend({ checkAddress: async () => answer });
    const page = await render(<Flow from={at("address")} />, { backend });
    await type(labelled(page, "Prototype address"), typed);
    await click(button(page, "Check address"));
    await settle();
    return { page, backend };
  };

  test("checks the address with https:// added, and offers the stack it found", async () => {
    const { page, backend } = await check({ kind: "public", stack: "nuxt" });
    expect(backend.calls).toEqual([{ name: "checkAddress", args: ["https://acme-proto.vercel.app/"] }]);
    expect(text(page)).toContain("acme-proto.vercel.app is public");
    expect(text(page)).toContain("Looks like Nuxt.");
    await click(button(page, "Change"));
    expect(text(page)).toContain("What's your prototype built with?");
    expect(page.querySelector(".ds-select")?.textContent).toBe("Nuxt");
    expect(text(page)).toContain("Critiqs installs in React apps built with Vite or Next.js today. Nuxt support is coming.");
  });

  test("Use confirms the stack and moves on", async () => {
    const { page } = await check({ kind: "sign-in", via: "redirect", host: "accounts.google.com", stack: "next" });
    expect(text(page)).toContain("acme-proto.vercel.app needs a sign-in");
    await click(button(page, "Use Next.js"));
    expect(title(page)).toBe("What's your role?");
  });

  test("each result line", async () => {
    expect(text((await check({ kind: "blocked" })).page)).toContain("Bot protection stopped the checkacme-proto.vercel.app returned a bot challenge.");
    expect(text((await check({ kind: "unreachable" })).page)).toContain("Couldn't reach acme-proto.vercel.appIt may be offline, or behind a VPN or firewall. You can still continue.");
    expect(text((await check({ kind: "sign-in", via: "password", host: null, stack: null })).page)).toContain("acme-proto.vercel.app asks for a password");
  });

  test("an address on this computer isn't sent to the server", async () => {
    const { page, backend } = await check({ kind: "public", stack: null }, "localhost:5173");
    expect(backend.calls).toEqual([]);
    expect(text(page)).toContain("localhost:5173 runs on your computerOnly this computer can open it.");
    expect(text(page)).toContain("What's your prototype built with?");
    expect(text((await check({ kind: "public", stack: null }, "127.0.0.1:3000")).page)).toContain("127.0.0.1:3000 runs on your computer");
  });

  test("an address on a private network says Critiqs can't reach it, not that it runs on this computer", async () => {
    for (const typed of ["devbox.tail1234.ts.net", "192.168.1.4:3000", "proto.local", "app.internal", "nas.home.arpa"]) {
      const { page, backend } = await check({ kind: "public", stack: null }, typed);
      expect([typed, backend.calls]).toEqual([typed, []]);
      const host = new URL(`http://${typed}`).host;
      expect([typed, text(page)]).toEqual([typed, expect.stringContaining(`${host} is on a private networkCritiqs can't reach private networks. You can still continue.`)]);
      expect(text(page)).not.toContain("runs on your computer");
    }
  });

  test("the server's refusal is shown, keeping the address", async () => {
    const backend = fakeBackend({
      checkAddress: async () => {
        throw Object.assign(new Error("x"), { data: { code: "limit", message: "You've checked 20 addresses this hour. Try again later, or skip this step." } });
      },
    });
    const page = await render(<Flow from={at("address")} />, { backend });
    await type(labelled(page, "Prototype address"), "acme.com");
    await click(button(page, "Check address"));
    await settle();
    expect(text(page)).toContain("You've checked 20 addresses this hour. Try again later, or skip this step.");
    expect(labelled(page, "Prototype address")?.value).toBe("acme.com");
  });

  test("It's only on my computer and I don't have one yet answer without checking", async () => {
    const backend = fakeBackend();
    const page = await render(<Flow from={at("address")} />, { backend });
    await click(button(page, "I don't have one yet"));
    expect(text(page)).toContain("No address yetYou can add one later in the project's settings.");
    await click(button(page, "It's only on my computer"));
    expect(text(page)).toContain("It runs on your computer");
    expect(backend.calls).toEqual([]);
  });
});

describe("creating the project", () => {
  test("sends the name, review address, answers, and stack; skipped answers are absent", async () => {
    const backend = fakeBackend({ organizations: [{ id: "o1", name: "Acme", role: "admin", plan: "Free", home: true }] });
    const from = at("create", {
      address: { status: "checked", text: "acme.com", url: "https://acme.com/", check: { kind: "public", stack: "next" } },
      stack: { detected: "next", chosen: "next", picking: false },
      answers: { role: "designer", codeAccess: "teammate", purpose: "qa" },
    });
    const page = await render(<Flow from={from} />, { backend });
    expect(button(page, "Skip")).toBeUndefined();
    expect(labelled(page, "Project name")?.value).toBe("acme");
    // One organization: no choice, and the project goes in it.
    expect(text(page)).not.toContain("Organization");
    await click(button(page, "Create project"));
    await settle();
    expect(backend.calls).toEqual([
      { name: "createProject", args: [{ name: "acme", reviewUrl: "https://acme.com/", organizationId: "o1", answers: { codeAccess: "teammate", purpose: "qa" }, stack: "next" }] },
    ]);
    expect(title(page)).toBe("Recommended for acme");
  });

  test("everything skipped still creates a project named My prototype", async () => {
    const backend = fakeBackend();
    const page = await render(<Flow from={at("create")} />, { backend });
    await click(button(page, "Create project"));
    await settle();
    expect(backend.calls).toEqual([{ name: "createProject", args: [{ name: "My prototype", reviewUrl: null, organizationId: null, answers: {}, stack: null }] }]);
    expect(title(page)).toBe("Recommended for My prototype");
  });

  test("with several organizations, a choice that starts on the home one", async () => {
    const organizations = [
      { id: "o1", name: "Client work", role: "member" as const, plan: "Plus", home: false },
      { id: "o2", name: "Sam's organization", role: "admin" as const, plan: "Free", home: true },
    ];
    expect(defaultOrganization(organizations)?.id).toBe("o2");
    expect(defaultOrganization([{ ...organizations[0]!, home: false }])?.id).toBe("o1");
    const page = await render(<Flow from={at("create")} />, { backend: fakeBackend({ organizations }) });
    expect(text(page)).toContain("Organization");
    expect(page.querySelector(".ds-select")?.textContent).toBe("Sam's organization");
  });

  test("an organization that leaves the list while the form is open clears the choice: Create waits until the person chooses again", async () => {
    const acme = { id: "o1", name: "Acme", role: "admin" as const, plan: "Free", home: true };
    const client = { id: "o2", name: "Client work", role: "member" as const, plan: "Plus", home: false };
    const backend = fakeBackend({ organizations: [acme, client] });
    const page = await render(<Flow from={at("create")} />, { backend });
    expect(page.querySelector(".ds-select")?.textContent).toBe("Acme");
    // Acme is gone; one organization is left, and the chooser stays so the person confirms it.
    const after = fakeBackend({ organizations: [client] });
    await rerender(<Flow from={at("create")} />, { backend: after });
    expect(page.querySelector(".ds-select")?.textContent).toBe("Choose");
    expect(text(page)).toContain("Acme is no longer one of your organizations. Choose where to create the project.");
    await act(async () => void page.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await click(button(page, "Create project"));
    expect(after.calls).toEqual([]);
    await click(page.querySelector(".ds-select"));
    await click([...document.querySelectorAll("[role='menuitemradio']")].find((item) => item.textContent?.includes("Client work")));
    await click(button(page, "Create project"));
    await settle();
    expect(after.calls.map((call) => (call.args[0] as NewProject).organizationId)).toEqual(["o2"]);
  });

  test("the only organization, never shown as a choice, leaving the list also asks for a choice", async () => {
    const page = await render(<Flow from={at("create")} />, { backend: fakeBackend({ organizations: [{ id: "o1", name: "Acme", role: "admin", plan: "Free", home: true }] }) });
    expect(text(page)).not.toContain("Organization");
    const after = fakeBackend({ organizations: [{ id: "o2", name: "Client work", role: "member", plan: "Plus", home: true }] });
    await rerender(<Flow from={at("create")} />, { backend: after });
    expect(page.querySelector(".ds-select")?.textContent).toBe("Choose");
    await click(button(page, "Create project"));
    expect(after.calls).toEqual([]);
  });

  test("a checked address that can't be the review address says so before Create, and isn't sent", async () => {
    const backend = fakeBackend();
    const from = at("create", { address: { status: "checked", text: "http://192.168.1.4:3000", url: "http://192.168.1.4:3000/", check: { kind: "local" } } });
    const page = await render(<Flow from={from} />, { backend });
    expect(text(page)).toContain(
      "http://192.168.1.4:3000/ won't be saved as the project's review address: Critiqs saves only HTTPS addresses, or HTTP ones on this computer. You can add one later in the project's settings.",
    );
    await click(button(page, "Create project"));
    await settle();
    expect((backend.calls[0]!.args[0] as NewProject).reviewUrl).toBeNull();
    // An address that is saved says nothing.
    const saved = await render(<Flow from={at("create", { address: { status: "checked", text: "acme.com", url: "https://acme.com/", check: { kind: "public", stack: null } } })} />);
    expect(text(saved)).not.toContain("won't be saved");
  });

  const LIMIT = "Your organization has reached the Free plan's limit of 1 project. An admin of the organization can upgrade the plan.";
  const limited = () => async (): Promise<string> => {
    throw Object.assign(new Error("x"), { data: { code: "limit", message: LIMIT } });
  };
  const old = { _id: "k57oldprojectidabcdef", name: "Old prototype", tags: [], createdAt: 0, reviewUrl: null, isOwner: true };

  test("a plan's project limit shows the server's message and stays on the step", async () => {
    const backend = fakeBackend({ createProject: limited() });
    const page = await render(<Flow from={at("create")} />, { backend });
    await click(button(page, "Create project"));
    await settle();
    expect(page.querySelector("[role='alert']")?.textContent).toBe(LIMIT);
    expect(title(page)).toBe("Create your project");
    expect(button(page, "Create project")?.disabled).toBe(false);
  });

  test("at the limit, a project the person created can be used instead, with its own name and saved stack", async () => {
    const backend = fakeBackend({
      createProject: limited(),
      organizations: [{ id: "o1", name: "Acme", role: "member", plan: "Free", home: true }],
      mine: [old],
      projectSetup: async (projectId) => ({ projectId, projectName: "Old prototype", address: "https://old.example/", stack: { id: "nuxt", label: "Nuxt", installable: false }, installCommands: null }),
    });
    const page = await render(<Flow from={at("create", { answers: { codeAccess: "self" } })} />, { backend });
    await click(button(page, "Create project"));
    await settle();
    expect(text(page)).toContain("Use a project you created");
    // A member can't upgrade the organization's plan: no Upgrade, only the server's message.
    expect(page.querySelector("a")).toBeNull();
    await click(button(page, /^Old prototype/));
    await settle();
    expect(backend.calls.map((call) => call.name)).toEqual(["createProject", "projectSetup"]);
    expect(title(page)).toBe("Recommended for Old prototype");
    expect(text(page)).toContain("Critiqs installs in React apps built with Vite or Next.js today. Nuxt support is coming.");
  });

  test("at the limit, each project the person created shows its organization and address, or when it was created", async () => {
    const created = Date.UTC(2026, 10, 20, 12);
    const backend = fakeBackend({
      createProject: limited(),
      mine: [
        { ...old, _id: "k57firstprojectabcdef", name: "Prototype", createdAt: created, reviewUrl: "https://one.example/", organization: { id: "o1", name: "Acme", role: "member" } },
        { ...old, _id: "k57secondprojectabcde", name: "Prototype", createdAt: created, reviewUrl: null, organization: { id: "o2", name: "Client work", role: "admin" } },
      ],
    });
    const page = await render(<Flow from={at("create")} />, { backend });
    await click(button(page, "Create project"));
    await settle();
    expect([...page.querySelectorAll(".project-list button")].map((choice) => [...choice.children].map((part) => text(part)))).toEqual([
      ["Prototype", "Acme · one.example"],
      ["Prototype", "Client work · Created Nov 20, 2026"],
    ]);
  });

  test("at the limit, an admin of the organization gets the deployment's upgrade page, when it names one", async () => {
    const admin = [{ id: "o1", name: "Acme", role: "admin" as const, plan: "Free", home: true }];
    const page = await render(<Flow from={at("create")} />, { backend: fakeBackend({ createProject: limited(), organizations: admin, upgradeUrl: "https://critiqs.example/pricing" }) });
    await click(button(page, "Create project"));
    await settle();
    const upgrade = page.querySelector("a");
    expect([upgrade?.textContent, upgrade?.getAttribute("href"), upgrade?.getAttribute("target")]).toEqual(["Upgrade the plan", "https://critiqs.example/pricing", "_blank"]);
    const none = await render(<Flow from={at("create")} />, { backend: fakeBackend({ createProject: limited(), organizations: admin, upgradeUrl: null }) });
    await click(button(none, "Create project"));
    await settle();
    expect(none.querySelector("a")).toBeNull();
    expect(none.querySelector("[role='alert']")?.textContent).toBe(LIMIT);
  });

  test("while Create is pending, Create and Back wait: a second click or Back creates nothing more", async () => {
    let finish: (id: string) => void = () => {};
    const backend = fakeBackend({ createProject: () => new Promise<string>((resolve) => (finish = resolve)) });
    const page = await render(<Flow from={at("create")} />, { backend });
    await click(button(page, "Create project"));
    expect(button(page, "Creating…")?.disabled).toBe(true);
    expect(button(page, "Back")?.disabled).toBe(true);
    await click(button(page, "Creating…"));
    await click(button(page, "Back"));
    await act(async () => void page.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(title(page)).toBe("Create your project");
    expect(backend.calls.filter((call) => call.name === "createProject")).toHaveLength(1);
    await act(async () => finish("k57abcdefghijklmnop"));
    await settle();
    expect(title(page)).toBe("Recommended for My prototype");
  });

  test("organizations that can't be loaded say so, and Create waits for them instead of using the home organization", async () => {
    const backend = fakeBackend({ organizationsState: { status: "error", code: "error", message: "Something went wrong. Try again." } });
    const page = await render(<Flow from={at("create")} />, { backend });
    expect(page.querySelector("[role='alert']")?.textContent).toBe("Your organizations couldn't be loaded, so the project can't be created yet. Something went wrong. Try again.");
    expect(button(page, "Create project")?.disabled).toBe(true);
    await act(async () => void page.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(backend.calls).toEqual([]);
    const loading = await render(<Flow from={at("create")} />, { backend: fakeBackend({ organizationsState: { status: "loading" } }) });
    expect(button(loading, "Create project")?.disabled).toBe(true);
  });

  test("an empty name says so instead of creating", async () => {
    const backend = fakeBackend();
    const page = await render(<Flow from={at("create")} />, { backend });
    await type(labelled(page, "Project name"), "  ");
    await click(button(page, "Create project"));
    expect(text(page)).toContain("Enter a name for the project.");
    expect(backend.calls).toEqual([]);
  });

  test("once the project exists there's no Back to the answers it was made from; Start over begins a new one", async () => {
    const project = { id: "k57abcdefghijklmnop", name: "Acme", reviewUrl: null, answers: {}, stack: null, check: { kind: "none" } as const };
    const page = await render(<Flow from={at("recommendation", { project })} />);
    expect(button(page, "Back")).toBeUndefined();
    expect(button(page, "Create project")).toBeUndefined();
    await click(button(page, "Start over"));
    expect(title(page)).toBe("What's your prototype's address?");
  });
});

describe("developer email errors", () => {
  test("Continue with an invalid address moves focus to the first invalid field, which names its error", async () => {
    const page = await render(<Flow from={at("code-access", { answers: { codeAccess: "nobody" }, developers: ["dev@acme.com", "dev@acme"] })} />);
    await click(button(page, "Continue"));
    const field = labelled(page, "Developer 2 email")!;
    expect(focused()).toBe(field);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(field.getAttribute("aria-describedby")!)?.textContent).toBe("Enter a valid email address.");
    // Again after moving away: focus goes back to it.
    labelled(page, "Developer 1 email")!.focus();
    await click(button(page, "Continue"));
    expect(focused()).toBe(field);
  });
});

describe("the page", () => {
  test("About you is saved as the person leaves the team-size step, with only what they answered", async () => {
    sessionStorage.clear();
    const backend = fakeBackend();
    const page = await render(<Onboarding />, { backend });
    expect(title(page)).toBe("What's your prototype's address?");
    await click(button(page, "Skip"));
    await click(labelled(page, "Engineer"));
    await click(button(page, "Continue"));
    await click(button(page, "Skip"));
    expect(backend.calls).toEqual([{ name: "saveAboutYou", args: [{ role: "engineer" }] }]);
    expect(title(page)).toBe("Can you change the prototype's code?");
  });

  test("both skipped: nothing is saved", async () => {
    sessionStorage.clear();
    const backend = fakeBackend();
    const page = await render(<Onboarding />, { backend });
    for (let i = 0; i < 3; i++) await click(button(page, "Skip"));
    expect(backend.calls).toEqual([]);
  });

  test("another reviewer signing in gets a fresh flow: no answers or draft carry over, and signing out removes the draft", async () => {
    sessionStorage.clear();
    const sam = fakeAuth(ME, "r1");
    const page = await render(<Onboarding />, { auth: sam });
    await click(button(page, "Skip"));
    await click(labelled(page, "Founder"));
    expect(sessionStorage.getItem("critiqs:onboarding:v2")).toContain("founder");
    const lee = fakeAuth("lee@acme.com", "r2");
    await rerender(<Onboarding />, { auth: lee });
    expect(title(page)).toBe("What's your prototype's address?");
    await click(button(page, "Skip"));
    expect(labelled(page, "Founder")?.checked).toBe(false);
    expect(sessionStorage.getItem("critiqs:onboarding:v2")).not.toContain("founder");
    await rerender(<Onboarding />, { auth: fakeAuth(null) });
    expect(title(page)).toBe("Sign in to Critiqs");
    expect(sessionStorage.getItem("critiqs:onboarding:v2")).toBeNull();
    // Sam signing back in finds no draft.
    await rerender(<Onboarding />, { auth: sam });
    expect(title(page)).toBe("What's your prototype's address?");
  });

  test("a draft saved by one reviewer isn't restored for another, even with the same address", async () => {
    sessionStorage.clear();
    const first = await render(<Onboarding />, { auth: fakeAuth(ME, "r1") });
    await click(button(first, "Skip"));
    await click(labelled(first, "Founder"));
    const again = await render(<Onboarding />, { auth: fakeAuth(ME, "r9") });
    expect(title(again)).toBe("What's your prototype's address?");
  });

  test("a create that finishes after another reviewer signed in doesn't land in their flow", async () => {
    sessionStorage.clear();
    let finish: (id: string) => void = () => {};
    const created: NewProject[] = [];
    const backend = fakeBackend({ createProject: (project) => (created.push(project), new Promise<string>((resolve) => (finish = resolve))) });
    const page = await render(<Onboarding />, { backend, auth: fakeAuth(ME, "r1") });
    for (let i = 0; i < 6; i++) await click(button(page, "Skip"));
    expect(title(page)).toBe("Create your project");
    await click(button(page, "Create project"));
    await rerender(<Onboarding />, { backend, auth: fakeAuth("lee@acme.com", "r2") });
    await act(async () => finish("k57abcdefghijklmnop"));
    await settle();
    expect(created).toHaveLength(1);
    expect(title(page)).toBe("What's your prototype's address?");
  });

  test("a reload comes back to the same step with the same answers", async () => {
    sessionStorage.clear();
    const first = await render(<Onboarding />);
    await click(button(first, "Skip"));
    await click(labelled(first, "Founder"));
    const again = await render(<Onboarding />);
    expect(title(again)).toBe("What's your role?");
    expect(labelled(again, "Founder")?.checked).toBe(true);
  });
});
