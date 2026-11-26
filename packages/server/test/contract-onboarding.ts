import { expect, test } from "bun:test";
import { DEFAULT_TAGS, startingTags } from "@critiqs/core";
import { DEFAULT_PLANS, type Plan } from "../src/limits.ts";
import {
  deliverDeveloperEmail,
  getDeveloperSetup,
  getProjectSetup,
  listDeveloperSends,
  prepareDeveloperEmail,
  recordDeveloperEmail,
  reportUnwantedEmail,
  type ReservedEmail,
  reserveDeveloperSends,
} from "../src/developer-setup.ts";
import { utcDay } from "../src/limits.ts";
import { saveAboutYou } from "../src/onboarding.ts";
import * as ops from "../src/operations.ts";
import * as organizations from "../src/organizations.ts";
import { MailError, type MailMessage } from "../src/signin.ts";
import type { Identity } from "../src/store.ts";
import { type ContractBackend, reviewer } from "./contract.ts";

/**
 * Onboarding on the Critiqs website, as every backend must store it. Each
 * backend's tests call this with a fresh, empty backend per test.
 */
export function defineOnboardingContract(name: string, fresh: () => ContractBackend) {
  const dana = reviewer("Dana");

  const person = (backend: ContractBackend, who: Identity) => backend.run(async (store) => await store.users.byToken(who.tokenIdentifier));
  const project = (backend: ContractBackend, projectId: string) => backend.run(async (store) => await store.projects.get(projectId));
  const tags = async (backend: ContractBackend, projectId: string) => (await backend.run((store) => ops.getProject(store, dana, { projectId }))).tags;

  test(`${name}: "About you" saves known answers on the person; unknown ones and skipped ones change nothing`, async () => {
    const backend = fresh();
    await backend.run((store) => saveAboutYou(store, dana, { role: "designer", teamSize: "6-20" }));
    expect(await person(backend, dana)).toMatchObject({ role: "designer", teamSize: "6-20" });
    // Skipping one answer, or both, keeps what was saved.
    await backend.run((store) => saveAboutYou(store, dana, { teamSize: "just-me" }));
    await backend.run((store) => saveAboutYou(store, dana, {}));
    // Values core doesn't know are dropped, as if skipped.
    await backend.run((store) => saveAboutYou(store, dana, { role: "ceo", teamSize: "huge" }));
    expect(await person(backend, dana)).toMatchObject({ role: "designer", teamSize: "just-me" });
    // A sign-in afterwards keeps the answers.
    await backend.run((store) => ops.syncReviewer(store, { ...dana, name: "Dana Kim" }));
    expect(await person(backend, dana)).toMatchObject({ name: "Dana Kim", role: "designer", teamSize: "just-me" });
  });

  test(`${name}: skipping "About you" stores no answers, and signing in is required`, async () => {
    const backend = fresh();
    await backend.run((store) => saveAboutYou(store, dana, { role: "nope" }));
    const saved = (await person(backend, dana))!;
    expect("role" in saved || "teamSize" in saved).toBe(false);
    await expect(backend.run((store) => saveAboutYou(store, null, { role: "designer" }))).rejects.toThrow("Sign in");
    await expect(backend.run((store) => saveAboutYou(store, { ...dana, emailVerified: false }, { role: "designer" }))).rejects.toThrow("Verify");
  });

  test(`${name}: a project from onboarding keeps its answers and stack, and starts with its purpose's tags`, async () => {
    const backend = fresh();
    const projectId = await backend.run((store) =>
      ops.createProject(store, dana, {
        name: "acme-proto.vercel.app",
        reviewUrl: "https://acme-proto.vercel.app",
        onboarding: { codeAccess: "nobody", feedbackFrom: ["test-users", "team", "bogus", "team"], purpose: "qa" },
        stack: "next",
      }),
    );
    expect(await project(backend, projectId)).toMatchObject({
      name: "acme-proto.vercel.app",
      reviewUrl: "https://acme-proto.vercel.app/",
      onboarding: { codeAccess: "nobody", feedbackFrom: ["team", "test-users"], purpose: "qa", stack: "next" },
    });
    expect(await tags(backend, projectId)).toEqual([...startingTags("qa")]);
    expect(await tags(backend, projectId)).toEqual(["Bug", "Regression", "UX copy change", "User feedback"]);
  });

  test(`${name}: each purpose picks its starting tags; without one a project starts with the default tags`, async () => {
    const backend = fresh();
    for (const purpose of ["design-review", "user-testing"] as const) {
      const projectId = await backend.run((store) => ops.createProject(store, dana, { name: purpose, onboarding: { purpose } }));
      expect(await tags(backend, projectId)).toEqual([...startingTags(purpose)]);
    }
    const skipped = await backend.run((store) => ops.createProject(store, dana, { name: "Skipped", onboarding: { codeAccess: "self" } }));
    const before = await backend.run((store) => ops.createProject(store, dana, { name: "Setup panel" }));
    for (const projectId of [skipped, before]) expect(await tags(backend, projectId)).toEqual([...DEFAULT_TAGS]);
  });

  test(`${name}: unknown answers and stacks are dropped, and a project with none keeps no onboarding record`, async () => {
    const backend = fresh();
    const projectId = await backend.run((store) =>
      ops.createProject(store, dana, { name: "Odd", onboarding: { codeAccess: "maybe", feedbackFrom: ["everyone"], purpose: "fun" }, stack: "cobol" }),
    );
    expect(await tags(backend, projectId)).toEqual([...DEFAULT_TAGS]);
    expect(await project(backend, projectId)).not.toHaveProperty("onboarding");
    const stackOnly = await backend.run((store) => ops.createProject(store, dana, { name: "Stack only", onboarding: {}, stack: "vue" }));
    expect((await project(backend, stackOnly))!.onboarding).toEqual({ stack: "vue" });
  });

  test(`${name}: creating from onboarding keeps setup's rules: a name, the organization chosen, and the plan's project limit`, async () => {
    const free = DEFAULT_PLANS.free!;
    const projectLimit = free.limits.find((limit) => limit.metric === "projects")!.max;
    const backend = fresh().withPlans({ free } satisfies Record<string, Plan>);
    const create = (name: string, extra: Partial<Parameters<typeof ops.createProject>[2]> = {}) =>
      backend.run((store) => ops.createProject(store, dana, { name, onboarding: { purpose: "qa" }, stack: "react", ...extra }));
    await expect(create("   ")).rejects.toThrow("A project needs a name.");
    await expect(create("Elsewhere", { organizationId: "not-an-id" })).rejects.toThrow("only in organizations you belong to");
    // A review address emails can't link to is left out, not refused.
    const first = await create("First", { reviewUrl: "ftp://proto.example" });
    expect(await project(backend, first)).not.toHaveProperty("reviewUrl");
    for (let count = 1; count < projectLimit; count++) await create(`Project ${count}`);
    await expect(create("One too many")).rejects.toThrow("An admin of the organization can upgrade the plan.");
  });
}

