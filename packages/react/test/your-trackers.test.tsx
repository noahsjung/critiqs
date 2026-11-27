import { afterEach, expect, test } from "bun:test";
import type { TicketsConfig, TrackerAccountView } from "@critiqs/core";
import { ConvexError } from "convex/values";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import type { Deployment } from "../src/deployment.ts";
import { Session } from "../src/session.ts";
import { TransportContext } from "../src/transport.ts";
import { YourTrackersDialog } from "../src/ui/YourTrackersDialog.tsx";
import { type FakeBackend, fakeTransport } from "./fake-transport.tsx";

// Your trackers, a person's own tracker accounts, offered from the avatar menu
// where the backend stores tickets and offers a tracker: connecting Linear
// through its sign-in window or with a pasted API key, the Created from
// Critiqs default, and Disconnect.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const originalUrl = window.location.href;
const originalOpen = window.open;
const originalSubmit = HTMLFormElement.prototype.submit;
const SIGN_IN = "https://auth.example";
const BY_TOKEN: TicketsConfig = { trackers: [{ id: "linear", signIn: "token" }] };
const BY_SIGN_IN: TicketsConfig = { trackers: [{ id: "linear", signIn: "oauth" }] };
const CONNECTED: TrackerAccountView = { tracker: "linear", method: "oauth", accountName: "Dana Smith", site: "Acme", connectedAt: 1, attribution: true };

let root: Root | null = null;
let host: HTMLElement | null = null;
let container: HTMLElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  container?.remove();
  container = null;
  localStorage.clear();
  window.open = originalOpen;
  HTMLFormElement.prototype.submit = originalSubmit;
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(originalUrl);
});

function backend(overrides: Partial<FakeBackend> = {}): FakeBackend {
  return {
    project: { _id: "project", name: "Pilot", tags: [], createdAt: 1, reviewUrl: null, isOwner: true },
    threads: [],
    trackers: { accounts: [] },
    calls: [],
    ...overrides,
  };
}

/** The whole interface, signed in, in a shadow root as on a prototype. */
async function mount(data: FakeBackend, tickets: Deployment["tickets"]) {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://prototype.example/pilot");
  const payload = btoa(JSON.stringify({ sub: "dana", name: "Dana", email: "dana@example.com" }));
  localStorage.setItem(`critiqs:session:${SIGN_IN}`, JSON.stringify({ accessToken: `header.${payload}.signature`, refreshToken: "fixture", expiresAt: Date.now() + 900_000 }));
  host = document.createElement("critiqs-root");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const inner = document.createElement("div");
  shadow.append(inner);
  root = createRoot(inner);
  const session = new Session(SIGN_IN, localStorage, async () => new Response(null, { status: 204 }));
  const deployment: Deployment = { backendUrl: "https://backend.convex.cloud", siteUrl: "https://backend.convex.site", signInUrl: SIGN_IN, transport: "convex", signIn: null, personalAi: true, tickets };
  await act(async () =>
    root!.render(
      <TransportContext.Provider value={fakeTransport(data)}>
        <App props={{ projectId: "project", getContext: () => ({ screen: "pilot" }) }} deployment={deployment} session={session} host={host!} />
      </TransportContext.Provider>,
    ),
  );
  await settle();
  return shadow;
}

/** The dialog on its own, rendered again with the backend's current data by `rerender`. */
async function render(node: ReactNode, data: FakeBackend) {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await rerender(node, data);
  return container;
}

async function rerender(node: ReactNode, data: FakeBackend) {
  await act(async () => root!.render(<TransportContext.Provider value={fakeTransport(data)}>{node}</TransportContext.Provider>));
  await settle();
}

async function settle() {
  for (let i = 0; i < 3; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}

const button = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text || candidate.getAttribute("aria-label") === text) ?? null;

async function click(element: Element | null | undefined) {
  if (element == null) throw new Error("Nothing to click");
  await act(async () => (element as HTMLElement).click());
  await settle();
}

async function type(field: HTMLInputElement | null, text: string) {
  if (field === null) throw new Error("No field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openMenu(shadow: ShadowRoot) {
  await click(shadow.querySelector('button[aria-label="Signed in as Dana"]'));
}

/** A sign-in window the dialog opens, recording the forms posted to it. */
function fakeWindow() {
  const popup = { location: { href: "" }, closed: false, close() {
    popup.closed = true;
  } };
  const opened: unknown[][] = [];
  const posted: { action: string; method: string; target: string; address: string; fields: Record<string, string>; connected: boolean }[] = [];
  window.open = ((...args: unknown[]) => {
    opened.push(args);
    return popup;
  }) as typeof window.open;
  HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
    const fields = Object.fromEntries([...this.querySelectorAll("input")].map((input) => [input.name, input.value]));
    posted.push({ action: this.action, method: this.method.toLowerCase(), target: this.target, address: popup.location.href, fields, connected: this.isConnected });
  };
  return { popup, opened, posted };
}

