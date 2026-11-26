import { afterEach, expect, test } from "bun:test";
import type { OrganizationDetails, OrganizationSummary } from "@critiqs/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import { Session } from "../src/session.ts";
import { CritiqsRequestError, TransportContext } from "../src/transport.ts";
import { OpenBillingContext } from "../src/ui/BillingDialog.tsx";
import { OrganizationDialog } from "../src/ui/OrganizationDialog.tsx";
import { Setup } from "../src/ui/Setup.tsx";
import { type FakeBackend, fakeTransport } from "./fake-transport.tsx";

// The Organization page, from the avatar menu where the backend keeps
// organizations' members: its name, members and roles, and for admins,
// inviting by email, pending invites, and changing or removing members.
// Members see it read-only. Setup puts a new project in a chosen organization.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const originalUrl = window.location.href;
const SIGN_IN = "https://auth.example";

const acme: OrganizationSummary = { id: "acme", name: "Acme", role: "admin", plan: "Free", home: true };
const studio: OrganizationSummary = { id: "studio", name: "Studio", role: "member", plan: "Plus", home: false };

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
/** Studio as Dana, a member, sees it. */
const asMember: OrganizationDetails = {
  id: "studio",
  name: "Studio",
  role: "member",
  plan: "Plus",
  members: [
    { userId: "sam", name: "Sam", imageUrl: null, email: null, role: "admin", you: false },
    { userId: "dana", name: "Dana", imageUrl: null, email: null, role: "member", you: true },
  ],
  invites: [],
};

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
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(originalUrl);
});

function backend(overrides: Partial<FakeBackend> = {}): FakeBackend {
  return {
    project: { _id: "project", name: "Pilot", tags: [], createdAt: 1, reviewUrl: null, isOwner: true, organization: { id: "acme", name: "Acme", role: "admin" } },
    threads: [],
    organizations: [acme],
    organizationDetails: { acme: asAdmin, studio: asMember },
    calls: [],
    ...overrides,
  };
}

/** The whole interface, signed in as Dana, in a shadow root as on a prototype. */
async function mount(data: FakeBackend, { organizationMembers = true, projectId = "project" as string | undefined } = {}) {
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
  const deployment = { backendUrl: "https://backend.convex.cloud", siteUrl: "https://backend.convex.site", signInUrl: SIGN_IN, transport: "convex", signIn: null, organizationMembers } as const;
  await act(async () =>
    root!.render(
      <TransportContext.Provider value={fakeTransport(data)}>
        <App props={{ ...(projectId === undefined ? {} : { projectId }), getContext: () => ({ screen: "pilot" }) }} deployment={deployment} session={session} host={host!} />
      </TransportContext.Provider>,
    ),
  );
  await settle();
  return shadow;
}

/** The dialog on its own. */
async function render(node: ReactNode, data: FakeBackend) {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => root!.render(<TransportContext.Provider value={fakeTransport(data)}>{node}</TransportContext.Provider>));
  await settle();
  return container;
}

async function rerender(node: ReactNode, data: FakeBackend) {
  await act(async () => root!.render(<TransportContext.Provider value={fakeTransport(data)}>{node}</TransportContext.Provider>));
  await settle();
}

