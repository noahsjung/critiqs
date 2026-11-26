import type { OrganizationDetails, OrganizationMember, OrganizationRole, OrganizationSummary, OrganizationUsage, ProjectInfo } from "@critiqs/core";
import { fail } from "./errors.ts";
import {
  ALSO_PER_PROJECT,
  addUsage,
  countWithinAll,
  DEFAULT_PLAN,
  ORGANIZATION_METRICS,
  type OrganizationPlan,
  PERIODS,
  type PlanHolder,
  planExists,
  planFor,
  usageDay,
  usageKey,
  upgradeOf,
  usageSummary,
  utcDay,
} from "./limits.ts";
import { isLocalReviewAddress } from "./notify.ts";
import { currentReviewer, requireUser } from "./operations.ts";
import { escapeHtml, type MailMessage, normalizeEmail } from "./signin.ts";
import type { Identity, MembershipRecord, OrganizationRecord, OverageCapChoice, ProjectRecord, Store, UserRecord } from "./store.ts";

// Organizations own projects and the Critiqs Cloud plan.

/** Whose plan covers something, and the ID its organization-wide usage counts under. */
interface Account extends PlanHolder {
  id: string;
}

/** A person's home organization; see `standIn` for someone the backfill hasn't reached yet. */
async function homeOf(store: Store, userId: string): Promise<{ account: Account; organization: OrganizationRecord | null }> {
  const user = await store.users.get(userId);
  const organization = await storedHome(store, user);
  return organization === null ? standIn(userId, user) : { account: accountOf(organization), organization };
}

async function storedHome(store: Store, user: UserRecord | null): Promise<OrganizationRecord | null> {
  return user?.homeOrganizationId === undefined ? null : await store.organizations.get(user.homeOrganizationId);
}

async function isMember(store: Store, organization: OrganizationRecord, userId: string): Promise<boolean> {
  return (await store.memberships.find(organization._id, userId)) !== null;
}

/**
 * Someone who set up projects before organizations, until the backfill
 * (`organizations:backfill` on Convex; SQLite backfills while migrating)
 * gives them a home organization, stands in for it: they are its admin
 * (`roleIn`), their own plan applies, and organization-wide usage counts
 * under their ID, as before. Delete this, and the `organization: null` cases,
 * once Critiqs Cloud is backfilled.
 */
function standIn(userId: string, user: UserRecord | null): { account: Account; organization: null } {
  return { account: { id: userId, ...(user?.plan === undefined ? {} : { plan: user.plan }) }, organization: null };
}

function accountOf({ _id, plan, overageCap, extraStorageUnits }: OrganizationRecord): Account {
  return { id: _id, plan, overageCap, extraStorageUnits };
}

async function projectOrganization(store: Store, project: ProjectRecord): Promise<{ account: Account; organization: OrganizationRecord | null }> {
  const organization = project.organizationId === undefined ? null : await store.organizations.get(project.organizationId);
  return organization !== null ? { account: accountOf(organization), organization } : await homeOf(store, project.createdBy);
}

async function roleIn(store: Store, project: ProjectRecord, organization: OrganizationRecord | null, userId: string): Promise<OrganizationRole | null> {
  if (organization === null) return userId === project.createdBy ? "admin" : null;
  return (await store.memberships.find(organization._id, userId))?.role ?? null;
}

/** Whether a person may manage a project: change its settings, organize its tags, see its usage. */
export type ProjectAccess = "manage" | null;

/**
 * What a person may do with a project, and its organization when they belong
 * to it. Admins of the project's organization manage it, and so does its
 * creator while still a member.
 */
export async function projectRole(
  store: Store,
  project: ProjectRecord,
  userId: string | null,
): Promise<{ access: ProjectAccess; organization: NonNullable<ProjectInfo["organization"]> | null }> {
  if (userId === null) return { access: null, organization: null };
  const { organization } = await projectOrganization(store, project);
  const role = await roleIn(store, project, organization, userId);
  return {
    access: role === "admin" || (role !== null && project.createdBy === userId) ? "manage" : null,
    organization: organization === null || role === null ? null : { id: organization._id, name: organization.name, role },
  };
}

export async function projectAccess(store: Store, project: ProjectRecord, userId: string | null): Promise<ProjectAccess> {
  return (await projectRole(store, project, userId)).access;
}

