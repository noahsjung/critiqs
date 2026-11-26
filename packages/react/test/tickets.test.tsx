import { afterEach, expect, test } from "bun:test";
import type { Anchor, TicketBadge, TicketsConfig, ThreadDetail, ThreadSummary, TrackerAccountView } from "@critiqs/core";
import { ConvexError } from "convex/values";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import type { Deployment } from "../src/deployment.ts";
import { Session } from "../src/session.ts";
import { TransportContext } from "../src/transport.ts";
import { type FakeBackend, fakeTicketView, fakeTransport } from "./fake-transport.tsx";

// Tickets in the interface: Create ticket… and Link ticket… in the thread
// window's menu where the backend offers tickets (Your trackers first when no
// tracker is connected), their dialogs, the chips under the header, the key
// and status on the list row, and the pin's ticket mark.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const originalUrl = window.location.href;
const SIGN_IN = "https://auth.example";
const OFFERED: TicketsConfig = { trackers: [{ id: "linear", signIn: "token" }], threadTickets: true };
const LINEAR: TrackerAccountView = { tracker: "linear", method: "token", accountName: "Dana Smith", site: "Acme", connectedAt: 1, attribution: false };
const target = { purposeId: "review", recordKey: null, clues: { tagName: "button", role: null, label: "Review", path: "main:1/button:1" } };
const anchor: Anchor = {
  screen: "pilot",
  viewState: {},
  scope: "shared",
  target,
  evidence: { url: "https://prototype.example/pilot", capturedAt: 1, revision: "v1", persona: null, viewport: { width: 800, height: 600 }, marker: { x: 0, y: 0, width: 10, height: 10 }, userAgent: "Browser" },
};
const badge: TicketBadge = { tracker: "linear", key: "ENG-1", status: { label: "In Progress", category: "started" } };

function summary(tickets?: TicketBadge[]): ThreadSummary {
  return {
    _id: "thread",
    status: "open",
    anchor,
    location: null,
    tags: [],
    createdAt: 1,
    lastMessageAt: 1,
    messageCount: 1,
    unread: false,
    preview: { body: "Align the review button", authorName: "Dana", authorImageUrl: null },
    ...(tickets === undefined ? {} : { tickets }),
  };
}

function detail(tickets?: ThreadDetail["tickets"]): ThreadDetail {
  return {
    _id: "thread",
    status: "open",
    anchor,
    tags: [],
    capture: { status: "failed", failureReason: "Blocked by the browser." },
    createdAt: 1,
    lastMessageAt: 1,
    messageCount: 1,
    projectId: "project",
    statusChangedByName: null,
    reattachedByName: null,
    readState: { lastReadAt: 1, manualUnread: false },
    messages: [{ _id: "message", body: "Align the review button", createdAt: 1, editedAt: null, revision: "v1", author: { name: "Dana", imageUrl: null }, isMine: true, reactions: [], mentions: [] }],
    ...(tickets === undefined ? {} : { tickets }),
  };
}

function backend(overrides: Partial<FakeBackend> = {}): FakeBackend {
  return {
    project: { _id: "project", name: "Pilot", tags: [], createdAt: 1, reviewUrl: null, isOwner: true },
    threads: [summary([])],
    thread: detail([]),
    trackers: { accounts: [LINEAR] },
    calls: [],
    ...overrides,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let page: HTMLElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  page?.remove();
  page = null;
  localStorage.clear();
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(originalUrl);
});

/** The interface, signed in as `person` (Dana by default), over a prototype with the thread's target, its sidebar open or closed. */
async function mount(data: FakeBackend, tickets: Deployment["tickets"] = OFFERED, { sidebarOpen = false, person = "Dana" } = {}) {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://prototype.example/pilot");
  page = document.createElement("main");
  const button = document.createElement("button");
  button.setAttribute("data-critiqs-id", "review");
  button.textContent = "Review";
  button.getBoundingClientRect = () => new DOMRect(40, 80, 120, 30);
  button.getClientRects = () => [new DOMRect(40, 80, 120, 30)] as unknown as DOMRectList;
  (button as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true;
  page.append(button);
  document.body.append(page);
  const payload = btoa(JSON.stringify({ sub: person.toLowerCase(), name: person, email: `${person.toLowerCase()}@example.com` }));
  localStorage.setItem(`critiqs:session:${SIGN_IN}`, JSON.stringify({ accessToken: `header.${payload}.signature`, refreshToken: "fixture", expiresAt: Date.now() + 900_000 }));
  localStorage.setItem("critiqs:sidebar-open", JSON.stringify(sidebarOpen));
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
  if (sidebarOpen) await click(shadow.querySelector('[aria-label="Comment mode"]'));
  return shadow;
}

async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
}

