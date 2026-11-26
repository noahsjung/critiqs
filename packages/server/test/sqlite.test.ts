import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { bunDriver, migrate, SCHEMA_VERSION, SqliteStore } from "../src/sqlite/index.ts";
import { MIGRATIONS } from "../src/sqlite/store.ts";
import { reserveCredits, settleCredits } from "../src/ai/credits.ts";
import * as operations from "../src/operations.ts";
import { saveAboutYou } from "../src/onboarding.ts";
import { listMyOrganizations } from "../src/organizations.ts";
import type { Plan } from "../src/limits.ts";
import { anchor, type ContractBackend, defineContract, reviewer } from "./contract.ts";
import { defineAiContract } from "./contract-ai.ts";
import { defineDeveloperEmailContract, defineOnboardingContract } from "./contract-onboarding.ts";

function sqliteBackend(plans?: Record<string, Plan>): ContractBackend {
  const live = { ...plans };
  const store = new SqliteStore(bunDriver(new Database(":memory:")), plans === undefined ? {} : { plans: live });
  return {
    run: (operation) => store.transaction(operation),
    saveFile: (contentType, bytes = 64) => store.saveFile(new Uint8Array(bytes), contentType),
    storeFile: async (data) => await store.saveFile(new Uint8Array(await data.arrayBuffer()), data.type === "" ? null : data.type),
    readFile: async (fileId) => {
      const file = store.readFile(fileId);
      return file === null ? null : new Blob([file.data as Uint8Array<ArrayBuffer>]);
    },
    withPlans: (next) => sqliteBackend(next),
    changePlans: async (next) => {
      for (const name of Object.keys(live)) delete live[name];
      Object.assign(live, next);
    },
  };
}

defineContract("SQLite", () => sqliteBackend());
defineAiContract("SQLite", () => sqliteBackend());
defineOnboardingContract("SQLite", () => sqliteBackend());
defineDeveloperEmailContract("SQLite", () => sqliteBackend());

