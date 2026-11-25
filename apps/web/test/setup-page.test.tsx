import { describe, expect, test } from "bun:test";
import { STACKS } from "@critiqs/core";
import type { SetupInfo } from "../src/backend.ts";
import { routeOf } from "../src/route.ts";
import { SetupPage, SetupView } from "../src/ui/SetupPage.tsx";
import { button, click, fakeAuth, fakeBackend, fakeClipboard, render, text } from "./render.tsx";

// The developer's setup page in each state its link can be in.

const PROJECT_ID = "n579b6w6641phdvxeymddfn1zd8jwjxw";
const SETUP: SetupInfo = {
  projectId: PROJECT_ID,
  projectName: "Acme prototype",
  address: "https://acme-proto.vercel.app/",
  stack: STACKS.find((stack) => stack.id === "next")!,
  installCommands: ["npm install critiqs-react", `npx critiqs init ${PROJECT_ID}`],
  inviterName: "Alex Kim",
};
const noop = () => {};

describe("the setup page", () => {
  test("signed out: asks to sign in with the address the link was sent to", async () => {
    const page = await render(<SetupPage id="s1" />, { auth: fakeAuth(null) });
    expect(text(page)).toContain("Sign in to Critiqs");
    expect(text(page)).toContain("Sign in with the email address this link was sent to.");
    expect(button(page, "Sign in with email")).toBeDefined();
  });

  test("loading", async () => {
    const page = await render(<SetupView state={{ status: "loading" }} email="dev@acme.com" onSignOut={noop} />);
    expect(text(page)).toBe("Loading…");
  });

  test("a send: who asked, the project, the address as text, and the command to copy", async () => {
    const clipboard = fakeClipboard();
    const page = await render(<SetupView state={{ status: "ready", data: SETUP }} email="dev@acme.com" onSignOut={noop} />);
    expect(page.querySelector("h1")?.textContent).toBe("Add Critiqs to Acme prototype");
    expect(text(page)).toContain("Alex Kim asked you to add Critiqs so your team can comment right on the prototype.");
    expect([...page.querySelectorAll(".facts .fact")].map((row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent])).toEqual([
      ["Project", "Acme prototype"],
      ["Prototype", "https://acme-proto.vercel.app/"],
      ["Built with", "Next.js"],
    ]);
    // The address is never a link.
    expect(page.querySelector("a")).toBeNull();
    expect(text(page)).toContain("Run this in the prototype's folder. It already has the project ID.");
    await click(button(page, "Copy command"));
    expect(clipboard.text).toBe(`npm install critiqs-react && npx critiqs init ${PROJECT_ID}`);
  });

  test("a project on a backend other than Critiqs Cloud: a step that gives Critiqs its backend", async () => {
    const backend = fakeBackend({ componentBackend: "https://team-backend.convex.cloud" });
    const page = await render(<SetupView state={{ status: "ready", data: SETUP }} email="dev@acme.com" onSignOut={noop} />, { backend });
    expect(text(page)).toContain("This project is on your team's own Critiqs backend, not Critiqs Cloud. Then add this setting where init added Critiqs, so it connects there:");
    expect([...page.querySelectorAll("code")].map((code) => code.textContent)).toEqual([SETUP.installCommands!.join(" &&\n"), 'backend="https://team-backend.convex.cloud"']);
    // No commands, no step.
    const laravel = STACKS.find((stack) => stack.id === "laravel")!;
    const none = await render(<SetupView state={{ status: "ready", data: { ...SETUP, stack: laravel, installCommands: null } }} email="dev@acme.com" onSignOut={noop} />, { backend });
    expect(text(none)).not.toContain("backend=");
  });

  test("a project with no saved stack: no one named, the stack not confirmed, and init alone, which finds the framework", async () => {
    const page = await render(<SetupView state={{ status: "ready", data: { ...SETUP, stack: null, inviterName: null, address: null } }} email="dev@acme.com" onSignOut={noop} />);
    expect(text(page)).toContain("Your team asked you to add Critiqs so they can comment right on the prototype.");
    expect(text(page)).toContain("PrototypeNot given");
    expect(text(page)).toContain("Built withNot confirmed");
    expect(text(page)).toContain("It finds your framework (React, Next.js, Vue, Nuxt, Svelte, SvelteKit, Angular, Astro, Solid, Rails, Django, or Flask) and adds Critiqs.");
    expect([...page.querySelectorAll("code")].map((code) => code.textContent)).toEqual([`npx critiqs init ${PROJECT_ID}`]);
  });

  test("a stack with no Critiqs package: the script tag's guide and the project ID, with no commands", async () => {
    const wordpress = STACKS.find((stack) => stack.id === "wordpress")!;
    const page = await render(<SetupView state={{ status: "ready", data: { ...SETUP, stack: wordpress, installCommands: null } }} email="dev@acme.com" onSignOut={noop} />);
    expect(text(page)).toContain("WordPress has no Critiqs package, so add Critiqs with a script tag on every page.");
    expect(page.querySelector("a")?.getAttribute("href")).toBe("https://github.com/noahsjung/critiqs/tree/main/packages/critiqs#with-a-script-tag");
    expect([...page.querySelectorAll("code")].map((code) => code.textContent)).toEqual([PROJECT_ID]);
  });

  test("a framework package's commands show even when an older backend answered with none", async () => {
    const vue = { ...STACKS.find((stack) => stack.id === "vue")!, installable: false };
    const page = await render(<SetupView state={{ status: "ready", data: { ...SETUP, stack: vue, installCommands: null } }} email="dev@acme.com" onSignOut={noop} />);
    expect([...page.querySelectorAll("code")].map((code) => code.textContent)).toEqual([`npm install critiqs-vue &&\nnpx critiqs init ${PROJECT_ID}`]);
    expect(text(page)).not.toContain("coming soon");
  });

  test("a send that doesn't exist and one sent to someone else look the same", async () => {
    let signedOut = false;
    const missing = await render(
      <SetupView state={{ status: "error", code: "not-found", message: "This setup link doesn't exist, or it was sent to another address." }} email="dev@acme.com" onSignOut={() => (signedOut = true)} />,
    );
    const shown = text(missing);
    expect(shown).toBe("Setup link not foundThis setup link doesn't exist, or it was sent to another address.Signed in as dev@acme.com.Sign out");
    await click(button(missing, "Sign out"));
    expect(signedOut).toBe(true);
    const forbidden = await render(<SetupView state={{ status: "error", code: "forbidden", message: "Something specific." }} email="dev@acme.com" onSignOut={noop} />);
    expect(text(forbidden)).toBe(shown);
  });

  test("signed in, a send's link shows the send's setup, naming who asked", async () => {
    const { inviterName, ...project } = SETUP;
    const page = await render(<SetupPage id="s1" />, { backend: fakeBackend({ sendSetup: { status: "ready", data: { ...project, inviterName: inviterName! } } }) });
    expect(page.querySelector("h1")?.textContent).toBe("Add Critiqs to Acme prototype");
    expect(text(page)).toContain("Alex Kim asked you");
  });

  test("a copied message's link, by project ID, shows the project's saved stack and its commands", async () => {
    const notFound = { status: "error", code: "not-found", message: "This setup link doesn't exist, or it was sent to another address." } as const;
    const nuxt = STACKS.find((stack) => stack.id === "nuxt")!;
    const page = await render(<SetupPage id={PROJECT_ID} />, {
      backend: fakeBackend({ sendSetup: notFound, projectSetupState: { status: "ready", data: { projectId: PROJECT_ID, projectName: "Nuxt shop", address: "https://shop.example/", stack: nuxt, installCommands: null } } }),
    });
    expect(page.querySelector("h1")?.textContent).toBe("Add Critiqs to Nuxt shop");
    expect(text(page)).toContain("Built withNuxt");
    expect([...page.querySelectorAll("code")].map((code) => code.textContent)).toEqual([`npm install critiqs-nuxt &&\nnpx critiqs init ${PROJECT_ID}`]);
    const next = await render(<SetupPage id={PROJECT_ID} />, {
      backend: fakeBackend({ sendSetup: notFound, projectSetupState: { status: "ready", data: { projectId: PROJECT_ID, projectName: "Acme", address: null, stack: SETUP.stack, installCommands: SETUP.installCommands } } }),
    });
    expect(text(next)).toContain("Built withNext.js");
    expect(text(next)).toContain("Run this in the prototype's folder. It already has the project ID.");
    expect([...next.querySelectorAll("code")].map((code) => code.textContent)).toEqual([SETUP.installCommands!.join(" &&\n")]);
    // A project ID that names no project looks the same as a send that doesn't exist.
    const missing = await render(<SetupPage id={PROJECT_ID} />, { backend: fakeBackend({ sendSetup: notFound, projectSetupState: { status: "error", code: "not-found", message: "This project does not exist." } }) });
    expect(text(missing)).toContain("This setup link doesn't exist, or it was sent to another address.");
    // Something that isn't a project ID isn't looked up as one.
    expect(text(await render(<SetupPage id="not-an-id" />, { backend: fakeBackend({ sendSetup: notFound, projectSetupState: { status: "ready", data: { ...SETUP } } }) }))).toContain("Setup link not found");
  });
});

describe("routes", () => {
  test("/setup/<id> is the setup page; everything else is onboarding", () => {
    expect(routeOf("/setup/k172b883z6s90ct76fj11b7h5n8jxn0w")).toEqual({ page: "setup", id: "k172b883z6s90ct76fj11b7h5n8jxn0w" });
    expect(routeOf("/setup/abc/")).toEqual({ page: "setup", id: "abc" });
    expect(routeOf("/start")).toEqual({ page: "start" });
    expect(routeOf("/")).toEqual({ page: "start" });
    expect(routeOf("/setup/")).toEqual({ page: "start" });
    expect(routeOf("/setup/%E0%A4%A")).toEqual({ page: "start" });
  });
});