/** The plan covering something, and where its organization-wide usage counts. */
export interface Coverage {
  plan: OrganizationPlan | null;
  /** The organization, or the person standing in for one. */
  accountId: string;
  /** The organization itself; null for a stand-in. */
  organizationId: string | null;
}

export async function projectQuota(store: Store, project: ProjectRecord): Promise<Coverage & { projectId: string }> {
  const { account, organization } = await projectOrganization(store, project);
  return { plan: await planFor(store, account), accountId: account.id, organizationId: organization?._id ?? null, projectId: project._id };
}

/**
 * What covers a person's own Critiqs AI: their home organization while they
 * belong to it, otherwise the default plan, counted under the person.
 */
export async function personalQuota(store: Store, userId: string): Promise<Coverage> {
  const { account, organization } = await homeOf(store, userId);
  if (organization === null || (await isMember(store, organization, userId))) {
    return { plan: await planFor(store, account), accountId: account.id, organizationId: organization?._id ?? null };
  }
  return { plan: await planFor(store, null), accountId: userId, organizationId: null };
}

/**
 * The person's home organization, where their new projects go. Someone with
 * none, or removed from theirs, gets a new one with them as its admin.
 * Someone from before organizations keeps their plan, and the projects they
 * set up stay counted against it. One transaction; running it again changes
 * nothing.
 */
export async function homeOrganization(store: Store, user: UserRecord, now: number): Promise<OrganizationRecord> {
  const existing = await storedHome(store, user);
  if (existing !== null && (await isMember(store, existing, user._id))) return existing;
  const fromBefore = user.homeOrganizationId === undefined;
  const record: Omit<OrganizationRecord, "_id"> = {
    name: `${user.name.trim() || user.email || "Critiqs"}'s organization`,
    createdBy: user._id,
    createdAt: now,
    ...(fromBefore && user.plan !== undefined ? { plan: user.plan } : {}),
  };
  const organizationId = await store.organizations.insert(record);
  await store.memberships.insert({ organizationId, userId: user._id, role: "admin", createdAt: now });
  await store.users.patch(user._id, { homeOrganizationId: organizationId });
  if (fromBefore) {
    const day = utcDay(now);
    for (const metric of ORGANIZATION_METRICS) {
      // Images come with each project as it moves in (`adoptProject`).
      if (ALSO_PER_PROJECT.includes(metric)) continue;
      for (const period of PERIODS) {
        const counted = await store.usage.find(usageKey(metric, period, user._id, day));
        if (counted !== null) await addUsage(store, usageKey(metric, period, organizationId, day), counted.count);
      }
    }
  }
  return { _id: organizationId, ...record };
}

/**
 * Moves one project from before organizations into its creator's home
 * organization, creating it if needed. Returns whether anything changed.
 */
export async function adoptProject(store: Store, projectId: string, now: number): Promise<boolean> {
  const project = await store.projects.get(projectId);
  if (project === null || project.organizationId !== undefined) return false;
  const creator = await store.users.get(project.createdBy);
  if (creator === null) return false;
  const organization = (await storedHome(store, creator)) ?? (await homeOrganization(store, creator, now));
  await store.projects.patch(project._id, { organizationId: organization._id });
  // Images count per organization now; the project's stored images come with it.
  const day = utcDay(now);
  const stored = await store.usage.find(usageKey("captureBytes", "total", project._id, day));
  if (stored !== null) await addUsage(store, usageKey("captureBytes", "total", organization._id, day), stored.count);
  return true;
}

/**
 * Sets an organization's stored image bytes to the sum of what its projects
 * (`projectIds`) store: images stored before they counted per organization
 * were counted only per project. Returns whether anything changed; running
 * it again changes nothing.
 */
export async function recountStorage(store: Store, organizationId: string, projectIds: string[], now: number): Promise<boolean> {
  const day = utcDay(now);
  let total = 0;
  for (const projectId of projectIds) total += (await store.usage.find(usageKey("captureBytes", "total", projectId, day)))?.count ?? 0;
  const key = usageKey("captureBytes", "total", organizationId, day);
  const counter = await store.usage.find(key);
  if ((counter?.count ?? 0) === total) return false;
  if (counter === null) await store.usage.insert({ key, count: total });
  else await store.usage.patch(counter._id, { count: total });
  return true;
}

/** Gives a person whose plan was set before organizations a home organization holding it. Returns whether anything changed. */
export async function adoptPlan(store: Store, userId: string, now: number): Promise<boolean> {
  const user = await store.users.get(userId);
  if (user?.plan === undefined || user.homeOrganizationId !== undefined) return false;
  await homeOrganization(store, user, now);
  return true;
}