test("Your trackers… sits beside Your AI… where the backend stores tickets and offers a tracker, and opens the dialog", async () => {
  const shadow = await mount(backend(), BY_TOKEN);
  await openMenu(shadow);
  const items = [...shadow.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim());
  expect(items.indexOf("Your trackers…")).toBe(items.indexOf("Your AI…") + 1);
  await click(button(shadow, "Your trackers…"));
  const dialog = shadow.querySelector('[role="dialog"][aria-label="Your trackers"]')!;
  expect(dialog.querySelector('[role="group"][aria-label="Linear"]')).not.toBeNull();
  expect(button(dialog, "Connect Linear")).not.toBeNull();
});

test("Your trackers isn't offered where the backend reports no tickets, or its transport has none", async () => {
  let shadow = await mount(backend(), null);
  await openMenu(shadow);
  expect(button(shadow, "Your AI…")).not.toBeNull();
  expect(button(shadow, "Your trackers…")).toBeNull();
  await act(async () => root?.unmount());
  host?.remove();
  shadow = await mount(backend({ trackers: undefined }), BY_TOKEN);
  await openMenu(shadow);
  expect(button(shadow, "Your trackers…")).toBeNull();
});

test("without Linear sign-in, Connect Linear asks for an API key, links to where to make one, and connects with it", async () => {
  const data = backend();
  const notes: string[] = [];
  const node = <YourTrackersDialog offered={BY_TOKEN} onClose={() => undefined} notify={(note) => notes.push(note)} />;
  const dialog = await render(node, data);
  await click(button(dialog, "Connect Linear"));
  expect(dialog.querySelector("h2, h3")?.textContent).toContain("Connect Linear");
  const settings = [...dialog.querySelectorAll("a")].find((link) => link.textContent === "Open Linear settings")!;
  expect(settings.getAttribute("href")).toBe("https://linear.app/settings/account/security");
  expect(settings.getAttribute("target")).toBe("_blank");
  const connect = button(dialog, "Connect")!;
  expect(connect.disabled).toBe(true);
  const field = dialog.querySelector<HTMLInputElement>('input[type="password"]');
  await type(field, "lin_api_123");
  await click(connect);
  expect(data.calls).toEqual([{ name: "connectTrackerWithToken", args: { tracker: "linear", token: "lin_api_123" } }]);
  expect(notes).toEqual(["Linear connected"]);
  await rerender(node, data);
  const group = dialog.querySelector('[role="group"][aria-label="Linear"]')!;
  expect(group.textContent).toContain("Dana Smith");
  expect(group.textContent).toContain("Acme");
  expect(button(dialog, "Connect Linear")).toBeNull();
});

test("a key Linear refuses keeps the page open with Linear's reason", async () => {
  const data = backend({ trackers: { accounts: [], connect: async () => Promise.reject(new ConvexError({ code: "invalid", message: "Linear didn't accept this API key. Check that you copied all of it, or create a new one." })) } });
  const dialog = await render(<YourTrackersDialog offered={BY_TOKEN} onClose={() => undefined} notify={() => undefined} />, data);
  await click(button(dialog, "Connect Linear"));
  await type(dialog.querySelector<HTMLInputElement>('input[type="password"]'), "lin_api_bad");
  await click(button(dialog, "Connect"));
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe("Linear didn't accept this API key. Check that you copied all of it, or create a new one.");
  expect(button(dialog, "Connect")).not.toBeNull();
});

