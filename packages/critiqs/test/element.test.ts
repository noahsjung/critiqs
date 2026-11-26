import { afterEach, expect, test } from "bun:test";
import { combineContext } from "../../react/src/mount.tsx";
import { mountCritiqs } from "../src/index.ts";
import { CritiqsElement } from "../src/element.ts";

const BACKEND = "http://localhost:9999/critiqs";
const PROJECT = "js71q5kzssedhq0rp6myv7zdf58gbb1t";
const HOST = "critiqs-root";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  document.body.innerHTML = "";
});

/** A server in the host app that knows `PROJECT` and no reviewer. */
function fakeBackend() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/critiqs/config")) return Response.json({ protocol: 5, transport: "http", signIn: "host", signInUrl: BACKEND });
    if (url.includes("/critiqs/health")) return Response.json({ protocol: 5, signIn: "host", project: "found" });
    if (url.endsWith("/me")) return Response.json({ reviewer: null });
    if (url.endsWith("/changes")) return Response.json({ version: 1 });
    return Response.json({ error: { code: "not-found", message: "Unknown request." } }, { status: 404 });
  }) as typeof fetch;
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const hosts = () => document.querySelectorAll(HOST).length;

test("mountCritiqs adds Critiqs above the page and destroy removes it", async () => {
  fakeBackend();
  const critiqs = mountCritiqs({ backend: BACKEND, projectId: PROJECT });
  await settle();
  expect(hosts()).toBe(1);
  // The interface renders after its backend answers; slower machines need longer than one settle.
  const rendered = () => (document.querySelector(HOST)?.shadowRoot?.textContent ?? "") !== "";
  for (let waited = 0; !rendered() && waited < 2000; waited += 25) await settle(25);
  expect(rendered()).toBe(true);
  critiqs.destroy();
  await settle();
  expect(hosts()).toBe(0);
  critiqs.update({ backend: BACKEND, projectId: PROJECT });
  await settle();
  expect(hosts()).toBe(0);
});

test("with requireProjectId, Critiqs appears only once the project ID is valid", async () => {
  fakeBackend();
  const critiqs = mountCritiqs({ backend: BACKEND, requireProjectId: true });
  await settle();
  expect(hosts()).toBe(0);
  critiqs.update({ backend: BACKEND, requireProjectId: true, projectId: PROJECT });
  await settle();
  expect(hosts()).toBe(1);
  critiqs.update({ backend: BACKEND, requireProjectId: true, projectId: "" });
  await settle();
  expect(hosts()).toBe(0);
  critiqs.destroy();
});

test("<critiqs-app> follows the element: added, configured by attributes, and removed", async () => {
  fakeBackend();
  const element = document.createElement("critiqs-app");
  element.setAttribute("backend", BACKEND);
  element.setAttribute("require-project-id", "");
  document.body.append(element);
  await settle();
  expect(hosts()).toBe(0);
  element.setAttribute("project-id", PROJECT);
  await settle();
  expect(hosts()).toBe(1);
  element.remove();
  await settle();
  expect(hosts()).toBe(0);
});

test("pushed context fills in what getContext doesn't report, and getContext wins key by key", () => {
  expect(combineContext({}, undefined)).toBeUndefined();
  const own = () => ({ screen: "own" });
  expect(combineContext({}, own)).toBe(own);
  expect(combineContext({ screen: "users/:id", persona: "Admin" }, undefined)?.()).toEqual({ screen: "users/:id", persona: "Admin" });
  const combined = combineContext({ screen: "users/:id", viewState: { tab: "billing" } }, () => ({ viewState: { tab: "profile" }, screen: undefined }));
  expect(combined?.()).toEqual({ screen: "users/:id", viewState: { tab: "profile" } });
});

test("a getContext that throws still leaves the pushed context", () => {
  const realError = console.error;
  console.error = () => {};
  try {
    const combined = combineContext({ screen: "checkout" }, () => {
      throw new Error("broken");
    });
    expect(combined?.()).toEqual({ screen: "checkout" });
  } finally {
    console.error = realError;
  }
});