/**
 * Moves an organization to another plan, such as after an upgrade: named
 * directly, or as the organization of one of its projects. A cap an admin
 * chose on extra credits doesn't carry over: the new plan's default applies.
 * Assigning the plan it already has changes nothing. For operators.
 */
export async function assignPlan(store: Store, args: { organizationId?: string; projectId?: string; plan: string }, now: number): Promise<void> {
  if (!(await planExists(store, args.plan))) throw new Error(`There is no plan named "${args.plan}".`);
  let organizationId = args.organizationId;
  if (args.projectId !== undefined) {
    await adoptProject(store, args.projectId, now);
    const owner = (await store.projects.get(args.projectId))?.organizationId;
    if (owner === undefined) throw new Error("There is no such project.");
    if (organizationId !== undefined && organizationId !== owner) throw new Error("That project belongs to another organization.");
    organizationId = owner;
  }
  if (organizationId === undefined) throw new Error("Name the organization by organizationId or by one of its projects (projectId).");
  const organization = await store.organizations.get(organizationId);
  if (organization === null) throw new Error("There is no such organization.");
  if ((organization.plan ?? DEFAULT_PLAN) === args.plan) return;
  await store.organizations.patch(organizationId, { plan: args.plan, overageCap: "default" });
}

/** Most extra Critiqs AI credits an admin may allow in a month. */
export const MAX_OVERAGE_CAP = 100_000_000;

/**
 * Sets how many Critiqs AI credits past the plan's an organization may use
 * each month, billed as extra; null allows any, and `default` goes back to
 * the plan's default. For the organization's admins.
 */
export async function setOverageCap(store: Store, identity: Identity | null, args: { organizationId: string; cap: OverageCapChoice }): Promise<void> {
  // Outsiders have always been refused with `forbidden` here, not told it isn't found.
  const { organization } = await requireAdmin(store, identity, args.organizationId, "forbidden");
  if (typeof args.cap === "number" && !(Number.isInteger(args.cap) && args.cap >= 0 && args.cap <= MAX_OVERAGE_CAP)) {
    fail("invalid", `The cap must be a whole number of credits from 0 to ${MAX_OVERAGE_CAP.toLocaleString("en-US")}, none, or the plan's default.`);
  }
  await store.organizations.patch(organization._id, { overageCap: args.cap });
}

/**
 * What an organization's plan limits for the whole organization, with usage
 * in the periods containing `day`, for its members; null without plans.
 */
export async function getOrganizationUsage(store: Store, identity: Identity | null, args: { organizationId: string; day?: string }): Promise<OrganizationUsage | null> {
  const { user } = await currentReviewer(store, identity);
  const organization = await store.organizations.get(args.organizationId);
  if (organization === null || user === null || !(await isMember(store, organization, user._id))) fail("forbidden", "Only members of the organization can see its usage.");
  const usage = await usageSummary(store, { plan: await planFor(store, organization), accountId: organization._id, projectId: null }, usageDay(args.day, Date.now()));
  if (usage === null) return null;
  const { upgradeUrl: _, ...shown } = usage;
  const ownCredits = (await planFor(store, { ...organization, overageCap: undefined }))?.limits.find((limit) => limit.metric === "aiCredits" && limit.overage !== null);
  const defaultCap = ownCredits?.overage?.cap;
  return typeof defaultCap === "number" ? { ...shown, extraCredits: { defaultCap, usesDefault: organization.overageCap === undefined } } : shown;
}

/** Sets how many storage add-ons an organization has; each raises image storage by its plan's add-on size. For billing and operators. */
export async function setExtraStorage(store: Store, args: { organizationId: string; units: number }): Promise<void> {
  if (!(Number.isInteger(args.units) && args.units >= 0)) throw new Error("Extra storage is a whole number of units, 0 or more.");
  if ((await store.organizations.get(args.organizationId)) === null) throw new Error("There is no such organization.");
  await store.organizations.patch(args.organizationId, { extraStorageUnits: args.units });
}

