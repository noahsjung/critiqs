import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { DEFAULT_PLANS, utcDay } from "../src/limits.ts";
import { MAX_MENTION_EMAILS_PER_PROJECT_DAY } from "../src/notify.ts";
import * as ops from "../src/operations.ts";
import { bunDriver, SqliteStore } from "../src/sqlite/index.ts";
import { anchor, reviewer } from "./contract.ts";

const dana = reviewer("Dana");
const lee = reviewer("Lee");
const failed = { status: "failed" as const, failureReason: "test" };

test("paid plans stop queuing mention emails once a project reaches the daily safety cap", async () => {
  const db = new Database(":memory:");
  const backend = new SqliteStore(bunDriver(db), { plans: DEFAULT_PLANS });
  try {
    const projectId = await backend.transaction((store) => ops.createProject(store, dana, { name: "Demo" }));
    await backend.transaction(async (store) => {
      const project = (await store.projects.get(projectId))!;
      await store.organizations.patch(project.organizationId!, { plan: "pro" });
    });
    await backend.transaction((store) => ops.createThread(store, lee, { projectId, anchor, body: "Hi", tags: [], capture: failed }));

    const day = utcDay(Date.now());
    const key = `mention-email-safety:${projectId}:${day}`;
    await backend.transaction((store) => store.usage.insert({ key, count: MAX_MENTION_EMAILS_PER_PROJECT_DAY - 1 }));

    const leeId = (await backend.transaction((store) => store.users.byToken(lee.tokenIdentifier)))!._id;
    await backend.transaction((store) =>
      ops.createThread(store, dana, { projectId, anchor, body: "One @Lee", mentions: [{ userId: leeId, label: "Lee" }], tags: [], capture: failed }),
    );
    const beforeCap = await backend.transaction((store) => store.deliveries.due(Date.now() + 120_000, 100));
    expect(beforeCap.length).toBe(1);

    await backend.transaction((store) =>
      ops.createThread(store, dana, { projectId, anchor, body: "Two @Lee", mentions: [{ userId: leeId, label: "Lee" }], tags: [], capture: failed }),
    );
    const afterCap = await backend.transaction((store) => store.deliveries.due(Date.now() + 120_000, 100));
    expect(afterCap.length).toBe(1);
    const mentionUsage = await backend.transaction((store) => store.usage.find(`mentionEmails:${projectId}:${day}`));
    expect(mentionUsage?.count).toBe(1);
  } finally {
    db.close();
  }
});
