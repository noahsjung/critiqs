import { expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import type { NewProject } from "../src/backend.ts";
import { Onboarding } from "../src/ui/Onboarding.tsx";
import { button, click, fakeAuth, fakeBackend, labelled, reload, render, rerender, settle, text, type } from "./render.tsx";

// Creating the project with an idempotency key, on backends that report
// `createKeys`: a reload while the create is pending sends the same request
// again, and gets the same project instead of a second one.

const PROJECT_ID = "k57abcdefghijklmnop";
const I_WILL = /^I will/;
const MY_DEVELOPER = /^My developer will/;
const title = (page: Element) => page.querySelector("h1")?.textContent;
const creates = (backend: ReturnType<typeof fakeBackend>) => backend.calls.filter((call) => call.name === "createProject").map((call) => call.args[0] as NewProject);
const saved = () => Object.keys(sessionStorage).map((key) => sessionStorage.getItem(key) ?? "").join("\n");
const never = () => new Promise<string>(() => {});

async function chooseWithLink(page: Element, choice: RegExp = I_WILL) {
  await type(labelled(page, "Prototype link"), "acme-proto.vercel.app");
  await click(button(page, "Continue"));
  await settle();
  await click(button(page, choice));
  await settle();
}

test("choosing sends a new key, saved in this tab before the request goes out", async () => {
  sessionStorage.clear();
  const seenAtSend: string[] = [];
  const backend = fakeBackend({
    createKeys: true,
    createProject: async () => {
      seenAtSend.push(saved());
      return PROJECT_ID;
    },
  });
  const page = await render(<Onboarding />, { backend });
  await chooseWithLink(page);
  const [sent] = creates(backend);
  expect(sent?.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  expect(seenAtSend[0]).toContain(sent!.idempotencyKey!);
  expect(title(page)).toBe("Add Critiqs to your prototype");
  // Once the project is saved with the flow, its key is gone.
  expect(saved()).not.toContain(sent!.idempotencyKey!);
});

test("a reload while the create is pending sends the same request with the same key, and shows that project", async () => {
  sessionStorage.clear();
  const before = fakeBackend({ createKeys: true, createProject: never, checkAddress: async () => ({ kind: "public", stack: "next" }) });
  const page = await render(<Onboarding />, { backend: before });
  await chooseWithLink(page, MY_DEVELOPER);
  const [first] = creates(before);
  expect(first?.idempotencyKey).toBeDefined();
  const after = fakeBackend({ createKeys: true });
  const again = await reload(<Onboarding />, { backend: after });
  await settle();
  expect(creates(after)).toEqual([first!]);
  expect(title(again)).toBe("Send the steps to your developer");
  expect(saved()).not.toContain(first!.idempotencyKey!);
  // A second reload shows the same project, and sends nothing.
  const third = fakeBackend({ createKeys: true });
  await reload(<Onboarding />, { backend: third });
  await settle();
  expect(creates(third)).toEqual([]);
});

test("a reload while the address check is still running sends nothing: the choice is open again", async () => {
  sessionStorage.clear();
  const before = fakeBackend({ createKeys: true, checkAddress: () => new Promise(() => {}) });
  const page = await render(<Onboarding />, { backend: before });
  await chooseWithLink(page);
  expect(creates(before)).toEqual([]);
  const after = fakeBackend({ createKeys: true });
  const again = await reload(<Onboarding />, { backend: after });
  await settle();
  expect(creates(after)).toEqual([]);
  expect(title(again)).toBe("Who will add Critiqs to it?");
  expect(button(again, I_WILL)?.disabled).toBe(false);
});

test("a create that failed is chosen again under a new key", async () => {
  sessionStorage.clear();
  let fail = true;
  const backend = fakeBackend({
    createKeys: true,
    createProject: async () => {
      if (fail) throw Object.assign(new Error("x"), { data: { code: "unavailable", message: "Critiqs is busy." } });
      return PROJECT_ID;
    },
  });
  const page = await render(<Onboarding />, { backend });
  await chooseWithLink(page);
  expect(text(page)).toContain("Critiqs is busy.");
  fail = false;
  await click(button(page, I_WILL));
  await settle();
  const [first, second] = creates(backend);
  expect(second?.idempotencyKey).toBeDefined();
  expect(second!.idempotencyKey).not.toBe(first!.idempotencyKey);
});

test("a resent create that fails says so, and the choice is open again", async () => {
  sessionStorage.clear();
  const before = fakeBackend({ createKeys: true, createProject: never });
  const page = await render(<Onboarding />, { backend: before });
  await chooseWithLink(page);
  const after = fakeBackend({ createKeys: true, createProject: async () => Promise.reject(Object.assign(new Error("x"), { data: { code: "limit", message: "Your plan allows 3 projects." } })) });
  const again = await reload(<Onboarding />, { backend: after });
  await settle();
  expect(text(again)).toContain("Your plan allows 3 projects.");
  expect(button(again, I_WILL)?.disabled).toBe(false);
  expect(saved()).not.toContain(creates(before)[0]!.idempotencyKey!);
});

test("on a backend without create keys, no key is sent or kept, and a reload goes back to the choice as before", async () => {
  sessionStorage.clear();
  const before = fakeBackend({ createProject: never });
  const page = await render(<Onboarding />, { backend: before });
  await chooseWithLink(page);
  expect(creates(before)).toHaveLength(1);
  expect(creates(before)[0]).not.toHaveProperty("idempotencyKey");
  const after = fakeBackend();
  const again = await reload(<Onboarding />, { backend: after });
  await settle();
  expect(creates(after)).toEqual([]);
  expect(button(again, I_WILL)?.disabled).toBe(false);
});

test("signing out removes a pending create's key with the draft", async () => {
  sessionStorage.clear();
  const backend = fakeBackend({ createKeys: true, createProject: never });
  const page = await render(<Onboarding />, { backend });
  await chooseWithLink(page);
  const key = creates(backend)[0]!.idempotencyKey!;
  expect(saved()).toContain(key);
  await reload(<Onboarding />, { backend, auth: fakeAuth(null) });
  await act(async () => {});
  expect(saved()).not.toContain(key);
});

test("a create already sent when sign-in is briefly not ready isn't sent again: its own answer decides", async () => {
  sessionStorage.clear();
  const answer = Promise.withResolvers<string>();
  const backend = fakeBackend({ createKeys: true, createProject: () => answer.promise });
  const page = await render(<Onboarding />, { backend });
  await chooseWithLink(page);
  await rerender(<Onboarding />, { backend, auth: { ...fakeAuth(), ready: false } });
  await rerender(<Onboarding />, { backend, auth: fakeAuth() });
  await settle();
  expect(creates(backend)).toHaveLength(1);
  await act(async () => answer.reject(Object.assign(new Error("x"), { data: { code: "unavailable", message: "Critiqs is busy." } })));
  await settle();
  expect(text(page)).toContain("Critiqs is busy.");
  expect(button(page, I_WILL)?.disabled).toBe(false);
  expect(creates(backend)).toHaveLength(1);
});

test("a kept create reopens the choice when it can't be sent again: the backend's keys are unknown, or the key is a day old", async () => {
  const day = Date.UTC(2026, 10, 25, 9, 0);
  for (const [label, after, at] of [
    ["create keys unknown", () => fakeBackend(), day + 60_000],
    ["23 hours later", () => fakeBackend({ createKeys: true }), day + 23 * 3_600_000],
  ] as const) {
    sessionStorage.clear();
    setSystemTime(new Date(day));
    const before = fakeBackend({ createKeys: true, createProject: never });
    const page = await render(<Onboarding />, { backend: before });
    await chooseWithLink(page);
    setSystemTime(new Date(at));
    const backend = after();
    const again = await reload(<Onboarding />, { backend });
    await settle();
    expect([label, creates(backend), button(again, I_WILL)?.disabled, button(again, "Back")?.disabled]).toEqual([label, [], false, false]);
  }
  // Just under 23 hours, the server still knows the key: the same request goes again.
  sessionStorage.clear();
  setSystemTime(new Date(day));
  const before = fakeBackend({ createKeys: true, createProject: never });
  await chooseWithLink(await render(<Onboarding />, { backend: before }));
  setSystemTime(new Date(day + 23 * 3_600_000 - 60_000));
  const after = fakeBackend({ createKeys: true });
  await reload(<Onboarding />, { backend: after });
  await settle();
  expect(creates(after)).toEqual(creates(before));
  setSystemTime();
});

test("resending after a reload keeps the first send's time, so a reload can't stretch the key past 23 hours", async () => {
  const day = Date.UTC(2026, 10, 25, 9, 0);
  sessionStorage.clear();
  setSystemTime(new Date(day));
  const before = fakeBackend({ createKeys: true, createProject: never });
  await chooseWithLink(await render(<Onboarding />, { backend: before }));
  setSystemTime(new Date(day + 22 * 3_600_000));
  const resent = fakeBackend({ createKeys: true, createProject: never });
  await reload(<Onboarding />, { backend: resent });
  await settle();
  expect(creates(resent)).toHaveLength(1);
  setSystemTime(new Date(day + 23 * 3_600_000));
  const late = fakeBackend({ createKeys: true });
  const page = await reload(<Onboarding />, { backend: late });
  await settle();
  expect([creates(late), button(page, I_WILL)?.disabled]).toEqual([[], false]);
  setSystemTime();
});