/** The organizations the signed-in person belongs to, by name. */
export async function listMyOrganizations(store: Store, identity: Identity | null): Promise<OrganizationSummary[]> {
  const { user } = await currentReviewer(store, identity);
  if (user === null) return [];
  const summaries: OrganizationSummary[] = [];
  for (const membership of await store.memberships.forUser(user._id, MAX_ORGANIZATIONS)) {
    const organization = await store.organizations.get(membership.organizationId);
    if (organization === null) continue;
    const plan = await planFor(store, organization);
    summaries.push({
      id: organization._id,
      name: organization.name,
      role: membership.role,
      plan: plan?.label ?? null,
      home: organization._id === user.homeOrganizationId,
    });
  }
  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

const MAX_ORGANIZATIONS = 100;

/** Members an organization page shows, and counts admins among. */
export const MAX_MEMBERS = 500;
/** Pending invites an organization page shows. */
export const MAX_PENDING_INVITES = 200;
/** Invites one organization may send per UTC day. */
export const MAX_INVITES_PER_DAY = 50;
/** Invite emails one inbox may receive per UTC day, from all organizations. */
export const MAX_INVITE_EMAILS_PER_INBOX = 5;
/** Invite emails one deployment sends per hour. */
export const MAX_INVITE_EMAILS_PER_HOUR = 100;
const MAX_ACCEPTED = 20;
export const MAX_ORGANIZATION_NAME = 80;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const ONLY_ADMINS = "Only an organization's admins can change its name, members, or billing.";
const LAST_ADMIN = "An organization needs at least one admin. Make someone else an admin first.";

const NOT_IN_IT = "This organization doesn't exist, or you aren't in it.";

async function findMembership(store: Store, rawId: string, userId: string): Promise<{ organization: OrganizationRecord; membership: MembershipRecord } | null> {
  const id = store.normalizeId("organizations", rawId);
  const organization = id === null ? null : await store.organizations.get(id);
  const membership = organization === null ? null : await store.memberships.find(organization._id, userId);
  return organization === null || membership === null ? null : { organization, membership };
}

async function requireMembership(store: Store, rawId: string, userId: string): Promise<{ organization: OrganizationRecord; membership: MembershipRecord }> {
  return (await findMembership(store, rawId, userId)) ?? fail("not-found", NOT_IN_IT);
}

/**
 * The signed-in admin of the organization. People outside it are told it
 * isn't found, or, with `outsiders: "forbidden"`, get the same refusal as its
 * members, for calls that have always answered `forbidden`.
 */
async function requireAdmin(store: Store, identity: Identity | null, organizationId: string, outsiders: "not-found" | "forbidden" = "not-found") {
  const user = await requireUser(store, identity);
  const found = await findMembership(store, organizationId, user._id);
  if (found === null && outsiders === "not-found") fail("not-found", NOT_IN_IT);
  if (found === null || found.membership.role !== "admin") fail("forbidden", ONLY_ADMINS);
  return { user, ...found };
}

async function adminCount(store: Store, organizationId: string): Promise<number> {
  return (await store.memberships.forOrganization(organizationId, MAX_MEMBERS)).filter((membership) => membership.role === "admin").length;
}

/** An organization's name, members, and, for its admins, pending invites and members' addresses. Only its members see it. */
export async function getOrganization(store: Store, identity: Identity | null, args: { organizationId: string }): Promise<OrganizationDetails> {
  const { user } = await currentReviewer(store, identity);
  if (user === null) fail("not-found", NOT_IN_IT);
  const { organization, membership } = await requireMembership(store, args.organizationId, user._id);
  const admin = membership.role === "admin";
  const members: OrganizationMember[] = [];
  for (const each of await store.memberships.forOrganization(organization._id, MAX_MEMBERS)) {
    const person = await store.users.get(each.userId);
    if (person === null) continue;
    members.push({
      userId: person._id,
      name: person.name,
      imageUrl: person.imageUrl,
      email: admin ? person.email : null,
      role: each.role,
      you: person._id === user._id,
    });
  }
  members.sort((a, b) => a.name.localeCompare(b.name));
  const invites = [];
  if (admin) {
    for (const invite of await store.invites.pendingForOrganization(organization._id, MAX_PENDING_INVITES)) {
      const inviter = await store.users.get(invite.invitedBy);
      invites.push({ _id: invite._id, email: invite.email, role: invite.role, invitedBy: inviter?.name ?? "Someone", createdAt: invite.createdAt });
    }
  }
  const plan = await planFor(store, organization);
  return { id: organization._id, name: organization.name, role: membership.role, plan: plan?.label ?? null, members, invites, ...(plan === null ? {} : upgradeOf(store)) };
}

export async function renameOrganization(store: Store, identity: Identity | null, args: { organizationId: string; name: string }): Promise<void> {
  const { organization } = await requireAdmin(store, identity, args.organizationId);
  const name = args.name.trim().replace(/\s+/g, " ");
  if (name === "") fail("invalid", "An organization needs a name.");
  if (name.length > MAX_ORGANIZATION_NAME) fail("invalid", `An organization's name can have at most ${MAX_ORGANIZATION_NAME} characters.`);
  if (CONTROL_CHARACTERS.test(name)) fail("invalid", "An organization's name can't contain control characters.");
  if (name !== organization.name) await store.organizations.patch(organization._id, { name });
}

/** What inviting someone did: a new invite, or nothing because they are already a member or invited. */
export type InviteResult = { status: "invited"; inviteId: string } | { status: "member" } | { status: "pending" };

/**
 * Invites someone by email to join as `role`. Admins only. Inviting someone
 * who is already a member, or already invited, changes nothing. They join
 * when they next sign in with that address (`acceptInvites`).
 */
export async function inviteMember(
  store: Store,
  identity: Identity | null,
  args: { organizationId: string; email: string; role: OrganizationRole },
  now: number,
): Promise<InviteResult> {
  const { user, organization } = await requireAdmin(store, identity, args.organizationId);
  const email = normalizeEmail(args.email);
  if (email === null || email.endsWith(".") || email.includes("..") || email.includes(".@")) fail("invalid", "Enter a valid email address.");
  for (const membership of await store.memberships.forOrganization(organization._id, MAX_MEMBERS)) {
    const person = await store.users.get(membership.userId);
    if (person?.email != null && normalizeEmail(person.email) === email) return { status: "member" };
  }
  if ((await store.invites.findPending(organization._id, email)) !== null) return { status: "pending" };
  const key = `invites:${organization._id}:${utcDay(now)}`;
  if (!(await countWithinAll(store, [[key, MAX_INVITES_PER_DAY]]))) fail("limit", `This organization has sent ${MAX_INVITES_PER_DAY} invites today. Try again tomorrow.`);
  const inviteId = await store.invites.insert({ organizationId: organization._id, email, role: args.role, invitedBy: user._id, createdAt: now });
  return { status: "invited", inviteId };
}

/**
 * The inbox an address reaches, so its other spellings share one limit:
 * without a `+tag`, and for Gmail without dots.
 */
function inboxOf(email: string): string {
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at).split("+")[0]!;
  const domain = email.slice(at + 1);
  return domain === "gmail.com" || domain === "googlemail.com" ? `${local.replaceAll(".", "")}@gmail.com` : `${local}@${domain}`;
}

