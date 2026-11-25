import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TransportContext } from "../src/transport.ts";
import { NotificationsDialog } from "../src/ui/NotificationsDialog.tsx";
import { type FakeBackend, fakeTransport } from "./fake-transport.tsx";

// The Email notifications dialog: mention emails, reply emails, and muting the project.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function open(backend: FakeBackend) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <TransportContext.Provider value={fakeTransport(backend)}>
        <NotificationsDialog projectId="project" projectName="ADI Planner" onClose={() => {}} />
      </TransportContext.Provider>,
    ),
  );
  const box = (label: string) =>
    [...host!.querySelectorAll("label")].find((element) => element.textContent?.includes(label))?.querySelector("input") ?? null;
  return { box };
}

test("reply emails can be turned off on their own, and muting stays available while either kind is on", async () => {
  const calls: { name: string; args: unknown }[] = [];
  const backend: FakeBackend = { project: undefined, threads: undefined, calls, notificationSettings: { mentionEmails: false, replyEmails: true, projectMuted: false } };
  const { box } = await open(backend);
  expect(host!.textContent).toContain("replies in a thread you started, replied to, or were mentioned in");
  const replies = box("Email me about new replies in threads I'm in")!;
  expect(replies.checked).toBe(true);
  expect(box("Email me when someone mentions me")!.checked).toBe(false);
  // Reply emails are still on, so the project can still be muted.
  expect(box("Mute ADI Planner")!.disabled).toBe(false);
  await act(async () => replies.click());
  expect(calls).toEqual([{ name: "setNotificationSettings", args: { projectId: "project", replyEmails: false } }]);
});

test("muting is unavailable only when both kinds of email are off", async () => {
  const { box } = await open({ project: undefined, threads: undefined, notificationSettings: { mentionEmails: false, replyEmails: false, projectMuted: false } });
  expect(box("Mute ADI Planner")!.disabled).toBe(true);
});

test("a backend without reply emails shows only the mention choice", async () => {
  const { box } = await open({ project: undefined, threads: undefined, notificationSettings: { mentionEmails: true, projectMuted: false } });
  expect(box("Email me when someone mentions me")).not.toBeNull();
  expect(box("Email me about new replies")).toBeNull();
  expect(box("Mute ADI Planner")!.disabled).toBe(false);
});
