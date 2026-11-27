import { describe, expect, test } from "bun:test";
import type { TrackerAccountView, TrackerId, TrackerSignInStart } from "@critiqs/core";
import { act } from "react";
import type { TrackersBackend } from "../src/backend.ts";
import { YourTrackers } from "../src/ui/Trackers.tsx";
import { fakeBackend, render } from "./render.tsx";

// Your trackers on the website's setup screen: each tracker the backend
// offers, connected through the backend's sign-in window or a pasted token,
// and nothing where the backend offers no tickets.

function trackers(accounts: TrackerAccountView[] = [], refuse: string | null = null) {
  const calls: { name: string; args: unknown[] }[] = [];
  const backend: TrackersBackend = {
    offered: { trackers: [{ id: "linear", signIn: "oauth" }, { id: "github", signIn: "token" }, { id: "jira", signIn: "oauth" }], threadTickets: true },
    useAccounts: () => ({ status: "ready", data: accounts }),
    startSignIn: async (tracker: TrackerId, site?: string): Promise<TrackerSignInStart> => {
      calls.push({ name: "startSignIn", args: [tracker, site] });
      return { url: `https://backend.example.site/trackers/${tracker}/start`, state: "s1", binding: "secret-binding" };
    },
    connectWithToken: async (tracker, token, site) => {
      calls.push({ name: "connectWithToken", args: [tracker, token, site] });
      if (refuse !== null) throw Object.assign(new Error("refused"), { data: { code: "invalid", message: refuse } });
      return { tracker, method: "token", accountName: "Sam", site: null, connectedAt: 1, attribution: true };
    },
  };
  return { backend, calls };
}

const text = (element: Element) => element.textContent ?? "";
const button = (scope: ParentNode, label: string) => [...scope.querySelectorAll("button")].find((candidate) => candidate.textContent === label) ?? null;
const row = (page: Element, name: string) => [...page.querySelectorAll(".tracker-row")].find((candidate) => candidate.querySelector("strong")?.textContent === name)!;
async function click(element: Element | null) {
  await act(async () => (element as HTMLElement).click());
}
async function type(field: HTMLInputElement | null, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field!, value);
    field!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Your trackers on the website", () => {
  test("lists each tracker the backend offers, with the person's connected account", async () => {
    const { backend } = trackers([{ tracker: "linear", method: "oauth", accountName: "Sam Lee", site: "Acme", connectedAt: 1, attribution: true }]);
    const page = await render(<YourTrackers />, { backend: fakeBackend({ trackers: backend }) });
    expect(page.querySelector("h2")?.textContent).toBe("Your trackers");
    expect([...page.querySelectorAll(".tracker-row strong")].map(text)).toEqual(["Linear", "GitHub Issues", "Jira"]);
    expect(text(row(page, "Linear"))).toContain("Connected as Sam Lee in Acme");
    expect(button(row(page, "GitHub Issues"), "Connect")).not.toBeNull();
  });

  test("signing in opens the backend's window and posts the state and binding, never in an address; Jira asks for its site first", async () => {
    const { backend, calls } = trackers();
    const opened: string[] = [];
    const posted: { action: string; target: string; fields: Record<string, string> }[] = [];
    const realOpen = window.open;
    const realSubmit = HTMLFormElement.prototype.submit;
    window.open = ((url: string, name: string) => (opened.push(`${url}|${name}`), { close() {} })) as typeof window.open;
    HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
      posted.push({ action: this.action, target: this.target, fields: Object.fromEntries([...this.querySelectorAll("input")].map((input) => [input.name, input.value])) });
    };
    try {
      const page = await render(<YourTrackers />, { backend: fakeBackend({ trackers: backend }) });
      await click(button(row(page, "Linear"), "Connect"));
      expect(opened).toEqual(["|critiqs-tracker-sign-in"]);
      expect(posted).toEqual([{ action: "https://backend.example.site/trackers/linear/start", target: "critiqs-tracker-sign-in", fields: { state: "s1", binding: "secret-binding" } }]);
      expect(text(row(page, "Linear"))).toContain("Finish signing in in the window that opened.");
      await click(button(row(page, "Jira"), "Connect"));
      expect(calls.filter((call) => call.args[0] === "jira")).toEqual([]);
      await type(row(page, "Jira").querySelector("input"), "acme.atlassian.net");
      await act(async () => row(page, "Jira").querySelector("form")!.requestSubmit());
      expect(calls.at(-1)).toEqual({ name: "startSignIn", args: ["jira", "acme.atlassian.net"] });
    } finally {
      window.open = realOpen;
      HTMLFormElement.prototype.submit = realSubmit;
    }
  });

  test("a pasted token connects; a refused one says why and keeps the form", async () => {
    const { backend, calls } = trackers([], "This token can't read issues.");
    const page = await render(<YourTrackers />, { backend: fakeBackend({ trackers: backend }) });
    await click(button(row(page, "GitHub Issues"), "Connect"));
    await type(row(page, "GitHub Issues").querySelector('input[type="password"]'), "github_pat_x");
    await act(async () => row(page, "GitHub Issues").querySelector("form")!.requestSubmit());
    expect(calls).toEqual([{ name: "connectWithToken", args: ["github", "github_pat_x", undefined] }]);
    expect(text(row(page, "GitHub Issues"))).toContain("This token can't read issues.");
    expect(row(page, "GitHub Issues").querySelector("form")).not.toBeNull();
  });

  test("a backend without tickets shows nothing", async () => {
    const page = await render(<YourTrackers />, { backend: fakeBackend() });
    expect(page.querySelector(".trackers")).toBeNull();
  });
});