function Organization({
  notify = () => undefined,
  onClose = () => undefined,
  projectOrganizationId = "acme",
}: {
  notify?: (message: string) => void;
  onClose?: () => void;
  projectOrganizationId?: string | null;
}) {
  return <OrganizationDialog projectOrganizationId={projectOrganizationId} projectId="project" onClose={onClose} notify={notify} />;
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

async function submit(scope: ParentNode, label: string) {
  await click(button(scope, label));
}

function select(scope: ParentNode, label: string): HTMLButtonElement | null {
  return (
    [...scope.querySelectorAll<HTMLButtonElement>(".ds-select")].find((candidate) => {
      const [labelId] = candidate.getAttribute("aria-labelledby")!.split(" ");
      return scope.querySelector(`[id="${labelId}"]`)?.textContent?.trim() === label;
    }) ?? null
  );
}

async function choose(scope: ParentNode, label: string, option: string) {
  await click(select(scope, label));
  await click([...scope.querySelectorAll('[role="menuitemradio"]')].find((item) => item.textContent?.replace("✓", "").trim() === option));
}

/** An element's text without avatars' initials. */
function text(element: Element | null): string {
  if (element === null) return "";
  const copy = element.cloneNode(true) as Element;
  for (const avatar of copy.querySelectorAll(".avatar")) avatar.remove();
  return copy.textContent ?? "";
}
const navRows = (scope: ParentNode) => [...scope.querySelectorAll<HTMLButtonElement>("button.ds-nav-row")].map((row) => [text(row.querySelector(".label")), row.querySelector(".value")?.textContent ?? null]);
const navRow = (scope: ParentNode, label: string) => [...scope.querySelectorAll<HTMLButtonElement>("button.ds-nav-row")].find((row) => text(row.querySelector(".label")).startsWith(label)) ?? null;
const heading = (scope: ParentNode) => scope.querySelector(".ds-dialog-header h3")?.textContent ?? null;
const group = (scope: ParentNode, label: string) => scope.querySelector(`[role="group"][aria-label="${label}"]`);

test("the avatar menu opens the Organization page only where the backend keeps members", async () => {
  let shadow = await mount(backend(), { organizationMembers: false });
  await click(shadow.querySelector('button[aria-label="Signed in as Dana"]'));
  expect(button(shadow, "Organization…")).toBeNull();
  await act(async () => root!.unmount());
  host!.remove();

  shadow = await mount(backend());
  await click(shadow.querySelector('button[aria-label="Signed in as Dana"]'));
  await click(button(shadow, "Organization…"));
  const dialog = shadow.querySelector('[role="dialog"][aria-label="Organization"]')!;
  expect(heading(dialog)).toBe("Acme");
});

test("an admin sees the name, plan, members with addresses and roles, pending invites, and Invite by email", async () => {
  const page = await render(<Organization />, backend());
  expect(heading(page)).toBe("Acme");
  expect(navRows(page)).toEqual([
    ["Name", "Acme"],
    ["Dana (you)dana@example.com", "Admin"],
    ["Leelee@example.com", "Member"],
    ["Invite by email", null],
  ]);
  expect(page.textContent).toContain("PlanFree");
  expect(group(page, "Invited")!.textContent).toContain("riley@example.com");
  expect(group(page, "Invited")!.textContent).toContain("Member · invited by Dana");
});

test("a member sees the organization read-only, and may leave it", async () => {
  const data = backend({ organizations: [studio] });
  const left: string[] = [];
  let closed = false;
  const page = await render(<Organization notify={(message) => left.push(message)} onClose={() => (closed = true)} />, data);
  expect(heading(page)).toBe("Studio");
  // Nothing to open but leaving: no name page, no member pages, no invites.
  expect(navRows(page)).toEqual([["Leave organization", null]]);
  expect(text(group(page, "Members"))).toBe("MembersSamAdminDana (you)Member");
  expect(group(page, "Invited")).toBeNull();
  expect(page.querySelector('input')).toBeNull();
  await click(navRow(page, "Leave organization"));
  expect(page.querySelector('[role="alert"]')!.textContent).toContain("Leave Studio?");
  await click(button(page, "Leave"));
  expect(data.calls).toEqual([{ name: "removeMember", args: { organizationId: "studio", userId: "dana" } }]);
  expect(left).toEqual(["You left Studio"]);
  expect(closed).toBe(true);
});

test("an admin invites by email with a role; the page says whether an invite went out", async () => {
  const data = backend();
  const toasts: string[] = [];
  const page = await render(<Organization notify={(message) => toasts.push(message)} />, data);
  await click(navRow(page, "Invite by email"));
  expect(heading(page)).toBe("Invite by email");
  expect(button(page, "Send invite")!.disabled).toBe(true);
  await type(page.querySelector<HTMLInputElement>('input[type="email"]'), "sam@example.com");
  await choose(page, "Role", "Admin");
  await submit(page, "Send invite");
  expect(data.calls).toEqual([{ name: "inviteMember", args: { organizationId: "acme", email: "sam@example.com", role: "admin", projectId: "project" } }]);
  expect(toasts).toEqual(["Invite sent to sam@example.com"]);
  expect(heading(page)).toBe("Acme");

  // Only an email the mail service accepted is called sent: none going out says how they join, and one still to come, or a backend that doesn't say, just invites.
  for (const [email, toast] of [
    ["not-sent", "kim@example.com is invited and joins by signing in to Critiqs with that address"],
    ["pending", "Invited kim@example.com"],
    [undefined, "Invited kim@example.com"],
  ] as const) {
    data.organizationChange = async () => ({ status: "invited", ...(email === undefined ? {} : { email }) });
    await click(navRow(page, "Invite by email"));
    await type(page.querySelector<HTMLInputElement>('input[type="email"]'), "kim@example.com");
    await submit(page, "Send invite");
    expect(toasts.at(-1)).toBe(toast);
  }

  data.organizationChange = async () => ({ status: "member" });
  await click(navRow(page, "Invite by email"));
  await type(page.querySelector<HTMLInputElement>('input[type="email"]'), "lee@example.com");
  await submit(page, "Send invite");
  expect(toasts.at(-1)).toBe("lee@example.com is already a member");

  // A refused invite keeps the page and what was typed, with the reason.
  data.organizationChange = async () => {
    throw new CritiqsRequestError("limit", "This organization has sent 50 invites today. Try again tomorrow.");
  };
  await click(navRow(page, "Invite by email"));
  await type(page.querySelector<HTMLInputElement>('input[type="email"]'), "ana@example.com");
  await submit(page, "Send invite");
  expect(heading(page)).toBe("Invite by email");
  expect(page.querySelector('[role="alert"]')!.textContent).toBe("This organization has sent 50 invites today. Try again tomorrow.");
  expect(page.querySelector<HTMLInputElement>('input[type="email"]')!.value).toBe("ana@example.com");
});

test("an admin withdraws an invite and renames the organization", async () => {
  const data = backend();
  const toasts: string[] = [];
  const page = await render(<Organization notify={(message) => toasts.push(message)} />, data);
  await click(button(page, "Withdraw the invite to riley@example.com"));
  await click(navRow(page, "Name"));
  expect(heading(page)).toBe("Organization name");
  expect(button(page, "Save name")!.disabled).toBe(true);
  await type(page.querySelector<HTMLInputElement>("input.field"), "Acme design");
  await submit(page, "Save name");
  expect(data.calls).toEqual([
    { name: "revokeInvite", args: { inviteId: "invite" } },
    { name: "renameOrganization", args: { organizationId: "acme", name: "Acme design" } },
  ]);
  expect(toasts).toEqual(["Invite to riley@example.com withdrawn", "Organization renamed"]);
  expect(heading(page)).toBe("Acme");
});

test("an admin changes a member's role or removes them; the last admin's refusal is shown", async () => {
  const data = backend();
  const toasts: string[] = [];
  const page = await render(<Organization notify={(message) => toasts.push(message)} />, data);
  await click(navRow(page, "Lee"));
  expect(heading(page)).toBe("Lee");
  expect(page.textContent).toContain("lee@example.com");
  await choose(page, "Role", "Admin");
  expect(toasts).toEqual(["Lee is now an admin"]);
  await click(navRow(page, "Remove from organization"));
  expect(page.querySelector('[role="alert"]')!.textContent).toContain("Remove Lee from Acme?");
  await click(button(page, "Keep Lee"));
  await click(navRow(page, "Remove from organization"));
  await click(button(page, "Remove"));
  expect(toasts.at(-1)).toBe("Lee was removed");
  expect(heading(page)).toBe("Acme");

  data.organizationChange = async () => {
    throw new CritiqsRequestError("invalid", "An organization needs at least one admin. Make someone else an admin first.");
  };
  await click(navRow(page, "Dana"));
  expect(heading(page)).toBe("Dana (you)");
  await choose(page, "Role", "Member");
  expect(page.querySelector('[role="alert"]')!.textContent).toBe("An organization needs at least one admin. Make someone else an admin first.");
  expect(select(page, "Role")!.textContent).toBe("Admin");
  expect(data.calls!.map((call) => call.name)).toEqual(["setMemberRole", "removeMember", "setMemberRole"]);

  // Each action shows its own result: asking to leave clears the role's refusal, and the refused leave shows its own beside it.
  const errors = () => [...page.querySelectorAll(".error")].map((line) => [line.textContent, line.closest(".ds-group")?.textContent?.includes("Leave") ?? false]);
  await click(navRow(page, "Leave organization"));
  expect(errors()).toEqual([]);
  data.organizationChange = async () => {
    throw new CritiqsRequestError("invalid", "You're the last admin of Acme. Make someone else an admin before you leave.");
  };
  await click(button(page, "Leave"));
  expect(errors()).toEqual([["You're the last admin of Acme. Make someone else an admin before you leave.", true]]);
  await choose(page, "Role", "Member");
  expect(errors()).toEqual([["You're the last admin of Acme. Make someone else an admin before you leave.", false]]);
});

test("a role change that fails after the admin moved to another member's page reports nowhere, not on that page", async () => {
  const data = backend();
  const page = await render(<Organization />, data);
  let refuse = (_error: Error) => {};
  data.organizationChange = () => new Promise((_, reject) => (refuse = reject));
  await click(navRow(page, "Dana"));
  await choose(page, "Role", "Member");
  await click(button(page, "Back"));
  await click(navRow(page, "Lee"));
  expect(heading(page)).toBe("Lee");
  await act(async () => refuse(new CritiqsRequestError("invalid", "An organization needs at least one admin. Make someone else an admin first.")));
  await settle();
  expect(heading(page)).toBe("Lee");
  expect(page.querySelector(".error")).toBeNull();
  // Nor on Dana's page, back where it started.
  await click(button(page, "Back"));
  await click(navRow(page, "Dana"));
  expect(page.querySelector(".error")).toBeNull();
});

test("a refused withdrawal shows beside the invite it was for", async () => {
  const kim = { _id: "invite-kim", email: "kim@example.com", role: "admin" as const, invitedBy: "Dana", createdAt: 2 };
  const data = backend({ organizationDetails: { acme: { ...asAdmin, invites: [...asAdmin.invites, kim] } } });
  const page = await render(<Organization />, data);
  data.organizationChange = async () => {
    throw new CritiqsRequestError("not-found", "This invite was already accepted or withdrawn.");
  };
  await click(button(page, "Withdraw the invite to kim@example.com"));
  const errors = [...page.querySelectorAll(".error")];
  expect(errors.map((line) => line.textContent)).toEqual(["This invite was already accepted or withdrawn."]);
  expect(errors[0]!.previousElementSibling!.textContent).toContain("kim@example.com");
  expect(errors[0]!.closest('[role="group"]')!.getAttribute("aria-label")).toBe("Invited");
});

test("the plan opens Plan and billing where the deployment takes payment, otherwise links to Upgrade where it names a page", async () => {
  const opened: (string | undefined)[] = [];
  let page = await render(
    <OpenBillingContext.Provider value={{ open: (organizationId) => void opened.push(organizationId), organizationId: null }}>
      <Organization />
    </OpenBillingContext.Provider>,
    backend(),
  );
  expect(navRows(page)[1]).toEqual(["Plan", "Free"]);
  await click(navRow(page, "Plan"));
  expect(opened).toEqual(["acme"]);
  await act(async () => root!.unmount());
  container!.remove();

  page = await render(<Organization />, backend({ organizationDetails: { acme: { ...asAdmin, upgradeUrl: "https://critiqs.example/plans" } } }));
  expect(navRow(page, "Plan")).toBeNull();
  const upgrade = [...page.querySelectorAll("a")].find((anchor) => anchor.textContent === "Upgrade")!;
  expect(upgrade.closest(".ds-row")!.textContent).toBe("PlanFreeUpgrade");
  expect(upgrade.getAttribute("href")).toBe("https://critiqs.example/plans");
  await act(async () => root!.unmount());
  container!.remove();

  // Without either, the plan is plain text.
  page = await render(<Organization />, backend());
  expect(page.querySelector("a")).toBeNull();
  expect(page.textContent).toContain("PlanFree");
});

test("someone in several organizations picks one first, and goes back to the list", async () => {
  const page = await render(<Organization />, backend({ organizations: [studio, acme] }));
  expect(heading(page)).toBe("Organizations");
  // The open project's organization first.
  expect(navRows(page)).toEqual([
    ["Acme", "Admin"],
    ["Studio", "Member"],
  ]);
  await click(navRow(page, "Studio"));
  expect(heading(page)).toBe("Studio");
  await click(button(page, "Back"));
  expect(heading(page)).toBe("Organizations");
});

test("leaving one of two organizations shows the other one, without a question open", async () => {
  const data = backend({ organizations: [studio, acme] });
  data.organizationChange = async (name) => {
    if (name === "removeMember") data.organizations = [studio];
  };
  const page = await render(<Organization />, data);
  await click(navRow(page, "Acme"));
  await click(navRow(page, "Dana"));
  await click(navRow(page, "Leave organization"));
  await click(button(page, "Leave"));
  expect(heading(page)).toBe("Studio");
  expect(page.querySelector('[role="alert"]')).toBeNull();
  expect(navRows(page)).toEqual([["Leave organization", null]]);
});

test("a Leave that finishes after the reviewer moved to another organization leaves that one where it is", async () => {
  const data = backend({ organizations: [studio, acme] });
  let finish = () => {};
  data.organizationChange = () => new Promise<undefined>((resolve) => (finish = () => resolve(undefined)));
  const notified: string[] = [];
  const page = await render(<Organization notify={(message) => notified.push(message)} />, data);
  await click(navRow(page, "Acme"));
  await click(navRow(page, "Dana"));
  await click(navRow(page, "Leave organization"));
  await click(button(page, "Leave"));
  await click(button(page, "Back"));
  await click(button(page, "Back"));
  await click(navRow(page, "Studio"));
  expect(heading(page)).toBe("Studio");
  data.organizations = [studio];
  await act(async () => finish());
  await settle();
  expect(heading(page)).toBe("Studio");
  expect(navRows(page)).toEqual([["Leave organization", null]]);
  expect(notified).toEqual([]);
});

test("a Leave whose organization leaves the list first, then a choice of another organization, leaves that one where it is", async () => {
  const third = { ...acme, id: "third", name: "Third" };
  const data = backend({ organizations: [studio, acme, third] });
  let finish = () => {};
  data.organizationChange = () => new Promise<undefined>((resolve) => (finish = () => resolve(undefined)));
  const notified: string[] = [];
  const dialog = <Organization notify={(message) => notified.push(message)} />;
  const page = await render(dialog, data);
  await click(navRow(page, "Acme"));
  await click(navRow(page, "Dana"));
  await click(navRow(page, "Leave organization"));
  await click(button(page, "Leave"));
  // The membership list drops Acme before the Leave itself answers, which returns the dialog to the list.
  data.organizations = [studio, third];
  await rerender(dialog, data);
  expect(heading(page)).toBe("Organizations");
  await click(navRow(page, "Studio"));
  await act(async () => finish());
  await settle();
  expect(heading(page)).toBe("Studio");
  expect(notified).toEqual([]);
});

test("a Leave that finishes after the dialog closed reports nothing and closes nothing again", async () => {
  const data = backend();
  let finish = () => {};
  data.organizationChange = () => new Promise<undefined>((resolve) => (finish = () => resolve(undefined)));
  const notified: string[] = [];
  let closed = 0;
  const dialog = <Organization notify={(message) => notified.push(message)} onClose={() => closed++} />;
  const page = await render(dialog, data);
  await click(navRow(page, "Dana"));
  await click(navRow(page, "Leave organization"));
  await click(button(page, "Leave"));
  await rerender(null, data);
  await act(async () => finish());
  await settle();
  expect(notified).toEqual([]);
  expect(closed).toBe(0);
});

test("someone removed from the organization they are looking at sees what they are still in", async () => {
  const data = backend({ organizations: [studio, acme] });
  const page = await render(<Organization />, data);
  await click(navRow(page, "Studio"));
  expect(heading(page)).toBe("Studio");
  data.organizations = [acme];
  await rerender(<Organization />, data);
  expect(heading(page)).toBe("Acme");
  expect(page.querySelector(".error")).toBeNull();
});

test("someone removed while asked whether to leave goes back to the list of the organizations still theirs", async () => {
  const third = { ...acme, id: "third", name: "Third" };
  const data = backend({ organizations: [studio, acme, third] });
  const page = await render(<Organization />, data);
  await click(navRow(page, "Studio"));
  await click(navRow(page, "Leave organization"));
  data.organizations = [acme, third];
  await rerender(<Organization />, data);
  expect(heading(page)).toBe("Organizations");
  expect(page.querySelector('[role="alert"]')).toBeNull();
  expect(navRows(page)).toEqual([
    ["Acme", "Admin"],
    ["Third", "Admin"],
  ]);
});

test("the page says when someone has no organization, and while it loads or fails", async () => {
  let page = await render(<Organization />, backend({ organizations: [] }));
  expect(page.textContent).toContain("You aren't in an organization yet.");
  await act(async () => root!.unmount());
  page = await render(<Organization />, backend({ organizationDetails: {} }));
  expect(page.textContent).toContain("Loading…");
  await act(async () => root!.unmount());
  const failing = backend();
  const transport = fakeTransport(failing);
  transport.useOrganization = () => ({ status: "error", code: "not-found", message: "This organization doesn't exist, or you aren't in it." });
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => root!.render(<TransportContext.Provider value={transport}><Organization /></TransportContext.Provider>));
  await settle();
  expect(container.querySelector(".error")!.textContent).toBe("This organization doesn't exist, or you aren't in it.");
});

