import type { ProjectInfo } from "@critiqs/core";
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TransportContext } from "../src/transport.ts";
import { Setup } from "../src/ui/Setup.tsx";
import { type FakeBackend, fakeTransport } from "./fake-transport.tsx";

// The review address: the page mention emails open, which only the project's
// owner sets, explicitly, in project setup.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const originalUrl = window.location.href;
const setUrl = (url: string) => (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);
afterEach(() => setUrl(originalUrl));

const project: ProjectInfo = { _id: "project", name: "Pilot", tags: [], createdAt: 1, reviewUrl: null, isOwner: true };

async function renderSetup(backend: Partial<FakeBackend>, { projectId = "project" }: { projectId?: string | null } = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const calls: { name: string; args: unknown }[] = [];
  const created: string[] = [];
  await act(async () =>
    root.render(
      <TransportContext.Provider value={fakeTransport({ project, threads: [], calls, ...backend })}>
        <Setup
          backLabel="Back to comments"
          reviewer={{ id: "u_dana", name: "Dana", email: "dana@example.com", pictureUrl: null }}
          signedIn
          onSignIn={() => {}}
          configuredProjectId={projectId}
          browserProjectId={null}
          onUseProject={(id) => void (id !== null && created.push(id))}
          onDone={() => {}}
          notify={() => {}}
        />
      </TransportContext.Provider>,
    ),
  );
  const button = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((entry) => entry.textContent?.trim() === label);
  const field = (label: string) =>
    Array.from(host.querySelectorAll("label")).find((entry) => entry.querySelector("span")?.textContent === label)?.querySelector("input") ?? null;
  return {
    host,
    calls,
    created,
    button,
    field,
    type: async (input: HTMLInputElement, value: string) =>
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }),
    click: async (target: HTMLElement) => await act(async () => target.click()),
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const warning = (host: HTMLElement) => host.querySelector(".warning")?.textContent ?? null;

test("creating a project saves no review address unless the owner enters one, even on an HTTPS page", async () => {
  setUrl("https://devbox.tail1234.ts.net/app/users");
  const setup = await renderSetup({}, { projectId: null });
  const address = setup.field("Review address (optional)")!;
  expect(address.value).toBe("");
  expect(setup.host.textContent).toContain("The page reviewers open, such as the deployed prototype. Mention emails open it");
  await setup.type(setup.field("Project name")!, "Admin console");
  await setup.click(setup.button("Create project")!);
  expect(setup.calls).toEqual([{ name: "createProject", args: { name: "Admin console", reviewUrl: null } }]);
  expect(setup.created).toEqual(["project"]);
  await setup.done();
});

test("the owner can choose this page; a private (Tailscale) address is explained but allowed", async () => {
  setUrl("https://devbox.tail1234.ts.net/app/users?tab=a&env=a%20b#/start");
  const setup = await renderSetup({}, { projectId: null });
  expect(warning(setup.host)).toBeNull();
  await setup.click(setup.button("Use this page")!);
  expect(setup.field("Review address (optional)")!.value).toBe("https://devbox.tail1234.ts.net/app/users?tab=a&env=a%20b#/start");
  expect(warning(setup.host)).toContain("Only people on this computer or its private network (such as a Tailscale network) can open this address");
  expect(warning(setup.host)).toContain("If reviewers use a deployed copy, enter that address instead.");
  await setup.type(setup.field("Project name")!, "Admin console");
  await setup.click(setup.button("Create project")!);
  expect(setup.calls).toEqual([{ name: "createProject", args: { name: "Admin console", reviewUrl: "https://devbox.tail1234.ts.net/app/users?tab=a&env=a%20b#/start" } }]);
  await setup.done();
});

test("choosing this page removes a copied comment target while keeping the host route", async () => {
  setUrl("https://team.github.io/admin-prototype/?version=v2&critiqs=thread.reply#/start");
  const setup = await renderSetup({}, { projectId: null });
  await setup.click(setup.button("Use this page")!);
  expect(setup.field("Review address (optional)")!.value).toBe("https://team.github.io/admin-prototype/?version=v2#/start");
  await setup.done();
});

