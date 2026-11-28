import { afterEach, expect, test } from "bun:test";
import type { OrganizationDetails, ParticipantInfo, ProjectInfo, ReviewAccess } from "@critiqs/core";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import { Session } from "../src/session.ts";
import { type CritiqsTransport, CritiqsRequestError, type InviteAnswer, TransportContext } from "../src/transport.ts";
import { type FakeBackend, fakeTransport } from "./fake-transport.tsx";

// The project panel's "Who has access" card. Everyone sees who can comment
// and the people; an admin of the project's organization, on a backend that
// keeps organizations' members, also adds people by email, removes members,
// withdraws invites, and chooses who can comment. A backend without members
// shows the card as before.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const originalUrl = window.location.href;
const SIGN_IN = "https://auth.example";
const LAST_ADMIN = "An organization needs at least one admin. Make someone else an admin first.";
const INVITE_LIMIT = "This organization has sent 50 invites today. Try again tomorrow.";
const ANYONE = "Anyone who signs in while using this prototype can see and add comments. Control access by controlling who can reach the prototype.";
const ONLY_ADDED = "Only people added here, the members of Acme, can see and add comments.";

/** Acme as Dana, its admin, sees it: Lee is a member and Riley is invited. */
const asAdmin: OrganizationDetails = {
  id: "acme",
  name: "Acme",
  role: "admin",
  plan: "Free",
  members: [
    { userId: "dana", name: "Dana", imageUrl: null, email: "dana@example.com", role: "admin", you: true },
    { userId: "lee", name: "Lee", imageUrl: null, email: "lee@example.com", role: "member", you: false },
  ],
  invites: [{ _id: "invite", email: "riley@example.com", role: "member", invitedBy: "Dana", createdAt: 1 }],
};

/** Acme as Dana, a member, sees it: no addresses, no invites. */
const asMember: OrganizationDetails = {
  id: "acme",
  name: "Acme",
  role: "member",
  plan: "Free",
  members: [
    { userId: "dana", name: "Dana", imageUrl: null, email: null, role: "member", you: true },
    { userId: "sam", name: "Sam", imageUrl: null, email: null, role: "admin", you: false },
  ],
  invites: [],
};

/** Lee commented and is a member; Kim commented and isn't. */
const commenters: ParticipantInfo[] = [
  { _id: "lee", name: "Lee", imageUrl: null },
  { _id: "kim", name: "Kim", imageUrl: null },
];

const project = (overrides: Partial<ProjectInfo> = {}): ProjectInfo => ({
  _id: "project",
  name: "Pilot",
  tags: [],
  createdAt: 1,
  reviewUrl: null,
  isOwner: true,
  organization: { id: "acme", name: "Acme", role: "admin" },
  reviewAccess: "anyone",
  ...overrides,
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  localStorage.clear();
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(originalUrl);
});

interface Options {
  /** What the deployment's email does with a new invite. */
  email?: InviteAnswer["email"];
  /** The organization sent its invites for today. */
  inviteLimit?: boolean;
  /** The backend refuses removals as the last admin's, as when the data shown is out of date. */
  lastAdmin?: boolean;
}

/**
 * A fake backend that behaves as Critiqs's does for these calls and, like
 * Convex, updates what the interface shows as soon as its data changes.
 */