async function renderSetup(data: FakeBackend, organizations: boolean) {
  return await render(
    <Setup
      backLabel="Back to comments"
      reviewer={{ id: "dana", name: "Dana", email: "dana@example.com", pictureUrl: null }}
      signedIn
      organizations={organizations}
      onSignIn={() => {}}
      configuredProjectId={null}
      browserProjectId={null}
      onUseProject={() => {}}
      onDone={() => {}}
      notify={() => {}}
    />,
    data,
  );
}
const projectName = (scope: ParentNode) => scope.querySelector<HTMLInputElement>('input[placeholder="For example, Admin console prototype"]');

test("setup creates a project in the home organization unless the person picks another of theirs", async () => {
  const data = backend({ project: undefined, organizations: [studio, acme] });
  const setup = await renderSetup(data, true);
  expect(select(setup, "Organization")!.textContent).toBe("Acme");
  await type(projectName(setup), "Studio prototype");
  await choose(setup, "Organization", "Studio");
  await submit(setup, "Create project");
  expect(data.calls).toEqual([{ name: "createProject", args: { name: "Studio prototype", reviewUrl: null, organizationId: "studio" } }]);
});

test("setup's name field holds at most as many characters as a project's name can have", async () => {
  const setup = await renderSetup(backend({ project: undefined, organizations: [acme] }), true);
  expect(projectName(setup)!.maxLength).toBe(200);
});

