import { afterEach } from "bun:test";
import type { DeveloperSendSummary, DeveloperSetup, OrganizationSummary, ProjectInfo, ProjectSetup } from "@critiqs/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type Auth, AuthContext, type Backend, BackendContext } from "../src/backend.ts";
import type { QueryState } from "../src/shared.ts";

// Renders the app's pages the way packages/react's tests do: happy-dom, act,
// and a fake backend whose calls the test sees.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let container: HTMLElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
});

export async function render(node: ReactNode, { backend = fakeBackend(), auth = fakeAuth() }: { backend?: Backend; auth?: Auth } = {}) {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <BackendContext.Provider value={backend}>
        <AuthContext.Provider value={auth}>{node}</AuthContext.Provider>
      </BackendContext.Provider>,
    ),
  );
  return container;
}

export async function rerender(node: ReactNode, { backend = fakeBackend(), auth = fakeAuth() }: { backend?: Backend; auth?: Auth } = {}) {
  await act(async () =>
    root!.render(
      <BackendContext.Provider value={backend}>
        <AuthContext.Provider value={auth}>{node}</AuthContext.Provider>
      </BackendContext.Provider>,
    ),
  );
}

export function fakeAuth(email: string | null = "sam@acme.com", id = "r1"): Auth {
  return {
    reviewer: email === null ? null : { id, name: "Sam Lee", email, pictureUrl: null },
    ready: email !== null,
    signIn: async () => {},
    signOut: async () => {},
  };
}

export interface FakeBackend extends Backend {
  calls: { name: string; args: unknown[] }[];
}

const loading = { status: "loading" } as const;

/**
 * A backend whose calls the test sees. Queries answer from the overrides:
 * `organizations` (or `organizationsState` for an error), `sends`, `project`,
 * the person's own projects (`mine`), the deployment's `upgradeUrl`, and a
 * setup link's send (`sendSetup`) or project (`projectSetupState`).
 */
export function fakeBackend(
  overrides: Partial<Backend> & {
    organizations?: OrganizationSummary[];
    organizationsState?: QueryState<OrganizationSummary[]>;
    sends?: DeveloperSendSummary[];
    project?: ProjectInfo;
    mine?: ProjectInfo[];
    upgradeUrl?: string | null;
    sendSetup?: QueryState<DeveloperSetup>;
    projectSetupState?: QueryState<ProjectSetup>;
    projectState?: QueryState<ProjectInfo>;
  } = {},
): FakeBackend {
  const calls: FakeBackend["calls"] = [];
  const record =
    <A extends unknown[], R>(name: string, run: (...args: A) => Promise<R>) =>
    (...args: A) => {
      calls.push({ name, args });
      return run(...args);
    };
  return {
    calls,
    componentBackend: overrides.componentBackend ?? null,
    checkAddress: record("checkAddress", overrides.checkAddress ?? (async () => ({ kind: "public", stack: null }) as const)),
    saveAboutYou: record("saveAboutYou", overrides.saveAboutYou ?? (async () => {})),
    createProject: record("createProject", overrides.createProject ?? (async () => "k57abcdefghijklmnop")),
    sendDeveloperSetup: record("sendDeveloperSetup", overrides.sendDeveloperSetup ?? (async (_projectId: string, emails: string[]) => emails.map((email) => ({ email, status: "sent" as const, sendId: "s1", invite: "none" as const })))),
    projectSetup: record("projectSetup", overrides.projectSetup ?? (async (projectId: string) => ({ projectId, projectName: "Old prototype", address: null, stack: null, installCommands: null }))),
    useOrganizations: () => overrides.organizationsState ?? { status: "ready", data: overrides.organizations ?? [] },
    useProject: (projectId) => (projectId === null ? loading : (overrides.projectState ?? (overrides.project === undefined ? loading : { status: "ready", data: overrides.project }))),
    useMyProjects: (enabled) => (enabled ? { status: "ready", data: overrides.mine ?? [] } : loading),
    useUpgradeUrl: (enabled) => (enabled ? { status: "ready", data: overrides.upgradeUrl ?? null } : loading),
    useDeveloperSends: () => ({ status: "ready", data: overrides.sends ?? [] }),
    useDeveloperSetup: (sendId) => (sendId === null ? loading : (overrides.sendSetup ?? loading)),
    useProjectSetup: (projectId) => (projectId === null ? loading : (overrides.projectSetupState ?? loading)),
  };
}

export async function click(element: Element | null | undefined) {
  if (!(element instanceof HTMLElement)) throw new Error("Nothing to click.");
  await act(async () => element.click());
}

/** Types into a field as React sees it. */
export async function type(field: Element | null | undefined, value: string) {
  if (!(field instanceof HTMLInputElement)) throw new Error("Not a field.");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export function button(scope: ParentNode, name: string | RegExp): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll("button")].find((candidate) => {
    const label = candidate.getAttribute("aria-label") ?? candidate.textContent ?? "";
    return typeof name === "string" ? label.trim() === name || candidate.textContent?.trim() === name : name.test(label);
  });
}

export function labelled(scope: ParentNode, label: string): HTMLInputElement | undefined {
  for (const element of scope.querySelectorAll("label")) {
    if (element.textContent?.trim() !== label) continue;
    const id = element.getAttribute("for");
    if (id !== null) return (document.getElementById(id) as HTMLInputElement | null) ?? undefined;
    return element.querySelector("input") ?? undefined;
  }
  return undefined;
}

/** Lets pending promises settle inside act. */
export async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export function text(scope: Element): string {
  return (scope.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** A clipboard the copy buttons write to. */
export function fakeClipboard(): { text: string } {
  const clipboard = { text: "" };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => void (clipboard.text = value), readText: async () => clipboard.text },
  });
  return clipboard;
}

/** A browser that refuses to copy: the clipboard API throws, and the copy command copies nothing. */
export function refusingClipboard() {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => Promise.reject(new Error("Not allowed")) } });
  Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
}