test("with Linear sign-in, Connect Linear opens a window, posts the sign-in's secret to the backend's start in it, and says when Linear is connected", async () => {
  const { opened, posted } = fakeWindow();
  const data = backend();
  const notes: string[] = [];
  const node = <YourTrackersDialog offered={BY_SIGN_IN} onClose={() => undefined} notify={(note) => notes.push(note)} />;
  const dialog = await render(node, data);
  await click(button(dialog, "Connect Linear"));
  // Opened from the click, then sent to the backend's start by a form post: the secret is never in an address.
  expect(opened).toHaveLength(1);
  expect(opened[0]![1]).toBe("critiqs-tracker-sign-in");
  expect(posted).toEqual([
    {
      action: "https://backend.convex.site/trackers/linear/start",
      method: "post",
      target: "critiqs-tracker-sign-in",
      address: "",
      fields: { state: "s1", binding: "secret-1" },
      connected: true,
    },
  ]);
  expect(dialog.querySelector("form")).toBeNull();
  expect(data.calls).toEqual([{ name: "startTrackerSignIn", args: { tracker: "linear" } }]);
  expect(dialog.querySelector('[role="status"]')?.textContent).toBe("Finish connecting in the Linear window.");
  expect(notes).toEqual([]);
  // The sign-in finishes in the window; the account arrives with the next read.
  data.trackers!.accounts = [CONNECTED];
  await rerender(node, data);
  expect(notes).toEqual(["Linear connected"]);
  expect(dialog.querySelector('[role="status"]')).toBeNull();
  expect(dialog.textContent).toContain("Dana Smith");
});

/** The event a browser fires at the page when its content security policy refuses something, as for a form it won't post. */
function violation(directive: string, options: { disposition?: "enforce" | "report"; blockedURI?: string } = {}): Event {
  return Object.assign(new Event("securitypolicyviolation", { bubbles: true, composed: true }), {
    effectiveDirective: directive,
    disposition: options.disposition ?? "enforce",
    blockedURI: options.blockedURI ?? "https://backend.convex.site/trackers/linear/start",
  });
}

test("with Linear sign-in, Use an API key instead connects with a pasted key; without sign-in it isn't offered", async () => {
  const { opened } = fakeWindow();
  const data = backend();
  const notes: string[] = [];
  const dialog = await render(<YourTrackersDialog offered={BY_SIGN_IN} onClose={() => undefined} notify={(note) => notes.push(note)} />, data);
  expect(button(dialog, "Connect Linear")).not.toBeNull();
  await click(button(dialog, "Use an API key instead"));
  expect(opened).toEqual([]);
  expect(dialog.querySelector("h2, h3")?.textContent).toContain("Connect Linear");
  await type(dialog.querySelector<HTMLInputElement>('input[type="password"]'), "lin_api_123");
  await click(button(dialog, "Connect"));
  expect(data.calls).toEqual([{ name: "connectTrackerWithToken", args: { tracker: "linear", token: "lin_api_123" } }]);
  expect(notes).toEqual(["Linear connected"]);

  await act(async () => root?.unmount());
  container?.remove();
  const byToken = await render(<YourTrackersDialog offered={BY_TOKEN} onClose={() => undefined} notify={() => undefined} />, backend());
  expect(button(byToken, "Connect Linear")).not.toBeNull();
  expect(button(byToken, "Use an API key instead")).toBeNull();
});

test("a page whose security policy refuses the sign-in form closes the window and offers an API key instead", async () => {
  const { popup, posted } = fakeWindow();
  // The browser refuses the post after it is made, and says so to the page.
  const submit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
    submit.call(this);
    setTimeout(() => {
      // Another policy's refusal is someone else's.
      document.dispatchEvent(violation("script-src-elem"));
      document.dispatchEvent(violation("form-action"));
    }, 5);
  };
  const data = backend();
  const dialog = await render(<YourTrackersDialog offered={BY_SIGN_IN} onClose={() => undefined} notify={() => undefined} />, data);
  await click(button(dialog, "Connect Linear"));
  expect(posted).toHaveLength(1);
  expect(popup.closed).toBe(true);
  expect(dialog.querySelector('[role="status"]')).toBeNull();
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe("This page doesn't allow the Linear sign-in window. Use an API key instead.");
  await click(button(dialog, "Use an API key instead"));
  expect(dialog.querySelector<HTMLInputElement>('input[type="password"]')).not.toBeNull();
});

test("a sign-in form the page allows keeps waiting for the window, whatever other policies refuse", async () => {
  const { popup } = fakeWindow();
  const submit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
    submit.call(this);
    setTimeout(() => {
      document.dispatchEvent(violation("img-src"));
      // A report-only policy only reports: the post went through.
      document.dispatchEvent(violation("form-action", { disposition: "report" }));
      // The page refusing one of its own forms isn't the sign-in's.
      document.dispatchEvent(violation("form-action", { blockedURI: "https://elsewhere.example/submit" }));
    }, 5);
  };
  const dialog = await render(<YourTrackersDialog offered={BY_SIGN_IN} onClose={() => undefined} notify={() => undefined} />, backend());
  await click(button(dialog, "Connect Linear"));
  expect(popup.closed).toBe(false);
  expect(dialog.querySelector('[role="status"]')?.textContent).toBe("Finish connecting in the Linear window.");
  expect(dialog.querySelector('[role="alert"]')).toBeNull();
});

