import { afterEach, expect, test } from "bun:test";
import type { AiChoiceView, Anchor, TicketBadge, TicketDraftOptions, TicketsConfig, ThreadDetail, ThreadSummary, TrackerAccountView, TrackerId, TrackerTemplateGroup } from "@critiqs/core";
import { ConvexError } from "convex/values";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import type { Deployment } from "../src/deployment.ts";
import { Session } from "../src/session.ts";
import { TransportContext } from "../src/transport.ts";
import { commentField, typeInto } from "./comment-field.ts";
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
async function mount(data: FakeBackend, tickets: Deployment["tickets"] = OFFERED, { sidebarOpen = false, person = "Dana", modelLists = false } = {}) {
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
  const deployment: Deployment = { backendUrl: "https://backend.convex.cloud", siteUrl: "https://backend.convex.site", signInUrl: SIGN_IN, transport: "convex", signIn: null, personalAi: true, tickets, ...(modelLists ? { modelLists: true } : {}) };
  await act(async () =>
    root!.render(
      <TransportContext.Provider value={fakeTransport(data)}>
        <App props={{ projectId: "project", getContext: () => ({ screen: "pilot" }) }} deployment={deployment} session={session} host={host!} shadow={host!.shadowRoot!} />
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

test("Has ticket in the filter menu shows only threads with a ticket, says so, and resets", async () => {
  const plain = { ...summary(), _id: "plain", preview: { body: "No ticket here", authorName: "Lee", authorImageUrl: null } };
  const shadow = await mount(backend({ threads: [summary([badge]), plain] }), OFFERED, { sidebarOpen: true });
  expect(shadow.querySelectorAll(".entry")).toHaveLength(2);
  await click(shadow.querySelector('button[aria-label="Filter"]'));
  await click([...shadow.querySelectorAll('[role^="menuitem"]')].find((item) => item.textContent === "Has ticket"));
  const entries = [...shadow.querySelectorAll(".entry")];
  expect(entries.map((entry) => entry.querySelector(".excerpt")?.textContent)).toEqual(["Align the review button"]);
  expect(entries[0]!.querySelector(".ticket-badge")?.textContent).toBe("ENG-1 · In Progress");
  expect(shadow.querySelector(".filter-summary")!.textContent).toContain("has ticket");
  expect(shadow.querySelector(".filter-summary")!.textContent).toContain("1 hidden by filters");
  await click(button(shadow.querySelector(".filter-summary")!, "Reset"));
  expect(shadow.querySelectorAll(".entry")).toHaveLength(2);
});

test("with no thread linked to a ticket, Has ticket says so and offers to clear it; a backend without tickets has no Has ticket", async () => {
  let shadow = await mount(backend(), OFFERED, { sidebarOpen: true });
  await click(shadow.querySelector('button[aria-label="Filter"]'));
  await click([...shadow.querySelectorAll('[role^="menuitem"]')].find((item) => item.textContent === "Has ticket"));
  expect(shadow.querySelector(".empty")!.textContent).toContain("No threads with tickets");
  await click(button(shadow.querySelector(".empty")!, "Clear filters"));
  expect(shadow.querySelectorAll(".entry")).toHaveLength(1);
  await act(async () => root?.unmount());
  host?.remove();
  page?.remove();
  shadow = await mount(backend({ trackers: undefined }), OFFERED, { sidebarOpen: true });
  await click(shadow.querySelector('button[aria-label="Filter"]'));
  expect([...shadow.querySelectorAll('[role^="menuitem"]')].map((item) => item.textContent)).not.toContain("Has ticket");
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

// ---------------------------------------------------------------------------
// Drafting: templates, Critiqs AI, and labels from tags

const DRAFTING: TicketsConfig = { ...OFFERED, drafting: true };
const COPY = { id: "tpl-copy", name: "Copy change" };
/** Design offers its Copy change template and suggests its Bug label; Engineering offers nothing. */
const designOptions = async (destinationId: string): Promise<TicketDraftOptions> =>
  destinationId === "team-des" ? { templates: [COPY], labels: [{ id: "label-bug", name: "Bug" }] } : { templates: [], labels: [] };
const opus: AiChoiceView = { source: "project", models: [{ id: "opus", label: "Opus", credits: 6, estimated: true }], defaultModel: "opus" };
const calls = (data: FakeBackend, name: string) => data.calls!.filter((call) => call.name === name).map((call) => call.args);

async function chooseOption(shadow: ShadowRoot, select: Element | null | undefined, text: string) {
  await click(select);
  await click([...shadow.querySelectorAll('[role^="menuitem"]')].find((item) => item.textContent?.includes(text)));
}

const rowSelect = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll(".ds-row")].find((row) => row.querySelector(".ds-row-label")?.textContent === label)?.querySelector(".ds-select") ?? null;

test("with drafting, choosing the team's template fills the draft from it, and Draft with Critiqs AI, its cost shown first, fills it from the thread and template", async () => {
  const data = backend({ trackers: { accounts: [LINEAR], options: designOptions }, aiChoice: opus });
  const shadow = await mount(data, DRAFTING, { modelLists: true });
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  const create = dialog(shadow, "Create ticket")!;
  // Design is first: its template and its label matching the thread's Bug tag.
  expect(rowSelect(create, "Template")!.textContent).toContain("Critiqs's standard format");
  expect([...create.querySelectorAll(".ticket-label")].map((label) => label.textContent)).toEqual(["Bug"]);
  expect(create.querySelector(".ticket-ai")!.textContent).toBe("Draft with Critiqs AIAbout 6 credits");

  await chooseOption(shadow, rowSelect(create, "Template"), "Copy change");
  expect(calls(data, "ticketDraft").at(-1)).toEqual({ threadId: "thread", tracker: "linear", destinationId: "team-des", templateId: "tpl-copy" });
  expect(create.querySelector("textarea")!.value).toBe("## Summary\n\n> Department is wrong\n\n## Steps (tpl-copy)\n");
  expect(calls(data, "draftTicketWithAi")).toEqual([]);

  await click(button(create, "Draft with Critiqs AI"));
  expect(calls(data, "draftTicketWithAi")).toEqual([{ threadId: "thread", tracker: "linear", destinationId: "team-des", templateId: "tpl-copy", model: "opus" }]);
  expect(create.querySelector<HTMLInputElement>("input.field")!.value).toBe("Department shows the wrong team");
  expect(create.querySelector("textarea")!.value).toBe("Drafted by AI\n");
  expect(create.querySelector('[role="status"]')?.textContent).toBe("Drafted by Critiqs AI from the thread. Check it before creating.");

  await click(button(create, "Create"));
  expect(calls(data, "createTicket")).toEqual([expect.objectContaining({ destinationId: "team-des", title: "Department shows the wrong team", templateId: "tpl-copy", labelIds: ["label-bug"] })]);
});

test("Draft with Critiqs AI waits for the model and its cost to load; creating doesn't", async () => {
  const data = backend({ trackers: { accounts: [LINEAR], options: designOptions } });
  const shadow = await mount(data, DRAFTING, { modelLists: true });
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  const create = dialog(shadow, "Create ticket")!;
  // The models are still loading: no cost to show, so no draft can start.
  expect(create.querySelector(".ticket-ai")!.textContent).toBe("Draft with Critiqs AI");
  expect(button(create, "Draft with Critiqs AI")!.hasAttribute("disabled")).toBe(true);
  await click(button(create, "Draft with Critiqs AI"));
  expect(calls(data, "draftTicketWithAi")).toEqual([]);
  expect(button(create, "Create")!.hasAttribute("disabled")).toBe(false);

  // Loaded: the cost shows, and the draft asks for the model shown.
  data.aiChoice = opus;
  await type(create.querySelector("textarea"), "Edited");
  expect(create.querySelector(".ticket-ai")!.textContent).toBe("Draft with Critiqs AIAbout 6 credits");
  await click(button(create, "Draft with Critiqs AI"));
  expect(calls(data, "draftTicketWithAi")).toEqual([{ threadId: "thread", tracker: "linear", destinationId: "team-des", templateId: null, model: "opus" }]);
});

test("when the AI's models can't load, Draft with Critiqs AI stays off and says so; creating still works", async () => {
  const data = backend({ trackers: { accounts: [LINEAR], options: designOptions }, aiChoiceError: "Critiqs couldn't reach the server." });
  const shadow = await mount(data, DRAFTING, { modelLists: true });
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  const create = dialog(shadow, "Create ticket")!;
  expect(button(create, "Draft with Critiqs AI")!.hasAttribute("disabled")).toBe(true);
  expect(create.querySelector(".ticket-ai")!.textContent).toBe("Draft with Critiqs AICouldn't load the AI's models.");
  expect(button(create, "Create")!.hasAttribute("disabled")).toBe(false);
});

test("a template whose draft can't load isn't chosen: the template and draft before it stay, and the dialog says why", async () => {
  const data = backend({
    trackers: {
      accounts: [LINEAR],
      options: designOptions,
      draft: async (_threadId, _tracker, format) => {
        if (format?.templateId === "tpl-copy") throw new ConvexError({ code: "not-found", message: "Linear no longer has this template. Choose another, or Critiqs's standard format." });
        return { title: "Department is wrong", body: "> Department is wrong\n", createdFromCritiqs: true, resumeSubmissionId: null };
      },
    },
  });
  const shadow = await mount(data, DRAFTING);
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  const create = dialog(shadow, "Create ticket")!;
  await chooseOption(shadow, rowSelect(create, "Template"), "Copy change");
  expect(calls(data, "ticketDraft").at(-1)).toEqual({ threadId: "thread", tracker: "linear", destinationId: "team-des", templateId: "tpl-copy" });
  expect(create.querySelector('[role="alert"]')?.textContent).toBe("Linear no longer has this template. Choose another, or Critiqs's standard format.");
  expect(rowSelect(create, "Template")!.textContent).toContain("Critiqs's standard format");
  expect(create.querySelector("textarea")!.value).toBe("> Department is wrong\n");
  await click(button(create, "Create"));
  const [sent] = calls(data, "createTicket") as Record<string, unknown>[];
  expect(sent).not.toHaveProperty("templateId");
});

test("a removed label isn't sent, and another team drops the chosen template for the standard format", async () => {
  const data = backend({ trackers: { accounts: [LINEAR], options: designOptions } });
  const shadow = await mount(data, DRAFTING);
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  const create = dialog(shadow, "Create ticket")!;
  // Without the model list, there's no cost to show, and the draft is still offered.
  expect(create.querySelector(".ticket-ai")!.textContent).toBe("Draft with Critiqs AI");
  await chooseOption(shadow, rowSelect(create, "Template"), "Copy change");
  await click(button(create, "Remove label Bug"));
  expect(create.querySelector(".ticket-labels")).toBeNull();

  await chooseOption(shadow, rowSelect(create, "Team"), "Engineering");
  expect(rowSelect(create, "Template")).toBeNull();
  expect(calls(data, "ticketDraft").at(-1)).toEqual({ threadId: "thread", tracker: "linear" });
  expect(create.querySelector("textarea")!.value).toBe("> Department is wrong\n");
  await click(button(create, "Create"));
  const [sent] = calls(data, "createTicket") as Record<string, unknown>[];
  expect(sent).toMatchObject({ destinationId: "team-eng" });
  expect(sent).not.toHaveProperty("templateId");
  expect(sent).not.toHaveProperty("labelIds");
});

test("another team's draft replaces the one before it: while it loads, or if it can't, Create waits, and Try again loads it", async () => {
  const pending: ((reason: unknown) => void)[] = [];
  let failing = true;
  const data = backend({
    trackers: {
      accounts: [LINEAR],
      options: designOptions,
      draft: async (_threadId, _tracker, format) => {
        // The third draft, the standard format's after the template's, waits, then fails.
        if (calls(data, "ticketDraft").length === 3) return new Promise((_, reject) => pending.push(reject));
        // The fourth, the new team's, fails until Try again.
        if (calls(data, "ticketDraft").length === 4 && failing) throw new ConvexError({ code: "unavailable", message: "Critiqs couldn't reach Linear. Try again in a moment." });
        return { title: "Department is wrong", body: format === undefined ? "> Department is wrong\n" : "## Copy change\n", createdFromCritiqs: true, resumeSubmissionId: null };
      },
    },
  });
  const shadow = await mount(data, DRAFTING);
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  const create = dialog(shadow, "Create ticket")!;
  await chooseOption(shadow, rowSelect(create, "Template"), "Copy change");
  expect(create.querySelector("textarea")!.value).toBe("## Copy change\n");
  await chooseOption(shadow, rowSelect(create, "Template"), "Critiqs's standard format");
  expect(pending).toHaveLength(1);
  await chooseOption(shadow, rowSelect(create, "Team"), "Engineering");
  await act(async () => pending[0]!(new Error("Too slow")));
  // The Design team's template text stays for the person to see, but can't be sent to Engineering.
  expect(calls(data, "ticketDraft").at(-1)).toEqual({ threadId: "thread", tracker: "linear" });
  expect(create.querySelector('[role="alert"]')?.textContent).toBe("Critiqs couldn't reach Linear. Try again in a moment.");
  expect(create.querySelector("textarea")!.value).toBe("## Copy change\n");
  expect(button(create, "Create")!.hasAttribute("disabled")).toBe(true);
  expect(create.textContent).toContain("Create waits until the draft for this team loads.");

  failing = false;
  await click(button(create, "Try again"));
  expect(create.querySelector("textarea")!.value).toBe("> Department is wrong\n");
  expect(button(create, "Try again")).toBeNull();
  await click(button(create, "Create"));
  const [sent] = calls(data, "createTicket") as Record<string, unknown>[];
  expect(sent).toMatchObject({ destinationId: "team-eng", body: "> Department is wrong\n" });
  expect(sent).not.toHaveProperty("templateId");
});

test("when Critiqs AI can't draft, the dialog fills the draft without AI and says why; a failed request keeps the person's text", async () => {
  const notice = "AI is turned off for this project. The draft is filled from the thread without AI.";
  let fail = false;
  const data = backend({
    trackers: {
      accounts: [LINEAR],
      aiDraft: async () => {
        if (fail) throw new ConvexError({ code: "unavailable", message: "Critiqs couldn't reach Linear. Try again in a moment." });
        return { title: "Department is wrong", body: "> Department is wrong\n", drafted: "plain", notice };
      },
    },
  });
  const shadow = await mount(data, DRAFTING);
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  const create = dialog(shadow, "Create ticket")!;
  await type(create.querySelector("textarea"), "Edited");
  await click(button(create, "Draft with Critiqs AI"));
  expect(create.querySelector('[role="status"]')?.textContent).toBe(notice);
  expect(create.querySelector("textarea")!.value).toBe("> Department is wrong\n");
  // Creating doesn't depend on AI.
  expect(button(create, "Create")!.hasAttribute("disabled")).toBe(false);

  fail = true;
  await type(create.querySelector("textarea"), "Keep this");
  await click(button(create, "Draft with Critiqs AI"));
  expect(create.querySelector('[role="alert"]')?.textContent).toBe("Critiqs couldn't reach Linear. Try again in a moment.");
  expect(create.querySelector("textarea")!.value).toBe("Keep this");
});

test("when the project needs the person's own AI, the draft's notice offers Set up your AI, which opens Your AI", async () => {
  const notice = "This project uses each reviewer's own AI. Set up Your AI to draft with it. The draft is filled from the thread without AI.";
  const data = backend({
    trackers: { accounts: [LINEAR], aiDraft: async () => ({ title: "Department is wrong", body: "> Department is wrong\n", drafted: "plain", notice, noticeCode: "setup-ai" }) },
  });
  const shadow = await mount(data, DRAFTING);
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  const create = dialog(shadow, "Create ticket")!;
  await click(button(create, "Draft with Critiqs AI"));
  expect(create.querySelector('[role="status"]')?.textContent).toBe(notice);
  await click(button(create, "Set up your AI"));
  expect(dialog(shadow, "Create ticket")).toBeNull();
  expect(dialog(shadow, "Your AI")).not.toBeNull();
});

test("a backend without drafting offers no template, Critiqs AI, or labels, and isn't asked for them", async () => {
  const data = backend({ trackers: { accounts: [LINEAR], options: designOptions }, aiChoice: opus });
  const shadow = await mount(data, OFFERED, { modelLists: true });
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  const create = dialog(shadow, "Create ticket")!;
  expect(button(create, "Draft with Critiqs AI")).toBeNull();
  expect(rowSelect(create, "Template")).toBeNull();
  expect(create.querySelector(".ticket-labels")).toBeNull();
  expect(calls(data, "ticketDraftOptions")).toEqual([]);
});

// ---------------------------------------------------------------------------
// The project's ticket templates, for its owners

async function openTicketsTab(shadow: ShadowRoot) {
  await click(shadow.querySelector('[aria-label="Tags and AI settings"]'));
  const settings = dialog(shadow, "Tags and AI")!;
  await click(button(settings, "Tickets"));
  return settings;
}

const switchFor = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll(".ds-row")].find((row) => row.querySelector(".ds-row-label")?.textContent === label)?.querySelector<HTMLButtonElement>('[role="switch"]') ?? null;

test("an owner turns on the team's ticket templates in Tags and AI and chooses which to offer; turned off, the choice is kept", async () => {
  const data = backend();
  const shadow = await mount(data, DRAFTING, { sidebarOpen: true });
  const settings = await openTicketsTab(shadow);
  const use = () => switchFor(settings, "Use the team's ticket templates")!;
  expect(use().getAttribute("aria-checked")).toBe("false");
  expect(settings.querySelector(".ds-group-label")).toBeNull();
  expect(calls(data, "listTrackerTemplates")).toEqual([]);

  await click(use());
  expect(calls(data, "saveTicketTemplateSettings")).toEqual([{ projectId: "project", on: true, templates: [] }]);
  expect(shadow.textContent).toContain("Ticket templates turned on");
  // The owner's own Linear teams' templates, by team.
  expect([...settings.querySelectorAll(".ds-group-label")].map((label) => label.textContent)).toEqual(["Design", "Engineering"]);
  expect(switchFor(settings, "Bug report")!.getAttribute("aria-checked")).toBe("false");

  await click(switchFor(settings, "Bug report"));
  const bug = { tracker: "linear", destinationId: "team-eng", templateId: "tpl-bug", name: "Bug report" };
  expect(calls(data, "saveTicketTemplateSettings").at(-1)).toEqual({ projectId: "project", on: true, templates: [bug] });
  expect(switchFor(settings, "Bug report")!.getAttribute("aria-checked")).toBe("true");
  expect(shadow.textContent).toContain("Offering Bug report");

  await click(use());
  expect(calls(data, "saveTicketTemplateSettings").at(-1)).toEqual({ projectId: "project", on: false, templates: [bug] });
  expect(settings.querySelector(".ds-group-label")).toBeNull();
});

test("the Tickets tab asks an owner without Linear to connect it, and a backend without drafting has no Tickets tab", async () => {
  let shadow = await mount(backend({ trackers: { accounts: [], templateSettings: { on: true, templates: [] } } }), DRAFTING, { sidebarOpen: true });
  const settings = await openTicketsTab(shadow);
  expect(settings.textContent).toContain("Connect Linear, GitHub Issues, or Jira in Your trackers to choose your teams' templates.");
  await act(async () => root?.unmount());
  host?.remove();
  page?.remove();
  shadow = await mount(backend(), OFFERED, { sidebarOpen: true });
  await click(shadow.querySelector('[aria-label="Tags and AI settings"]'));
  expect(button(dialog(shadow, "Tags and AI")!, "Tickets")).toBeNull();
});

const WITH_STATUS: TicketsConfig = { ...OFFERED, ticketStatus: true };

test("a ticket whose status Critiqs can't check shows its last known status, and says why on hover", async () => {
  const checkedAt = Date.parse("2026-11-25T09:30:00.000Z");
  const shadow = await mount(
    backend({
      thread: detail([
        fakeTicketView({ _id: "stale", key: "ENG-1", status: { label: "In Progress", category: "started" }, statusStale: true, statusCheckedAt: checkedAt, linkedByName: "Lee" }),
        fakeTicketView({ _id: "fresh", key: "ENG-2", status: { label: "Done", category: "done" }, statusStale: false }),
      ]),
    }),
    WITH_STATUS,
  );
  await click(shadow.querySelector(".pin"));
  const [stale, fresh] = [...shadow.querySelectorAll('[aria-label="Linked tickets"] .ticket-chip a')];
  expect(stale!.textContent).toBe("ENG-1In Progress· last known");
  expect(stale!.getAttribute("title")).toMatch(/\. Last known status from .+: Critiqs can't check it with Lee's Linear account\.$/);
  expect(fresh!.textContent).toBe("ENG-2Done");
  expect(fresh!.getAttribute("title")).not.toContain("Last known");
});

test("opening a thread with tickets asks the backend to check their status once, only where it reports ticketStatus", async () => {
  const withTicket = () => backend({ thread: detail([fakeTicketView({ key: "ENG-1" })]) });
  let data = withTicket();
  let shadow = await mount(data, WITH_STATUS);
  await click(shadow.querySelector(".pin"));
  await settle();
  expect(data.calls!.filter((call) => call.name === "checkTicketStatus").map((call) => call.args)).toEqual([{ threadId: "thread" }]);
  await act(async () => root?.unmount());
  root = null;

  // A backend from before status updates.
  data = withTicket();
  shadow = await mount(data, OFFERED);
  await click(shadow.querySelector(".pin"));
  expect(data.calls!.some((call) => call.name === "checkTicketStatus")).toBe(false);
  await act(async () => root?.unmount());
  root = null;

  // A thread without tickets has nothing to check.
  data = backend();
  shadow = await mount(data, WITH_STATUS);
  await click(shadow.querySelector(".pin"));
  expect(data.calls!.some((call) => call.name === "checkTicketStatus")).toBe(false);
});

test("a thread resolved because its tickets were done says so instead of naming a person", async () => {
  const resolved = { ...detail([fakeTicketView({ key: "ENG-1", status: { label: "Done", category: "done" } })]), status: "resolved" as const, resolvedByTickets: true as const, statusChangedAt: Date.parse("2026-11-25T10:00:00.000Z") };
  // The list still shows it open; the window opens what the backend answers.
  const shadow = await mount(backend({ threads: [summary([badge])], thread: resolved }), WITH_STATUS);
  await click(shadow.querySelector(".pin"));
  expect(shadow.querySelector(".status-banner")?.textContent).toMatch(/^Resolved when its tickets were done, .+\. Resolved threads stay as an archive\.$/);
});

test("the project owner turns Resolve when done on and off in the Tickets tab of Tags and AI, only where the backend has it", async () => {
  const data = backend();
  let shadow = await mount(data, WITH_STATUS, { sidebarOpen: true });
  await click(shadow.querySelector('[aria-label="Tags and AI settings"]'));
  await click(button(shadow, "Tickets"));
  const toggle = () => shadow.querySelector<HTMLButtonElement>('[role="tabpanel"][aria-label="Tickets"] [role="switch"]');
  const label = shadow.getElementById(toggle()!.getAttribute("aria-labelledby")!);
  expect(label?.textContent).toBe("Resolve threads when their tickets are done");
  expect(toggle()!.getAttribute("aria-checked")).toBe("false");
  expect(shadow.querySelector('[role="tabpanel"]')?.textContent).toContain("Canceled tickets count as done. Reopening a ticket doesn't reopen its thread.");

  await click(toggle());
  expect(data.calls!.filter((call) => call.name === "setResolveWhenDone").map((call) => call.args)).toEqual([{ projectId: "project", on: true }]);
  expect(toggle()!.getAttribute("aria-checked")).toBe("true");
  expect(shadow.textContent).toContain("Threads now resolve when their tickets are done");

  // While a save is under way the switch shows the new choice and keeps focus; another press waits for it.
  let finish = () => {};
  data.trackers!.setResolveWhenDone = () => new Promise<void>((resolve) => (finish = resolve));
  // The settings read the choice back later, as a live query can lag the save.
  let live = data.trackers!.settings!;
  let written = live;
  Object.defineProperty(data.trackers!, "settings", { configurable: true, get: () => live, set: (value) => (written = value) });
  toggle()!.focus();
  await click(toggle());
  expect(toggle()!.getAttribute("aria-checked")).toBe("false");
  expect(toggle()!.disabled).toBe(false);
  expect(shadow.activeElement).toBe(toggle());
  await click(toggle());
  expect(data.calls!.filter((call) => call.name === "setResolveWhenDone")).toHaveLength(2);
  await act(async () => finish());
  await settle();
  // Saved, but not read back yet: still the new choice.
  expect(toggle()!.getAttribute("aria-checked")).toBe("false");
  live = written;
  delete (data.trackers as { settings?: unknown }).settings;
  data.trackers!.settings = live;

  // A refused save says why and puts the switch back.
  data.trackers!.setResolveWhenDone = async () => {
    throw new ConvexError({ code: "forbidden", message: "Only the person who set up this project can change its ticket settings." });
  };
  await click(toggle());
  expect(toggle()!.getAttribute("aria-checked")).toBe("false");
  expect(shadow.querySelector('[role="tabpanel"] [role="alert"]')?.textContent).toBe("Only the person who set up this project can change its ticket settings.");
  await act(async () => root?.unmount());
  root = null;

  // A backend without ticket status has no Tickets tab.
  shadow = await mount(backend(), OFFERED, { sidebarOpen: true });
  await click(shadow.querySelector('[aria-label="Tags and AI settings"]'));
  expect(button(shadow, "Tickets")).toBeNull();
});

test("with drafting and ticket status, one Tickets tab shows the templates first, then Resolve when done, and each saves only its own setting", async () => {
  const data = backend();
  let shadow = await mount(data, { ...OFFERED, drafting: true, ticketStatus: true }, { sidebarOpen: true });
  const settings = await openTicketsTab(shadow);
  expect([...settings.querySelectorAll('[role="tab"]')].filter((tab) => tab.textContent === "Tickets")).toHaveLength(1);
  const panel = settings.querySelector('[role="tabpanel"][aria-label="Tickets"]')!;
  const templates = () => switchFor(panel, "Use the team's ticket templates")!;
  const resolve = () => switchFor(panel, "Resolve threads when their tickets are done")!;
  expect(templates().compareDocumentPosition(resolve()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(panel.textContent).toContain("Canceled tickets count as done. Reopening a ticket doesn't reopen its thread.");

  await click(templates());
  expect(calls(data, "saveTicketTemplateSettings")).toEqual([{ projectId: "project", on: true, templates: [] }]);
  expect(calls(data, "setResolveWhenDone")).toEqual([]);
  expect(resolve().getAttribute("aria-checked")).toBe("false");
  await click(resolve());
  expect(calls(data, "setResolveWhenDone")).toEqual([{ projectId: "project", on: true }]);
  expect(calls(data, "saveTicketTemplateSettings")).toHaveLength(1);
  expect(templates().getAttribute("aria-checked")).toBe("true");
  expect(resolve().getAttribute("aria-checked")).toBe("true");
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  page?.remove();

  // Each section shows only where the backend has it.
  shadow = await mount(backend(), DRAFTING, { sidebarOpen: true });
  let panelOnly = (await openTicketsTab(shadow)).querySelector('[role="tabpanel"][aria-label="Tickets"]')!;
  expect(switchFor(panelOnly, "Use the team's ticket templates")).not.toBeNull();
  expect(switchFor(panelOnly, "Resolve threads when their tickets are done")).toBeNull();
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  page?.remove();
  shadow = await mount(backend(), WITH_STATUS, { sidebarOpen: true });
  panelOnly = (await openTicketsTab(shadow)).querySelector('[role="tabpanel"][aria-label="Tickets"]')!;
  expect(switchFor(panelOnly, "Use the team's ticket templates")).toBeNull();
  expect(switchFor(panelOnly, "Resolve threads when their tickets are done")).not.toBeNull();
});

test("a list row marks a ticket's status last known as its chip does; the page layer's pin gets only the fields it takes", async () => {
  const shadow = await mount(backend({ threads: [summary([{ ...badge, lastKnown: true }])] }), OFFERED, { sidebarOpen: true });
  expect(shadow.querySelector(".entry .ticket-badge")?.textContent).toBe("ENG-1 · In Progress · last known");
  // The pin is still drawn: the page layer refuses ticket fields it doesn't know, which would drop every pin.
  expect(shadow.querySelector(".pin .pin-ticket")).not.toBeNull();
});

const GITHUB: TrackerAccountView = { tracker: "github", method: "oauth", accountName: "dana-smith", site: null, connectedAt: 1, attribution: true };

test("Create ticket in GitHub, with no repository that takes issues, says so and links to installing Critiqs on repositories", async () => {
  const install = "https://github.com/apps/critiqs/installations/new";
  const data = backend({ trackers: { accounts: [GITHUB], destinations: async () => [] } });
  const shadow = await mount(data, { trackers: [{ id: "github", signIn: "oauth", installUrl: install }], threadTickets: true });
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  const create = dialog(shadow, "Create ticket")!;
  expect(create.textContent).toContain("Repository");
  expect(create.textContent).toContain("You have no repository here that takes new tickets.");
  const link = [...create.querySelectorAll("a")].find((anchor) => anchor.textContent === "Install Critiqs on your repositories in GitHub")!;
  expect(link.getAttribute("href")).toBe(install);
  expect(link.getAttribute("target")).toBe("_blank");
});

test("with Linear and GitHub connected, the Tickets tab lists each tracker's templates, and a GitHub template is saved as GitHub's", async () => {
  const groups = async (tracker: TrackerId): Promise<TrackerTemplateGroup[]> =>
    tracker === "github"
      ? [{ destination: { id: "acme/web", name: "acme/web", key: null }, templates: [{ id: "acme/web:bug.yml", name: "Bug form" }] }]
      : [{ destination: { id: "team-eng", name: "Engineering", key: "ENG" }, templates: [{ id: "tpl-bug", name: "Bug report" }] }];
  const data = backend({ trackers: { accounts: [LINEAR, GITHUB], templateSettings: { on: true, templates: [] }, trackerTemplates: groups } });
  const shadow = await mount(data, { ...DRAFTING, trackers: [{ id: "linear", signIn: "token" }, { id: "github", signIn: "oauth" }] }, { sidebarOpen: true });
  const settings = await openTicketsTab(shadow);
  expect(calls(data, "listTrackerTemplates")).toEqual([
    { projectId: "project", tracker: "linear" },
    { projectId: "project", tracker: "github" },
  ]);
  // Each tracker is a titled section; its repositories and teams are groups inside it.
  expect([...settings.querySelectorAll("section h4.ds-section-title")].map((label) => label.textContent)).toEqual(["Linear", "GitHub Issues"]);
  expect([...settings.querySelectorAll('section[aria-label="GitHub Issues"] .ds-group-label')].map((label) => label.textContent)).toEqual(["acme/web"]);
  expect([...settings.querySelectorAll('section[aria-label="Linear"] .ds-group-label')].map((label) => label.textContent)).toEqual(["Engineering"]);
  expect(settings.querySelector('[role="group"][aria-label="GitHub Issues templates"]')!.textContent).toContain("in their repository");
  await click(switchFor(settings, "Bug form"));
  expect(calls(data, "saveTicketTemplateSettings").at(-1)).toEqual({
    projectId: "project",
    on: true,
    templates: [{ tracker: "github", destinationId: "acme/web", templateId: "acme/web:bug.yml", name: "Bug form" }],
  });
  expect(switchFor(settings, "Bug form")!.getAttribute("aria-checked")).toBe("true");
  expect(switchFor(settings, "Bug report")!.getAttribute("aria-checked")).toBe("false");
});

test("with Linear and GitHub connected, switching the tracker never asks one tracker about the other's destination", async () => {
  const destinations = async (tracker: TrackerId) => (tracker === "linear" ? [{ id: "team-des", name: "Design", key: "DES" }] : [{ id: "acme/web", name: "acme/web", key: null }]);
  const data = backend({ trackers: { accounts: [LINEAR, GITHUB], destinations, options: async () => ({ templates: [], labels: [] }) } });
  const both: TicketsConfig = { trackers: [{ id: "linear", signIn: "token" }, { id: "github", signIn: "token" }], threadTickets: true, drafting: true };
  const shadow = await mount(data, both);
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  const create = dialog(shadow, "Create ticket")!;
  expect(rowSelect(create, "Tracker")!.textContent).toContain("Linear");
  await chooseOption(shadow, rowSelect(create, "Tracker"), "GitHub Issues");
  expect(rowSelect(create, "Repository")!.textContent).toContain("acme/web");
  expect(calls(data, "ticketDraftOptions")).toEqual([
    { threadId: "thread", tracker: "linear", destinationId: "team-des" },
    { threadId: "thread", tracker: "github", destinationId: "acme/web" },
  ]);
});

const JIRA: TrackerAccountView = { tracker: "jira", method: "token", accountName: "Dana Smith", site: "acme.atlassian.net", connectedAt: 1, attribution: true };
const JIRA_DRAFTING: TicketsConfig = { trackers: [{ id: "jira", signIn: "token" }], threadTickets: true, drafting: true };
/** Website · Bug needs nothing more; Operations · Incident needs a priority and a number; Operations · Escalation needs a person, which Critiqs can't fill. */
const jiraOptions = async (destinationId: string): Promise<TicketDraftOptions> => {
  if (destinationId === "10002/10020") {
    return {
      templates: [],
      labels: [],
      fields: [
        { id: "priority", name: "Priority", kind: "choice", options: [{ id: "1", name: "Highest" }, { id: "3", name: "Medium" }] },
        { id: "customfield_10051", name: "Affected users", kind: "number", options: [] },
      ],
      unsupportedFields: [],
    };
  }
  if (destinationId === "10002/10021") return { templates: [], labels: [], fields: [], unsupportedFields: ["Escalation owner"] };
  return { templates: [], labels: [], fields: [], unsupportedFields: [] };
};

test("a Jira issue type's required fields are asked for, Create waits until each has a value, and they are sent; one Critiqs can't fill is named and blocks Create", async () => {
  const data = backend({
    trackers: {
      accounts: [JIRA],
      options: jiraOptions,
      destinations: async () => [
        { id: "10001/10010", name: "Website · Bug", key: "WEB" },
        { id: "10002/10020", name: "Operations · Incident", key: "OPS" },
        { id: "10002/10021", name: "Operations · Escalation", key: "OPS" },
      ],
    },
  });
  const shadow = await mount(data, JIRA_DRAFTING);
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  const create = dialog(shadow, "Create ticket")!;
  expect(rowSelect(create, "Project and type")!.textContent).toContain("Website · Bug");
  expect(create.querySelector(".ticket-fields")).toBeNull();

  await chooseOption(shadow, rowSelect(create, "Project and type"), "Operations · Escalation");
  expect(create.querySelector('[role="alert"]')?.textContent).toContain("needs Escalation owner, which Critiqs can't fill yet");
  expect(button(create, "Create")!.disabled).toBe(true);

  await chooseOption(shadow, rowSelect(create, "Project and type"), "Operations · Incident");
  expect(create.querySelector('[role="alert"]')).toBeNull();
  expect(button(create, "Create")!.disabled).toBe(true);
  await chooseOption(shadow, rowSelect(create, "Priority"), "Medium");
  await type(create.querySelector<HTMLInputElement>('.ticket-fields input[type="number"]'), "40");
  expect(button(create, "Create")!.disabled).toBe(false);
  await click(button(create, "Create"));
  expect(calls(data, "createTicket")).toEqual([expect.objectContaining({ tracker: "jira", destinationId: "10002/10020", fields: { priority: "3", customfield_10051: "40" } })]);
});

test("with all three trackers connected, switching the tracker never asks one tracker about another's destination", async () => {
  const destinations = async (tracker: TrackerId) =>
    tracker === "linear"
      ? [{ id: "team-des", name: "Design", key: "DES" }]
      : tracker === "github"
        ? [{ id: "acme/web", name: "acme/web", key: null }]
        : [{ id: "10001/10010", name: "Website · Bug", key: "WEB" }];
  const data = backend({ trackers: { accounts: [LINEAR, GITHUB, JIRA], destinations, options: async () => ({ templates: [], labels: [] }) } });
  const all: TicketsConfig = { trackers: [{ id: "linear", signIn: "token" }, { id: "github", signIn: "token" }, { id: "jira", signIn: "token" }], threadTickets: true, drafting: true };
  const shadow = await mount(data, all);
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  const create = dialog(shadow, "Create ticket")!;
  expect(rowSelect(create, "Tracker")!.textContent).toContain("Linear");
  await chooseOption(shadow, rowSelect(create, "Tracker"), "GitHub Issues");
  expect(rowSelect(create, "Repository")!.textContent).toContain("acme/web");
  await chooseOption(shadow, rowSelect(create, "Tracker"), "Jira");
  expect(rowSelect(create, "Project and type")!.textContent).toContain("Website · Bug");
  const own: Record<TrackerId, string> = { linear: "team-des", github: "acme/web", jira: "10001/10010" };
  const asked = calls(data, "ticketDraftOptions") as { tracker: TrackerId; destinationId: string }[];
  expect(asked.map((call) => call.tracker)).toEqual(["linear", "github", "jira"]);
  for (const call of asked) expect(call.destinationId).toBe(own[call.tracker]);
});

// ---------------------------------------------------------------------------
// The project's default destination

const DEFAULTS: TicketsConfig = { ...OFFERED, drafting: true, ticketStatus: true, defaultDestinations: true };

test("an owner chooses each connected tracker's default destination in the Tickets tab, or none, among their own destinations", async () => {
  const data = backend({ trackers: { accounts: [LINEAR, GITHUB], destinations: async (tracker) => (tracker === "github" ? [{ id: "acme/web", name: "acme/web", key: null }] : [{ id: "team-des", name: "Design", key: "DES" }, { id: "team-eng", name: "Engineering", key: "ENG" }]) } });
  const shadow = await mount(data, { ...DEFAULTS, trackers: [{ id: "linear", signIn: "token" }, { id: "github", signIn: "oauth" }] }, { sidebarOpen: true });
  const settings = await openTicketsTab(shadow);
  // One titled section per tracker, each with its own default.
  expect([...settings.querySelectorAll("section h4.ds-section-title")].map((title) => title.textContent)).toEqual(["Linear", "GitHub Issues"]);
  const linear = settings.querySelector('section[aria-label="Linear"]')!;
  expect(rowSelect(linear, "Default team")!.textContent).toContain("None");
  expect(rowSelect(settings.querySelector('section[aria-label="GitHub Issues"]')!, "Default repository")).not.toBeNull();
  await chooseOption(shadow, rowSelect(linear, "Default team"), "Engineering");
  expect(calls(data, "setTicketDefaultDestination")).toEqual([{ projectId: "project", tracker: "linear", destinationId: "team-eng" }]);
  expect(shadow.textContent).toContain("New Linear tickets go to Engineering by default");
  expect(rowSelect(linear, "Default team")!.textContent).toContain("Engineering");
  await chooseOption(shadow, rowSelect(linear, "Default team"), "None");
  expect(calls(data, "setTicketDefaultDestination").at(-1)).toEqual({ projectId: "project", tracker: "linear", destinationId: null });
  expect(shadow.textContent).toContain("New Linear tickets have no default team");
});

test("a default another owner chose that this owner can't see stays listed by its saved name", async () => {
  const data = backend({ trackers: { accounts: [LINEAR], settings: { project: { resolveWhenDone: false, defaults: [{ tracker: "linear", destinationId: "team-ops", name: "Operations" }] } } } });
  const shadow = await mount(data, DEFAULTS, { sidebarOpen: true });
  const settings = await openTicketsTab(shadow);
  const linear = settings.querySelector('section[aria-label="Linear"]')!;
  expect(rowSelect(linear, "Default team")!.textContent).toContain("Operations");
});

test("without default destinations on the backend, the Tickets tab has no default rows", async () => {
  const shadow = await mount(backend(), { ...OFFERED, drafting: true, ticketStatus: true }, { sidebarOpen: true });
  const settings = await openTicketsTab(shadow);
  expect(rowSelect(settings, "Default team")).toBeNull();
});

test("Create ticket starts at the project's default destination, unless the person chose another for this project before", async () => {
  const data = backend({ trackers: { accounts: [LINEAR], draft: async () => ({ title: "Department is wrong", body: "Text\n", createdFromCritiqs: true, resumeSubmissionId: null, projectDestinationId: "team-eng" }) } });
  let shadow = await mount(data, DEFAULTS);
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  let create = dialog(shadow, "Create ticket")!;
  expect(rowSelect(create, "Team")!.textContent).toContain("Engineering");
  // Only the project's default is asked about: the first team never is.
  expect(calls(data, "ticketDraftOptions")).toEqual([{ threadId: "thread", tracker: "linear", destinationId: "team-eng" }]);
  await chooseOption(shadow, rowSelect(create, "Team"), "Design");
  await act(async () => root?.unmount());
  host?.remove();
  page?.remove();
  // The person's own choice wins from then on.
  shadow = await mount(data, DEFAULTS);
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  create = dialog(shadow, "Create ticket")!;
  expect(rowSelect(create, "Team")!.textContent).toContain("Design");
});

test("a project default the person can't create tickets in falls back to their first destination", async () => {
  const data = backend({ trackers: { accounts: [LINEAR], draft: async () => ({ title: "T", body: "Text\n", createdFromCritiqs: true, resumeSubmissionId: null, projectDestinationId: "team-secret" }) } });
  const shadow = await mount(data, DEFAULTS);
  await openThreadMenu(shadow);
  await click(button(shadow, "Create ticket…"));
  expect(rowSelect(dialog(shadow, "Create ticket")!, "Team")!.textContent).toContain("Design");
});

test("templates from an organization's .github repository say where they come from, and a Linear workspace template is saved for every team", async () => {
  const groups = async (tracker: TrackerId): Promise<TrackerTemplateGroup[]> =>
    tracker === "github"
      ? [{ destination: { id: "acme/api", name: "acme/api", key: null }, templates: [{ id: "acme/.github:bug.md", name: "Organization bug" }], from: "acme/.github" }]
      : [{ destination: { id: "*", name: "Workspace templates (every team)", key: null }, templates: [{ id: "tpl-ws", name: "Workspace template" }] }];
  const data = backend({ trackers: { accounts: [LINEAR, GITHUB], templateSettings: { on: true, templates: [] }, trackerTemplates: groups } });
  const shadow = await mount(data, { ...DRAFTING, trackers: [{ id: "linear", signIn: "token" }, { id: "github", signIn: "oauth" }] }, { sidebarOpen: true });
  const settings = await openTicketsTab(shadow);
  expect(settings.querySelector('[role="group"][aria-label="acme/api"]')!.textContent).toContain("From acme/.github: this repository has no templates of its own, so GitHub uses these.");
  expect(settings.querySelector('[role="group"][aria-label="Workspace templates (every team)"] .note')).toBeNull();
  await click(switchFor(settings, "Workspace template"));
  expect(calls(data, "saveTicketTemplateSettings").at(-1)).toEqual({
    projectId: "project",
    on: true,
    templates: [{ tracker: "linear", destinationId: "*", templateId: "tpl-ws", name: "Workspace template" }],
  });
});

// ---------------------------------------------------------------------------
// Also create a ticket, and Create tickets for a collection

/** Selects the page's button in Comment mode (already on) and writes a comment. */
async function startComment(shadow: ShadowRoot, text: string) {
  const target = page!.querySelector("button")!;
  document.elementFromPoint = () => target;
  await act(async () => void target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 50, clientY: 90 })));
  await settle();
  const form = shadow.querySelector<HTMLFormElement>('form[aria-label="New comment"]')!;
  await typeInto(commentField(form)!, text);
  return form;
}

test("Also create a ticket in the new-comment box opens Create ticket for the saved thread; unchecked, it doesn't", async () => {
  const data = backend();
  const shadow = await mount(data, OFFERED, { sidebarOpen: true });
  let form = await startComment(shadow, "Align the review button");
  const also = [...form.querySelectorAll("label")].find((label) => label.textContent === "Also create a ticket")!.querySelector("input")!;
  expect(also.checked).toBe(false);
  await click(also);
  await act(async () => form.requestSubmit());
  await settle(6);
  expect(calls(data, "createThread")).toHaveLength(1);
  const create = dialog(shadow, "Create ticket")!;
  expect(create).not.toBeNull();
  expect(calls(data, "ticketDraft").at(-1)).toMatchObject({ threadId: "thread", tracker: "linear" });
  await click(button(create, "Close"));
  expect(dialog(shadow, "Create ticket")).toBeNull();
  // A second comment, left unchecked, opens no dialog.
  form = await startComment(shadow, "Another");
  expect([...form.querySelectorAll("label")].find((label) => label.textContent === "Also create a ticket")!.querySelector("input")!.checked).toBe(false);
  await act(async () => form.requestSubmit());
  await settle(6);
  expect(dialog(shadow, "Create ticket")).toBeNull();
});

test("without a tracker connected, Also create a ticket opens Your trackers; a backend without tickets on threads doesn't offer it", async () => {
  let shadow = await mount(backend({ trackers: { accounts: [] } }), OFFERED, { sidebarOpen: true });
  const form = await startComment(shadow, "Align the review button");
  await click([...form.querySelectorAll("label")].find((label) => label.textContent === "Also create a ticket")!.querySelector("input"));
  await act(async () => form.requestSubmit());
  await settle(6);
  expect(dialog(shadow, "Your trackers")).not.toBeNull();
  await act(async () => root?.unmount());
  host?.remove();
  page?.remove();
  shadow = await mount(backend(), { trackers: [{ id: "linear", signIn: "token" }] }, { sidebarOpen: true });
  const plain = await startComment(shadow, "Hi");
  expect([...plain.querySelectorAll("label")].map((label) => label.textContent)).not.toContain("Also create a ticket");
});

const thread = (id: string, body: string, tickets: TicketBadge[] = []) => ({ ...summary(tickets), _id: id, preview: { body, authorName: "Dana", authorImageUrl: null } });

async function openBulk(shadow: ShadowRoot, ids: string[]) {
  await click(shadow.querySelector('button[aria-label="Select threads to export"]'));
  for (const entry of [...shadow.querySelectorAll<HTMLLabelElement>("label.entry")]) {
    const excerpt = entry.querySelector(".excerpt")?.textContent ?? "";
    if (ids.some((id) => excerpt.startsWith(id))) await click(entry.querySelector("input"));
  }
  await click(button(shadow, "Create tickets…"));
  return dialog(shadow, "Create tickets")!;
}

test("Create tickets makes one ticket per selected thread, skipping ones with a ticket, with progress, at the project's default team", async () => {
  const data = backend({
    threads: [thread("t1", "First issue"), thread("t2", "Second issue"), thread("t3", "Third has one", [badge])],
    trackers: {
      accounts: [LINEAR],
      draft: async (threadId) => ({ title: `Title ${threadId}`, body: `Body ${threadId}\n`, createdFromCritiqs: true, resumeSubmissionId: null, projectDestinationId: "team-eng" }),
      create: async (input) => {
        const ticket = fakeTicketView({ _id: `link-${input.threadId}`, threadId: input.threadId, key: `ENG-${input.threadId.slice(1)}` });
        // The thread list updates with the new ticket as the backend's would, while the run goes on.
        data.threads = data.threads!.map((each) => (each._id === input.threadId ? { ...each, tickets: [{ tracker: "linear", key: ticket.key, status: ticket.status }] } : each));
        return ticket;
      },
    },
  });
  const shadow = await mount(data, { ...OFFERED, drafting: true }, { sidebarOpen: true });
  const bulk = await openBulk(shadow, ["First", "Second", "Third"]);
  expect(rowSelect(bulk, "Team")!.textContent).toContain("Engineering");
  expect(bulk.textContent).toContain("Creates 2 tickets in Engineering.");
  expect([...bulk.querySelectorAll(".bulk-ticket")].map((row) => row.textContent)).toContain("Third has oneSkipped: Has ENG-1");
  await click(button(bulk, "Create tickets"));
  await settle(4);
  const created = calls(data, "createTicket") as { threadId: string; destinationId: string; title: string; body: string; createdFromCritiqs: boolean; submissionId: string }[];
  expect(created.map((input) => [input.threadId, input.destinationId, input.title, input.body, input.createdFromCritiqs])).toEqual([
    ["t1", "team-eng", "Title t1", "Body t1\n", false],
    ["t2", "team-eng", "Title t2", "Body t2\n", false],
  ]);
  expect(new Set(created.map((input) => input.submissionId)).size).toBe(2);
  expect([...bulk.querySelectorAll(".bulk-ticket.created")].map((row) => row.querySelector(".bulk-state")!.textContent)).toEqual(["Created ENG-1 · Triage", "Created ENG-2 · Triage"]);
  expect(bulk.querySelector('[role="status"]')!.textContent).toBe("Created 2 tickets.");
  expect(shadow.textContent).toContain("Created 2 tickets");
});

test("a partial failure names the threads with no ticket; a limit pauses the rest and continues them on its own a minute later; Try again retries the others, under the same submissions", async () => {
  let refuse = new Set(["t2"]);
  let limited = false;
  const data = backend({
    threads: [thread("t1", "First issue"), thread("t2", "Second issue"), thread("t3", "Third issue"), thread("t4", "Fourth issue")],
    trackers: {
      accounts: [LINEAR],
      create: async (input) => {
        if (refuse.has(input.threadId)) throw new ConvexError({ code: "invalid", message: "Linear refused this ticket." });
        if (limited && input.threadId === "t3") throw new ConvexError({ code: "limit", message: "Too many tickets created or linked. Wait a minute, then try again." });
        return fakeTicketView({ _id: `link-${input.threadId}`, threadId: input.threadId, key: `ENG-${input.threadId.slice(1)}` });
      },
    },
  });
  limited = true;
  // The dialog's wait for the limit is taken here and run by hand, so the test never waits a minute.
  const waits: { run: () => void; ms: number }[] = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((run: () => void, ms?: number, ...rest: unknown[]) => {
    if ((ms ?? 0) >= 60_000) {
      waits.push({ run, ms: ms! });
      return 0 as never;
    }
    return realSetTimeout(run, ms, ...rest);
  }) as typeof setTimeout;
  try {
    const shadow = await mount(data, OFFERED, { sidebarOpen: true });
    const bulk = await openBulk(shadow, ["First", "Second", "Third", "Fourth"]);
    await click(button(bulk, "Create tickets"));
    await settle(4);
    const state = () => Object.fromEntries([...bulk.querySelectorAll(".bulk-ticket")].map((row) => [row.querySelector(".grow")!.textContent, row.querySelector(".bulk-state")!.textContent]));
    expect(state()).toEqual({
      "First issue": "Created ENG-1 · Triage",
      "Second issue": "Not created: Linear refused this ticket.",
      "Third issue": "Waiting for the limit of tickets a minute",
      "Fourth issue": "Waiting for the limit of tickets a minute",
    });
    // The fourth was never sent; the rest wait a minute, said with the time they continue.
    expect((calls(data, "createTicket") as { threadId: string }[]).map((input) => input.threadId)).toEqual(["t1", "t2", "t3"]);
    expect(waits.map((wait) => wait.ms)).toEqual([61_000]);
    expect(bulk.querySelector('[role="status"]')!.textContent).toMatch(/^Created 1 of 4\. Paused at the limit of tickets a minute: 2 more continue on their own at .+ while this stays open\. 1 thread has no ticket: “Second issue”\.$/);
    const firstTries = Object.fromEntries((calls(data, "createTicket") as { threadId: string; submissionId: string }[]).map((input) => [input.threadId, input.submissionId]));
    limited = false;
    await act(async () => waits.shift()!.run());
    await settle(4);
    const continued = (calls(data, "createTicket") as { threadId: string; submissionId: string }[]).slice(3);
    expect(continued.map((input) => input.threadId)).toEqual(["t3", "t4"]);
    // The third is sent again under its first submission, so a creation the limit's answer hid can't make a second ticket.
    expect(continued[0]!.submissionId).toBe(firstTries.t3!);
    expect(bulk.querySelector('[role="status"]')!.textContent).toBe("Created 3 of 4. 1 thread has no ticket: “Second issue”.");
    refuse = new Set();
    await click(button(bulk, "Try again"));
    await settle(4);
    const retries = (calls(data, "createTicket") as { threadId: string; submissionId: string }[]).slice(5);
    expect(retries.map((input) => input.threadId)).toEqual(["t2"]);
    expect(retries[0]!.submissionId).toBe(firstTries.t2!);
    expect(bulk.querySelector('[role="status"]')!.textContent).toBe("Created 4 tickets.");
    expect(waits).toEqual([]);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test("a bulk run that keeps meeting the limit stops continuing on its own and says to press Try again", async () => {
  const data = backend({
    threads: [thread("t1", "First issue")],
    trackers: { accounts: [LINEAR], create: async () => { throw new ConvexError({ code: "limit", message: "Too many tickets created or linked. Wait a minute, then try again." }); } },
  });
  const waits: (() => void)[] = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((run: () => void, ms?: number, ...rest: unknown[]) => ((ms ?? 0) >= 60_000 ? (waits.push(run), 0 as never) : realSetTimeout(run, ms, ...rest))) as typeof setTimeout;
  try {
    const shadow = await mount(data, OFFERED, { sidebarOpen: true });
    const bulk = await openBulk(shadow, ["First"]);
    await click(button(bulk, "Create ticket"));
    await settle(4);
    // Three times on its own, at most.
    for (let round = 0; round < 3; round++) {
      expect(waits).toHaveLength(1);
      await act(async () => waits.shift()!());
      await settle(4);
    }
    expect(waits).toHaveLength(0);
    expect(calls(data, "createTicket")).toHaveLength(4);
    expect(bulk.querySelector(".bulk-state")!.textContent).toBe("Not created: Too many tickets created or linked. Wait a minute, then try again.");
    expect(bulk.querySelector('[role="status"]')!.textContent).toBe("Created 0 of 1. The limit of tickets a minute was reached again: press Try again in a minute. 1 thread has no ticket: “First issue”.");
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test("Create tickets holds at most 20 threads, and refuses an issue type whose required fields it can't fill", async () => {
  const many = Array.from({ length: 21 }, (_, index) => thread(`t${index + 1}`, `Issue ${String(index + 1).padStart(2, "0")}`));
  let shadow = await mount(backend({ threads: many }), OFFERED, { sidebarOpen: true });
  await click(shadow.querySelector('button[aria-label="Select threads to export"]'));
  await click(button(shadow, "Select all"));
  await click(button(shadow, "Create tickets…"));
  let bulk = dialog(shadow, "Create tickets")!;
  expect(bulk.textContent).toContain("Create tickets works on up to 20 threads at a time; 21 are selected without a ticket. Select fewer.");
  expect(button(bulk, "Create tickets")!.disabled).toBe(true);
  await act(async () => root?.unmount());
  host?.remove();
  page?.remove();
  const data = backend({ threads: [thread("t1", "First issue")], trackers: { accounts: [LINEAR], options: async () => ({ templates: [], labels: [], fields: [{ id: "f1", name: "Severity", kind: "text", options: [] } as never], unsupportedFields: ["Reviewer"] }) } });
  shadow = await mount(data, { ...OFFERED, drafting: true }, { sidebarOpen: true });
  bulk = await openBulk(shadow, ["First"]);
  expect(bulk.textContent).toContain("This team needs Severity, Reviewer on each ticket. Choose another, or create these tickets one at a time.");
  expect(button(bulk, "Create ticket")!.disabled).toBe(true);
  expect(calls(data, "createTicket")).toEqual([]);
});

test("with no tracker connected, Create tickets… opens Your trackers; a backend without tickets on threads doesn't offer it", async () => {
  let shadow = await mount(backend({ trackers: { accounts: [] } }), OFFERED, { sidebarOpen: true });
  await click(shadow.querySelector('button[aria-label="Select threads to export"]'));
  await click(shadow.querySelector("label.entry input"));
  await click(button(shadow, "Create tickets…"));
  expect(dialog(shadow, "Create tickets")).toBeNull();
  expect(dialog(shadow, "Your trackers")).not.toBeNull();
  await act(async () => root?.unmount());
  host?.remove();
  page?.remove();
  shadow = await mount(backend(), { trackers: [{ id: "linear", signIn: "token" }] }, { sidebarOpen: true });
  await click(shadow.querySelector('button[aria-label="Select threads to export"]'));
  expect(button(shadow, "Create tickets…")).toBeNull();
});

test("Create tickets' Created from Critiqs box starts at each tracker's own setting when the tracker changes, as Create ticket's does", async () => {
  const both: TicketsConfig = { trackers: [{ id: "linear", signIn: "token" }, { id: "github", signIn: "token" }], threadTickets: true };
  // Linear's setting is on and GitHub's off: the opposite of the defaults, so a kept box shows.
  const data = backend({ threads: [thread("t1", "First issue")], trackers: { accounts: [{ ...LINEAR, attribution: true }, { ...GITHUB, attribution: false }] } });
  const shadow = await mount(data, both, { sidebarOpen: true });
  const bulk = await openBulk(shadow, ["First"]);
  const box = () => [...bulk.querySelectorAll("label")].find((label) => label.textContent?.includes("Created from Critiqs"))!.querySelector("input")!;
  expect(box().checked).toBe(true);
  await chooseOption(shadow, rowSelect(bulk, "Tracker"), "GitHub Issues");
  await settle(3);
  expect(box().checked).toBe(false);
  // What the person ticks holds while the tracker stays; switching back starts at Linear's setting again.
  await click(box());
  expect(box().checked).toBe(true);
  await chooseOption(shadow, rowSelect(bulk, "Tracker"), "Linear");
  await settle(3);
  expect(box().checked).toBe(true);
  await click(box());
  await chooseOption(shadow, rowSelect(bulk, "Tracker"), "GitHub Issues");
  await settle(3);
  expect(box().checked).toBe(false);
});