test("setup forgets a picked organization the person is no longer in", async () => {
  const data = backend({ project: undefined, organizations: [studio, acme] });
  const node = (
    <Setup
      backLabel="Back to comments"
      reviewer={{ id: "dana", name: "Dana", email: "dana@example.com", pictureUrl: null }}
      signedIn
      organizations
      onSignIn={() => {}}
      configuredProjectId={null}
      browserProjectId={null}
      onUseProject={() => {}}
      onDone={() => {}}
      notify={() => {}}
    />
  );
  const setup = await render(node, data);
  await type(projectName(setup), "Pilot");
  await choose(setup, "Organization", "Studio");
  data.organizations = [acme];
  await rerender(node, data);
  await submit(setup, "Create project");
  expect(data.calls).toEqual([{ name: "createProject", args: { name: "Pilot", reviewUrl: null, organizationId: "acme" } }]);
});

test("setup offers no choice to someone in one organization, and a backend without members gets none", async () => {
  const data = backend({ project: undefined });
  let setup = await renderSetup(data, true);
  expect(select(setup, "Organization")).toBeNull();
  await type(projectName(setup), "Pilot");
  await submit(setup, "Create project");
  await act(async () => root!.unmount());
  data.organizations = [acme, studio];
  setup = await renderSetup(data, false);
  expect(select(setup, "Organization")).toBeNull();
  await type(projectName(setup), "Pilot");
  await submit(setup, "Create project");
  expect(data.calls).toEqual([
    { name: "createProject", args: { name: "Pilot", reviewUrl: null, organizationId: "acme" } },
    { name: "createProject", args: { name: "Pilot", reviewUrl: null } },
  ]);
});

test("the project panel calls an admin who didn't create the project its owner", async () => {
  localStorage.setItem("critiqs:sidebar-open", "true");
  const shadow = await mount(backend({ project: { _id: "project", name: "Pilot", tags: [], createdAt: 1, reviewUrl: null, isOwner: true, organization: { id: "acme", name: "Acme", role: "admin" } } }));
  expect(shadow.querySelector('section[aria-label="Who has access"]')!.textContent).toContain("Dana (you, project owner)");
});