/** Withdraws an invite no one has accepted yet. Admins only; to anyone else it doesn't exist. */
export async function revokeInvite(store: Store, identity: Identity | null, args: { inviteId: string }): Promise<void> {
  const user = await requireUser(store, identity);
  const id = store.normalizeId("invites", args.inviteId);
  const invite = id === null ? null : await store.invites.get(id);
  const membership = invite === null || invite.acceptedAt !== undefined ? null : await store.memberships.find(invite.organizationId, user._id);
  if (invite === null || membership?.role !== "admin") fail("not-found", "This invite was already accepted or withdrawn.");
  await store.invites.delete(invite._id);
}

/** Makes a member an admin, or an admin a member. Admins only; the last admin stays one. */
export async function setMemberRole(
  store: Store,
  identity: Identity | null,
  args: { organizationId: string; userId: string; role: OrganizationRole },
): Promise<void> {
  const { organization } = await requireAdmin(store, identity, args.organizationId);
  const target = await requireMember(store, organization._id, args.userId);
  if (target.role === args.role) return;
  if (target.role === "admin" && (await adminCount(store, organization._id)) <= 1) fail("invalid", LAST_ADMIN);
  await store.memberships.patch(target._id, { role: args.role });
}

/**
 * Removes someone from an organization: an admin removes anyone, and anyone
 * may leave, except its last admin. Projects they created stay in the
 * organization. Someone whose home it was gets a new one with their next
 * project (`homeOrganization`).
 */
export async function removeMember(store: Store, identity: Identity | null, args: { organizationId: string; userId: string }): Promise<void> {
  const user = await requireUser(store, identity);
  const { organization, membership } = await requireMembership(store, args.organizationId, user._id);
  const target = await requireMember(store, organization._id, args.userId);
  if (target.userId !== user._id && membership.role !== "admin") fail("forbidden", ONLY_ADMINS);
  if (target.role === "admin" && (await adminCount(store, organization._id)) <= 1) fail("invalid", LAST_ADMIN);
  await store.memberships.delete(target._id);
}