test("a blocked sign-in window, or a sign-in the backend refuses, says why", async () => {
  window.open = (() => null) as typeof window.open;
  const data = backend({ trackers: { accounts: [], signIn: async () => Promise.reject(new ConvexError({ code: "invalid", message: "Linear sign-in isn't set up on this deployment. Paste an API key instead." })) } });
  const dialog = await render(<YourTrackersDialog offered={BY_SIGN_IN} onClose={() => undefined} notify={() => undefined} />, data);
  await click(button(dialog, "Connect Linear"));
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe("Your browser blocked the sign-in window. Allow pop-ups for this site and try again.");
  const { popup } = fakeWindow();
  await click(button(dialog, "Connect Linear"));
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe("Linear sign-in isn't set up on this deployment. Paste an API key instead.");
  expect(popup.closed).toBe(true);
  expect(dialog.querySelector('[role="status"]')).toBeNull();
});

test("Created from Critiqs is on by default and saves at once; Disconnect asks first, then removes the account", async () => {
  const data = backend({ trackers: { accounts: [CONNECTED] } });
  const notes: string[] = [];
  const node = <YourTrackersDialog offered={BY_SIGN_IN} onClose={() => undefined} notify={(note) => notes.push(note)} />;
  const dialog = await render(node, data);
  const toggle = () => dialog.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  expect(dialog.querySelector(`#${CSS.escape(toggle().getAttribute("aria-labelledby")!)}`)?.textContent).toBe("Created from Critiqs");
  await click(toggle());
  await rerender(node, data);
  expect(data.calls).toEqual([{ name: "setTrackerAttribution", args: { tracker: "linear", on: false } }]);
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  expect(notes).toEqual(["New tickets won't say they came from Critiqs"]);

  await click(button(dialog, "Disconnect"));
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("Disconnect Linear? Tickets already linked keep their links.");
  await click(button(dialog, "Keep Linear"));
  expect(dialog.querySelector('[role="alert"]')).toBeNull();
  expect(data.calls).toHaveLength(1);
  await click(button(dialog, "Disconnect"));
  await click([...dialog.querySelectorAll<HTMLButtonElement>("button.danger")].find((each) => each.textContent === "Disconnect"));
  await rerender(node, data);
  expect(data.calls!.at(-1)).toEqual({ name: "disconnectTracker", args: { tracker: "linear" } });
  expect(notes.at(-1)).toBe("Linear disconnected");
  expect(button(dialog, "Connect Linear")).not.toBeNull();
});

test("disconnecting says plainly what happened at the tracker: a pasted key still works there, and a sign-in Critiqs couldn't end does too", async () => {
  const pasted = backend({ trackers: { accounts: [{ ...CONNECTED, method: "token" }] } });
  const notes: string[] = [];
  const disconnect = async (data: FakeBackend) => {
    const node = <YourTrackersDialog offered={BY_SIGN_IN} onClose={() => undefined} notify={(note) => notes.push(note)} />;
    const dialog = await render(node, data);
    await click(button(dialog, "Disconnect"));
    await click([...dialog.querySelectorAll<HTMLButtonElement>("button.danger")].find((each) => each.textContent === "Disconnect"));
    await rerender(node, data);
    return dialog;
  };
  let dialog = await disconnect(pasted);
  expect(notes.at(-1)).toBe("Linear disconnected");
  expect(dialog.querySelector('[role="status"]')?.textContent).toBe("Critiqs no longer has your Linear API key, but the key still works in Linear until you delete it there.");
  // Linear couldn't be told: the sign-in still works there, and the person learns how to end it.
  const refused = backend({ trackers: { accounts: [CONNECTED], disconnected: "failed" } });
  dialog = await disconnect(refused);
  expect(notes.at(-1)).toBe("Linear disconnected");
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(
    "Linear is disconnected here, but Critiqs couldn't tell Linear to end its access, so Critiqs can still reach your Linear account. Critiqs will try again for about an hour; to end it now, remove Critiqs in Linear's settings.",
  );
  // Ended: nothing more to say.
  dialog = await disconnect(backend({ trackers: { accounts: [CONNECTED] } }));
  expect(dialog.querySelector('[role="alert"]')).toBeNull();
  expect(dialog.querySelector('[role="status"]')).toBeNull();
});