function world(details: OrganizationDetails, info: ProjectInfo, options: Options = {}) {
  const listeners = new Set<() => void>();
  let version = 0;
  const changed = () => {
    version++;
    for (const listener of [...listeners]) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const data: FakeBackend = {
    project: info,
    threads: [],
    participants: commenters,
    organizations: [{ id: details.id, name: details.name, role: details.role, plan: details.plan, home: true }],
    organizationDetails: { [details.id]: details },
    calls: [],
  };
  const organization = () => data.organizationDetails![details.id]!;
  const update = (next: Partial<OrganizationDetails>) => {
    data.organizationDetails = { [details.id]: { ...organization(), ...next } };
    changed();
  };
  data.organizationChange = async (name, args) => {
    const current = organization();
    if (name === "inviteMember") {
      const { email, role } = args as { email: string; role: "admin" | "member" };
      const address = email.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new CritiqsRequestError("invalid", "Enter a valid email address.");
      if (current.members.some((member) => member.email === address)) return { status: "member" };
      if (current.invites.some((invite) => invite.email === address)) return { status: "pending" };
      if (options.inviteLimit === true) throw new CritiqsRequestError("limit", INVITE_LIMIT);
      update({ invites: [...current.invites, { _id: `invite:${address}`, email: address, role, invitedBy: "Dana", createdAt: 2 }] });
      return { status: "invited", email: options.email ?? "pending" };
    }
    if (name === "removeMember") {
      const { userId } = args as { userId: string };
      if (options.lastAdmin === true) throw new CritiqsRequestError("invalid", LAST_ADMIN);
      update({ members: current.members.filter((member) => member.userId !== userId) });
      return undefined;
    }
    if (name === "revokeInvite") {
      const { inviteId } = args as { inviteId: string };
      update({ invites: current.invites.filter((invite) => invite._id !== inviteId) });
      return undefined;
    }
    throw new Error(`Unexpected ${name}`);
  };
  data.setReviewAccess = async ({ reviewAccess }) => {
    data.project = { ...data.project!, reviewAccess };
    changed();
  };
  const base = fakeTransport(data);
  const watch = () => useSyncExternalStore(subscribe, () => version);
  const transport: CritiqsTransport = {
    ...base,
    useProject: (projectId) => (watch(), base.useProject(projectId)),
    useOrganization: (organizationId) => (watch(), base.useOrganization(organizationId)),
    useParticipants: (projectId, query, threadId) => (watch(), base.useParticipants(projectId, query, threadId)),
  };
  return { data, transport, update, calls: (name: string) => data.calls!.filter((call) => call.name === name).map((call) => call.args) };
}

/** The whole interface with the side panel open in Browse mode, signed in as Dana. */
async function mount(transport: CritiqsTransport, { organizationMembers = true } = {}) {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://prototype.example/pilot");
  localStorage.setItem("critiqs:sidebar-open", "true");
  const payload = btoa(JSON.stringify({ sub: "dana", name: "Dana", email: "dana@example.com" }));
  localStorage.setItem(`critiqs:session:${SIGN_IN}`, JSON.stringify({ accessToken: `header.${payload}.signature`, refreshToken: "fixture", expiresAt: Date.now() + 900_000 }));
  host = document.createElement("critiqs-root");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const inner = document.createElement("div");
  shadow.append(inner);
  root = createRoot(inner);
  const session = new Session(SIGN_IN, localStorage, async () => new Response(null, { status: 204 }));
  const deployment = { backendUrl: "https://backend.convex.cloud", siteUrl: "https://backend.convex.site", signInUrl: SIGN_IN, transport: "convex", signIn: null, organizationMembers } as const;
  await act(async () =>
    root!.render(
      <TransportContext.Provider value={transport}>
        <App props={{ projectId: "project", getContext: () => ({ screen: "pilot" }) }} deployment={deployment} session={session} host={host!} shadow={host!.shadowRoot!} />
      </TransportContext.Provider>,
    ),
  );
  await settle();
  return shadow;
}

async function settle() {
  for (let i = 0; i < 3; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}

const card = (shadow: ShadowRoot) => {
  const section = shadow.querySelector('section[aria-label="Who has access"]');
  if (section === null) throw new Error("No Who has access card");
  return section;
};

/** Each person's line, without avatars' initials, buttons, or a confirmation or message under it. */
const rows = (scope: Element) =>
  [...scope.querySelectorAll("ul.people > li")].map((row) => {
    const copy = row.cloneNode(true) as Element;
    for (const extra of copy.querySelectorAll(".avatar, button, [role]")) extra.remove();
    return copy.textContent!.trim();
  });

/** The sentence about who can see and add comments. */
const sentence = (scope: Element) => scope.querySelector(":scope > .note")!.textContent;

const button = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label") === name || (candidate.getAttribute("aria-label") === null && candidate.textContent?.trim() === name)) ?? null;

/** The control a label names: the one it holds, or the one its `for` points at. */
const labelled = (label: HTMLLabelElement) => label.querySelector("input") ?? (label.getRootNode() as ParentNode).querySelector<HTMLInputElement>(`[id="${label.htmlFor}"]`);

const field = (scope: ParentNode) => {
  const label = [...scope.querySelectorAll("label")].find((candidate) => candidate.textContent?.trim() === "Add people");
  return label === undefined ? null : labelled(label);
};

/** A control's accessible name, as far as these controls need: its aria-label, its label, or its text. */
const nameOf = (control: Element) =>
  control.getAttribute("aria-label") ?? [...(control.getRootNode() as ParentNode).querySelectorAll("label")].find((label) => labelled(label) === control)?.textContent?.trim() ?? control.textContent!.trim();

const controls = (scope: Element) => [...scope.querySelectorAll("button, input, select, textarea, [tabindex]")];

function select(scope: ParentNode, label: string): HTMLButtonElement | null {
  return (
    [...scope.querySelectorAll<HTMLButtonElement>(".ds-select")].find((candidate) => {
      const [labelId] = candidate.getAttribute("aria-labelledby")!.split(" ");
      return (candidate.getRootNode() as ParentNode).querySelector(`[id="${labelId}"]`)?.textContent?.trim() === label;
    }) ?? null
  );
}

async function choose(shadow: ShadowRoot, label: string, option: string) {
  await click(select(card(shadow), label));
  await click([...shadow.querySelectorAll('[role="menuitemradio"]')].find((item) => item.textContent?.replace("✓", "").trim() === option));
}

async function click(element: Element | null | undefined) {
  if (element == null) throw new Error("Nothing to click");
  await act(async () => (element as HTMLElement).click());
  await settle();
}

async function type(input: HTMLInputElement | null, text: string) {
  if (input === null) throw new Error("No field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function add(shadow: ShadowRoot, address: string) {
  await type(field(card(shadow)), address);
  await click(button(card(shadow), "Add"));
}

async function key(target: Element, key: string, init: KeyboardEventInit = {}) {
  let event: KeyboardEvent | null = null;
  await act(async () => {
    event = new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true, ...init });
    target.dispatchEvent(event);
  });
  await settle();
  return event!;
}

const active = (shadow: ShadowRoot) => shadow.activeElement;

test("1. an admin adds a new address: one invite naming this project, an Invited row at once, and the field clears", async () => {
  const { transport, calls } = world(asAdmin, project());
  const shadow = await mount(transport);
  await add(shadow, "new@example.com");
  expect(calls("inviteMember")).toEqual([{ organizationId: "acme", email: "new@example.com", role: "member", projectId: "project" }]);
  expect(rows(card(shadow))).toContain("new@example.com · Invited");
  expect(field(card(shadow))!.value).toBe("");
});

test("2. an address already a member, already invited, not valid, the admin's own, or past a limit shows the backend's message and adds no row", async () => {
  const cases: [string, string, Options][] = [
    ["lee@example.com", "lee@example.com is already a member", {}],
    ["riley@example.com", "riley@example.com is already invited", {}],
    ["not-an-address", "Enter a valid email address.", {}],
    ["dana@example.com", "dana@example.com is already a member", {}],
    ["new@example.com", INVITE_LIMIT, { inviteLimit: true }],
  ];
  for (const [address, message, options] of cases) {
    const { transport } = world(asAdmin, project(), options);
    const shadow = await mount(transport);
    const before = rows(card(shadow));
    await add(shadow, address);
    expect(card(shadow).textContent).toContain(message);
    expect(rows(card(shadow))).toEqual(before);
    await act(async () => root!.unmount());
    host!.remove();
  }
});

test("3. when the deployment can't send email, the card says so in the backend's words and the row appears", async () => {
  const { transport } = world(asAdmin, project(), { email: "not-sent" });
  const shadow = await mount(transport);
  await add(shadow, "new@example.com");
  expect(card(shadow).textContent).toContain("new@example.com is invited and joins by signing in to Critiqs with that address");
  expect(rows(card(shadow))).toContain("new@example.com · Invited");
});

test("4. Remove asks first, naming the person; confirming removes them once, Keep calls nothing; not on your own row or a commenter's", async () => {
  const { transport, calls } = world(asAdmin, project());
  const shadow = await mount(transport);
  expect(rows(card(shadow))).toEqual(["Dana (you, project owner, admin)", "Lee", "riley@example.com · Invited", "Kim · commented"]);
  expect(button(card(shadow), "Remove Dana")).toBeNull();
  expect(button(card(shadow), "Remove Kim")).toBeNull();

  await click(button(card(shadow), "Remove Lee"));
  expect(card(shadow).querySelector('[role="alertdialog"]')!.textContent).toContain("Remove Lee from Acme?");
  await click(button(card(shadow), "Keep Lee"));
  expect(card(shadow).querySelector('[role="alertdialog"]')).toBeNull();
  expect(calls("removeMember")).toEqual([]);
  expect(rows(card(shadow))).toContain("Lee");

  await click(button(card(shadow), "Remove Lee"));
  await click(button(card(shadow), "Remove Lee from Acme"));
  expect(calls("removeMember")).toEqual([{ organizationId: "acme", userId: "lee" }]);
  expect(rows(card(shadow))).not.toContain("Lee");
});

test("5. the backend's refusal to remove the last admin shows, and the row stays", async () => {
  const { transport } = world(asAdmin, project(), { lastAdmin: true });
  const shadow = await mount(transport);
  await click(button(card(shadow), "Remove Lee"));
  await click(button(card(shadow), "Remove Lee from Acme"));
  expect([...card(shadow).querySelectorAll('[role="alert"]')].map((alert) => alert.textContent)).toContain(LAST_ADMIN);
  expect(rows(card(shadow))).toContain("Lee");
});

test("6. Withdraw on an invitation withdraws it once and the row goes", async () => {
  const { transport, calls } = world(asAdmin, project());
  const shadow = await mount(transport);
  await click(button(card(shadow), "Withdraw the invite to riley@example.com"));
  expect(calls("revokeInvite")).toEqual([{ inviteId: "invite" }]);
  expect(rows(card(shadow))).not.toContain("riley@example.com · Invited");
});

test("7. Who can comment saves the project's access rule and changes the sentence; someone who can't set it sees no choice", async () => {
  const { transport, calls } = world(asAdmin, project());
  const shadow = await mount(transport);
  expect(sentence(card(shadow))).toBe(ANYONE);
  expect(card(shadow).textContent).toContain("removing someone here doesn't stop them");

  await choose(shadow, "Who can comment", "Only people added here");
  expect(calls("setReviewAccess")).toEqual([{ projectId: "project", reviewAccess: "organization" satisfies ReviewAccess }]);
  expect(sentence(card(shadow))).toBe(ONLY_ADDED);
  expect(card(shadow).textContent).not.toContain("removing someone here doesn't stop them");

  await choose(shadow, "Who can comment", "Anyone who can reach the prototype");
  expect(calls("setReviewAccess")).toEqual([
    { projectId: "project", reviewAccess: "organization" },
    { projectId: "project", reviewAccess: "anyone" },
  ]);
  expect(sentence(card(shadow))).toBe(ANYONE);
  await act(async () => root!.unmount());
  host!.remove();

  // A backend from before the setting, and someone it doesn't let manage the project.
  for (const info of [project({ reviewAccess: undefined }), project({ isOwner: false })]) {
    const other = world(asAdmin, info);
    const page = await mount(other.transport);
    expect(select(card(page), "Who can comment")).toBeNull();
    await act(async () => root!.unmount());
    host!.remove();
  }
});

test("8. a member who isn't an admin sees the people and whom to ask, and nothing they can't do", async () => {
  const { transport } = world(asMember, project({ isOwner: false, organization: { id: "acme", name: "Acme", role: "member" } }));
  const shadow = await mount(transport);
  // Lee commented and isn't a member here.
  expect(rows(card(shadow))).toEqual(["Dana (you)", "Sam (admin)", "Lee · commented", "Kim · commented"]);
  expect(card(shadow).textContent).toContain("Ask an admin of Acme to add or remove people.");
  expect(sentence(card(shadow))).toBe(ANYONE);
  expect(controls(card(shadow)).map((control) => control.outerHTML.slice(0, 60))).toEqual([]);
});

test("9. a backend that reports no member management shows the card exactly as before", async () => {
  // The card's markup before this change, with Kim's comment.
  const before = `<section class="review-address" aria-label="Who has access"><strong>Who has access</strong><span class="note">${ANYONE}</span><ul class="people"><li><span class="avatar" style="background: #7c3aed;" title="Dana">DA</span><span>Dana <span class="note">(you, project owner)</span></span></li><li><span class="avatar" style="background: #b45309;" title="Kim">KI</span><span>Kim</span></li></ul><span class="note">People who commented most recently.</span></section>`;
  const { transport, data } = world(asAdmin, project());
  data.participants = [{ _id: "kim", name: "Kim", imageUrl: null }];
  const shadow = await mount(transport, { organizationMembers: false });
  expect(card(shadow).outerHTML).toBe(before);
  expect(controls(card(shadow)).length).toBe(0);
  await act(async () => root!.unmount());
  host!.remove();

  // Someone outside the project's organization can't read its members: the card as before too.
  const outside = world(asAdmin, project({ organization: undefined, isOwner: false }));
  outside.data.participants = [{ _id: "kim", name: "Kim", imageUrl: null }];
  const page = await mount(outside.transport);
  expect(card(page).outerHTML).toBe(before.replace("Dana <span class=\"note\">(you, project owner)</span>", "Dana <span class=\"note\">(you)</span>"));
});

test("10. the list follows the backend's data: an accepted invitation becomes a member without a reload", async () => {
  const { transport, update } = world(asAdmin, project());
  const shadow = await mount(transport);
  expect(rows(card(shadow))).toContain("riley@example.com · Invited");
  await act(async () =>
    update({
      invites: [],
      members: [...asAdmin.members, { userId: "riley", name: "Riley", imageUrl: null, email: "riley@example.com", role: "member", you: false }],
    }),
  );
  await settle();
  expect(rows(card(shadow))).toEqual(["Dana (you, project owner, admin)", "Lee", "Riley", "Kim · commented"]);
  expect(button(card(shadow), "Remove Riley")).not.toBeNull();
});

test("11. keyboard only: every control is reachable and named for its person, Enter adds, and the confirmation traps focus until Escape", async () => {
  const { transport, calls } = world(asAdmin, project());
  const shadow = await mount(transport);
  const section = card(shadow);
  const input = field(section)!;
  // Reached in this order with Tab: native controls, none taken out of the tab order.
  const reachable = controls(section).filter((control) => !(control as HTMLButtonElement).disabled && control.getAttribute("tabindex") !== "-1");
  const named = reachable.map(nameOf);
  expect(named).toEqual(["Remove Lee", "Withdraw the invite to riley@example.com", "Add people", "Add", named[4]!]);
  expect(reachable[4]).toBe(select(section, "Who can comment")!);

  // Enter in the field submits its form, as a browser does for a field with a submit button.
  await type(input, "new@example.com");
  const enter = await key(input, "Enter");
  expect(enter.defaultPrevented).toBe(false);
  expect(input.form).not.toBeNull();
  expect(input.form!.noValidate).toBe(true);
  expect([...input.form!.querySelectorAll('button[type="submit"]')].map((submit) => submit.textContent)).toEqual(["Add"]);
  await act(async () => input.form!.requestSubmit());
  await settle();
  expect(calls("inviteMember").length).toBe(1);

  // The confirmation takes focus, keeps Tab inside it, and Escape cancels it, back on Remove.
  const remove = button(section, "Remove Lee")!;
  await act(async () => remove.focus());
  await click(remove);
  const confirm = section.querySelector('[role="alertdialog"]')!;
  expect(confirm.getAttribute("aria-label") ?? confirm.textContent).toContain("Remove Lee from Acme?");
  expect(active(shadow)).toBe(button(confirm, "Keep Lee"));
  await key(active(shadow)!, "Tab");
  expect(active(shadow)).toBe(button(confirm, "Remove Lee from Acme"));
  await key(active(shadow)!, "Tab");
  expect(active(shadow)).toBe(button(confirm, "Keep Lee"));
  await key(active(shadow)!, "Tab", { shiftKey: true });
  expect(active(shadow)).toBe(button(confirm, "Remove Lee from Acme"));
  await key(active(shadow)!, "Escape");
  expect(section.querySelector('[role="alertdialog"]')).toBeNull();
  expect(calls("removeMember")).toEqual([]);
  expect(active(shadow)).toBe(button(section, "Remove Lee"));
  // Escape closed only the confirmation, not the side panel.
  expect(shadow.querySelector('section[aria-label="Who has access"]')).not.toBeNull();
});