async function requireMember(store: Store, organizationId: string, rawUserId: string): Promise<MembershipRecord> {
  const userId = store.normalizeId("users", rawUserId);
  const membership = userId === null ? null : await store.memberships.find(organizationId, userId);
  if (membership === null) fail("not-found", "That person isn't in this organization.");
  return membership;
}

/**
 * Joins every organization that invited the signed-in person's address and
 * marks those invites accepted.
 */
export async function acceptInvites(store: Store, user: UserRecord, now: number): Promise<void> {
  const email = user.email === null ? null : normalizeEmail(user.email);
  if (email === null) return;
  for (const invite of await store.invites.pendingForEmail(email, MAX_ACCEPTED)) {
    if ((await store.memberships.find(invite.organizationId, user._id)) === null) {
      await store.memberships.insert({ organizationId: invite.organizationId, userId: user._id, role: invite.role, createdAt: now });
    }
    await store.invites.patch(invite._id, { acceptedAt: now });
  }
}

/**
 * The email for a new invite, counted against its inbox's daily limit and the
 * deployment's hourly one right before it is sent. Null once the invite was
 * accepted or withdrawn, or past a limit. `projectId`, the project the
 * admin invited from, adds a link to its review address when it belongs to
 * the organization and opens beyond one computer.
 */
export async function claimInviteEmail(store: Store, args: { inviteId: string; projectId?: string | null }, now: number): Promise<MailMessage | null> {
  const invite = await store.invites.get(args.inviteId);
  if (invite === null || invite.acceptedAt !== undefined) return null;
  const organization = await store.organizations.get(invite.organizationId);
  if (organization === null) return null;
  const limits: [string, number][] = [
    [`inviteEmails:${inboxOf(invite.email)}:${utcDay(now)}`, MAX_INVITE_EMAILS_PER_INBOX],
    [`inviteEmails:hour:${Math.floor(now / 3_600_000)}`, MAX_INVITE_EMAILS_PER_HOUR],
  ];
  if (!(await countWithinAll(store, limits))) return null;
  const inviter = (await store.users.get(invite.invitedBy))?.name ?? "Someone";
  const projectId = args.projectId == null ? null : store.normalizeId("projects", args.projectId);
  const project = projectId === null ? null : await store.projects.get(projectId);
  const link = project?.organizationId === organization._id && project.reviewUrl && !isLocalReviewAddress(project.reviewUrl) ? project.reviewUrl : null;
  return inviteMessage({ to: invite.email, organization: organization.name, inviter, role: invite.role, link, idempotencyKey: `critiqs-invite:${invite._id}` });
}

const MAX_NAME_SHOWN = 80;

function inviteMessage(parts: { to: string; organization: string; inviter: string; role: OrganizationRole; link: string | null; idempotencyKey: string }): MailMessage {
  const organization = shorten(parts.organization);
  const inviter = shorten(parts.inviter);
  const as = parts.role === "admin" ? "an admin" : "a member";
  const join = `Sign in to Critiqs with this address (${parts.to}) and you'll join ${organization} automatically.`;
  const ignore = "If you didn't expect this, you can ignore this email.";
  return {
    to: parts.to,
    subject: `${inviter} invited you to ${organization} on Critiqs`,
    text: [`${inviter} invited you to join ${organization} on Critiqs as ${as}.`, join, ...(parts.link === null ? [] : [`Open the prototype: ${parts.link}`]), ignore].join("\n\n"),
    html: [
      `<p>${escapeHtml(inviter)} invited you to join <strong>${escapeHtml(organization)}</strong> on Critiqs as ${as}.</p>`,
      `<p>${escapeHtml(join)}</p>`,
      ...(parts.link === null ? [] : [`<p><a href="${escapeHtml(parts.link)}">Open the prototype</a></p>`]),
      `<p style="color:#666">${escapeHtml(ignore)}</p>`,
    ].join("\n"),
    idempotencyKey: parts.idempotencyKey,
  };
}

function shorten(text: string): string {
  const clean = text.replace(/\s+/g, " ").replace(new RegExp(CONTROL_CHARACTERS, "g"), "").trim();
  return clean.length > MAX_NAME_SHOWN ? `${clean.slice(0, MAX_NAME_SHOWN - 1)}…` : clean;
}