test("SQLite: operations on one database run one at a time", async () => {
  const store = new SqliteStore(bunDriver(new Database(":memory:")));
  const order: string[] = [];
  const slow = store.transaction(async () => {
    order.push("slow start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("slow end");
  });
  const fast = store.transaction(async () => {
    order.push("fast");
  });
  await Promise.all([slow, fast]);
  expect(order).toEqual(["slow start", "slow end", "fast"]);
});

test("SQLite: the schema is created once and a newer database is refused", () => {
  const db = new Database(":memory:");
  const driver = bunDriver(db);
  migrate(driver);
  migrate(driver);
  expect(driver.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(SCHEMA_VERSION);
  driver.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  expect(() => migrate(driver)).toThrow("upgrade Critiqs");
});

test("SQLite: stored files keep their bytes and type", async () => {
  const store = new SqliteStore(bunDriver(new Database(":memory:")));
  const id = await store.saveFile(new Uint8Array([1, 2, 3]), "image/png");
  expect(store.readFile(id)).toEqual({ data: new Uint8Array([1, 2, 3]), contentType: "image/png" });
  expect(store.readFile("../etc/passwd")).toBeNull();
});

test("SQLite: work started inside an operation joins its transaction instead of waiting forever", async () => {
  const store = new SqliteStore(bunDriver(new Database(":memory:")));
  const fileId = await store.transaction(async () => {
    const nested = await store.transaction(async () => "inner");
    expect(nested).toBe("inner");
    return await store.saveFile(new Uint8Array([1]), "image/png");
  });
  expect(store.readFile(fileId)?.contentType).toBe("image/png");
  // The store still accepts new work afterwards.
  expect(await store.transaction(async () => "after")).toBe("after");
});

test("SQLite: listing a project's threads uses the index of threads that are not deleted", () => {
  const db = new Database(":memory:");
  const driver = bunDriver(db);
  migrate(driver);
  const plan = driver.all<{ detail: string }>(
    "EXPLAIN QUERY PLAN SELECT * FROM threads WHERE project_id = ? AND status != 'deleted' AND seq > ? ORDER BY seq LIMIT ?",
    ["p_1", 0, 41],
  );
  expect(plan.map((row) => row.detail).join(" ")).toContain("threads_visible_by_project");
});

test("SQLite: an image uploaded too long ago must be uploaded again", async () => {
  const db = new Database(":memory:");
  const store = new SqliteStore(bunDriver(db));
  const dana = reviewer("Dana");
  const projectId = await store.transaction((s) => operations.createProject(s, dana, { name: "Admin" }));
  const fileId = await store.saveFile(new Uint8Array([1]), "image/png");
  db.query("UPDATE files SET created_at = ? WHERE id = ?").run(Date.now() - 61 * 60 * 1000, fileId);
  await expect(
    store.transaction((s) =>
      operations.createThread(s, dana, { projectId, anchor, body: "Old", tags: [], capture: { status: "captured", fileId } }),
    ),
  ).rejects.toThrow("Upload the image again");
});

test("SQLite: work an operation leaves running after it ends gets its own transaction", async () => {
  const store = new SqliteStore(bunDriver(new Database(":memory:")));
  const dana = reviewer("Dana");
  let later!: Promise<unknown>;
  await store.transaction(async () => {
    // Not awaited: runs after this operation has committed.
    later = new Promise((resolve) => setTimeout(resolve, 10)).then(() =>
      store.transaction(async (s) => {
        await operations.createProject(s, dana, { name: "Deferred" });
        throw new Error("Deferred failure");
      }),
    );
  });
  await expect(later).rejects.toThrow("Deferred failure");
  const mine = await store.transaction((s) => operations.listMyProjects(s, dana, { numItems: 40, cursor: null }));
  expect(mine.page).toEqual([]);

  // A deferred save during another operation waits for it, so that operation's rollback can't remove it.
  let saved!: Promise<string>;
  await store.transaction(async () => {
    saved = new Promise((resolve) => setTimeout(resolve, 5)).then(() => store.saveFile(new Uint8Array([7]), "image/png"));
  });
  await expect(
    store.transaction(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error("Unrelated failure");
    }),
  ).rejects.toThrow("Unrelated failure");
  expect(store.readFile(await saved)?.data).toEqual(new Uint8Array([7]));
});

test("SQLite: an operation that doesn't await work it joined rolls back, and the late work cannot write", async () => {
  const store = new SqliteStore(bunDriver(new Database(":memory:")));
  const dana = reviewer("Dana");
  const page = { numItems: 40, cursor: null };
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let child!: Promise<unknown>;
  await expect(
    store.transaction(async () => {
      child = store.transaction(async (s) => {
        await held;
        await operations.createProject(s, dana, { name: "Late" });
      });
      child.catch(() => undefined);
    }),
  ).rejects.toThrow("finished before work it started");
  release();
  await expect(child).rejects.toThrow("transaction has ended");
  expect((await store.transaction((s) => operations.listMyProjects(s, dana, page))).page).toEqual([]);
});

test("SQLite: awaited joined work commits with its operation, and its failure rolls the operation back", async () => {
  const store = new SqliteStore(bunDriver(new Database(":memory:")));
  const dana = reviewer("Dana");
  const page = { numItems: 40, cursor: null };
  await store.transaction(async () => {
    await store.transaction((s) => operations.createProject(s, dana, { name: "Kept" }));
  });
  await expect(
    store.transaction(async (s) => {
      await operations.createProject(s, dana, { name: "Dropped" });
      await store
        .transaction(async () => {
          throw new Error("Joined failure");
        })
        .catch(() => undefined);
    }),
  ).rejects.toThrow("Work joined to this Critiqs transaction failed");
  const names = (await store.transaction((s) => operations.listMyProjects(s, dana, page))).page.map((project) => project.name);
  expect(names).toEqual(["Kept"]);
});

test("SQLite: a store kept after its transaction ended refuses every call", async () => {
  const store = new SqliteStore(bunDriver(new Database(":memory:")));
  let kept!: Parameters<Parameters<typeof store.transaction>[0]>[0];
  await store.transaction(async (s) => {
    kept = s;
  });
  await expect(Promise.resolve().then(() => kept.users.byToken("x"))).rejects.toThrow("transaction has ended");
});

test("SQLite: upgrading a version 1 database keeps its data and lets earlier commenters be mentioned", async () => {
  const db = new Database(":memory:");
  const driver = bunDriver(db);
  driver.exec(MIGRATIONS[0] as string);
  driver.exec("PRAGMA user_version = 1");
  const ids = { dana: `u_${"1".repeat(32)}`, lee: `u_${"2".repeat(32)}`, project: `p_${"3".repeat(32)}`, thread: `t_${"4".repeat(32)}` };
  driver.run("INSERT INTO users (id, token, name, email) VALUES (?, ?, 'Dana', 'dana@example.com'), (?, ?, 'Lee', 'lee@example.com')", [
    ids.dana,
    "https://auth.example|dana",
    ids.lee,
    "https://auth.example|lee",
  ]);
  driver.run("INSERT INTO projects (id, name, tags, created_by, created_at) VALUES (?, 'Admin', '[]', ?, 1)", [ids.project, ids.dana]);
  driver.run(
    `INSERT INTO threads (id, project_id, status, anchor, tags, capture, created_by, created_at, last_message_at, message_count)
     VALUES (?, ?, 'open', ?, '[]', '{"status":"failed","failureReason":"x"}', ?, 1, 3, 2)`,
    [ids.thread, ids.project, JSON.stringify(anchor), ids.dana],
  );
  driver.run(
    "INSERT INTO messages (id, thread_id, author_id, body, created_at) VALUES (?, ?, ?, 'First', 1), (?, ?, ?, 'Reply', 3)",
    [`m_${"5".repeat(32)}`, ids.thread, ids.dana, `m_${"6".repeat(32)}`, ids.thread, ids.lee],
  );
  const store = new SqliteStore(driver);
  expect(driver.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(SCHEMA_VERSION);
  const dana = reviewer("Dana");
  const suggestions = await store.transaction((s) => operations.listParticipants(s, dana, { projectId: ids.project, query: "" }));
  expect(suggestions.map((person) => person.name)).toEqual(["Lee"]);
  const thread = await store.transaction((s) => operations.getThread(s, dana, { threadId: ids.thread }, { numItems: 40, cursor: null }));
  expect(thread.page.map((message) => message.body)).toEqual(["First", "Reply"]);
});

test("SQLite: upgrading a version 5 database keeps explicit tags and reads hashtags from existing messages", async () => {
  const db = new Database(":memory:");
  const driver = bunDriver(db);
  for (const migration of MIGRATIONS.slice(0, 5)) driver.exec(migration as string);
  driver.exec("PRAGMA user_version = 5");
  const ids = { dana: `u_${"1".repeat(32)}`, project: `p_${"3".repeat(32)}`, thread: `t_${"4".repeat(32)}`, other: `t_${"7".repeat(32)}` };
  // Written before messages were limited to 30 different hashtags.
  const many = `Older ${Array.from({ length: 31 }, (_, i) => `#w${i}`).join(" ")}`;
  driver.run("INSERT INTO users (id, token, name, email) VALUES (?, 'https://auth.example|dana', 'Dana', 'dana@example.com')", [ids.dana]);
  driver.run("INSERT INTO projects (id, name, tags, created_by, created_at) VALUES (?, 'Admin', ?, ?, 1)", [
    ids.project,
    JSON.stringify(["Bug", "UX copy change"]),
    ids.dana,
  ]);
  for (const [thread, tags] of [
    [ids.thread, ["Bug"]],
    [ids.other, []],
  ] as const) {
    driver.run(
      `INSERT INTO threads (id, project_id, status, anchor, tags, capture, created_by, created_at, last_message_at, message_count)
       VALUES (?, ?, 'open', ?, ?, '{"status":"failed","failureReason":"x"}', ?, 1, 3, 2)`,
      [thread, ids.project, JSON.stringify(anchor), JSON.stringify(tags), ids.dana],
    );
  }
  driver.run(
    "INSERT INTO messages (id, thread_id, author_id, body, created_at) VALUES (?, ?, ?, 'Label is vague #Wording', 1), (?, ?, ?, 'Yes #wording #layout', 3), (?, ?, ?, ?, 2)",
    [`m_${"5".repeat(32)}`, ids.thread, ids.dana, `m_${"6".repeat(32)}`, ids.thread, ids.dana, `m_${"8".repeat(32)}`, ids.other, ids.dana, many],
  );
  const store = new SqliteStore(driver);
  const dana = reviewer("Dana");
  const page = { numItems: 40, cursor: null };
  const thread = await store.transaction((s) => operations.getThread(s, dana, { threadId: ids.thread }, page));
  expect(thread).toMatchObject({ tags: ["Bug", "Wording", "layout"], textTags: ["Wording", "layout"] });
  expect(thread.page.map((message) => message.body)).toEqual(["Label is vague #Wording", "Yes #wording #layout"]);
  // Counts carried over: removing #wording from one message keeps the tag from the other.
  await store.transaction((s) => operations.editMessage(s, dana, { messageId: `m_${"6".repeat(32)}`, body: "Yes #layout" }));
  expect((await store.transaction((s) => operations.getThread(s, dana, { threadId: ids.thread }, page))).tags).toEqual(["Bug", "Wording", "layout"]);
  const { tags, groups } = await store.transaction((s) => operations.listTags(s, dana, { projectId: ids.project }));
  const copy = groups.find((group) => group.name === "Copy & wording")!;
  expect(tags.find((tag) => tag.key === "wording")).toMatchObject({ label: "Wording", groupIds: [copy._id], grouping: "starter" });
  expect(tags.find((tag) => tag.key === "layout")).toMatchObject({ grouping: "pending" });
  expect(tags.find((tag) => tag.key === "bug")).toMatchObject({ preset: true });
  // Existing messages are searchable.
  const found = await store.transaction((s) => s.messages.search(ids.project, ["vague"], 10));
  expect(found.map((message) => message.body)).toEqual(["Label is vague #Wording"]);
  const tagged = await store.transaction((s) => s.threadTags.byKey(ids.project, "layout", 10));
  expect(tagged.map((row) => row.threadId)).toEqual([ids.thread]);
  // A message with more hashtags than new messages may use keeps its text and its first 30.
  const older = await store.transaction((s) => operations.getThread(s, dana, { threadId: ids.other }, page));
  expect(older.textTags).toEqual(Array.from({ length: 30 }, (_, i) => `w${i}`));
  expect(older.page[0]!.body).toBe(many);
});

test("SQLite: upgrading a version 8 database gives people from before organizations a home organization with their projects, plan, and project count", async () => {
  const driver = bunDriver(new Database(":memory:"));
  for (const migration of MIGRATIONS.slice(0, 8)) {
    if (typeof migration === "string") driver.exec(migration);
    else migration(driver);
  }
  driver.exec("PRAGMA user_version = 8");
  const ids = { dana: `u_${"1".repeat(32)}`, sam: `u_${"2".repeat(32)}`, lee: `u_${"3".repeat(32)}`, one: `p_${"4".repeat(32)}`, two: `p_${"5".repeat(32)}`, unnamed: `u_${"9".repeat(32)}` };
  driver.run(
    `INSERT INTO users (id, token, name, email, plan) VALUES
       (?, 'https://auth.example|dana', 'Dana', 'dana@example.com', 'team'),
       (?, 'https://auth.example|sam', 'Sam', 'sam@example.com', 'team'),
       (?, 'https://auth.example|lee', 'Lee', 'lee@example.com', NULL),
       (?, 'https://auth.example|unnamed', ' ', '', 'team')`,
    [ids.dana, ids.sam, ids.lee, ids.unnamed],
  );
  driver.run("INSERT INTO projects (id, name, tags, created_by, created_at) VALUES (?, 'One', '[]', ?, 1), (?, 'Two', '[]', ?, 2)", [ids.one, ids.dana, ids.two, ids.dana]);
  driver.run("INSERT INTO usage (id, key, count) VALUES (?, ?, 2), (?, ?, 2), (?, ?, 7), (?, ?, 100), (?, ?, 50)", [
    `c_${"6".repeat(32)}`,
    `projects:${ids.dana}:total`,
    `c_${"7".repeat(32)}`,
    `projects:${ids.dana}:2026-11`,
    `c_${"8".repeat(32)}`,
    `threads:${ids.one}:total`,
    `c_${"a".repeat(32)}`,
    `captureBytes:${ids.one}:total`,
    `c_${"b".repeat(32)}`,
    `captureBytes:${ids.two}:total`,
  ]);
  const team: Plan = { name: "team", label: "Team", limits: [{ metric: "projects", period: "total", max: 3 }] };
  const store = new SqliteStore(driver, { plans: { team } });
  const dana = reviewer("Dana");
  const organization = (await store.transaction((s) => operations.getProject(s, dana, { projectId: ids.two }))).organization;
  expect(organization).toEqual({ id: expect.stringMatching(/^o_/), name: "Dana's organization", role: "admin" });
  expect(driver.all("SELECT organization_id FROM projects ORDER BY seq")).toEqual([{ organization_id: organization!.id }, { organization_id: organization!.id }]);
  expect(driver.all("SELECT key, count FROM usage WHERE key LIKE ? ORDER BY key", [`projects:${organization!.id}:%`])).toEqual([
    { key: `projects:${organization!.id}:2026-11`, count: 2 },
    { key: `projects:${organization!.id}:total`, count: 2 },
  ]);
  expect(await store.transaction((s) => operations.getUsage(s, dana, { projectId: ids.one }))).toMatchObject({
    plan: "Team",
    rows: [{ metric: "projects", period: "total", used: 2, max: 3 }],
  });
  // Images count per organization now, starting with what its projects store.
  expect(driver.get<{ count: number }>("SELECT count FROM usage WHERE key = ?", [`captureBytes:${organization!.id}:total`])?.count).toBe(150);
  expect(await store.transaction((s) => listMyOrganizations(s, reviewer("Sam")))).toEqual([
    { id: expect.stringMatching(/^o_/), name: "Sam's organization", role: "admin", plan: "Team", home: true },
  ]);
  expect(await store.transaction((s) => listMyOrganizations(s, reviewer("Lee")))).toEqual([]);
  expect(driver.get<{ name: string }>("SELECT name FROM organizations WHERE created_by = ?", [ids.unnamed])?.name).toBe("Critiqs's organization");
  expect((await store.transaction((s) => operations.getProject(s, reviewer("Lee"), { projectId: ids.one }))).isOwner).toBe(false);
  await store.transaction((s) => operations.createProject(s, dana, { name: "Three" }));
  await expect(store.transaction((s) => operations.createProject(s, dana, { name: "Four" }))).rejects.toThrow("Team plan's limit of 3 projects");
  expect(driver.get<{ count: number }>("SELECT count(*) AS count FROM organizations")?.count).toBe(3);
});

test("SQLite: upgrading a version 10 database holds Critiqs AI credits against what its organizations already used", async () => {
  const driver = bunDriver(new Database(":memory:"));
  for (const migration of MIGRATIONS.slice(0, 10)) {
    if (typeof migration === "string") driver.exec(migration);
    else migration(driver);
  }
  driver.exec("PRAGMA user_version = 10");
  const ids = { dana: `u_${"1".repeat(32)}`, organization: `o_${"2".repeat(32)}`, project: `p_${"3".repeat(32)}` };
  driver.run("INSERT INTO users (id, token, name, email, home_organization_id) VALUES (?, 'https://auth.example|dana', 'Dana', 'dana@example.com', ?)", [ids.dana, ids.organization]);
  driver.run("INSERT INTO organizations (id, name, created_by, created_at, plan) VALUES (?, 'Dana''s organization', ?, 1, 'plus')", [ids.organization, ids.dana]);
  driver.run("INSERT INTO memberships (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'admin', 1)", [`b_${"4".repeat(32)}`, ids.organization, ids.dana]);
  driver.run("INSERT INTO projects (id, name, tags, created_by, created_at, organization_id) VALUES (?, 'One', '[]', ?, 1, ?)", [ids.project, ids.dana, ids.organization]);
  const month = new Date().toISOString().slice(0, 7);
  driver.run("INSERT INTO usage (id, key, count) VALUES (?, ?, 3990)", [`c_${"5".repeat(32)}`, `aiCredits:${ids.organization}:${month}`]);
  const store = new SqliteStore(driver, { plans: {} });
  expect(driver.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(SCHEMA_VERSION);
  const payer = { payer: "project" as const, ownerId: ids.project };
  const reserve = (credits: number) => store.transaction((s) => reserveCredits(s, payer, credits, Date.now()));
  // Plus allows 2,000 credits and 2,000 extra: 10 of them are left.
  // More than is left says so; once held, nothing is left.
  expect(await reserve(11)).toEqual({ ok: false, reason: "This project's organization doesn't have enough Critiqs AI credits left for this request." });
  const held = await reserve(10);
  expect(held).toEqual({ ok: true, hold: expect.stringMatching(/^v_/) });
  expect(await reserve(1)).toEqual({ ok: false, reason: "This project's organization has no Critiqs AI credits left for now." });
  await store.transaction((s) => settleCredits(s, held.ok ? held.hold : null, { ...payer, credits: 7 }, Date.now()));
  expect(await store.transaction((s) => s.usage.find(`aiCredits:${ids.organization}:${month}`))).toMatchObject({ count: 3997 });
  expect(driver.get<{ count: number }>("SELECT count(*) AS count FROM credit_holds")?.count).toBe(0);
});

test("SQLite: upgrading a version 11 database keeps people and projects, with no onboarding answers until given", async () => {
  const driver = bunDriver(new Database(":memory:"));
  for (const migration of MIGRATIONS.slice(0, 11)) {
    if (typeof migration === "string") driver.exec(migration);
    else migration(driver);
  }
  driver.exec("PRAGMA user_version = 11");
  const ids = { dana: `u_${"1".repeat(32)}`, organization: `o_${"2".repeat(32)}`, project: `p_${"3".repeat(32)}` };
  driver.run("INSERT INTO users (id, token, name, email, home_organization_id) VALUES (?, 'https://auth.example|dana', 'Dana', 'dana@example.com', ?)", [ids.dana, ids.organization]);
  driver.run("INSERT INTO organizations (id, name, created_by, created_at) VALUES (?, 'Dana''s organization', ?, 1)", [ids.organization, ids.dana]);
  driver.run("INSERT INTO memberships (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'admin', 1)", [`b_${"4".repeat(32)}`, ids.organization, ids.dana]);
  driver.run("INSERT INTO projects (id, name, tags, created_by, created_at, organization_id) VALUES (?, 'One', '[\"Bug\"]', ?, 1, ?)", [ids.project, ids.dana, ids.organization]);
  const store = new SqliteStore(driver);
  expect(driver.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(SCHEMA_VERSION);
  const dana = reviewer("Dana");
  expect(await store.transaction((s) => s.users.get(ids.dana))).toEqual({
    _id: ids.dana,
    tokenIdentifier: "https://auth.example|dana",
    name: "Dana",
    email: "dana@example.com",
    imageUrl: null,
    homeOrganizationId: ids.organization,
  });
  expect(await store.transaction((s) => s.projects.get(ids.project))).not.toHaveProperty("onboarding");
  await store.transaction((s) => saveAboutYou(s, dana, { role: "founder" }));
  expect(await store.transaction((s) => s.users.get(ids.dana))).toMatchObject({ role: "founder" });
  expect((await store.transaction((s) => operations.getProject(s, dana, { projectId: ids.project }))).tags).toEqual(["Bug"]);
});

test("SQLite: upgrading a version 9 database counts each organization's images from what its projects store", async () => {
  const driver = bunDriver(new Database(":memory:"));
  for (const migration of MIGRATIONS.slice(0, 9)) {
    if (typeof migration === "string") driver.exec(migration);
    else migration(driver);
  }
  driver.exec("PRAGMA user_version = 9");
  const ids = { dana: `u_${"1".repeat(32)}`, organization: `o_${"2".repeat(32)}`, one: `p_${"3".repeat(32)}`, two: `p_${"4".repeat(32)}` };
  driver.run("INSERT INTO users (id, token, name, email, home_organization_id) VALUES (?, 'https://auth.example|dana', 'Dana', 'dana@example.com', ?)", [ids.dana, ids.organization]);
  driver.run("INSERT INTO organizations (id, name, created_by, created_at) VALUES (?, 'Dana''s organization', ?, 1)", [ids.organization, ids.dana]);
  driver.run("INSERT INTO memberships (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'admin', 1)", [`b_${"5".repeat(32)}`, ids.organization, ids.dana]);
  driver.run("INSERT INTO projects (id, name, tags, created_by, created_at, organization_id) VALUES (?, 'One', '[]', ?, 1, ?), (?, 'Two', '[]', ?, 2, ?)", [
    ids.one,
    ids.dana,
    ids.organization,
    ids.two,
    ids.dana,
    ids.organization,
  ]);
  driver.run("INSERT INTO usage (id, key, count) VALUES (?, ?, 1000), (?, ?, 500)", [
    `c_${"6".repeat(32)}`,
    `captureBytes:${ids.one}:total`,
    `c_${"7".repeat(32)}`,
    `captureBytes:${ids.two}:total`,
  ]);
  const store = new SqliteStore(driver, { plans: { free: { name: "free", label: "Free", limits: [{ metric: "captureBytes", period: "total", max: 10_000 }] } } });
  expect(await store.transaction((s) => operations.getUsage(s, reviewer("Dana"), { projectId: ids.one }))).toMatchObject({
    rows: [{ metric: "captureBytes", period: "total", used: 1500, max: 10_000 }],
  });
});

test("SQLite: message search finds word beginnings and accents, and treats search syntax as text", async () => {
  const store = new SqliteStore(bunDriver(new Database(":memory:")));
  const dana = reviewer("Dana");
  const projectId = await store.transaction((s) => operations.createProject(s, dana, { name: "P" }));
  const failed = { status: "failed" as const, failureReason: "x" };
  await store.transaction((s) => operations.createThread(s, dana, { projectId, anchor, body: "Le café est fermé", tags: [], capture: failed }));
  await store.transaction((s) => operations.createThread(s, dana, { projectId, anchor, body: 'Weird "quote" OR NEAR(x)', tags: [], capture: failed }));
  const search = (terms: string[]) => store.transaction(async (s) => (await s.messages.search(projectId, terms, 10)).map((message) => message.body));
  expect(await search(["cafe"])).toEqual(["Le café est fermé"]);
  expect(await search(["ferm"])).toEqual(["Le café est fermé"]);
  expect(await search(['"quote"', "NEAR(x)"])).toEqual(['Weird "quote" OR NEAR(x)']);
  expect(await search(["absent"])).toEqual([]);
});