/**
 * Developer setup emails, as every backend must keep them: limits, records,
 * failures, organization invites, suppression, and who may see what.
 */
export function defineDeveloperEmailContract(name: string, fresh: () => ContractBackend) {
  const dana = reviewer("Dana");
  const lee = reviewer("Lee");
  const day = Date.UTC(2026, 10, 25, 9, 0);
  const HOUR = 3_600_000;
  const links = { setupUrl: "https://critiqs.app/setup/x", reportUrl: "https://backend.example/developer-emails/report?token=t" };

  const create = (backend: ContractBackend, who: Identity = dana, extra: Partial<Parameters<typeof ops.createProject>[2]> = {}) =>
    backend.run((store) =>
      ops.createProject(store, who, {
        name: "Acme prototype",
        reviewUrl: "https://acme-proto.vercel.app",
        onboarding: { codeAccess: "nobody" },
        stack: "next",
        ...extra,
      }),
    );
  const send = (backend: ContractBackend, projectId: string, emails: string[], now = day, who: Identity = dana) =>
    backend.run((store) => reserveDeveloperSends(store, who, { projectId, emails }, now));
  const listed = (backend: ContractBackend, projectId: string, who: Identity = dana) => backend.run((store) => listDeveloperSends(store, who, { projectId }));
  const counter = async (backend: ContractBackend, key: string) => (await backend.run((store) => store.usage.find(key)))?.count ?? 0;

  /**
   * Delivers reserved emails at `now` through a mail service that answers
   * with `answer`, returning what it was asked to send. `refused` is a
   * confirmed refusal, such as 422 or 429; `no-answer` never answers.
   */
  async function deliver(backend: ContractBackend, reserved: ReservedEmail[], answer: "ok" | "refused" | "no-answer" = "ok", now = day) {
    const asked: MailMessage[] = [];
    const outcomes = [];
    for (const job of reserved) {
      outcomes.push(
        await deliverOne(backend, job, now, async (message) => {
          asked.push(message);
          if (answer === "refused") throw refused429();
          if (answer === "no-answer") throw new MailError("The email service couldn't be reached.");
        }),
      );
    }
    return { asked, outcomes };
  }

  /** Delivers one reserved email at `now`, through `mail`. */
  const deliverOne = (backend: ContractBackend, { sendId, idempotencyKey }: ReservedEmail, now: number, mail: (message: MailMessage) => Promise<void>) =>
    deliverDeveloperEmail({
      prepare: () => backend.run((store) => prepareDeveloperEmail(store, { sendId, idempotencyKey, ...links }, now)),
      send: mail,
      record: (attempt, answer) => backend.run((store) => recordDeveloperEmail(store, { sendId, idempotencyKey, attempt, answer })),
    });
  const refused429 = () => new MailError("The email service refused the message (429).", { confirmed: true });

  test(`${name}: a project sends setup steps to at most 3 developers, one email each, with a result per address`, async () => {
    const backend = fresh();
    const projectId = await create(backend);
    const first = await send(backend, projectId, ["Sam@Acme.com", "not an address", "kim@acme.com"]);
    expect(first.results).toEqual([
      { email: "sam@acme.com", status: "sent", sendId: expect.any(String), invite: "created" },
      { email: "not an address", status: "invalid", message: "Enter a valid email address." },
      { email: "kim@acme.com", status: "sent", sendId: expect.any(String), invite: "created" },
    ]);
    expect(first.reserved.map((each) => each.idempotencyKey)).toEqual(first.reserved.map((each) => `critiqs-developer:${each.sendId}:0`));
    await deliver(backend, first.reserved);
    const again = await send(backend, projectId, ["sam@acme.com", "lou@acme.com", "max@acme.com"], day + HOUR);
    expect(again.results).toEqual([
      { email: "sam@acme.com", status: "already-sent", sendId: first.reserved[0]!.sendId },
      { email: "lou@acme.com", status: "sent", sendId: expect.any(String), invite: "created" },
      { email: "max@acme.com", status: "limit", limit: "developers", message: "A project can send setup steps to 3 developers. Copy the message instead." },
    ]);
    expect((await listed(backend, projectId)).map((each) => [each.email, each.status, each.lastSentAt])).toEqual([
      ["sam@acme.com", "sent", day],
      ["kim@acme.com", "sent", day],
      ["lou@acme.com", "uncertain", day + HOUR],
    ]);
    // The refused address left no record and used none of its inbox's emails.
    expect(await counter(backend, `inviteEmails:max@acme.com:${utcDay(day)}`)).toBe(0);
    await expect(send(backend, projectId, ["a@acme.com", "b@acme.com", "c@acme.com", "d@acme.com"])).rejects.toThrow("Send to 1 to 3 developers at a time.");
    await expect(send(backend, projectId, [])).rejects.toThrow("Send to 1 to 3 developers at a time.");
  });

  test(`${name}: the same address twice in one request, in any case, is one email, counted once`, async () => {
    const backend = fresh();
    const projectId = await create(backend);
    const { results, reserved } = await send(backend, projectId, ["sam@acme.com", " Sam@Acme.com"]);
    expect(results.map((each) => [each.status, each.status === "sent" && each.sendId, each.status === "sent" && each.invite])).toEqual([
      ["sent", reserved[0]!.sendId, "created"],
      ["sent", reserved[0]!.sendId, "created"],
    ]);
    expect(reserved).toHaveLength(1);
    expect(await counter(backend, `inviteEmails:sam@acme.com:${utcDay(day)}`)).toBe(1);
  });

  test(`${name}: one person sends at most 5 developer emails a UTC day, across projects; a refusal counts nothing`, async () => {
    const backend = fresh();
    const one = await create(backend);
    const two = await create(backend, dana, { name: "Second" });
    expect((await send(backend, one, ["a@acme.com", "b@acme.com", "c@acme.com"])).results.map((each) => each.status)).toEqual(["sent", "sent", "sent"]);
    const second = await send(backend, two, ["d@acme.com", "e@acme.com", "f@acme.com"], day + HOUR);
    expect(second.results.map((each) => each.status)).toEqual(["sent", "sent", "limit"]);
    expect(second.results[2]).toMatchObject({ limit: "person", message: "You've sent 5 developer emails today. Copy the message instead." });
    expect((await listed(backend, two)).map((each) => each.email)).toEqual(["d@acme.com", "e@acme.com"]);
    expect(await counter(backend, `inviteEmails:f@acme.com:${utcDay(day)}`)).toBe(0);
    expect(await counter(backend, `inviteEmails:hour:${Math.floor((day + HOUR) / HOUR)}`)).toBe(2);
    // Someone else's day is their own, and the next UTC day starts again.
    const lees = await create(backend, lee);
    expect((await send(backend, lees, ["f@acme.com"], day + HOUR, lee)).results[0]!.status).toBe("sent");
    expect((await send(backend, two, ["f@acme.com"], Date.UTC(2026, 10, 26, 0, 0))).results[0]!.status).toBe("sent");
  });

  test(`${name}: each email counts on the UTC day it was queued, whenever it's delivered, so no day queues more than 5`, async () => {
    const backend = fresh();
    const midnight = Date.UTC(2026, 10, 26, 0, 0);
    const projects = [await create(backend), await create(backend, dana, { name: "Second" }), await create(backend, dana, { name: "Third" }), await create(backend, dana, { name: "Fourth" })];
    // Five queued in the last second of the day are delivered in the first seconds of the next.
    const late = [await send(backend, projects[0]!, ["a@acme.com", "b@acme.com", "c@acme.com"], midnight - 1000), await send(backend, projects[1]!, ["d@acme.com", "e@acme.com"], midnight - 500)];
    expect((await send(backend, projects[1]!, ["f@acme.com"], midnight - 1)).results[0]).toMatchObject({ status: "limit", limit: "person" });
    const delivered = await Promise.all(late.map((each) => deliver(backend, each.reserved, "ok", midnight + 2000)));
    expect(delivered.flatMap((each) => each.outcomes)).toEqual(["sent", "sent", "sent", "sent", "sent"]);
    // The new day has all 5 of its own, and no more.
    const next = [await send(backend, projects[2]!, ["g@acme.com", "h@acme.com", "i@acme.com"], midnight + 3000), await send(backend, projects[3]!, ["j@acme.com", "k@acme.com", "l@acme.com"], midnight + 4000)];
    expect(next.flatMap((each) => each.results.map((result) => result.status))).toEqual(["sent", "sent", "sent", "sent", "sent", "limit"]);
    const sender = (await backend.run((store) => store.users.byToken(dana.tokenIdentifier)))!._id;
    expect([await counter(backend, `developerEmails:${sender}:${utcDay(midnight - 1)}`), await counter(backend, `developerEmails:${sender}:${utcDay(midnight)}`)]).toEqual([5, 5]);
  });

  test(`${name}: developer and invite emails share each inbox's day and the deployment's hour`, async () => {
    const backend = fresh();
    const projectId = await create(backend);
    const organizationId = (await backend.run((store) => ops.getProject(store, dana, { projectId }))).organization!.id;
    // Five invite emails reach Sam's inbox today, through other spellings too.
    for (const [index, spelling] of ["sam@gmail.com", "s.am@gmail.com", "sam+1@gmail.com", "SAM@googlemail.com", "sa.m+2@gmail.com"].entries()) {
      const invited = await backend.run((store) => organizations.inviteMember(store, dana, { organizationId, email: spelling, role: "member" }, day));
      if (invited.status !== "invited") throw new Error(`expected an invite, got ${invited.status}`);
      expect([index, await backend.run((store) => organizations.claimInviteEmail(store, { inviteId: invited.inviteId }, day))]).toEqual([index, expect.anything()]);
      await backend.run((store) => organizations.revokeInvite(store, dana, { inviteId: invited.inviteId }));
    }
    const [full] = (await send(backend, projectId, ["sam@gmail.com"], day + HOUR)).results;
    expect(full).toMatchObject({ status: "limit", limit: "inbox" });
    // A developer email counts toward the inbox's day that invite emails count against.
    await send(backend, projectId, ["kim@acme.com"], day);
    expect(await counter(backend, `inviteEmails:kim@acme.com:${utcDay(day)}`)).toBe(1);
    // The deployment's hour, full of invite emails, refuses developer emails until the next hour.
    const hour = Math.floor((day + 2 * HOUR) / HOUR);
    await backend.run((store) => store.usage.insert({ key: `inviteEmails:hour:${hour}`, count: organizations.MAX_INVITE_EMAILS_PER_HOUR }));
    expect((await send(backend, projectId, ["lou@acme.com"], day + 2 * HOUR)).results[0]).toMatchObject({ status: "limit", limit: "deployment" });
    expect((await send(backend, projectId, ["lou@acme.com"], day + 3 * HOUR)).results[0]!.status).toBe("sent");
  });

  test(`${name}: a confirmed failure shows failed, doesn't use the developer's email, and still counts toward the day`, async () => {
    const backend = fresh();
    const projectId = await create(backend);
    const first = await send(backend, projectId, ["sam@acme.com"]);
    expect((await deliver(backend, first.reserved, "refused")).outcomes).toEqual(["failed"]);
    expect((await listed(backend, projectId))[0]).toMatchObject({ status: "failed" });
    // Sending again sends a new email at once, under a new key, on the same record.
    const retry = await send(backend, projectId, ["sam@acme.com"], day + 60_000);
    expect(retry.results[0]).toMatchObject({ status: "sent", sendId: first.reserved[0]!.sendId });
    expect(retry.reserved[0]!.idempotencyKey).toBe(`critiqs-developer:${first.reserved[0]!.sendId}:1`);
    await deliver(backend, retry.reserved);
    expect((await send(backend, projectId, ["sam@acme.com"], day + 2 * HOUR)).results[0]!.status).toBe("already-sent");
    expect(await counter(backend, `developerEmails:${(await backend.run((store) => store.users.byToken(dana.tokenIdentifier)))!._id}:${utcDay(day)}`)).toBe(2);
    expect(await counter(backend, `inviteEmails:sam@acme.com:${utcDay(day)}`)).toBe(2);
  });

  test(`${name}: an unknown result counts, and sending again retries it under the same key and the same email`, async () => {
    const backend = fresh();
    const projectId = await create(backend);
    const first = await send(backend, projectId, ["sam@acme.com"]);
    const lost = await deliver(backend, first.reserved, "no-answer");
    expect(lost.outcomes).toEqual(["uncertain"]);
    expect((await listed(backend, projectId))[0]).toMatchObject({ status: "uncertain" });
    // The project's name changes; the retry still sends exactly the first request.
    const retry = await send(backend, projectId, ["sam@acme.com"], day + HOUR);
    // The first send invited Sam to the organization, so the invite is now pending.
    expect(retry.results[0]).toMatchObject({ status: "sent", sendId: first.reserved[0]!.sendId, invite: "pending" });
    expect(retry.reserved).toEqual(first.reserved);
    const again = await deliver(backend, retry.reserved, "ok", day + HOUR);
    expect(again.asked).toEqual(lost.asked);
    // It went out when the mail service took it.
    expect((await listed(backend, projectId))[0]).toMatchObject({ status: "sent", lastSentAt: day + HOUR });
    // Retrying used no limit.
    expect(await counter(backend, `inviteEmails:sam@acme.com:${utcDay(day)}`)).toBe(1);
    // A late refusal for the lost attempt, or a second answer for the accepted one, changes nothing.
    for (const attempt of [0, 1]) await backend.run((store) => recordDeveloperEmail(store, { ...first.reserved[0]!, attempt, answer: "refused" }));
    expect((await listed(backend, projectId))[0]).toMatchObject({ status: "sent" });
    expect(await backend.run((store) => prepareDeveloperEmail(store, { ...first.reserved[0]!, ...links }, day + HOUR))).toBeNull();
  });

  test(`${name}: after an attempt goes unanswered, a refused retry leaves the email uncertain, under the same key`, async () => {
    const backend = fresh();
    const projectId = await create(backend);
    // The mail service takes the first request, but its answer is lost.
    const first = await send(backend, projectId, ["sam@acme.com"]);
    expect((await deliver(backend, first.reserved, "no-answer")).outcomes).toEqual(["uncertain"]);
    // Sending again retries under the same key, and the mail service rate-limits it (429): it may still have the first.
    const retry = await send(backend, projectId, ["sam@acme.com"], day + 60_000);
    expect(retry.reserved).toEqual(first.reserved);
    expect((await deliver(backend, retry.reserved, "refused", day + 60_000)).outcomes).toEqual(["uncertain"]);
    expect((await listed(backend, projectId))[0]).toMatchObject({ status: "uncertain" });
    // So sending again still retries the first email, never a second under a new key.
    const again = await send(backend, projectId, ["sam@acme.com"], day + 120_000);
    expect(again.reserved).toEqual(first.reserved);
    const { asked } = await deliver(backend, again.reserved, "ok", day + 120_000);
    expect(asked.map((email) => email.idempotencyKey)).toEqual([first.reserved[0]!.idempotencyKey]);
    expect((await listed(backend, projectId))[0]).toMatchObject({ status: "sent" });
    expect(await counter(backend, `inviteEmails:sam@acme.com:${utcDay(day)}`)).toBe(1);
  });

  test(`${name}: a retry is never sent past its key's 24 hours from the first try, and the email stays counted`, async () => {
    const backend = fresh();
    const projectId = await create(backend);
    const first = await send(backend, projectId, ["sam@acme.com"]);
    await deliver(backend, first.reserved, "no-answer", day);
    // A retry queued before the key's 24 hours run out, delivered after them, isn't sent: the mail service would have forgotten the key.
    const queued = await send(backend, projectId, ["sam@acme.com"], day + 22 * HOUR);
    expect(queued.reserved).toEqual(first.reserved);
    for (const late of [day + 24 * HOUR + 1000, day + 23 * HOUR + 1000]) {
      const outcome = await deliver(backend, queued.reserved, "ok", late);
      expect([late, outcome.outcomes, outcome.asked]).toEqual([late, ["skipped"], []]);
    }
    expect((await listed(backend, projectId))[0]).toMatchObject({ status: "uncertain", lastSentAt: day });
    // Retries stop an hour before the key runs out, so a slow request can't arrive after it; sending again then sends nothing.
    expect(await send(backend, projectId, ["sam@acme.com"], day + 23 * HOUR)).toEqual({
      results: [{ email: "sam@acme.com", status: "already-sent", sendId: first.reserved[0]!.sendId }],
      reserved: [],
    });
  });

  test(`${name}: only an admin's send invites the developer to the organization, as a member, with no invite email`, async () => {
    const backend = fresh();
    const projectId = await create(backend);
    const organizationId = (await backend.run((store) => ops.getProject(store, dana, { projectId }))).organization!.id;
    const pending = async () => (await backend.run((store) => organizations.getOrganization(store, dana, { organizationId }))).invites.map((each) => [each.email, each.role]);
    // Already invited: no second invite; already a member: none.
    await backend.run((store) => organizations.inviteMember(store, dana, { organizationId, email: "kim@acme.com", role: "admin" }, day));
    const riley = reviewer("Riley");
    const rileyInvite = await backend.run((store) => organizations.inviteMember(store, dana, { organizationId, email: riley.email!, role: "member" }, day));
    expect(rileyInvite.status).toBe("invited");
    await backend.run((store) => ops.syncReviewer(store, riley));
    const { results, reserved } = await send(backend, projectId, ["sam@acme.com", "kim@acme.com", riley.email!]);
    expect(results.map((each) => [each.email, each.status === "sent" && each.invite])).toEqual([
      ["sam@acme.com", "created"],
      ["kim@acme.com", "pending"],
      ["riley@example.com", "member"],
    ]);
    expect(await pending()).toEqual([
      ["kim@acme.com", "admin"],
      ["sam@acme.com", "member"],
    ]);
    const { asked } = await deliver(backend, reserved);
    expect(asked.map((email) => [email.to, email.text.includes("to join Dana's organization")])).toEqual([
      ["sam@acme.com", true],
      ["kim@acme.com", true],
      ["riley@example.com", false],
    ]);
    // A member who isn't an admin manages the project they created, and sends, but invites no one.
    await backend.run((store) => ops.syncReviewer(store, lee));
    const leeInvite = await backend.run((store) => organizations.inviteMember(store, dana, { organizationId, email: lee.email!, role: "member" }, day));
    expect(leeInvite.status).toBe("invited");
    await backend.run((store) => ops.syncReviewer(store, lee));
    const leesProject = await create(backend, lee, { organizationId });
    const fromLee = await send(backend, leesProject, ["lou@acme.com"], day, lee);
    expect(fromLee.results[0]).toMatchObject({ status: "sent", invite: "none" });
    expect(await pending()).toEqual([
      ["kim@acme.com", "admin"],
      ["sam@acme.com", "member"],
    ]);
  });

  test(`${name}: retrying an unconfirmed email reports the invite as it is now, and never invites again`, async () => {
    const backend = fresh();
    const projectId = await create(backend);
    const organizationId = (await backend.run((store) => ops.getProject(store, dana, { projectId }))).organization!.id;
    const invites = async () => (await backend.run((store) => organizations.getOrganization(store, dana, { organizationId }))).invites;
    const first = await send(backend, projectId, ["sam@acme.com"]);
    expect(first.results[0]).toMatchObject({ status: "sent", invite: "created" });
    await deliver(backend, first.reserved, "no-answer");
    // Dana withdraws the invite while the email is unconfirmed.
    const [invite] = await invites();
    await backend.run((store) => organizations.revokeInvite(store, dana, { inviteId: invite!._id }));
    expect(await invites()).toEqual([]);
    const retry = await send(backend, projectId, ["sam@acme.com"], day + HOUR);
    expect(retry.reserved).toEqual(first.reserved);
    expect(retry.results[0]).toMatchObject({ status: "sent", sendId: first.reserved[0]!.sendId, invite: "none" });
    expect(await invites()).toEqual([]);
  });

  test(`${name}: past the organization's invites for the day, the setup email still goes out, without an invite`, async () => {
    const backend = fresh();
    const projectId = await create(backend);
    const organizationId = (await backend.run((store) => ops.getProject(store, dana, { projectId }))).organization!.id;
    await backend.run((store) => store.usage.insert({ key: `invites:${organizationId}:${utcDay(day)}`, count: organizations.MAX_INVITES_PER_DAY }));
    expect((await send(backend, projectId, ["sam@acme.com"])).results[0]).toMatchObject({ status: "sent", invite: "limit" });
  });

  test(`${name}: a reported inbox gets no more developer or invite emails`, async () => {
    const backend = fresh();
    const projectId = await create(backend);
    const { reserved } = await send(backend, projectId, ["sam@gmail.com"]);
    await backend.run((store) => reportUnwantedEmail(store, { sendId: reserved[0]!.sendId }, day + HOUR));
    // Reporting twice, or an unknown send, changes nothing more.
    await backend.run((store) => reportUnwantedEmail(store, { sendId: reserved[0]!.sendId }, day + HOUR));
    await backend.run((store) => reportUnwantedEmail(store, { sendId: "nope" }, day + HOUR));
    const lees = await create(backend, lee);
    expect((await send(backend, lees, ["s.a.m+work@gmail.com"], day + 30 * HOUR, lee)).results).toEqual([{ email: "s.a.m+work@gmail.com", status: "suppressed" }]);
    expect(await listed(backend, lees, lee)).toEqual([]);
    const organizationId = (await backend.run((store) => ops.getProject(store, lee, { projectId: lees }))).organization!.id;
    const invited = await backend.run((store) => organizations.inviteMember(store, lee, { organizationId, email: "sam@gmail.com", role: "member" }, day + 30 * HOUR));
    if (invited.status !== "invited") throw new Error("expected an invite");
    expect(await backend.run((store) => organizations.claimInviteEmail(store, { inviteId: invited.inviteId }, day + 30 * HOUR))).toBeNull();
  });

  test(`${name}: an email queued before its inbox opted out is never sent, prepared or not`, async () => {
    const backend = fresh();
    const projectId = await create(backend);
    // Sam's email is reserved, and Kim's first try went unanswered, so it is prepared and queued for a retry.
    const sam = await send(backend, projectId, ["sam@acme.com"]);
    const kim = await send(backend, projectId, ["kim@acme.com"]);
    await deliver(backend, kim.reserved, "no-answer");
    // Both report Critiqs's email as unwanted before the queued emails go out.
    for (const each of [sam, kim]) await backend.run((store) => reportUnwantedEmail(store, { sendId: each.reserved[0]!.sendId }, day + 60_000));
    const late = await deliver(backend, [...sam.reserved, ...kim.reserved], "ok", day + 120_000);
    expect([late.outcomes, late.asked]).toEqual([["skipped", "skipped"], []]);
    // Sam's was never tried, so it wasn't sent: failed, the status for an email that didn't go out. Kim's first try may
    // have gone out, so it stays uncertain, and isn't retried.
    expect((await listed(backend, projectId)).map((each) => [each.email, each.status])).toEqual([
      ["sam@acme.com", "failed"],
      ["kim@acme.com", "uncertain"],
    ]);
    expect((await deliver(backend, kim.reserved, "ok", day + HOUR)).asked).toEqual([]);
  });

  test(`${name}: only the people who manage a project send its setup steps or see who it sent them to`, async () => {
    const backend = fresh();
    const projectId = await create(backend);
    await expect(send(backend, projectId, ["sam@acme.com"], day, lee)).rejects.toThrow("Only the people who manage this project");
    await expect(backend.run((store) => reserveDeveloperSends(store, null, { projectId, emails: ["sam@acme.com"] }, day))).rejects.toThrow("Sign in");
    await expect(send(backend, "not-a-project", ["sam@acme.com"])).rejects.toThrow("This project does not exist.");
    await expect(listed(backend, projectId, lee)).rejects.toThrow("Only the people who manage this project");
    expect(await listed(backend, projectId)).toEqual([]);
  });

  test(`${name}: a setup link shows the project to the developer it was sent to, and to no one else`, async () => {
    const backend = fresh();
    const projectId = await create(backend);
    const notInstallable = await create(backend, dana, { name: "Nuxt app", stack: "nuxt" });
    const unknown = await create(backend, dana, { name: "Unknown", stack: undefined, reviewUrl: null });
    const sendIds: string[] = [];
    for (const each of [projectId, notInstallable, unknown]) sendIds.push((await send(backend, each, ["sam@example.com"])).reserved[0]!.sendId);
    const sam = reviewer("Sam");
    const shown = (who: Identity, sendId: string) => backend.run((store) => getDeveloperSetup(store, who, { sendId }));
    expect(await shown(sam, sendIds[0]!)).toEqual({
      projectId,
      projectName: "Acme prototype",
      address: "https://acme-proto.vercel.app/",
      stack: { id: "next", label: "Next.js", installable: true },
      installCommands: ["npm install critiqs-react", `npx critiqs-react init ${projectId}`],
      inviterName: "Dana",
    });
    expect(await shown(sam, sendIds[1]!)).toMatchObject({ stack: { id: "nuxt", installable: false }, installCommands: null });
    expect(await shown(sam, sendIds[2]!)).toMatchObject({ address: null, stack: null, installCommands: ["npm install critiqs-react", `npx critiqs-react init ${unknown}`] });
    // The project's owners see it too.
    expect((await shown(dana, sendIds[0]!)).projectName).toBe("Acme prototype");
    // Anyone else, and a send that doesn't exist, get the same answer.
    const missing = "This setup link doesn't exist, or it was sent to another address.";
    await expect(shown(lee, sendIds[0]!)).rejects.toThrow(missing);
    await expect(shown(lee, "not-a-send")).rejects.toThrow(missing);
    await expect(shown(sam, projectId)).rejects.toThrow(missing);
    await expect(backend.run((store) => getDeveloperSetup(store, null, { sendId: sendIds[0]! }))).rejects.toThrow("Sign in");
  });

  test(`${name}: a project's setup page shows any signed-in reviewer the project, and its saved stack only to the people who manage it`, async () => {
    const backend = fresh();
    const projectId = await create(backend);
    const nuxt = await create(backend, dana, { name: "Nuxt app", stack: "nuxt" });
    const unknown = await create(backend, dana, { name: "Unknown", stack: undefined, reviewUrl: null });
    const shown = (who: Identity | null, id: string) => backend.run((store) => getProjectSetup(store, who, { projectId: id }));
    // The people who manage it see its saved stack and the commands for it.
    expect(await shown(dana, projectId)).toEqual({
      projectId,
      projectName: "Acme prototype",
      address: "https://acme-proto.vercel.app/",
      stack: { id: "next", label: "Next.js", installable: true },
      installCommands: ["npm install critiqs-react", `npx critiqs-react init ${projectId}`],
    });
    expect(await shown(dana, nuxt)).toMatchObject({ projectName: "Nuxt app", stack: { id: "nuxt", label: "Nuxt", installable: false }, installCommands: null });
    expect(await shown(dana, unknown)).toMatchObject({ address: null, stack: null, installCommands: ["npm install critiqs-react", `npx critiqs-react init ${unknown}`] });
    // Anyone else signed in with the project's ID, like `getProject`, sees it as if its stack were unknown.
    expect(await shown(lee, projectId)).toEqual({
      projectId,
      projectName: "Acme prototype",
      address: "https://acme-proto.vercel.app/",
      stack: null,
      installCommands: ["npm install critiqs-react", `npx critiqs-react init ${projectId}`],
    });
    expect(await shown(lee, nuxt)).toMatchObject({ stack: null, installCommands: ["npm install critiqs-react", `npx critiqs-react init ${nuxt}`] });
    await expect(shown(null, projectId)).rejects.toThrow("Sign in");
    await expect(shown({ ...lee, emailVerified: false }, projectId)).rejects.toThrow("Verify");
    await expect(shown(lee, "not-a-project")).rejects.toThrow("This project does not exist.");
    // Limited to its organization, it follows "Who can review": members still see it, anyone else is refused.
    await backend.run((store) => ops.setReviewAccess(store, dana, { projectId, reviewAccess: "organization" }));
    expect(await shown(dana, projectId)).toMatchObject({ projectId, stack: { id: "next" } });
    await expect(shown(lee, projectId)).rejects.toThrow("limited to members of its organization");
  });

  test(`${name}: a setup link opens only for the exact address it was sent to, ignoring case and spaces, not another +tag of the same inbox`, async () => {
    const backend = fresh();
    const projectId = await create(backend);
    const { reserved } = await send(backend, projectId, ["dev+b@corp.com"]);
    const sendId = reserved[0]!.sendId;
    const as = (email: string) => ({ ...reviewer("Dev"), email });
    const shown = (email: string) => backend.run((store) => getDeveloperSetup(store, as(email), { sendId }));
    await expect(shown("dev+a@corp.com")).rejects.toThrow("This setup link doesn't exist, or it was sent to another address.");
    await expect(shown("dev@corp.com")).rejects.toThrow("This setup link doesn't exist, or it was sent to another address.");
    expect((await shown("dev+b@corp.com")).projectId).toBe(projectId);
    expect((await shown(" Dev+B@Corp.com ")).projectId).toBe(projectId);
  });

  test(`${name}: the setup email names who asked and why, leaves out the prototype's address, and has the project's commands`, async () => {
    const backend = fresh();
    const projectId = await create(backend, { ...dana, name: "Dana <b>Kim</b>\u0007" }, { name: "Acme\u0000 & co" });
    const { reserved } = await send(backend, projectId, ["sam@acme.com"], day, { ...dana, name: "Dana <b>Kim</b>\u0007" });
    const [email] = (await deliver(backend, reserved)).asked;
    expect(email).toMatchObject({
      to: "sam@acme.com",
      fromName: "Dana <b>Kim</b> via Critiqs",
      replyTo: "dana@example.com",
      subject: "Dana <b>Kim</b> asked you to add Critiqs to Acme & co",
      idempotencyKey: reserved[0]!.idempotencyKey,
    });
    expect(email!.text).toContain("They said someone else changes its code");
    expect(email!.text).toContain(`npm install critiqs-react\nnpx critiqs-react init ${projectId}`);
    expect(email!.text).toContain(`Setup steps: ${links.setupUrl}`);
    expect(email!.text).toContain(`Report it: ${links.reportUrl}`);
    expect(email!.html).not.toContain("<b>");
    expect(email!.html).toContain("Dana &#60;b&#62;Kim&#60;");
    // The address is typed by the sender, and mail apps link plain-text URLs: only the signed-in setup page shows it.
    for (const part of [email!.text, email!.html, email!.html.replace(/<[^>]*>/g, "")]) {
      expect([part.includes("acme-proto"), part.includes("vercel.app")]).toEqual([false, false]);
    }
    expect(email!.text).toContain("The setup page shows the prototype's address once you sign in.");
    expect([...email!.html.matchAll(/href="([^"]+)"/g)].map((match) => match[1])).toEqual([links.setupUrl, links.reportUrl]);
  });

  test(`${name}: each address gets one email per project: asking again, even days later, sends nothing`, async () => {
    const backend = fresh();
    const projectId = await create(backend);
    const first = await send(backend, projectId, ["sam@acme.com"]);
    await deliver(backend, first.reserved);
    for (const offset of [HOUR, 24 * HOUR, 500 * HOUR]) {
      const again = await send(backend, projectId, ["sam@acme.com"], day + offset);
      expect([offset, again.results[0]!.status, again.reserved]).toEqual([offset, "already-sent", []]);
    }
    expect((await send(backend, projectId, ["sam@acme.com"], day + 501 * HOUR)).results).toEqual([{ email: "sam@acme.com", status: "already-sent", sendId: first.reserved[0]!.sendId }]);
    expect(await counter(backend, `inviteEmails:sam@acme.com:${utcDay(day + 24 * HOUR)}`)).toBe(0);
  });

  test(`${name}: a send to another address of the same inbox gets its own record, and a refused one opens no one else's link`, async () => {
    const backend = fresh();
    const projectId = await create(backend);
    const a = await send(backend, projectId, ["dev+a@corp.com"]);
    await deliver(backend, a.reserved);
    const b = await send(backend, projectId, ["dev+b@corp.com"], day + 24 * HOUR);
    expect(b.results[0]).toMatchObject({ status: "sent" });
    expect(b.reserved[0]!.sendId).not.toBe(a.reserved[0]!.sendId);
    expect((await deliver(backend, b.reserved, "refused", day + 24 * HOUR)).outcomes).toEqual(["failed"]);
    const opens = (email: string, sendId: string) =>
      backend.run((store) => getDeveloperSetup(store, { ...reviewer("Dev"), email }, { sendId })).then(
        () => true,
        () => false,
      );
    const sendA = a.reserved[0]!.sendId;
    expect([await opens("dev+a@corp.com", sendA), await opens("dev+b@corp.com", sendA)]).toEqual([true, false]);
    expect((await listed(backend, projectId)).map((each) => [each.email, each.status])).toEqual([
      ["dev+a@corp.com", "sent"],
      ["dev+b@corp.com", "failed"],
    ]);
  });

  test(`${name}: two overlapping attempts that are both refused (429) settle failed, and a new email can go out at once`, async () => {
    const backend = fresh();
    const projectId = await create(backend);
    const first = await send(backend, projectId, ["sam@acme.com"]);
    const started = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();
    const slow = deliverOne(backend, first.reserved[0]!, day, async () => {
      started.resolve();
      await answer.promise;
      throw refused429();
    });
    await started.promise;
    // While the first attempt waits for its answer, asking again retries under the same key, and that is refused first.
    const retry = await send(backend, projectId, ["sam@acme.com"], day + 1000);
    expect(retry.reserved).toEqual(first.reserved);
    const fast = await deliverOne(backend, retry.reserved[0]!, day + 1000, async () => {
      throw refused429();
    });
    answer.resolve();
    expect([await slow, fast]).toEqual(["failed", "uncertain"]);
    expect((await listed(backend, projectId))[0]).toMatchObject({ status: "failed" });
    const again = await send(backend, projectId, ["sam@acme.com"], day + 2000);
    expect(again.reserved.map((each) => each.idempotencyKey)).toEqual([`critiqs-developer:${first.reserved[0]!.sendId}:1`]);
  });

  test(`${name}: an attempt claimed before a crash keeps the email uncertain: retried under its key within 23 hours, then never sent again`, async () => {
    const backend = fresh();
    const projectId = await create(backend);
    const first = await send(backend, projectId, ["sam@acme.com"]);
    // The worker claims an attempt, then stops before the mail service answers.
    expect(await backend.run((store) => prepareDeveloperEmail(store, { ...first.reserved[0]!, ...links }, day))).not.toBeNull();
    expect((await listed(backend, projectId))[0]).toMatchObject({ status: "uncertain" });
    // Asking again retries under the same key; the mail service's refusal can't settle it, since the claimed attempt may have gone out.
    const retry = await send(backend, projectId, ["sam@acme.com"], day + HOUR);
    expect(retry.reserved).toEqual(first.reserved);
    const keys: string[] = [];
    const outcome = await deliverOne(backend, retry.reserved[0]!, day + HOUR, async (message) => {
      keys.push(message.idempotencyKey);
      throw refused429();
    });
    expect([outcome, keys]).toEqual(["uncertain", [first.reserved[0]!.idempotencyKey]]);
    // 23 hours after the first attempt it counts as possibly delivered: nothing more goes out.
    for (const offset of [23 * HOUR, 48 * HOUR]) {
      const late = await send(backend, projectId, ["sam@acme.com"], day + offset);
      expect([offset, late.results[0]!.status, late.reserved]).toEqual([offset, "already-sent", []]);
    }
    expect((await listed(backend, projectId))[0]).toMatchObject({ status: "uncertain" });
  });

  test(`${name}: a project or sender name with a web address in it refuses the whole request; ordinary names and versions pass`, async () => {
    const backend = fresh();
    for (const [projectName, senderName, message] of [
      ["https://elsewhere.example.test/hello", "Dana", "Project names in setup emails can't contain web addresses. Rename the project and try again."],
      ["Acme", "evil.com", "Names in setup emails can't contain web addresses. Change your name and try again."],
    ] as const) {
      const sender = { ...dana, name: senderName };
      const projectId = await create(backend, sender, { name: projectName });
      await expect(send(backend, projectId, ["sam@acme.com"], day, sender)).rejects.toThrow(message);
      expect(await listed(backend, projectId, sender)).toEqual([]);
    }
    for (const projectName of ["Acme v2.0", "Q4 plan"]) {
      const projectId = await create(backend, dana, { name: projectName });
      expect((await send(backend, projectId, ["sam@acme.com"])).results[0]).toMatchObject({ status: "sent" });
    }
  });

  test(`${name}: an organization name with a web address in it refuses a request whose email would name it; code names pass`, async () => {
    const backend = fresh();
    const lee = reviewer("Lee");
    const projectId = await create(backend);
    const organizationId = (await backend.run((store) => ops.getProject(store, dana, { projectId }))).organization!.id;
    await backend.run((store) => ops.syncReviewer(store, lee));
    await backend.run((store) => organizations.inviteMember(store, dana, { organizationId, email: lee.email!, role: "member" }, day));
    await backend.run((store) => ops.syncReviewer(store, lee));
    const leesProject = await create(backend, lee, { organizationId });
    await backend.run((store) => organizations.inviteMember(store, dana, { organizationId, email: "kim@acme.com", role: "member" }, day));
    for (const organizationName of ["acme.com", "See https://elsewhere.example.test", "www.acme"]) {
      await backend.run((store) => organizations.renameOrganization(store, dana, { organizationId, name: organizationName }));
      // An admin's email invites the developer, so it names the organization.
      await expect(send(backend, projectId, ["sam@acme.com"])).rejects.toThrow("Organization names in setup emails can't contain web addresses. Rename the organization and try again.");
      // A member's email names it only for a developer already invited, here by the admin.
      await expect(send(backend, leesProject, ["lou@acme.com", "kim@acme.com"], day, lee)).rejects.toThrow("Organization names in setup emails can't contain web addresses. Ask an admin to rename it, or copy the message instead.");
      expect([organizationName, await listed(backend, projectId), await listed(backend, leesProject, lee)]).toEqual([organizationName, [], []]);
    }
    // A member's email to a developer who isn't invited doesn't name it, so it goes.
    expect((await send(backend, leesProject, ["lou@acme.com"], day, lee)).results[0]).toMatchObject({ status: "sent", invite: "none" });
    await backend.run((store) => organizations.renameOrganization(store, dana, { organizationId, name: "Next.js team v2.0" }));
    expect((await send(backend, projectId, ["sam@acme.com"])).results[0]).toMatchObject({ status: "sent", invite: "created" });
  });

  test(`${name}: an invited developer whose email already went doesn't make a renamed organization refuse another's`, async () => {
    const backend = fresh();
    const lee = reviewer("Lee");
    const projectId = await create(backend);
    const organizationId = (await backend.run((store) => ops.getProject(store, dana, { projectId }))).organization!.id;
    await backend.run((store) => ops.syncReviewer(store, lee));
    await backend.run((store) => organizations.inviteMember(store, dana, { organizationId, email: lee.email!, role: "member" }, day));
    await backend.run((store) => ops.syncReviewer(store, lee));
    const leesProject = await create(backend, lee, { organizationId });
    await backend.run((store) => organizations.inviteMember(store, dana, { organizationId, email: "kim@acme.com", role: "member" }, day));
    await deliver(backend, (await send(backend, leesProject, ["kim@acme.com"], day, lee)).reserved);
    await backend.run((store) => organizations.renameOrganization(store, dana, { organizationId, name: "acme.com" }));
    // Kim's email went before the rename and isn't sent again; Lou isn't invited, so Lou's email won't name it.
    expect((await send(backend, leesProject, [" Kim@Acme.com ", "lou@acme.com"], day + HOUR, lee)).results.map((each) => each.status)).toEqual(["already-sent", "sent"]);
  });

  test(`${name}: a renamed organization doesn't refuse an admin's email to a member, which doesn't name it, or one past a limit`, async () => {
    const backend = fresh();
    const lee = reviewer("Lee");
    const projectId = await create(backend);
    const organizationId = (await backend.run((store) => ops.getProject(store, dana, { projectId }))).organization!.id;
    await backend.run((store) => ops.syncReviewer(store, lee));
    await backend.run((store) => organizations.inviteMember(store, dana, { organizationId, email: lee.email!, role: "member" }, day));
    await backend.run((store) => ops.syncReviewer(store, lee));
    await backend.run((store) => organizations.renameOrganization(store, dana, { organizationId, name: "acme.com" }));
    const toMember = await send(backend, projectId, [lee.email!]);
    expect(toMember.results[0]).toMatchObject({ status: "sent", invite: "member" });
    const { asked } = await deliver(backend, toMember.reserved);
    expect(asked[0]!.text).not.toContain("acme.com");
    // An address a limit refuses reports the limit, not the name.
    const sender = (await backend.run((store) => store.users.byToken(dana.tokenIdentifier)))!._id;
    await backend.run(async (store) => {
      const counter = (await store.usage.find(`developerEmails:${sender}:${utcDay(day)}`))!;
      await store.usage.patch(counter._id, { count: 5 });
    });
    const second = await create(backend, dana, { name: "Second" });
    expect((await send(backend, second, ["sam@acme.com"])).results[0]).toMatchObject({ status: "limit", limit: "person" });
  });

  test(`${name}: an organization or sender renamed to hold a web address after an email was queued fails that email instead of sending it`, async () => {
    const renames: [string, (backend: ContractBackend, projectId: string) => Promise<unknown>][] = [
      [
        "organization",
        async (backend, projectId) => {
          const organizationId = (await backend.run((store) => ops.getProject(store, dana, { projectId }))).organization!.id;
          await backend.run((store) => organizations.renameOrganization(store, dana, { organizationId, name: "acme.com" }));
        },
      ],
      ["sender", (backend) => backend.run(async (store) => await store.users.patch((await store.users.byToken(dana.tokenIdentifier))!._id, { name: "evil.com" }))],
    ];
    for (const [what, rename] of renames) {
      const backend = fresh();
      const projectId = await create(backend);
      const first = await send(backend, projectId, ["sam@acme.com"]);
      await rename(backend, projectId);
      const { asked, outcomes } = await deliver(backend, first.reserved);
      expect([what, asked, outcomes, (await listed(backend, projectId))[0]?.status]).toEqual([what, [], ["skipped"], "failed"]);
    }
  });
}