test("setContext reaches Critiqs and survives updates; <critiqs-app> keeps it across reconnects", async () => {
  fakeBackend();
  const critiqs = mountCritiqs({ backend: BACKEND, projectId: PROJECT });
  critiqs.setContext({ screen: "orders/:id" });
  critiqs.update({ backend: BACKEND, projectId: PROJECT, version: "2" });
  await settle();
  expect(hosts()).toBe(1);
  critiqs.destroy();
  critiqs.setContext({ screen: "ignored" });
  await settle();
  expect(hosts()).toBe(0);

  const element = document.createElement("critiqs-app");
  element.setAttribute("backend", BACKEND);
  element.setAttribute("project-id", PROJECT);
  element.setContext({ screen: "before-connect" });
  document.body.append(element);
  await settle();
  expect(hosts()).toBe(1);
  element.remove();
  await settle();
  expect(hosts()).toBe(0);
});

test("getContext set on <critiqs-app> before the element is defined still reaches Critiqs", async () => {
  fakeBackend();
  const tag = "critiqs-app-late";
  const early = document.createElement(tag) as HTMLElement & { getContext?: () => object };
  early.setAttribute("backend", BACKEND);
  const getContext = () => ({ screen: "early" });
  early.getContext = getContext;
  document.body.append(early);
  class Late extends CritiqsElement {}
  customElements.define(tag, Late);
  expect(Object.hasOwn(early, "getContext")).toBe(false);
  expect((early as unknown as CritiqsElement).getContext).toBe(getContext);
  early.remove();
  await settle();
});

test("a page copy Turbo is about to show loses its copied critiqs-root; the live Critiqs stays", async () => {
  fakeBackend();
  const critiqs = mountCritiqs({ backend: BACKEND, projectId: PROJECT });
  await settle();
  const live = document.querySelector(HOST);
  // What Turbo's page cache keeps: a clone of the body, with an empty host and the page's own element.
  const newBody = document.body.cloneNode(true) as HTMLElement;
  newBody.append(document.createElement("p"));
  expect(newBody.querySelectorAll(HOST).length).toBe(1);
  document.dispatchEvent(new CustomEvent("turbo:before-render", { detail: { newBody } }));
  expect(newBody.querySelectorAll(HOST).length).toBe(0);
  expect(newBody.querySelectorAll("p").length).toBe(1);
  expect(document.querySelector(HOST)).toBe(live);
  // A second Critiqs shares the one listener, and an event without a body is ignored.
  const second = mountCritiqs({ backend: BACKEND, projectId: PROJECT });
  document.dispatchEvent(new CustomEvent("turbo:before-render"));
  await settle();
  expect(hosts()).toBe(2);
  critiqs.destroy();
  second.destroy();
  await settle();
});

test("Critiqs's styles fall back to a <style> element where constructed stylesheets aren't supported", async () => {
  fakeBackend();
  const supported = mountCritiqs({ backend: BACKEND, projectId: PROJECT });
  await settle();
  const shadow = document.querySelector(HOST)!.shadowRoot!;
  expect(shadow.adoptedStyleSheets.length).toBe(1);
  expect(shadow.querySelector("style")).toBeNull();
  supported.destroy();
  await settle();

  const adopted = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, "adoptedStyleSheets")!;
  delete (ShadowRoot.prototype as Partial<ShadowRoot>).adoptedStyleSheets;
  try {
    const fallback = mountCritiqs({ backend: BACKEND, projectId: PROJECT });
    await settle();
    expect(document.querySelector(HOST)!.shadowRoot!.querySelector("style")?.textContent).toContain(".toolbar");
    fallback.destroy();
    await settle();
  } finally {
    Object.defineProperty(ShadowRoot.prototype, "adoptedStyleSheets", adopted);
  }
});
