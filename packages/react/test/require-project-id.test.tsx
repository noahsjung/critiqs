import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Critiqs } from "../src/Critiqs.tsx";
import { HOST_TAG } from "../src/constants.ts";
import type { CritiqsProps } from "../src/host.ts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const BACKEND = "http://localhost:9999/critiqs";
const PROJECT = "js71q5kzssedhq0rp6myv7zdf58gbb1t";
const OTHER = "p_0123456789abcdef0123456789abcdef";
const realFetch = globalThis.fetch;
const realWarn = console.warn;

afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  localStorage.clear();
  document.body.innerHTML = "";
});

/** A server in the host app that knows `PROJECT` only; `down` makes it unreachable. */
function fakeBackend({ down = false, projectFailure = false } = {}) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (down) throw new TypeError("Failed to fetch");
    if (url.endsWith("/critiqs/config")) return Response.json({ protocol: 5, transport: "http", signIn: "host", signInUrl: BACKEND });
    if (url.includes("/critiqs/health")) {
      const asked = new URL(url).searchParams.get("projectId");
      return Response.json({ protocol: 5, signIn: "host", ...(asked === null ? {} : { project: asked === PROJECT ? "found" : "missing" }) });
    }
    if (url.endsWith("/me")) return Response.json({ reviewer: projectFailure ? { id: "reviewer", name: "Reviewer", email: "reviewer@example.com" } : null });
    if (url.endsWith("/changes")) return Response.json({ version: 1 });
    if (url.endsWith("/api/project") && projectFailure) return Response.json({ error: { code: "not-found", message: "Project not found." } }, { status: 404 });
    return Response.json({ error: { code: "not-found", message: "Unknown request." } }, { status: 404 });
  }) as typeof fetch;
  return calls;
}

function warnings() {
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  return lines;
}

async function settle(ms = 30) {
  await act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
}

async function mount(props: CritiqsProps) {
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Critiqs {...props} />));
  await settle();
  return {
    rerender: async (next: CritiqsProps) => {
      await act(async () => root.render(<Critiqs {...next} />));
      await settle();
    },
    unmount: async () => {
      await act(async () => root.unmount());
      await settle();
    },
  };
}

const hosts = () => document.querySelectorAll(HOST_TAG);
/** What Critiqs shows: its shadow root's content, without its styles. */
const shownText = () => [...hosts()].map((host) => host.shadowRoot?.querySelector("div")?.textContent ?? "").join("");

test("a missing, empty, or malformed required project ID adds nothing and contacts no backend", async () => {
  // Another app on this site remembered a project; it must not turn Critiqs on.
  localStorage.setItem(`critiqs:project:${BACKEND}`, JSON.stringify(PROJECT));
  for (const projectId of [undefined, "", "   ", "not-a-project", "VITE_CRITIQS_PROJECT_ID", `${PROJECT}!`]) {
    const calls = fakeBackend();
    const warned = warnings();
    const view = await mount({ projectId, requireProjectId: true, backend: BACKEND });
    expect(hosts()).toHaveLength(0);
    expect(calls).toEqual([]);
    // Unset is how Critiqs is turned off; a value that isn't an ID is the developer's mistake.
    expect(warned).toHaveLength(projectId === undefined || projectId.trim() === "" ? 0 : 1);
    if (warned.length > 0) expect(warned[0]).toContain("is not a Critiqs project ID, so Critiqs stays hidden");
    await view.unmount();
  }
});

test("a valid required project shows Critiqs, and turning it off and on again cleans up", async () => {
  const calls = fakeBackend();
  const view = await mount({ projectId: ` ${PROJECT}\n`, requireProjectId: true, backend: BACKEND });
  expect(hosts()).toHaveLength(1);
  expect(calls).toContain(`${BACKEND}/critiqs/health?projectId=${PROJECT}`);
  expect(shownText()).not.toContain("Set up");

  await view.rerender({ projectId: undefined, requireProjectId: true, backend: BACKEND });
  expect(hosts()).toHaveLength(0);
  calls.length = 0;
  await settle(50);
  expect(calls).toEqual([]);

  await view.rerender({ projectId: PROJECT, requireProjectId: true, backend: BACKEND });
  expect(hosts()).toHaveLength(1);
  await view.rerender({ projectId: "malformed", requireProjectId: true, backend: BACKEND });
  expect(hosts()).toHaveLength(0);
  await view.rerender({ projectId: PROJECT, requireProjectId: true, backend: BACKEND });
  expect(hosts()).toHaveLength(1);
  await view.unmount();
  expect(hosts()).toHaveLength(0);
});

test("a required project the backend doesn't know, or an unreachable backend, stays hidden and tells the developer", async () => {
  fakeBackend();
  let warned = warnings();
  let view = await mount({ projectId: OTHER, requireProjectId: true, backend: BACKEND });
  expect(shownText()).toBe("");
  expect(warned.join("\n")).toContain(`The project ${OTHER} doesn't exist on the Critiqs backend at ${BACKEND}`);
  await view.unmount();

  fakeBackend({ down: true });
  warned = warnings();
  view = await mount({ projectId: PROJECT, requireProjectId: true, backend: BACKEND });
  expect(shownText()).not.toContain("can't reach");
  expect(shownText()).toBe("");
  expect(warned.join("\n")).toContain("Critiqs can't reach its backend");
  await view.unmount();
});

test("without requireProjectId, Critiqs keeps showing setup and backend problems as before", async () => {
  fakeBackend({ down: true });
  const warned = warnings();
  const view = await mount({ backend: BACKEND });
  expect(hosts()).toHaveLength(1);
  expect(shownText()).toContain("Critiqs can't reach its backend");
  expect(warned).toEqual([]);
  await view.unmount();
});

test("a project query failure after successful health stays private in required mode, with legacy recovery retained", async () => {
  localStorage.setItem("critiqs:sidebar-open", "true");
  for (const required of [true, false]) {
    const calls = fakeBackend({ projectFailure: true });
    const warned = warnings();
    const view = await mount({ projectId: PROJECT, requireProjectId: required, backend: BACKEND });
    await settle(100);
    expect(calls.some((url) => url.endsWith("/api/project"))).toBe(true);
    if (required) {
      expect(shownText()).toBe("");
      expect(hosts()[0]?.shadowRoot?.querySelector(".toolbar")).toBeNull();
      expect(warned.join("\n")).toContain("isn't available on the Critiqs backend");
      for (const key of [new KeyboardEvent("keydown", { key: "c", cancelable: true }), new KeyboardEvent("keydown", { key: "\\", ctrlKey: true, cancelable: true })]) {
        window.dispatchEvent(key);
        expect(key.defaultPrevented).toBe(false);
      }
    } else {
      expect(shownText()).toContain("Project not found");
      expect(shownText()).toContain("Open project setup");
    }
    await view.unmount();
  }
});