const button = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text || candidate.getAttribute("aria-label") === text) ?? null;

async function click(element: Element | null | undefined) {
  if (element == null) throw new Error("Nothing to click");
  await act(async () => (element as HTMLElement).click());
  await settle();
}

async function type(field: HTMLInputElement | HTMLTextAreaElement | null, text: string) {
  if (field === null) throw new Error("No field");
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Opens the thread from its pin, then the window's ⋯ menu. */
async function openThreadMenu(shadow: ShadowRoot) {
  await click(shadow.querySelector(".pin"));
  await click(shadow.querySelector('section[aria-label="Comment thread"] button[aria-label="More actions"]'));
}

const menuItems = (shadow: ShadowRoot) => [...shadow.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim());
const dialog = (shadow: ShadowRoot, label: string) => shadow.querySelector<HTMLElement>(`[role="dialog"][aria-label="${label}"]`);

test("the thread window's menu offers Create ticket… and Link ticket… only where the backend offers tickets", async () => {
  let shadow = await mount(backend());
  await openThreadMenu(shadow);
  expect(menuItems(shadow)).toEqual(["Copy link", "Mark unread", "Create ticket…", "Link ticket…", "Delete thread…"]);
  await act(async () => root?.unmount());
  host?.remove();
  page?.remove();
  shadow = await mount(backend(), null);
  await openThreadMenu(shadow);
  expect(menuItems(shadow)).not.toContain("Create ticket…");
});

test("a backend that offers only Your trackers gets no Create ticket… or Link ticket…, but linked tickets still show", async () => {
  const shadow = await mount(backend({ threads: [summary([badge])], thread: detail([fakeTicketView()]) }), { trackers: [{ id: "linear", signIn: "token" }] });
  await openThreadMenu(shadow);
  expect(menuItems(shadow)).toEqual(["Copy link", "Mark unread", "Delete thread…"]);
  expect([...shadow.querySelectorAll('[aria-label="Linked tickets"] .key')].map((key) => key.textContent)).toEqual(["ENG-1"]);
  expect(shadow.querySelector(".pin .pin-ticket")).not.toBeNull();
});

test("with no tracker connected, Create ticket… opens Your trackers", async () => {
  const shadow = await mount(backend({ trackers: { accounts: [] } }));
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  expect(dialog(shadow, "Create ticket")).toBeNull();
  expect(dialog(shadow, "Your trackers")).not.toBeNull();
});

test("Create ticket fills the title and text from the thread, remembers the team, and sends what the person edited", async () => {
  const data = backend();
  const shadow = await mount(data);
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  let create = dialog(shadow, "Create ticket")!;
  expect(create.querySelector<HTMLInputElement>("input.field")!.value).toBe("Department is wrong");
  expect(create.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("> Department is wrong\n");
  // The draft's default, from Your trackers, is on; one connected tracker needs no tracker row.
  expect(create.querySelector<HTMLInputElement>('.ticket-check input[type="checkbox"]')!.checked).toBe(true);
  expect(create.textContent).not.toContain("Tracker");
  // Teams load by name; Design is first.
  expect(create.querySelector(".ds-select")!.textContent).toContain("Design");
  await click(create.querySelector(".ds-select"));
  await click([...shadow.querySelectorAll('[role^="menuitem"]')].find((item) => item.textContent?.includes("Engineering")));
  await type(create.querySelector<HTMLInputElement>("input.field"), "Department label is wrong");
  await type(create.querySelector("textarea"), "Edited text");
  await click(create.querySelector('.ticket-check input[type="checkbox"]'));
  await click(button(create, "Create"));
  expect(data.calls!.filter((call) => call.name === "createTicket").map((call) => call.args)).toEqual([
    { threadId: "thread", submissionId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), tracker: "linear", destinationId: "team-eng", title: "Department label is wrong", body: "Edited text", createdFromCritiqs: false },
  ]);
  expect(dialog(shadow, "Create ticket")).toBeNull();
  expect(shadow.textContent).toContain("Created ENG-1");

  // The team is remembered for this project.
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  create = dialog(shadow, "Create ticket")!;
  expect(create.querySelector(".ds-select")!.textContent).toContain("Engineering");
});

test("the team is remembered per person: someone else signed in to the same browser doesn't get it", async () => {
  const unmount = async () => {
    await act(async () => root?.unmount());
    host?.remove();
    page?.remove();
  };
  const chosenTeam = async (shadow: ShadowRoot) => {
    await openThreadMenu(shadow);
    await click(button(shadow, "Create ticket…"));
    return dialog(shadow, "Create ticket")!.querySelector(".ds-select")!.textContent;
  };
  let shadow = await mount(backend());
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  const create = dialog(shadow, "Create ticket")!;
  await click(create.querySelector(".ds-select"));
  await click([...shadow.querySelectorAll('[role^="menuitem"]')].find((item) => item.textContent?.includes("Engineering")));
  await click(button(create, "Create"));
  await unmount();
  // Lee signs in to the same browser: the first team, not Dana's.
  shadow = await mount(backend(), OFFERED, { person: "Lee" });
  expect(await chosenTeam(shadow)).toContain("Design");
  await unmount();
  shadow = await mount(backend());
  expect(await chosenTeam(shadow)).toContain("Engineering");
});

test("a refused creation says why in the dialog and keeps the person's text", async () => {
  const data = backend({
    trackers: {
      accounts: [LINEAR],
      create: async () => {
        throw new ConvexError({ code: "limit", message: "A thread can link to at most 20 tickets. Unlink one first." });
      },
    },
  });
  const shadow = await mount(data);
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  const create = dialog(shadow, "Create ticket")!;
  await type(create.querySelector("textarea"), "Keep this");
  await click(button(create, "Create"));
  expect(create.querySelector('[role="alert"]')?.textContent).toBe("A thread can link to at most 20 tickets. Unlink one first.");
  expect(create.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Keep this");
});

test("each Create dialog is one submission: its retries send the same submission ID, and a new dialog a new one", async () => {
  let tries = 0;
  const data = backend({
    trackers: {
      accounts: [LINEAR],
      create: async (input) => {
        // The first try's answer is lost.
        if (++tries === 1) throw new ConvexError({ code: "unavailable", message: "Linear's answer wasn't what Critiqs expected (status 504). Try again in a moment." });
        return fakeTicketView({ threadId: input.threadId });
      },
    },
  });
  const shadow = await mount(data);
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  const create = dialog(shadow, "Create ticket")!;
  await click(button(create, "Create"));
  expect(create.querySelector('[role="alert"]')?.textContent).toContain("Try again in a moment.");
  await click(button(create, "Create"));
  expect(dialog(shadow, "Create ticket")).toBeNull();
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  await click(button(dialog(shadow, "Create ticket")!, "Create"));
  const sent = data.calls!.filter((call) => call.name === "createTicket").map((call) => (call.args as { submissionId: string }).submissionId);
  expect(sent).toHaveLength(3);
  expect(sent[1]).toBe(sent[0]!);
  expect(sent[2]).not.toBe(sent[0]!);
});

test("a Create dialog finishes the ticket the person started earlier, under its submission ID, and says so", async () => {
  const started = "6f1c2b9a-3d4e-4f50-8a1b-000000000001";
  const data = backend({
    trackers: { accounts: [LINEAR], draft: async () => ({ title: "Department is wrong", body: "> Department is wrong\n", createdFromCritiqs: true, resumeSubmissionId: started }) },
  });
  const shadow = await mount(data);
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  const create = dialog(shadow, "Create ticket")!;
  expect(create.querySelector(".note")?.textContent).toBe("Finishing the ticket you started earlier. If Linear already created it, Critiqs links it instead of creating another.");
  await click(button(create, "Create"));
  expect(data.calls!.filter((call) => call.name === "createTicket").map((call) => (call.args as { submissionId: string }).submissionId)).toEqual([started]);
  // With nothing unfinished, there is no note.
  data.trackers!.draft = undefined;
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  expect(dialog(shadow, "Create ticket")!.querySelector(".note")).toBeNull();
});

test("a ticket created without its link back says so, and Add link back, in the notice and on the chip, adds it", async () => {
  const data = backend({
    trackers: { accounts: [LINEAR], create: async (input) => fakeTicketView({ _id: "created", threadId: input.threadId, canAddLinkBack: true }) },
  });
  const shadow = await mount(data);
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  await click(button(dialog(shadow, "Create ticket")!, "Create"));
  const toast = shadow.querySelector(".toast")!;
  expect(toast.textContent).toContain("Created ENG-1, but Linear didn't add the link back to this thread.");
  await click(button(toast, "Add link back"));
  expect(data.calls!.filter((call) => call.name === "addTicketLinkBack").map((call) => call.args)).toEqual([{ linkId: "created" }]);
  expect(shadow.textContent).toContain("Added the link back to ENG-1");
});

test("a chip offers Add link back only on a ticket the person created without it", async () => {
  const data = backend({
    thread: detail([fakeTicketView({ _id: "missing", key: "ENG-1", canAddLinkBack: true }), fakeTicketView({ _id: "fine", key: "ENG-2", url: "https://linear.app/acme/issue/eng-2" })]),
  });
  const shadow = await mount(data);
  await click(shadow.querySelector(".pin"));
  const chips = [...shadow.querySelectorAll('[aria-label="Linked tickets"] .ticket-chip')];
  expect(button(chips[1]!, "Add link back")).toBeNull();
  const add = button(chips[0]!, "Add link back")!;
  expect(add.getAttribute("title")).toBe("Linear didn't add the link back to this thread");
  await click(add);
  expect(data.calls!.filter((call) => call.name === "addTicketLinkBack").map((call) => call.args)).toEqual([{ linkId: "missing" }]);
});

test("Link ticket searches the tracker, shows key, title and status, and links the chosen ticket with an optional comment", async () => {
  const data = backend({
    trackers: {
      accounts: [LINEAR],
      search: async (_tracker, query) =>
        query === "label"
          ? [
              { tracker: "linear", externalId: "i9", key: "ENG-9", url: "https://linear.app/acme/issue/eng-9", title: "Department label is unclear", status: { label: "Todo", category: "open" } },
              // The thread links this issue already, from before it moved to another team and took a new key.
              { tracker: "linear", externalId: "i1", key: "DES-4", url: "https://linear.app/acme/issue/des-4", title: "Already here", status: { label: "Done", category: "done" } },
            ]
          : [],
    },
    thread: detail([fakeTicketView({ externalId: "i1", key: "ENG-1" })]),
  });
  const shadow = await mount(data);
  await openThreadMenu(shadow);
  await click(button(shadow, "Link ticket…"));
  const linkDialog = dialog(shadow, "Link ticket")!;
  expect(button(linkDialog, "Link")!.disabled).toBe(true);
  await type(linkDialog.querySelector<HTMLInputElement>('input[type="search"]'), "label");
  await settle(20);
  const results = [...linkDialog.querySelectorAll(".ticket-result")];
  expect(results.map((result) => result.textContent)).toEqual(["ENG-9Department label is unclearTodo", "DES-4Already hereLinked"]);
  // A ticket the thread links to already can't be chosen again.
  expect(results[1]!.querySelector("input")!.disabled).toBe(true);
  await click(results[0]!.querySelector("input"));
  await click(linkDialog.querySelector('.ticket-check input[type="checkbox"]'));
  await click(button(linkDialog, "Link"));
  expect(data.calls!.filter((call) => call.name === "linkTicket").map((call) => call.args)).toEqual([{ threadId: "thread", tracker: "linear", externalId: "i9", comment: true }]);
  expect(shadow.textContent).toContain("Linked ENG-1");
});

test("Link ticket shows only the latest search's results: a slower answer to an earlier or cleared search is ignored", async () => {
  const answers: Record<string, () => void> = {};
  const found = (key: string) => ({ tracker: "linear" as const, externalId: key, key, url: `https://linear.app/acme/issue/${key}`, title: `Found by ${key}`, status: { label: "Todo", category: "open" as const } });
  const data = backend({
    trackers: {
      accounts: [LINEAR],
      // Each answer waits until the test releases it.
      search: (_tracker, query) => new Promise((resolve) => (answers[query] = () => resolve([found(query)]))),
    },
  });
  const shadow = await mount(data);
  await openThreadMenu(shadow);
  await click(button(shadow, "Link ticket…"));
  const linkDialog = dialog(shadow, "Link ticket")!;
  const search = linkDialog.querySelector<HTMLInputElement>('input[type="search"]');
  const keys = () => [...linkDialog.querySelectorAll(".ticket-result .key")].map((key) => key.textContent);
  // A search sent, then the query cleared before its answer arrives.
  await type(search, "OLD-1");
  await settle(20);
  expect(answers["OLD-1"]).toBeDefined();
  await type(search, "");
  await settle();
  await act(async () => answers["OLD-1"]!());
  await settle();
  expect(keys()).toEqual([]);
  expect(linkDialog.textContent).not.toContain("Searching…");
  // Two searches, the earlier one answered last.
  await type(search, "A-1");
  await settle(20);
  await type(search, "B-2");
  await settle(20);
  await act(async () => answers["B-2"]!());
  await settle();
  await act(async () => answers["A-1"]!());
  await settle();
  expect(keys()).toEqual(["B-2"]);
  // Changing the query takes the last results away at once, before the next search is sent.
  await type(search, "B-23");
  expect(keys()).toEqual([]);
  expect(linkDialog.textContent).toContain("Searching…");
});

test("linked tickets show as chips under the header that open the ticket, with Unlink only for who may", async () => {
  const data = backend({
    thread: detail([
      fakeTicketView({ _id: "mine", key: "ENG-1", status: { label: "In Progress", category: "started" } }),
      fakeTicketView({ _id: "theirs", key: "ENG-2", url: "https://linear.app/acme/issue/eng-2", status: null, canUnlink: false, linkedByName: "Lee" }),
    ]),
  });
  const shadow = await mount(data);
  await click(shadow.querySelector(".pin"));
  const chips = [...shadow.querySelectorAll('[aria-label="Linked tickets"] .ticket-chip')];
  expect(chips.map((chip) => chip.querySelector("a")!.textContent)).toEqual(["ENG-1In Progress", "ENG-2"]);
  const link = chips[0]!.querySelector("a")!;
  expect([link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel")]).toEqual(["https://linear.app/acme/issue/eng-1", "_blank", "noreferrer noopener"]);
  expect(button(chips[1]!, "Unlink ENG-2")).toBeNull();
  await click(button(chips[0]!, "Unlink ENG-1"));
  expect(data.calls!.filter((call) => call.name === "unlinkTicket").map((call) => call.args)).toEqual([{ linkId: "mine" }]);
  expect(shadow.textContent).toContain("Unlinked ENG-1");
});

test("the thread list row shows each linked ticket's key and status, and the pin a ticket mark named with them", async () => {
  const shadow = await mount(backend({ threads: [summary([badge])] }), OFFERED, { sidebarOpen: true });
  const entry = shadow.querySelector(".entry")!;
  expect(entry.querySelector(".ticket-badge")?.textContent).toBe("ENG-1 · In Progress");
  const pin = shadow.querySelector(".pin")!;
  expect(pin.querySelector(".pin-ticket")).not.toBeNull();
  expect(pin.getAttribute("aria-label")).toBe("Open comment by Dana, ticket Linear ENG-1 · In Progress");
  expect(pin.getAttribute("title")).toContain("ENG-1 · In Progress");
});

test("a thread without tickets shows no chips, badge, or pin mark", async () => {
  const shadow = await mount(backend(), OFFERED, { sidebarOpen: true });
  expect(shadow.querySelector(".ticket-badge")).toBeNull();
  expect(shadow.querySelector(".pin-ticket")).toBeNull();
  expect(shadow.querySelector(".pin")!.getAttribute("aria-label")).toBe("Open comment by Dana");
});

test("a linked ticket's address that isn't a web address is never a link", async () => {
  const views = [fakeTicketView({ _id: "a", url: "javascript:alert(1)" }), fakeTicketView({ _id: "b", key: "ENG-2", url: "https://linear.app/acme/issue/eng-2" })];
  const shadow = await mount(backend({ threads: [summary([badge])], thread: detail(views) }));
  await click(shadow.querySelector(".pin"));
  const links = [...shadow.querySelectorAll('[aria-label="Linked tickets"] a')].map((anchor) => anchor.getAttribute("href"));
  expect(links).toEqual(["https://linear.app/acme/issue/eng-2"]);
  expect(shadow.querySelector('[aria-label="Linked tickets"]')!.textContent).toContain("ENG-1");
});