test("setup checks the address as it's typed: private ones warn, unusable ones can't be saved", async () => {
  setUrl("http://localhost:5173/");
  const setup = await renderSetup({}, { projectId: null });
  const address = setup.field("Review address (optional)")!;
  await setup.type(setup.field("Project name")!, "Admin console");
  for (const typed of ["https://DevBox.Tail1234.TS.NET./", "https://100.101.102.103/", "http://localhost:5173/"]) {
    await setup.type(address, typed);
    expect([typed, warning(setup.host) !== null]).toEqual([typed, true]);
  }
  await setup.type(address, "https://team.github.io/admin-prototype/#/start");
  expect(warning(setup.host)).toBeNull();
  expect(setup.button("Create project")!.disabled).toBe(false);
  await setup.type(address, "team.github.io/admin-prototype");
  expect(setup.host.querySelector(".error")?.textContent).toBe("Enter the full address, starting with https:// (or http://localhost while testing).");
  expect(setup.button("Create project")!.disabled).toBe(true);
  await setup.done();
});

test("only the owner changes the review address; later emails use it, and nothing is filled in for them", async () => {
  setUrl("https://devbox.tail1234.ts.net/app/");
  const empty = await renderSetup({});
  expect(empty.host.querySelector('[aria-label="Review address"]')!.textContent).toContain("None yet, so mention emails can't link to comments.");
  await empty.click(empty.button("Add the address")!);
  expect(empty.field("Address")!.value).toBe("");
  expect(empty.host.textContent).toContain("Emails sent from now on use it; links in emails already sent don't change.");
  expect(empty.button("Save")!.disabled).toBe(true);
  await empty.type(empty.field("Address")!, " https://team.github.io/admin-prototype/ ");
  await empty.click(empty.button("Save")!);
  expect(empty.calls).toEqual([{ name: "setReviewUrl", args: { projectId: "project", reviewUrl: "https://team.github.io/admin-prototype/" } }]);
  await empty.done();

  const existing = await renderSetup({ project: { ...project, reviewUrl: "https://team.github.io/admin-prototype/" } });
  await existing.click(existing.button("Change")!);
  expect(existing.field("Address")!.value).toBe("https://team.github.io/admin-prototype/");
  await existing.click(existing.button("Cancel")!);
  expect(existing.calls).toEqual([]);
  await existing.done();

  const reviewer = await renderSetup({ project: { ...project, reviewUrl: "https://devbox.tail1234.ts.net/app/", isOwner: false } });
  expect(reviewer.button("Change")).toBeUndefined();
  expect(warning(reviewer.host)).toContain("The project's owner can change it.");
  await reviewer.done();
});

test("Cancel and Save return focus to the button that opened the address", async () => {
  const setup = await renderSetup({ project: { ...project, reviewUrl: "https://team.github.io/admin-prototype/" } });
  for (const close of ["Cancel", "Save"]) {
    await setup.click(setup.button("Change")!);
    await setup.click(setup.button(close)!);
    expect([close, document.activeElement?.textContent]).toEqual([close, "Change"]);
  }
  await setup.done();
});

test("a saved private review address is explained to the owner; a deployed one isn't", async () => {
  for (const reviewUrl of ["http://localhost:5173/", "https://devbox.tail1234.ts.net/", "https://192.168.1.4/"]) {
    const setup = await renderSetup({ project: { ...project, reviewUrl } });
    expect([reviewUrl, warning(setup.host)]).toEqual([reviewUrl, expect.stringContaining("reviewers elsewhere can't follow mention emails to it")]);
    await setup.done();
  }
  const deployed = await renderSetup({ project: { ...project, reviewUrl: "https://team.github.io/admin-prototype/" } });
  expect(warning(deployed.host)).toBeNull();
  await deployed.done();
});
