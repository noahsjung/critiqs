import type { ProjectInfo } from "@critiqs/core";
import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TransportContext } from "../src/transport.ts";
import { Setup } from "../src/ui/Setup.tsx";
import { type FakeBackend, fakeTransport } from "./fake-transport.tsx";

// The project's address list in project setup: its owners see the sites the
// browser extension finds the project on, remove one, and add an origin or a
// pattern, one change at a time, on backends that take single edits.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const owned: ProjectInfo = { _id: "project", name: "Pilot", tags: [], createdAt: 1, reviewUrl: null, isOwner: true };

async function renderSetup(backend: Partial<FakeBackend>, { addressEdits = true, project = owned }: { addressEdits?: boolean; project?: ProjectInfo } = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const calls: { name: string; args: unknown }[] = [];
  const notes: string[] = [];
  const data = { project, threads: [], calls, ...backend } as FakeBackend;
  const render = async () =>
    await act(async () =>
      root.render(
        <TransportContext.Provider value={fakeTransport(data)}>
          <Setup
            backLabel="Back to comments"
            reviewer={{ id: "u_dana", name: "Dana", email: "dana@example.com", pictureUrl: null }}
            signedIn
            addressEdits={addressEdits}
            onSignIn={() => {}}
            configuredProjectId="project"
            browserProjectId={null}
            onUseProject={() => {}}
            onDone={() => {}}
            notify={(message) => void notes.push(message)}
          />
        </TransportContext.Provider>,
      ),
    );
  await render();
  const section = () => host.querySelector<HTMLElement>("[aria-label='Extension addresses']");
  const button = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((entry) => (entry.getAttribute("aria-label") ?? entry.textContent?.trim()) === label);
  const input = () => host.querySelector<HTMLInputElement>("input[aria-label='Address or pattern to add']");
  return {
    host,
    calls,
    notes,
    data,
    section,
    button,
    input,
    rows: () => Array.from(section()?.querySelectorAll("li code") ?? []).map((code) => code.textContent),
    // The fake's list changes as a live query would: render again to read it.
    render,
    type: async (value: string) =>
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input()!, value);
        input()!.dispatchEvent(new Event("input", { bubbles: true }));
      }),
    submit: async () => await act(async () => input()!.form!.requestSubmit()),
    click: async (target: HTMLElement | undefined) => await act(async () => target!.click()),
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("an owner sees the list, removes an address, and adds a pattern; each saves at once", async () => {
  const view = await renderSetup({ addresses: ["https://pilot.example", "http://localhost:5173"] });
  expect(view.section()?.textContent).toContain("The Critiqs extension finds this project on these sites");
  expect(view.rows()).toEqual(["https://pilot.example", "http://localhost:5173"]);
  await view.click(view.button("Remove http://localhost:5173"));
  await view.render();
  expect(view.calls.filter((call) => call.name === "removeProjectAddress").map((call) => call.args)).toEqual([{ projectId: "project", address: "http://localhost:5173" }]);
  expect(view.rows()).toEqual(["https://pilot.example"]);
  // A pattern, typed loosely, is saved as the list holds it.
  await view.type("  https://*-pilot.vercel.app/ ");
  await view.submit();
  await view.render();
  expect(view.calls.filter((call) => call.name === "addProjectAddress").map((call) => call.args)).toEqual([{ projectId: "project", address: "https://*-pilot.vercel.app" }]);
  expect(view.rows()).toEqual(["https://pilot.example", "https://*-pilot.vercel.app"]);
  expect(view.notes).toEqual(["http://localhost:5173 removed", "Address added"]);
  expect(view.input()?.value).toBe("");
  await view.done();
});

test("an address the list can't hold says why and sends nothing; the server's refusal shows too", async () => {
  const view = await renderSetup({
    addresses: [],
    changeAddresses: async () => Promise.reject(Object.assign(new Error("x"), { data: { code: "forbidden", message: "Only the project's owners can change or see its address list." } })),
  });
  expect(view.section()?.textContent).toContain("None yet.");
  await view.type("http://pilot.example");
  await view.submit();
  expect(view.section()?.querySelector("[role='alert']")?.textContent).toContain("must start with https://");
  await view.type("https://pilot.example/path");
  await view.submit();
  expect(view.section()?.querySelector("[role='alert']")?.textContent).toContain("without a path");
  expect(view.calls.filter((call) => call.name === "addProjectAddress")).toEqual([]);
  await view.type("https://pilot.example");
  await view.submit();
  expect(view.section()?.querySelector("[role='alert']")?.textContent).toBe("Only the project's owners can change or see its address list.");
  await view.done();
});

test("a full list offers no field; people who aren't owners, and backends without single edits, see no list", async () => {
  const full = await renderSetup({ addresses: Array.from({ length: 20 }, (_, index) => `https://site-${index}.example`) });
  expect(full.input()).toBeNull();
  expect(full.section()?.textContent).toContain("A project can list up to 20 addresses. Remove one to add another.");
  await full.done();
  const reviewer = await renderSetup({ addresses: ["https://pilot.example"] }, { project: { ...owned, isOwner: false } });
  expect(reviewer.section()).toBeNull();
  await reviewer.done();
  const older = await renderSetup({ addresses: ["https://pilot.example"] }, { addressEdits: false });
  expect(older.section()).toBeNull();
  await older.done();
});
