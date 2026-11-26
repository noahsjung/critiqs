import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { AiModelListDraft, AiSettingsInput, AiTestResult, PersonalAiSettingsInput, SearchScope } from "@critiqs/core";
import {
  applyAiSettings,
  applyPersonalAiSettings,
  getAiChoice,
  prepareModelList,
  preparePersonalModelList,
  getAiSettings,
  getPersonalAiSettings,
  getPersonalAiUsage,
  preparePersonalTest,
  prepareTest,
  recheckAiManager,
  recordPersonalTest,
  recordTest,
  removePersonalAiSettings,
  requirePersonalAiOwner,
  TESTS_PER_MINUTE,
  testConnection,
} from "../src/ai/connection.ts";
import { listModels, MODEL_LISTS_PER_MINUTE } from "../src/ai/model-lists.ts";
import { applyGrouping, claimGrouping, failGrouping, groupOnce, type GroupingSteps, MAX_GROUPING_ATTEMPTS } from "../src/ai/grouping.ts";
import { type CreditSteps, HOLD_MS, reserveCredits, settleCredits, worstCaseCredits } from "../src/ai/credits.ts";
import { AiError, type ModelUsage, type StructuredModel, type StructuredRequest } from "../src/ai/model.ts";
import { testRequest } from "../src/ai/prompts.ts";
import { createStructuredModel } from "../src/ai/providers.ts";
import { authorizeSearch, finalizeSearch, prepareSearch, retrieveSearch, runSearch, SEARCHES_PER_MINUTE } from "../src/ai/search.ts";
import { keyBinding } from "../src/ai/secrets.ts";
import { type AiDeployment, chooseConnection, connectionOf, type ManagedAi, prepareSettings, resolveConnection, resolveProjectConnection, sealKey } from "../src/ai/settings.ts";
import { type Plan, usageKey, utcDay } from "../src/limits.ts";
import * as ops from "../src/operations.ts";
import { assignPlan, ORGANIZATION_ONLY } from "../src/organizations.ts";
import type { Identity, Store } from "../src/store.ts";
import { anchor, type ContractBackend, reviewer } from "./contract.ts";

const page = { numItems: 40, cursor: null };
const failed = { status: "failed" as const, failureReason: "Blocked" };
const KEY = "operator-encryption-key-".padEnd(48, "x");

/** A deployment with no managed AI, keys storable, and one allowed custom endpoint. */
export const deployment: AiDeployment = {
  managed: null,
  defaultProvider: null,
  encryptionKey: KEY,
  endpoints: { allowed: ["https://llm.example.com/v1"], allowLocal: false },
};

/** Critiqs AI with one model, as a deployment configured with only `CRITIQS_MANAGED_AI_MODEL` offers it. */
export const managedAi: ManagedAi = { provider: "openai", apiKey: "managed-key", models: [{ id: "default", label: "Critiqs AI", model: "managed-model", credits: 1 }] };

/** A model that answers from `answer`, each call using `usage`, recording the prompts it was given. */
export function fakeModel(answer: (request: StructuredRequest<unknown>) => unknown, usage: ModelUsage = { inputTokens: 100, outputTokens: 50 }) {
  const prompts: { task: string; prompt: string }[] = [];
  const model: StructuredModel = {
    description: "Fake",
    async generate<T>(request: StructuredRequest<T>) {
      // As the AI SDK path does, right before the request is sent.
      await request.beforeSend?.();
      prompts.push({ task: request.task, prompt: request.prompt });
      const parsed = request.parse(answer(request as StructuredRequest<unknown>));
      if (parsed === null) throw new AiError("capability", "The model's answer didn't match what Critiqs asked for.");
      return { output: parsed, usage };
    },
  };
  return { model, prompts };
}

const ownSettings: AiSettingsInput = { projectId: "", enabled: true, mode: "own", provider: "openai", model: "gpt-test", apiKey: "sk-test-1234567890abcd" };

/**
 * Tags, groups, automatic grouping, search, and AI settings, the same on
 * every backend. Each test starts with a fresh, empty backend.
 */
export function defineAiContract(name: string, fresh: () => ContractBackend) {
  const dana = reviewer("Dana");
  const lee = reviewer("Lee");

  afterEach(() => setSystemTime());

  async function setup(backend: ContractBackend, body = "Department label is unclear #wording") {
    const projectId = await backend.run((store) => ops.createProject(store, dana, { name: "Admin prototype" }));
    const threadId = await backend.run((store) => ops.createThread(store, dana, { projectId, anchor, body, tags: ["Bug"], capture: failed }));
    return { projectId, threadId };
  }

  async function saveSettings(backend: ContractBackend, projectId: string, input: Partial<AiSettingsInput> = {}, who: Identity = dana, dep = deployment) {
    const prepared = await sealKey(await prepareSettings({ ...ownSettings, ...input, projectId }, dep), keyBinding("project", projectId), dep);
    return await backend.run((store) => applyAiSettings(store, who, { projectId, prepared }, dep, Date.now()));
  }

  const credits = (backend: ContractBackend): CreditSteps => ({
    reserve: (payer, amount) => backend.run((store) => reserveCredits(store, payer, amount, Date.now())),
    settle: (hold, charge) => backend.run((store) => settleCredits(store, hold, charge, Date.now())),
  });

  function grouping(backend: ContractBackend, model: StructuredModel, dep = deployment): GroupingSteps {
    return {
      // A reply is stamped at least 1 ms after its thread's last message, so a tag it adds may be due a moment from now.
      claim: (token) => backend.run((store) => claimGrouping(store, dep, Date.now() + 1_000, token)),
      apply: (claim, answer) => backend.run((store) => applyGrouping(store, claim, answer, Date.now())),
      fail: (claim, message) => backend.run((store) => failGrouping(store, claim, message, Date.now())),
      ...credits(backend),
      model: () => model,
      deployment: dep,
    };
  }

  function search(backend: ContractBackend, who: Identity, projectId: string, question: string, model: StructuredModel | null, scope: SearchScope = { status: "all", screen: null }, dep = deployment) {
    return runSearch({
      prepare: () => backend.run((store) => prepareSearch(store, who, { projectId, question, scope }, dep, Date.now())),
      authorize: () => backend.run((store) => authorizeSearch(store, who, { projectId })),
      retrieve: (query, groups) => backend.run((store) => retrieveSearch(store, who, { projectId, query, groups })),
      finalize: (response) => backend.run((store) => finalizeSearch(store, who, { projectId, response })),
      ...credits(backend),
      model: () => {
        if (model === null) throw new Error("No model expected");
        return model;
      },
      deployment: dep,
      now: Date.now(),
    });
  }

  const tagsOf = (backend: ContractBackend, projectId: string, who: Identity = dana) => backend.run((store) => ops.listTags(store, who, { projectId }));
  /** `count` different hashtags: `#t0 #t1 …`, starting at `from`. */
  const hashtags = (prefix: string, count: number, from = 0) => Array.from({ length: count }, (_, i) => `#${prefix}${from + i}`).join(" ");

  // -------------------------------------------------------------------------
  // Hashtags

  test(`${name}: hashtags in a new thread, replies, and edits become its tags, beside explicit tags`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await setup(backend, "Label unclear #Wording, see https://x.example/#anchor and C#");
    const thread = () => backend.run((store) => ops.getThread(store, lee, { threadId }, page));
    expect(await thread()).toMatchObject({ tags: ["Bug", "Wording"], textTags: ["Wording"] });
    const replyId = await backend.run((store) => ops.reply(store, lee, { threadId, body: "Agreed #wording #microcopy", revision: null }));
    expect((await thread()).tags).toEqual(["Bug", "Wording", "microcopy"]);
    // The reply no longer uses #microcopy: the thread loses it; #wording stays, the first message still has it.
    await backend.run((store) => ops.editMessage(store, lee, { messageId: replyId, body: "Agreed #wording" }));
    expect((await thread()).tags).toEqual(["Bug", "Wording"]);
    const [first] = (await thread()).page;
    await backend.run((store) => ops.editMessage(store, dana, { messageId: first!._id, body: "Label unclear" }));
    // Still written in the reply; the first spelling seen stays.
    expect((await thread()).tags).toEqual(["Bug", "Wording"]);
    await backend.run((store) => ops.editMessage(store, lee, { messageId: replyId, body: "Agreed" }));
    expect(await thread()).toMatchObject({ tags: ["Bug"], textTags: [] });
    const listed = await backend.run((store) => ops.listThreads(store, lee, { projectId }, page));
    expect(listed.page[0]).toMatchObject({ tags: ["Bug"], textTags: [] });
    // The text is kept exactly as written.
    expect((await thread()).page[0]!.body).toBe("Label unclear");
  });

  test(`${name}: an older client's whole tag list neither repeats nor drops written tags`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await setup(backend);
    const thread = () => backend.run((store) => ops.getThread(store, lee, { threadId }, page));
    // An older client toggles "UX copy change" on, sending back every tag it was shown.
    await backend.run((store) => ops.setTags(store, lee, { threadId, tags: ["Bug", "wording", "UX copy change"] }));
    expect((await thread()).tags).toEqual(["Bug", "UX copy change", "wording"]);
    // And toggles Bug off, also leaving out the written tag: the written tag stays.
    await backend.run((store) => ops.setTags(store, lee, { threadId, tags: ["UX copy change"] }));
    expect((await thread()).tags).toEqual(["UX copy change", "wording"]);
    // Presets stay what ProjectInfo lists, so older composers aren't flooded with free tags.
    expect((await backend.run((store) => ops.getProject(store, lee, { projectId }))).tags).toEqual(["Bug", "UX copy change", "Design change request", "User feedback"]);
    const exported = await backend.run((store) => ops.exportThreads(store, lee, { projectId, threadIds: [threadId], threadIndex: 0 }, page));
    expect(exported.thread?.tags).toEqual(["UX copy change", "wording"]);
  });

  test(`${name}: an explicit tag the text also writes stays when the whole tag list is sent back and the text drops it`, async () => {
    const backend = fresh();
    // Bug is chosen explicitly and also written in the text.
    const { threadId } = await setup(backend, "Broken #Bug");
    const thread = () => backend.run((store) => ops.getThread(store, lee, { threadId }, page));
    const replyId = await backend.run((store) => ops.reply(store, lee, { threadId, body: "Still #bug", revision: null }));
    // A client adds a tag, sending back every tag it was shown.
    await backend.run((store) => ops.setTags(store, lee, { threadId, tags: ["Bug", "UX copy change"] }));
    expect((await thread()).tags).toEqual(["Bug", "UX copy change"]);
    const [first] = (await thread()).page;
    await backend.run((store) => ops.editMessage(store, dana, { messageId: first!._id, body: "Broken" }));
    await backend.run((store) => ops.editMessage(store, lee, { messageId: replyId, body: "Still" }));
    expect(await thread()).toMatchObject({ tags: ["Bug", "UX copy change"], textTags: [] });
    // Toggling it off explicitly still removes it.
    await backend.run((store) => ops.setTags(store, lee, { threadId, tags: ["UX copy change"] }));
    expect((await thread()).tags).toEqual(["UX copy change"]);
  });

  test(`${name}: a message with more different hashtags than a message keeps is refused whole, on create, reply, and edit`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await setup(backend);
    const thread = () => backend.run((store) => ops.getThread(store, lee, { threadId }, page));
    const tooMany = `Many ${hashtags("a", 31)}`;
    await expect(backend.run((store) => ops.createThread(store, dana, { projectId, anchor, body: tooMany, tags: [], capture: failed }))).rejects.toThrow(
      "A message can use up to 30 different hashtags; this one uses 31.",
    );
    expect((await backend.run((store) => ops.listThreads(store, lee, { projectId }, page))).page).toHaveLength(1);
    await expect(backend.run((store) => ops.reply(store, lee, { threadId, body: tooMany, revision: null }))).rejects.toThrow("up to 30 different hashtags");
    const [first] = (await thread()).page;
    await expect(backend.run((store) => ops.editMessage(store, dana, { messageId: first!._id, body: tooMany }))).rejects.toThrow("up to 30 different hashtags");
    // Nothing was saved: no reply, the first message as written, and no tags from the refused text.
    expect(await thread()).toMatchObject({ tags: ["Bug", "wording"], messageCount: 1 });
    expect((await thread()).page.map((message) => [message.body, message.editedAt])).toEqual([["Department label is unclear #wording", null]]);
    expect((await tagsOf(backend, projectId)).tags.some((tag) => tag.key === "a0")).toBe(false);
    // Repeats count once, so 30 different hashtags post.
    await backend.run((store) => ops.reply(store, lee, { threadId, body: `${hashtags("a", 30)} #A0`, revision: null }));
    expect((await thread()).textTags).toHaveLength(31);
  });

  test(`${name}: a new hashtag beyond a thread's 200 is refused, and at the limit an edit can swap one for another`, async () => {
    const backend = fresh();
    const { threadId } = await setup(backend, `Start ${hashtags("t", 30)}`);
    const thread = () => backend.run((store) => ops.getThread(store, lee, { threadId }, page));
    let last = "";
    for (let from = 30; from < 200; from += 30) {
      last = await backend.run((store) => ops.reply(store, lee, { threadId, body: hashtags("t", Math.min(30, 200 - from), from), revision: null }));
    }
    expect((await thread()).textTags).toHaveLength(200);
    await expect(backend.run((store) => ops.reply(store, lee, { threadId, body: "One more #extra", revision: null }))).rejects.toThrow(
      "A thread's messages can use up to 200 different hashtags, and this thread's already do, so #extra can't be added.",
    );
    expect((await thread()).messageCount).toBe(7);
    // Hashtags the thread already uses still post.
    await backend.run((store) => ops.reply(store, lee, { threadId, body: "Again #t0", revision: null }));
    // The last reply drops #t199 and writes #extra instead.
    const swapped = `${hashtags("t", 19, 180)} #extra`;
    await backend.run((store) => ops.editMessage(store, lee, { messageId: last, body: swapped }));
    const after = (await thread()).textTags!;
    expect(after).toHaveLength(200);
    expect(after).toContain("extra");
    expect(after).not.toContain("t199");
    // Adding one without dropping another is refused, leaving the reply as it was.
    await expect(backend.run((store) => ops.editMessage(store, lee, { messageId: last, body: `${swapped} #more` }))).rejects.toThrow("so #more can't be added");
    expect((await thread()).page.find((message) => message._id === last)!.body).toBe(swapped);
    expect((await thread()).textTags).toEqual(after);
  });

  test(`${name}: at a thread's 200 hashtags, an edit that keeps one and adds another is refused in either order, keeping its tag searchable`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await setup(backend, `Start ${hashtags("t", 30)}`);
    const thread = () => backend.run((store) => ops.getThread(store, lee, { threadId }, page));
    for (let from = 30; from < 199; from += 30) {
      await backend.run((store) => ops.reply(store, lee, { threadId, body: hashtags("t", Math.min(30, 199 - from), from), revision: null }));
    }
    // The last reply alone writes #t199, and #t0 is shared with the first message.
    const last = await backend.run((store) => ops.reply(store, lee, { threadId, body: "Only #t199 #t0", revision: null }));
    const full = (await thread()).textTags!;
    expect(full).toHaveLength(200);
    const found = async (tag: string) => (await search(backend, dana, projectId, `#${tag}`, null)).results.map((result) => result.threadId);
    expect(await found("t199")).toEqual([threadId]);

    for (const body of ["#extra #t199", "#t199 #extra"]) {
      await expect(backend.run((store) => ops.editMessage(store, lee, { messageId: last, body }))).rejects.toThrow("so #extra can't be added");
      expect((await thread()).page.find((message) => message._id === last)!.body).toBe("Only #t199 #t0");
      expect((await thread()).textTags).toEqual(full);
      expect(await found("t199")).toEqual([threadId]);
      expect(await found("extra")).toEqual([]);
    }

    // Keeping both written tags while dropping the shared one still adds nothing new.
    await backend.run((store) => ops.editMessage(store, lee, { messageId: last, body: "Kept #t199" }));
    expect((await thread()).textTags).toEqual(full);
    expect(await found("t0")).toEqual([threadId]);
    // Replacing the only use of #t199 frees its place for #extra.
    await backend.run((store) => ops.editMessage(store, lee, { messageId: last, body: "Now #extra" }));
    const swapped = (await thread()).textTags!;
    expect(swapped).toHaveLength(200);
    expect(swapped).toContain("extra");
    expect(swapped).not.toContain("t199");
    expect(await found("extra")).toEqual([threadId]);
    expect(await found("t199")).toEqual([]);
  });

  test(`${name}: an older client's whole tag list may hold every written tag beside up to 50 explicit tags`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await setup(backend, `First ${hashtags("w", 30)}`);
    const thread = () => backend.run((store) => ops.getThread(store, lee, { threadId }, page));
    await backend.run((store) => ops.reply(store, lee, { threadId, body: hashtags("w", 30, 30), revision: null }));
    const written = Array.from({ length: 60 }, (_, i) => `w${i}`);
    const shown = (await thread()).tags;
    expect(shown).toEqual(["Bug", ...written]);
    // An older client toggles a preset on, sending back all 61 tags it was shown.
    await backend.run((store) => ops.setTags(store, lee, { threadId, tags: [...shown, "UX copy change"] }));
    expect(await thread()).toMatchObject({ tags: ["Bug", "UX copy change", ...written], textTags: written });
    // And Bug off.
    await backend.run((store) => ops.setTags(store, lee, { threadId, tags: ["UX copy change", ...written] }));
    expect((await thread()).tags).toEqual(["UX copy change", ...written]);
    // Explicit tags are still limited to 50, besides the written ones.
    const free = Array.from({ length: 51 }, (_, i) => `free${i}`);
    await backend.run((store) => ops.setTags(store, lee, { threadId, tags: [...free.slice(0, 50), ...written] }));
    expect((await thread()).tags).toEqual([...free.slice(0, 50), ...written]);
    await expect(backend.run((store) => ops.setTags(store, lee, { threadId, tags: [...free, ...written] }))).rejects.toThrow(
      "A thread can have up to 50 tags besides the hashtags its messages use.",
    );
    expect((await thread()).tags).toEqual([...free.slice(0, 50), ...written]);
    // No list is longer than 50 explicit and 200 written tags, and a new thread chooses up to 50.
    const huge = Array.from({ length: 251 }, (_, i) => `x${i}`);
    await expect(backend.run((store) => ops.setTags(store, lee, { threadId, tags: huge }))).rejects.toThrow("up to 50 tags");
    await expect(backend.run((store) => ops.createThread(store, dana, { projectId, anchor, body: "x", tags: free, capture: failed }))).rejects.toThrow("up to 50 tags");
  });

  test(`${name}: the project's tags list presets and free tags by recent use, matched by key with the first spelling`, async () => {
    const backend = fresh();
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { projectId, threadId } = await setup(backend, "First #Onboarding");
    setSystemTime(new Date("2026-01-02T00:00:00Z"));
    await backend.run((store) => ops.reply(store, lee, { threadId, body: "Also #onboarding and #Checkout_Flow", revision: null }));
    const { tags, canOrganize } = await tagsOf(backend, projectId);
    expect(tags.filter((tag) => tag.lastUsedAt !== null).map((tag) => [tag.label, tag.preset])).toEqual([
      // Used at the same time: by name.
      ["Checkout_Flow", false],
      ["Onboarding", false],
      ["Bug", true],
    ]);
    expect(tags.filter((tag) => tag.lastUsedAt === null).map((tag) => tag.label)).toEqual(["Design change request", "User feedback", "UX copy change"]);
    expect(canOrganize).toBe(true);
    expect((await tagsOf(backend, projectId, lee)).canOrganize).toBe(false);
  });

  test(`${name}: copy and wording tags join the starter group without AI`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend, "Please make the department label clearer. #wording #microcopy #layout");
    const { tags, groups } = await tagsOf(backend, projectId);
    const copy = groups.find((group) => group.name === "Copy & wording")!;
    expect(copy.origin).toBe("starter");
    const byLabel = Object.fromEntries(tags.map((tag) => [tag.label, tag]));
    expect(byLabel.wording).toMatchObject({ groupIds: [copy._id], grouping: "starter" });
    expect(byLabel.microcopy).toMatchObject({ groupIds: [copy._id], grouping: "starter" });
    expect(byLabel.layout).toMatchObject({ groupIds: [], grouping: "pending" });
  });

  // -------------------------------------------------------------------------
  // Groups

  test(`${name}: only the project's owner organizes groups; a person's choice is final and tags may share groups`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend, "Odd #spacing and #layout");
    await expect(backend.run((store) => ops.createGroup(store, lee, { projectId, name: "Visual design" }))).rejects.toThrow("Only the person");
    const visual = await backend.run((store) => ops.createGroup(store, dana, { projectId, name: "Visual design" }));
    await expect(backend.run((store) => ops.createGroup(store, dana, { projectId, name: " visual  DESIGN " }))).rejects.toThrow("already exists");
    const polish = await backend.run((store) => ops.createGroup(store, dana, { projectId, name: "Polish" }));
    await backend.run((store) => ops.setTagGroups(store, dana, { projectId, tag: "#Spacing", groupIds: [visual, polish] }));
    await expect(backend.run((store) => ops.setTagGroups(store, lee, { projectId, tag: "layout", groupIds: [visual] }))).rejects.toThrow("Only the person");
    let tags = (await tagsOf(backend, projectId)).tags;
    expect(tags.find((tag) => tag.key === "spacing")).toMatchObject({ groupIds: [visual, polish], grouping: "human" });
    await backend.run((store) => ops.renameGroup(store, dana, { projectId, groupId: visual, name: "Visuals" }));
    await backend.run((store) => ops.mergeGroups(store, dana, { projectId, groupId: polish, intoGroupId: visual }));
    const { groups } = await tagsOf(backend, projectId);
    expect(groups.map((group) => group.name).sort()).toEqual(["Visuals"]);
    tags = (await tagsOf(backend, projectId)).tags;
    expect(tags.find((tag) => tag.key === "spacing")!.groupIds).toEqual([visual]);
    await backend.run((store) => ops.deleteGroup(store, dana, { projectId, groupId: visual }));
    tags = (await tagsOf(backend, projectId)).tags;
    expect(tags.find((tag) => tag.key === "spacing")).toMatchObject({ groupIds: [], grouping: "human" });
    // A preset nobody used yet can be grouped too.
    const research = await backend.run((store) => ops.createGroup(store, dana, { projectId, name: "Research" }));
    await backend.run((store) => ops.setTagGroups(store, dana, { projectId, tag: "User feedback", groupIds: [research] }));
    expect((await tagsOf(backend, projectId)).tags.find((tag) => tag.label === "User feedback")!.groupIds).toEqual([research]);
  });

  // -------------------------------------------------------------------------
  // Automatic grouping

  test(`${name}: automatic grouping places pending tags, creates groups, and never moves grouped or human tags`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await setup(backend, "Odd #spacing, #wording");
    await saveSettings(backend, projectId);
    const manual = await backend.run((store) => ops.createGroup(store, dana, { projectId, name: "Manual" }));
    await backend.run((store) => ops.reply(store, lee, { threadId, body: "and #padding #layout", revision: null }));
    // A person ungroups #layout: it is final.
    await backend.run((store) => ops.setTagGroups(store, dana, { projectId, tag: "layout", groupIds: [] }));
    const { model, prompts } = fakeModel((request) => {
      if (request.task !== "grouping") return null;
      return {
        assignments: [
          { tag: "spacing", groups: [], newGroups: ["Visual design"] },
          { tag: "padding", groups: [], newGroups: ["Visual design"] },
          { tag: "Bug", groups: ["G99"], newGroups: [] },
          // Answers about tags it wasn't given change nothing.
          { tag: "layout", groups: ["G1"], newGroups: [] },
          { tag: "wording", groups: ["G1"], newGroups: [] },
        ],
      };
    });
    expect(await groupOnce(grouping(backend, model))).toBe(true);
    expect(prompts[0]!.prompt).not.toContain('"layout"');
    expect(prompts[0]!.prompt).not.toContain('"wording"');
    const { tags, groups } = await tagsOf(backend, projectId);
    const visual = groups.find((group) => group.name === "Visual design")!;
    expect(visual.origin).toBe("ai");
    const byKey = Object.fromEntries(tags.map((tag) => [tag.key, tag]));
    expect(byKey.spacing).toMatchObject({ groupIds: [visual._id], grouping: "ai" });
    expect(byKey.padding).toMatchObject({ groupIds: [visual._id], grouping: "ai" });
    expect(byKey.bug).toMatchObject({ groupIds: [], grouping: "ai" });
    expect(byKey.layout).toMatchObject({ groupIds: [], grouping: "human" });
    expect(byKey.wording!.grouping).toBe("starter");
    expect(groups.some((group) => group._id === manual)).toBe(true);
    // Nothing is left to group; a second run finds nothing.
    expect(await groupOnce(grouping(backend, model))).toBe(false);
  });

  test(`${name}: a person's change or new settings during a grouping run win over its answer`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await setup(backend, "#spacing #padding");
    await saveSettings(backend, projectId);
    const visual = await backend.run((store) => ops.createGroup(store, dana, { projectId, name: "Visual" }));
    const claim = (await backend.run((store) => claimGrouping(store, deployment, Date.now(), "run-1")))!;
    expect(claim.tags.map((tag) => tag.key).sort()).toEqual(["bug", "padding", "spacing"]);
    // Meanwhile the owner places #spacing.
    await backend.run((store) => ops.setTagGroups(store, dana, { projectId, tag: "spacing", groupIds: [] }));
    const answer = { assignments: new Map(claim.tags.map((tag) => [tag.key, { groupIds: [visual], newGroups: [] }])) };
    expect(await backend.run((store) => applyGrouping(store, claim, answer, Date.now()))).toBe(2);
    let tags = (await tagsOf(backend, projectId)).tags;
    expect(tags.find((tag) => tag.key === "spacing")).toMatchObject({ groupIds: [], grouping: "human" });
    expect(tags.find((tag) => tag.key === "padding")).toMatchObject({ groupIds: [visual], grouping: "ai" });
    // A run claimed under older settings applies nothing.
    await backend.run((store) => ops.reply(store, dana, { threadId, body: "#margin", revision: null }));
    // A reply is stamped at least 1 ms after the thread's last message, so its tag may be due a moment from now.
    const second = (await backend.run((store) => claimGrouping(store, deployment, Date.now() + 1_000, "run-2")))!;
    await saveSettings(backend, projectId, { model: "gpt-other" });
    const other = { assignments: new Map(second.tags.map((tag) => [tag.key, { groupIds: [visual], newGroups: [] }])) };
    expect(await backend.run((store) => applyGrouping(store, second, other, Date.now()))).toBe(0);
    tags = (await tagsOf(backend, projectId)).tags;
    expect(tags.find((tag) => tag.key === "margin")).toMatchObject({ groupIds: [], grouping: "pending" });
  });

  test(`${name}: grouping failures retry later and stop after the last attempt, while comments keep posting`, async () => {
    const backend = fresh();
    setSystemTime(new Date("2026-03-01T00:00:00Z"));
    const { projectId, threadId } = await setup(backend, "#spacing");
    await saveSettings(backend, projectId);
    const broken = fakeModel(() => {
      throw new AiError("network", "Critiqs couldn't reach the provider, or it didn't answer in time.");
    });
    const steps = grouping(backend, broken.model);
    for (let attempt = 1; attempt <= MAX_GROUPING_ATTEMPTS; attempt++) {
      expect(await groupOnce(steps)).toBe(true);
      // Posting works whatever grouping is doing.
      await backend.run((store) => ops.reply(store, lee, { threadId, body: `Still broken ${attempt}`, revision: null }));
      // Not due again until its pause passes.
      expect(await groupOnce(steps)).toBe(false);
      setSystemTime(new Date(Date.now() + 13 * 3_600_000));
    }
    const tag = (await tagsOf(backend, projectId)).tags.find((entry) => entry.key === "spacing")!;
    expect(tag.grouping).toBe("none");
    expect(await groupOnce(steps)).toBe(false);
    expect((await backend.run((store) => ops.getThread(store, dana, { threadId }, page))).messageCount).toBe(MAX_GROUPING_ATTEMPTS + 1);
  });

  test(`${name}: without AI, pending tags are left ungrouped, and wait again once the owner connects AI`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend, "#spacing");
    const { model, prompts } = fakeModel(() => ({ assignments: [] }));
    // No settings, no managed AI, no deployment provider: nothing to call.
    expect(await groupOnce(grouping(backend, model))).toBe(false);
    expect(prompts).toEqual([]);
    expect((await tagsOf(backend, projectId)).tags.find((tag) => tag.key === "spacing")!.grouping).toBe("none");
    await saveSettings(backend, projectId);
    expect((await tagsOf(backend, projectId)).tags.find((tag) => tag.key === "spacing")!.grouping).toBe("pending");
  });

  // -------------------------------------------------------------------------
  // Search

  test(`${name}: basic search finds words in replies and #tags, never deleted threads or other projects, and says AI wasn't used`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await setup(backend, "Department label is unclear");
    await backend.run((store) => ops.reply(store, lee, { threadId, body: "The tooltip wording also confuses people", revision: null }));
    const tagged = await backend.run((store) => ops.createThread(store, lee, { projectId, anchor, body: "Revoke access link #permissions", tags: [], capture: failed }));
    const deleted = await backend.run((store) => ops.createThread(store, lee, { projectId, anchor, body: "Tooltip copy is wrong", tags: [], capture: failed }));
    await backend.run((store) => ops.removeThread(store, lee, { threadId: deleted }));
    const other = await backend.run((store) => ops.createProject(store, lee, { name: "Other" }));
    await backend.run((store) => ops.createThread(store, lee, { projectId: other, anchor, body: "Tooltip elsewhere", tags: [], capture: failed }));

    const words = await search(backend, dana, projectId, "tooltip", null);
    expect(words.mode).toBe("basic");
    expect(words.notice).toStartWith("AI unavailable: basic search.");
    expect(words.results.map((result) => result.threadId)).toEqual([threadId]);
    expect(words.results[0]!.matches[0]!.excerpt).toContain("tooltip wording");
    expect(words.insights).toEqual([]);

    const tags = await search(backend, dana, projectId, "#Permissions", null);
    expect(tags.query.tags).toEqual(["permissions"]);
    expect(tags.results.map((result) => result.threadId)).toEqual([tagged]);
    // The sidebar's scope applies: resolved only finds nothing open.
    expect((await search(backend, dana, projectId, "tooltip", null, { status: "resolved", screen: null })).results).toEqual([]);
    expect((await search(backend, dana, projectId, "tooltip", null, { status: "all", screen: "another-screen" })).results).toEqual([]);
  });

  test(`${name}: AI search interprets the question, and insights cite only threads it returned`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await setup(backend, "Department label is unclear #wording");
    const second = await backend.run((store) => ops.createThread(store, lee, { projectId, anchor, body: "Revoke access button text #microcopy", tags: [], capture: failed }));
    await backend.run((store) => ops.createThread(store, lee, { projectId, anchor, body: "Avatar is blurry", tags: [], capture: failed }));
    await saveSettings(backend, projectId);
    const copyGroup = (await tagsOf(backend, projectId)).groups.find((group) => group.name === "Copy & wording")!;
    const { model, prompts } = fakeModel((request) => {
      if (request.task === "search") {
        const label = request.prompt.match(/(G\d+) = "Copy & wording"/)?.[1];
        return { terms: [], tags: ["unknown-tag"], groups: [label, "G42"], status: "unspecified", since: "", until: "", screen: "" };
      }
      if (request.task === "insights") {
        return {
          findings: [
            { title: "Labels need clearer words", detail: "Two threads ask for clearer text.", threads: ["T1", "T2", "T9"] },
            { title: "Made up", detail: "No support.", threads: ["T7"] },
          ],
        };
      }
      return null;
    });
    const response = await search(backend, dana, projectId, "What do people say about copy?", model);
    expect(response.mode).toBe("ai");
    expect(response.notice).toBeNull();
    expect(response.query).toMatchObject({ terms: [], tags: [], groupIds: [copyGroup._id] });
    expect(response.results.map((result) => result.threadId).sort()).toEqual([threadId, second].sort());
    // The finding citing a thread it wasn't given loses that citation; the unsupported one is dropped.
    expect(response.insights).toHaveLength(1);
    expect(response.insights[0]!.threadIds.sort()).toEqual([threadId, second].sort());
    // Reviewers' text reached the model only as quoted data.
    expect(prompts.find((entry) => entry.task === "insights")!.prompt).toContain('"Department label is unclear #wording"');
  });

  test(`${name}: a question only about status, screen, or dates searches without words`, async () => {
    const backend = fresh();
    const { projectId, threadId: open } = await setup(backend, "Resolved state of the toggle is wrong");
    const resolved = await backend.run((store) => ops.createThread(store, lee, { projectId, anchor, body: "Button is too small", tags: [], capture: failed }));
    await backend.run((store) => ops.setStatus(store, lee, { threadId: resolved, status: "resolved" }));
    await saveSettings(backend, projectId);
    const filterOnly = fakeModel((request) =>
      request.task === "search" ? { terms: [], tags: [], groups: [], status: "resolved", since: "", until: "", screen: "" } : { findings: [] },
    );
    const response = await search(backend, dana, projectId, "Show resolved comments", filterOnly.model);
    expect(response.mode).toBe("ai");
    expect(response.query).toMatchObject({ terms: [], status: "resolved" });
    expect(response.results.map((result) => result.threadId)).toEqual([resolved]);
    // When the model understood nothing at all, the question's own words stand in.
    const nothing = fakeModel((request) =>
      request.task === "search" ? { terms: [], tags: [], groups: [], status: "unspecified", since: "", until: "", screen: "" } : { findings: [] },
    );
    const fallback = await search(backend, dana, projectId, "toggle state", nothing.model);
    expect(fallback.query.terms).toEqual(["toggle", "state"]);
    expect(fallback.results.map((result) => result.threadId)).toEqual([open]);
  });

  test(`${name}: a group with more tags than one search looks up says its results are incomplete`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend, "Unrelated");
    const group = await backend.run((store) => ops.createGroup(store, dana, { projectId, name: "Areas" }));
    const labels = Array.from({ length: 31 }, (_, index) => `area${String(index).padStart(2, "0")}`);
    for (const label of labels) {
      await backend.run((store) => ops.createThread(store, lee, { projectId, anchor, body: `Issue in #${label}`, tags: [], capture: failed }));
      await backend.run((store) => ops.setTagGroups(store, dana, { projectId, tag: label, groupIds: [group] }));
    }
    await saveSettings(backend, projectId);
    const { model } = fakeModel((request) => {
      if (request.task !== "search") return { findings: [] };
      const label = request.prompt.match(/(G\d+) = "Areas"/)?.[1];
      return { terms: [], tags: [], groups: [label], status: "unspecified", since: "", until: "", screen: "" };
    });
    const all = await search(backend, dana, projectId, "What about areas?", model);
    expect(all.query.groupIds).toEqual([group]);
    expect(all.results).toHaveLength(30);
    expect(all.truncated).toBe(true);
    // Every member looked up: complete.
    await backend.run((store) => ops.setTagGroups(store, dana, { projectId, tag: labels[30]!, groupIds: [] }));
    const fits = await search(backend, dana, projectId, "What about areas?", model);
    expect(fits.results).toHaveLength(30);
    expect(fits.truncated).toBe(false);
    // A project with more tags than search reads to learn groups' members knows a group only partly.
    const query = { terms: [], tags: [], groupIds: [group], status: "all" as const, screen: null, since: null, until: null };
    const partly = await backend.run((store) => retrieveSearch(store, dana, { projectId, query, groups: [{ id: group, tagKeys: labels.slice(0, 2), partial: true }] }));
    expect(partly.results).toHaveLength(2);
    expect(partly.truncated).toBe(true);
  });

  test(`${name}: a failing model falls back to basic search with a notice, and never to another provider`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await setup(backend, "Department label is unclear");
    // Managed AI exists on this deployment, but the project chose its own provider.
    const withManaged: AiDeployment = { ...deployment, managed: managedAi };
    await saveSettings(backend, projectId, {}, dana, withManaged);
    const used: string[] = [];
    const broken: StructuredModel = {
      description: "broken",
      generate: async () => {
        throw new AiError("auth", "The provider refused the key. Check that it is correct and active.");
      },
    };
    const response = await runSearch({
      prepare: () => backend.run((store) => prepareSearch(store, dana, { projectId, question: "department", scope: { status: "all", screen: null } }, withManaged, Date.now())),
      authorize: () => backend.run((store) => authorizeSearch(store, dana, { projectId })),
      retrieve: (query, groups) => backend.run((store) => retrieveSearch(store, dana, { projectId, query, groups })),
      finalize: (result) => backend.run((store) => finalizeSearch(store, dana, { projectId, response: result })),
      ...credits(backend),
      model: (connection) => {
        used.push(`${connection.mode}:${connection.model}`);
        return broken;
      },
      deployment: withManaged,
      now: Date.now(),
    });
    expect(used).toEqual(["own:gpt-test"]);
    expect(response.mode).toBe("basic");
    expect(response.notice).toBe("AI unavailable: basic search. The provider refused the key. Check that it is correct and active.");
    expect(response.results.map((result) => result.threadId)).toEqual([threadId]);
  });

  test(`${name}: a thread deleted before the answer is returned is left out, with its citations`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await setup(backend, "Unclear label");
    const retrieved = await backend.run((store) =>
      retrieveSearch(store, dana, { projectId, query: { terms: ["unclear"], tags: [], groupIds: [], status: "all", screen: null, since: null, until: null }, groups: [] }),
    );
    expect(retrieved.results).toHaveLength(1);
    await backend.run((store) => ops.removeThread(store, dana, { threadId }));
    const final = await backend.run((store) =>
      finalizeSearch(store, dana, {
        projectId,
        response: { mode: "ai", notice: null, query: retrieved.query, results: retrieved.results, truncated: false, insights: [{ title: "x", detail: "y", threadIds: [threadId] }], insightNotice: null },
      }),
    );
    expect(final.results).toEqual([]);
    expect(final.insights).toEqual([]);
  });

  test(`${name}: searches are limited per reviewer per minute, and need sign-in`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend);
    const scope = { status: "all" as const, screen: null };
    for (let i = 0; i < SEARCHES_PER_MINUTE; i++) {
      await backend.run((store) => prepareSearch(store, lee, { projectId, question: "label", scope }, deployment, 1_000));
    }
    await expect(backend.run((store) => prepareSearch(store, lee, { projectId, question: "label", scope }, deployment, 2_000))).rejects.toThrow("a lot of searches");
    // Another reviewer, or the next minute, isn't affected.
    await backend.run((store) => prepareSearch(store, dana, { projectId, question: "label", scope }, deployment, 2_000));
    await backend.run((store) => prepareSearch(store, lee, { projectId, question: "label", scope }, deployment, 62_000));
    await expect(backend.run((store) => prepareSearch(store, null, { projectId, question: "label", scope }, deployment, 62_000))).rejects.toThrow("Sign in");
    await expect(backend.run((store) => prepareSearch(store, lee, { projectId, question: "x".repeat(501), scope }, deployment, 62_000))).rejects.toThrow("limited to 500");
  });

  // -------------------------------------------------------------------------
  // AI settings

  test(`${name}: only the owner sees and changes AI settings, and the key never comes back`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend);
    await expect(backend.run((store) => getAiSettings(store, lee, { projectId }, deployment))).rejects.toThrow("Only the person");
    const prepared = await sealKey(await prepareSettings({ ...ownSettings, projectId }, deployment), keyBinding("project", projectId), deployment);
    await expect(backend.run((store) => applyAiSettings(store, lee, { projectId, prepared }, deployment, Date.now()))).rejects.toThrow("Only the person");
    const view = await saveSettings(backend, projectId);
    expect(view).toMatchObject({ enabled: true, mode: "own", provider: "openai", model: "gpt-test", keyHint: "abcd", status: { ready: true } });
    expect(JSON.stringify(view)).not.toContain("sk-test");
    const stored = await backend.run((store: Store) => store.aiSettings.find(projectId));
    expect(JSON.stringify(stored)).not.toContain("sk-test");
    const connection = await resolveProjectConnection(projectId, stored, deployment);
    expect(connection).toMatchObject({ ready: true, apiKey: "sk-test-1234567890abcd" });
    // Another project's settings can't use this ciphertext.
    expect(await resolveProjectConnection("another-project", stored, deployment)).toMatchObject({ ready: false });
    // A different operator key can't read it: the owner is told to enter the key again.
    expect(await resolveProjectConnection(projectId, stored, { ...deployment, encryptionKey: "another-operator-key".padEnd(40, "y") })).toMatchObject({ ready: false, reason: expect.stringContaining("Enter the key again") });
  });

  test(`${name}: keys need the operator's encryption key, endpoints need the allowlist, and a key stays with its provider`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend);
    await expect(prepareSettings({ ...ownSettings, projectId }, { ...deployment, encryptionKey: null })).rejects.toThrow("CRITIQS_AI_ENCRYPTION_KEY");
    await expect(prepareSettings({ ...ownSettings, projectId, provider: "compatible", baseUrl: "https://evil.example/v1" }, deployment)).rejects.toThrow("allowed AI endpoints");
    await expect(prepareSettings({ ...ownSettings, projectId, provider: "compatible", baseUrl: "http://127.0.0.1:11434/v1" }, deployment)).rejects.toThrow();
    await expect(prepareSettings({ ...ownSettings, projectId, provider: "compatible", baseUrl: "https://user:pw@llm.example.com/v1" }, deployment)).rejects.toThrow("username");
    await expect(saveSettings(backend, projectId, { mode: "managed" })).rejects.toThrow("isn't available");
    await saveSettings(backend, projectId, { provider: "compatible", baseUrl: "https://llm.example.com/v1/", apiKey: "secret-key-wxyz" });
    let view = await backend.run((store) => getAiSettings(store, dana, { projectId }, deployment));
    expect(view).toMatchObject({ provider: "compatible", baseUrl: "https://llm.example.com/v1", keyHint: "wxyz" });
    // Changing the provider without a new key drops the saved one, so it's never sent elsewhere.
    await saveSettings(backend, projectId, { provider: "anthropic", baseUrl: null, apiKey: undefined, model: "claude-test" });
    view = await backend.run((store) => getAiSettings(store, dana, { projectId }, deployment));
    expect(view).toMatchObject({ provider: "anthropic", baseUrl: null, keyHint: null, status: { ready: false } });
    // Turning AI off keeps the settings but stops using them.
    await saveSettings(backend, projectId, { enabled: false, apiKey: "sk-ant-key-5678" });
    view = await backend.run((store) => getAiSettings(store, dana, { projectId }, deployment));
    expect(view).toMatchObject({ enabled: false, keyHint: "5678", status: { ready: false, reason: "AI is turned off for this project." } });
  });

  test(`${name}: a connection test uses the saved connection, records its result, and reports failures plainly`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend);
    await saveSettings(backend, projectId);
    const steps = (model: StructuredModel) => ({
      prepare: () => backend.run(async (store) => ({ source: "project" as const, ownerId: projectId, settings: await store.aiSettings.find(projectId), refused: null })),
      record: (epoch: number, result: AiTestResult) => backend.run((store) => recordTest(store, dana, { projectId, epoch, result }, Date.now())),
      ...credits(backend),
      model: () => model,
      deployment,
    });
    const ok = await testConnection(steps(fakeModel(() => ({ status: "ok" })).model));
    expect(ok).toEqual({ ok: true, message: "Connected to OpenAI with gpt-test; structured answers work." });
    expect((await backend.run((store) => getAiSettings(store, dana, { projectId }, deployment))).lastTest).toMatchObject({ ok: true });
    const bad = await testConnection(steps(fakeModel(() => ({ status: "nope" })).model));
    expect(bad).toMatchObject({ ok: false, code: "capability" });
    // A draft is tested without saving it or its key.
    const draft = await testConnection(steps(fakeModel(() => ({ status: "ok" })).model), { ...ownSettings, projectId, provider: "compatible", baseUrl: "https://evil.example" });
    expect(draft).toMatchObject({ ok: false, code: "config" });
    expect((await backend.run((store) => getAiSettings(store, dana, { projectId }, deployment))).provider).toBe("openai");
  });

  /** The real connection-test steps for `who`, with `model` standing in for the provider unless given. */
  function testSteps(backend: ContractBackend, who: Identity, projectId: string, dep: AiDeployment, model?: StructuredModel) {
    return {
      prepare: () => backend.run((store) => prepareTest(store, who, { projectId }, dep, Date.now())),
      record: (epoch: number, result: AiTestResult) => backend.run((store) => recordTest(store, who, { projectId, epoch, result }, Date.now())),
      recheck: () => backend.run((store) => recheckAiManager(store, who, { projectId })),
      ...credits(backend),
      model: (connection: Parameters<typeof createStructuredModel>[0]) => model ?? createStructuredModel(connection, { timeoutMs: 5_000 }),
      deployment: dep,
    };
  }

  test(`${name}: an operator-allowed local HTTP endpoint saved in settings connects for tests and operations`, async () => {
    const requests: { path: string; authorization: string | null }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization") });
        return Response.json({
          id: "chat_1",
          object: "chat.completion",
          created: 1_700_000_000,
          model: "local-model",
          choices: [{ index: 0, message: { role: "assistant", content: '{"status":"ok"}' }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        });
      },
    });
    try {
      const endpoint = `http://127.0.0.1:${server.port}/v1`;
      const local: AiDeployment = { ...deployment, endpoints: { allowed: [endpoint], allowLocal: true } };
      const backend = fresh();
      const { projectId } = await setup(backend);
      const input = { provider: "compatible" as const, model: "local-model", baseUrl: endpoint, apiKey: "local-key-1234" };
      // Testing the draft before saving it, then the saved settings, reach the endpoint over HTTP.
      expect(await testConnection(testSteps(backend, dana, projectId, local), { ...ownSettings, ...input, projectId })).toMatchObject({ ok: true });
      await saveSettings(backend, projectId, input, dana, local);
      expect(await testConnection(testSteps(backend, dana, projectId, local))).toMatchObject({ ok: true });
      // Search and grouping resolve the same connection.
      const settings = await backend.run((store) => store.aiSettings.find(projectId));
      const connection = await resolveProjectConnection(projectId, settings, local);
      if (!connection.ready) throw new Error(connection.reason);
      expect((await createStructuredModel(connection, { timeoutMs: 5_000 }).generate(testRequest())).output).toEqual({ ok: true });
      expect(requests).toHaveLength(3);
      expect(requests.every((request) => request.path === "/v1/chat/completions" && request.authorization === "Bearer local-key-1234")).toBe(true);
      // Without the operator allowing local endpoints, as on Critiqs Cloud, the same address is refused and never contacted.
      const cloud: AiDeployment = { ...deployment, endpoints: { allowed: [endpoint], allowLocal: false } };
      expect(await resolveProjectConnection(projectId, settings, cloud)).toMatchObject({ ready: false });
      expect(await testConnection(testSteps(backend, dana, projectId, cloud))).toMatchObject({ ok: false, code: "config" });
      await expect(prepareSettings({ ...ownSettings, ...input, projectId }, cloud)).rejects.toThrow();
      expect(requests).toHaveLength(3);
    } finally {
      server.stop(true);
    }
  });

  test(`${name}: a connection test counts against the managed allowance only when it tests managed AI, saved or draft`, async () => {
    const plans: Record<string, Plan> = { free: { name: "free", label: "Free", limits: [{ metric: "aiCredits", period: "month", max: 1 }] } };
    const backend = fresh().withPlans(plans);
    const managed: AiDeployment = { ...deployment, managed: managedAi };
    const { projectId } = await setup(backend);
    const { model, prompts } = fakeModel(() => ({ status: "ok" }));
    const steps = () => testSteps(backend, dana, projectId, managed, model);
    const managedDraft = { ...ownSettings, projectId, mode: "managed" as const };
    const ownDraft = { ...ownSettings, projectId };
    // Saved as own provider: a managed draft is still counted, and refused once the allowance is used.
    await saveSettings(backend, projectId, {}, dana, managed);
    expect(await testConnection(steps(), managedDraft)).toMatchObject({ ok: true });
    await expect(testConnection(steps(), managedDraft)).rejects.toThrow("no Critiqs AI credits left");
    expect(prompts).toHaveLength(1);
    // The own provider, saved or draft, isn't blocked by the used-up allowance.
    expect(await testConnection(steps())).toMatchObject({ ok: true });
    expect(await testConnection(steps(), ownDraft)).toMatchObject({ ok: true });
    // Saved as managed: an own-provider draft runs; the saved managed connection is refused.
    await saveSettings(backend, projectId, { mode: "managed" }, dana, managed);
    expect(await testConnection(steps(), ownDraft)).toMatchObject({ ok: true });
    await expect(testConnection(steps())).rejects.toThrow("no Critiqs AI credits left");
    expect(prompts).toHaveLength(4);
  });

  const priced: AiDeployment = {
    ...deployment,
    managed: { provider: "openai", apiKey: "managed-key", models: [{ id: "opus", label: "Opus", model: "opus-model", credits: 6, estimated: true, price: { input: 4, output: 20 } }] },
  };
  const searchAnswer = (request: StructuredRequest<unknown>) =>
    request.task === "search" ? { terms: ["label"], tags: [], groups: [], status: "unspecified", since: "", until: "", screen: "" } : { findings: [] };
  /** The Critiqs AI credits counted this month for the organization the project belongs to. */
  const projectCredits = (backend: ContractBackend, projectId: string) => async () => {
    const organizationId = (await backend.run((store) => ops.getProject(store, dana, { projectId }))).organization!.id;
    return (await backend.run((store) => store.usage.find(usageKey("aiCredits", "month", organizationId, utcDay(Date.now())))))?.count ?? 0;
  };

  test(`${name}: a priced Critiqs AI model costs each answered request's real token use, starts only when its worst case fits, and costs nothing when the model fails`, async () => {
    const backend = fresh().withPlans({ free: { name: "free", label: "Free", limits: [{ metric: "aiCredits", period: "month", max: 40 }] } });
    const { projectId } = await setup(backend);
    await saveSettings(backend, projectId, { mode: "managed" }, dana, priced);
    const used = projectCredits(backend, projectId);
    const broken = fakeModel(() => ({ status: "nope" }), { inputTokens: 300, outputTokens: 40 });
    expect(await testConnection(testSteps(backend, dana, projectId, priced, broken.model))).toMatchObject({ ok: false, code: "capability" });
    expect(await used()).toBe(0);
    // 300 input and 40 output tokens at $4 and $20 per million: $0.002, so 1 credit.
    const ok = fakeModel(() => ({ status: "ok" }), { inputTokens: 300, outputTokens: 40 });
    expect(await testConnection(testSteps(backend, dana, projectId, priced, ok.model))).toMatchObject({ ok: true });
    expect(await used()).toBe(1);
    // Grouping: 1,000 in and 100 out is $0.006, so 2 credits.
    const grouper = fakeModel(() => ({ assignments: [] }), { inputTokens: 1_000, outputTokens: 100 });
    expect(await groupOnce(grouping(backend, grouper.model, priced))).toBe(true);
    expect(grouper.prompts).toHaveLength(1);
    expect(await used()).toBe(3);
    // A search is two requests, 1,500 in and 300 out each: $0.012, so 3 credits each.
    const searcher = fakeModel(searchAnswer, { inputTokens: 1_500, outputTokens: 300 });
    expect((await search(backend, dana, projectId, "label", searcher.model, undefined, priced)).mode).toBe("ai");
    expect(searcher.prompts.map((prompt) => prompt.task)).toEqual(["search", "insights"]);
    expect(await used()).toBe(9);
    // With 1 credit left, a search can't start: its 600 output tokens alone could cost 3. A test, at most 1, still can.
    await backend.run((store) => settleCredits(store, null, { payer: "project", ownerId: projectId, credits: 30 }, Date.now()));
    expect(await search(backend, dana, projectId, "label", searcher.model, undefined, priced)).toMatchObject({
      mode: "basic",
      notice: "AI unavailable: basic search. This project's organization doesn't have enough Critiqs AI credits left for this request.",
    });
    expect(searcher.prompts).toHaveLength(2);
    expect(await testConnection(testSteps(backend, dana, projectId, priced, ok.model))).toMatchObject({ ok: true });
    expect(await used()).toBe(40);
    await expect(testConnection(testSteps(backend, dana, projectId, priced, ok.model))).rejects.toThrow("no Critiqs AI credits left");
    expect(ok.prompts).toHaveLength(2);
    expect(await used()).toBe(40);
  });

  test(`${name}: a priced connection test holds its own worst case, not 1 credit, so it can't start past what's left`, async () => {
    // At $15 and $75 per million, the test's most (its bytes and framing in, 50 tokens out) costs 3 credits; a real answer costs less.
    const pricey: AiDeployment = { ...deployment, managed: { ...priced.managed!, models: [{ ...priced.managed!.models[0]!, price: { input: 15, output: 75 } }] } };
    expect(worstCaseCredits({ credits: 0, price: { input: 15, output: 75 } }, testRequest())).toBe(3);
    for (const [left, starts] of [[2, false], [3, true]] as const) {
      const backend = fresh().withPlans({ free: { name: "free", label: "Free", limits: [{ metric: "aiCredits", period: "month", max: left }] } });
      const { projectId } = await setup(backend);
      await saveSettings(backend, projectId, { mode: "managed" }, dana, pricey);
      const ok = fakeModel(() => ({ status: "ok" }), { inputTokens: 300, outputTokens: 40 });
      const run = testConnection(testSteps(backend, dana, projectId, pricey, ok.model));
      if (starts) expect(await run).toMatchObject({ ok: true });
      else await expect(run).rejects.toThrow("enough Critiqs AI credits left for this request");
      expect(ok.prompts).toHaveLength(starts ? 1 : 0);
    }
  });

  function heldModel(answer: (request: StructuredRequest<unknown>) => unknown, usage?: ModelUsage) {
    const { model, prompts } = fakeModel(answer, usage);
    let open = () => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    let waiting = 0;
    const held: StructuredModel = { ...model, generate: async (request) => (waiting++, await gate, model.generate(request)) };
    return { model: held, prompts, open, waiting: () => waiting };
  }

  async function concurrentSearches(backend: ContractBackend, projectId: string, count: number, dep: AiDeployment, usage?: ModelUsage) {
    const gated = heldModel(searchAnswer, usage);
    let finished = 0;
    const searches = Array.from({ length: count }, () => search(backend, dana, projectId, "label", gated.model, undefined, dep).finally(() => finished++));
    while (gated.waiting() + finished < count) await Bun.sleep(1);
    gated.open();
    return { responses: await Promise.all(searches), prompts: gated.prompts };
  }

  test(`${name}: requests in flight together can't spend past the allowance: each holds its worst case until its model answers`, async () => {
    const backend = fresh().withPlans({ free: { name: "free", label: "Free", limits: [{ metric: "aiCredits", period: "month", max: 10 }] } });
    const { projectId } = await setup(backend);
    await saveSettings(backend, projectId, { mode: "managed" }, dana, priced);
    const used = projectCredits(backend, projectId);
    await backend.run((store) => settleCredits(store, null, { payer: "project", ownerId: projectId, credits: 9 }, Date.now()));
    const late = await concurrentSearches(backend, projectId, 20, priced, { inputTokens: 1_500, outputTokens: 300 });
    expect(late.responses.every((response) => response.mode === "basic")).toBe(true);
    expect(late.prompts).toHaveLength(0);
    expect(await used()).toBe(9);
    const fresher = fresh().withPlans({ free: { name: "free", label: "Free", limits: [{ metric: "aiCredits", period: "month", max: 10 }] } });
    const other = await setup(fresher);
    await saveSettings(fresher, other.projectId, { mode: "managed" }, dana, { ...deployment, managed: managedAi });
    const flat = await concurrentSearches(fresher, other.projectId, 20, { ...deployment, managed: managedAi });
    expect(flat.prompts).toHaveLength(10);
    expect(flat.responses.filter((response) => response.mode === "ai")).toHaveLength(10);
    expect(await projectCredits(fresher, other.projectId)()).toBe(10);
  });

  const strandHold = async (backend: ContractBackend, projectId: string, credits: number, now: number) =>
    expect(await backend.run((store) => reserveCredits(store, { payer: "project", ownerId: projectId }, credits, now))).toMatchObject({ ok: true });

  test(`${name}: a failed request releases its hold, and a request that never finishes holds its credits only until its hold expires`, async () => {
    const backend = fresh().withPlans({ free: { name: "free", label: "Free", limits: [{ metric: "aiCredits", period: "month", max: 1 }] } });
    const { projectId } = await setup(backend);
    const managed = { ...deployment, managed: managedAi };
    await saveSettings(backend, projectId, { mode: "managed" }, dana, managed);
    const used = projectCredits(backend, projectId);
    const broken = fakeModel(() => ({ status: "nope" }));
    expect(await testConnection(testSteps(backend, dana, projectId, managed, broken.model))).toMatchObject({ ok: false, code: "capability" });
    expect(await testConnection(testSteps(backend, dana, projectId, managed, broken.model))).toMatchObject({ ok: false, code: "capability" });
    expect(await used()).toBe(0);
    const start = Date.now();
    await strandHold(backend, projectId, 1, start);
    const ok = fakeModel(() => ({ status: "ok" }));
    await expect(testConnection(testSteps(backend, dana, projectId, managed, ok.model))).rejects.toThrow("no Critiqs AI credits left");
    setSystemTime(start + HOLD_MS - 1_000);
    await expect(testConnection(testSteps(backend, dana, projectId, managed, ok.model))).rejects.toThrow("no Critiqs AI credits left");
    setSystemTime(start + HOLD_MS + 1_000);
    expect(await testConnection(testSteps(backend, dana, projectId, managed, ok.model))).toMatchObject({ ok: true });
    expect(ok.prompts).toHaveLength(1);
    expect(await used()).toBe(1);
  });

  test(`${name}: grouping releases its hold when its model can't be set up, so the credits stay free`, async () => {
    const backend = fresh().withPlans({ free: { name: "free", label: "Free", limits: [{ metric: "aiCredits", period: "month", max: 1 }] } });
    const { projectId } = await setup(backend);
    const managed = { ...deployment, managed: managedAi };
    await saveSettings(backend, projectId, { mode: "managed" }, dana, managed);
    const broken: GroupingSteps = {
      ...grouping(backend, fakeModel(() => ({ assignments: [] })).model, managed),
      model: () => {
        throw new Error("The provider's address isn't valid.");
      },
    };
    expect(await groupOnce(broken)).toBe(true);
    const ok = fakeModel(() => ({ status: "ok" }));
    expect(await testConnection(testSteps(backend, dana, projectId, managed, ok.model))).toMatchObject({ ok: true });
    expect(ok.prompts).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Personal AI connections and the project's AI usage rule

  const personalOwn: PersonalAiSettingsInput = { enabled: true, mode: "own", provider: "anthropic", model: "claude-test", apiKey: "sk-personal-5678" };
  /** Critiqs AI offering Fast (1 credit) and Strong (3 credits). */
  const twoModels: AiDeployment = {
    ...deployment,
    managed: {
      provider: "openai",
      apiKey: "managed-key",
      models: [
        { id: "fast", label: "Fast", model: "fast-model", credits: 1 },
        { id: "strong", label: "Strong", model: "strong-model", credits: 3 },
      ],
    },
  };

  async function savePersonal(backend: ContractBackend, who: Identity, input: Partial<PersonalAiSettingsInput> = {}, dep = deployment) {
    const { userId } = await backend.run((store) => requirePersonalAiOwner(store, who));
    const prepared = await sealKey(await prepareSettings({ ...personalOwn, ...input }, dep), keyBinding("personal", userId), dep);
    return await backend.run((store) => applyPersonalAiSettings(store, who, { prepared }, dep, Date.now()));
  }

  const userIdOf = async (backend: ContractBackend, who: Identity) => (await backend.run((store) => store.users.byToken(who.tokenIdentifier)))!._id;

  /** A search by `who`, noting which connection each model call used. */
  async function searchAs(backend: ContractBackend, who: Identity, projectId: string, dep = deployment) {
    const used: string[] = [];
    const { model } = fakeModel((request) =>
      request.task === "search" ? { terms: ["label"], tags: [], groups: [], status: "unspecified", since: "", until: "", screen: "" } : { findings: [] },
    );
    const response = await runSearch({
      prepare: () => backend.run((store) => prepareSearch(store, who, { projectId, question: "label", scope: { status: "all", screen: null } }, dep, Date.now())),
      authorize: () => backend.run((store) => authorizeSearch(store, who, { projectId })),
      retrieve: (query, groups) => backend.run((store) => retrieveSearch(store, who, { projectId, query, groups })),
      finalize: (result) => backend.run((store) => finalizeSearch(store, who, { projectId, response: result })),
      ...credits(backend),
      model: (connection) => ({
        ...model,
        generate: (request) => (used.push(`${connection.mode}:${connection.model}:${connection.apiKey}`), model.generate(request)),
      }),
      deployment: dep,
      now: Date.now(),
    });
    return { response, used: [...new Set(used)] };
  }

  /** The real connection-test steps for a person's own settings. */
  function personalTestSteps(backend: ContractBackend, who: Identity, dep: AiDeployment, model: StructuredModel) {
    let userId = "";
    return {
      prepare: async () => {
        const prepared = await backend.run((store) => preparePersonalTest(store, who, Date.now()));
        userId = prepared.ownerId;
        return prepared;
      },
      record: (epoch: number, result: AiTestResult) => backend.run((store) => recordPersonalTest(store, { userId, epoch, result }, Date.now())),
      ...credits(backend),
      model: () => model,
      deployment: dep,
    };
  }

  test(`${name}: a person's own AI settings are theirs alone: saved with a key bound to them, shown as a hint, tested, and removed`, async () => {
    const backend = fresh();
    await setup(backend);
    await expect(backend.run((store) => getPersonalAiSettings(store, null, deployment))).rejects.toThrow("Sign in");
    expect(await backend.run((store) => getPersonalAiSettings(store, dana, deployment))).toMatchObject({ saved: false, enabled: false, keyHint: null, status: { ready: false } });
    const view = await savePersonal(backend, dana);
    expect(view).toMatchObject({ saved: true, enabled: true, mode: "own", provider: "anthropic", model: "claude-test", models: ["claude-test"], keyHint: "5678", status: { ready: true } });
    expect(view.deployment.defaultProvider).toBeNull();
    expect(JSON.stringify(view)).not.toContain("sk-personal");
    // Lee sees only his own settings: there is no way to name anyone else's.
    expect(await backend.run((store) => getPersonalAiSettings(store, lee, deployment))).toMatchObject({ saved: false, keyHint: null });
    await savePersonal(backend, lee, { provider: "openai", model: "gpt-lee", apiKey: "sk-lee-0000" });
    expect(await backend.run((store) => getPersonalAiSettings(store, dana, deployment))).toMatchObject({ provider: "anthropic", keyHint: "5678" });
    const danaId = await userIdOf(backend, dana);
    const leeId = await userIdOf(backend, lee);
    const stored = await backend.run((store) => store.personalAiSettings.find(danaId));
    expect(JSON.stringify(stored)).not.toContain("sk-personal");
    const mine = connectionOf("personal", danaId, stored, deployment);
    if (!mine.ok) throw new Error(mine.reason);
    expect(await resolveConnection(mine, deployment)).toMatchObject({ ready: true, apiKey: "sk-personal-5678" });
    // The ciphertext is bound to Dana: not readable as Lee's, nor as a project's key.
    expect(await resolveConnection({ ...mine, ownerId: leeId }, deployment)).toMatchObject({ ready: false });
    expect(await resolveConnection({ ...mine, source: "project" }, deployment)).toMatchObject({ ready: false });
    // Tested with the person's own steps, recorded only on their settings.
    const { model } = fakeModel(() => ({ status: "ok" }));
    expect(await testConnection(personalTestSteps(backend, dana, deployment, model))).toEqual({ ok: true, message: "Connected to Anthropic with claude-test; structured answers work." });
    expect((await backend.run((store) => getPersonalAiSettings(store, dana, deployment))).lastTest).toMatchObject({ ok: true });
    expect((await backend.run((store) => getPersonalAiSettings(store, lee, deployment))).lastTest).toBeNull();
    // Removing them removes the key too; Lee's stay.
    expect(await backend.run((store) => removePersonalAiSettings(store, dana, deployment))).toMatchObject({ saved: false, keyHint: null });
    expect(await backend.run((store) => store.personalAiSettings.find(danaId))).toBeNull();
    expect(await backend.run((store) => getPersonalAiSettings(store, lee, deployment))).toMatchObject({ saved: true, keyHint: "0000" });
  });

  test(`${name}: the project's AI usage rule picks whose connection a person's search uses`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend, "Department label is unclear");
    await saveSettings(backend, projectId, { rule: "personal" });
    // Each person pays, and Lee has no AI of his own: basic search, asking him to set up Your AI.
    let lees = await searchAs(backend, lee, projectId);
    expect(lees.used).toEqual([]);
    expect(lees.response).toMatchObject({ mode: "basic", noticeCode: "setup-ai", notice: "AI unavailable: basic search. Set up your AI to use this." });
    await savePersonal(backend, lee);
    lees = await searchAs(backend, lee, projectId);
    expect(lees.used).toEqual(["own:claude-test:sk-personal-5678"]);
    expect(lees.response.mode).toBe("ai");
    expect(lees.response.noticeCode).toBeUndefined();
    // Project pays: everyone uses the project's connection.
    await saveSettings(backend, projectId, { rule: "project", apiKey: undefined });
    expect((await searchAs(backend, lee, projectId)).used).toEqual(["own:gpt-test:sk-test-1234567890abcd"]);
    // Project pays, personal allowed: Lee's own, and the project's for Dana, who has none.
    await saveSettings(backend, projectId, { rule: "either", apiKey: undefined });
    expect((await searchAs(backend, lee, projectId)).used).toEqual(["own:claude-test:sk-personal-5678"]);
    expect((await searchAs(backend, dana, projectId)).used).toEqual(["own:gpt-test:sk-test-1234567890abcd"]);
    // Lee's own connection turned off: the project's again, never a refusal.
    await savePersonal(backend, lee, { enabled: false, apiKey: undefined });
    expect((await searchAs(backend, lee, projectId)).used).toEqual(["own:gpt-test:sk-test-1234567890abcd"]);
  });

  test(`${name}: background grouping uses the project's connection whatever the rule`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend, "Layout is off #layout");
    await saveSettings(backend, projectId, { rule: "personal" });
    await savePersonal(backend, dana);
    const used: string[] = [];
    const { model } = fakeModel(() => ({ assignments: [{ tag: "layout", groups: [], newGroups: [] }] }));
    await groupOnce({ ...grouping(backend, model), model: (connection) => (used.push(`${connection.model}:${connection.apiKey}`), model) });
    expect(used).toEqual(["gpt-test:sk-test-1234567890abcd"]);
  });

  /** The organization a project belongs to, as its creator sees it. */
  const organizationOf = async (backend: ContractBackend, projectId: string, who: Identity = dana) =>
    (await backend.run((store) => ops.getProject(store, who, { projectId }))).organization!.id;

  /** A person's home organization, set up as a project of theirs creates it, on `plan`. */
  async function homeOrganizationOn(backend: ContractBackend, who: Identity, plan: string) {
    const projectId = await backend.run((store) => ops.createProject(store, who, { name: `${who.name}'s` }));
    const organizationId = await organizationOf(backend, projectId, who);
    await backend.run((store) => assignPlan(store, { organizationId, plan }, Date.now()));
    return organizationId;
  }

  test(`${name}: Critiqs AI credits count against whoever pays: the project's organization, or the person's home organization`, async () => {
    const plans: Record<string, Plan> = {
      free: { name: "free", label: "Free", limits: [{ metric: "aiCredits", period: "month", max: 0 }] },
      plus: { name: "plus", label: "Plus", limits: [{ metric: "aiCredits", period: "month", max: 100 }] },
    };
    const backend = fresh().withPlans(plans);
    const { projectId } = await setup(backend, "Department label is unclear");
    const danaOrganization = await organizationOf(backend, projectId);
    await backend.run((store) => assignPlan(store, { organizationId: danaOrganization, plan: "plus" }, Date.now()));
    await saveSettings(backend, projectId, { mode: "managed", managedModel: "strong", rule: "either" }, dana, twoModels);
    const day = utcDay(Date.now());
    const counted = async (accountId: string) => (await backend.run((store) => store.usage.find(usageKey("aiCredits", "month", accountId, day))))?.count ?? 0;
    // The project pays: a search is two requests of Strong, 3 credits each, on its organization's plan.
    expect((await searchAs(backend, lee, projectId, twoModels)).used).toEqual(["managed:strong-model:managed-key"]);
    expect(await counted(danaOrganization)).toBe(6);
    // Lee has no organization yet, so the default plan covers his own, and Free includes no Critiqs AI: saving it is refused.
    await expect(savePersonal(backend, lee, { mode: "managed", managedModel: "fast" }, twoModels)).rejects.toThrow("doesn't include Critiqs AI");
    const leeOrganization = await homeOrganizationOn(backend, lee, "plus");
    await savePersonal(backend, lee, { mode: "managed", managedModel: "fast" }, twoModels);
    // Lee pays for his own: 2 credits on his home organization; the project's organization doesn't move.
    expect((await searchAs(backend, lee, projectId, twoModels)).used).toEqual(["managed:fast-model:managed-key"]);
    expect(await counted(leeOrganization)).toBe(2);
    expect(await counted(danaOrganization)).toBe(6);
    const usage = await backend.run((store) => ops.getUsage(store, dana, { projectId, day, aiCredits: true }));
    expect(usage!.rows).toEqual([{ metric: "aiCredits", period: "month", used: 6, max: 100 }]);
    // A test of his own Critiqs AI counts too; once his organization's plan includes none, his requests are refused, never moved to the project.
    const { model } = fakeModel(() => ({ status: "ok" }));
    expect(await testConnection(personalTestSteps(backend, lee, twoModels, model))).toMatchObject({ ok: true, message: "Connected to Critiqs AI (Fast); structured answers work." });
    expect(await counted(leeOrganization)).toBe(3);
    await backend.run((store) => assignPlan(store, { organizationId: leeOrganization, plan: "free" }, Date.now()));
    const refused = await searchAs(backend, lee, projectId, twoModels);
    expect(refused.used).toEqual([]);
    expect(refused.response.notice).toBe("AI unavailable: basic search. Your plan doesn't include Critiqs AI. Connect your own key in Your AI, or choose a plan that includes it.");
    await expect(testConnection(personalTestSteps(backend, lee, twoModels, model))).rejects.toThrow("doesn't include Critiqs AI");
    expect(await counted(leeOrganization)).toBe(3);
    expect(await counted(danaOrganization)).toBe(6);
    // Own keys count nothing against plans.
    await savePersonal(backend, lee, {}, twoModels);
    expect((await searchAs(backend, lee, projectId, twoModels)).used).toEqual(["own:claude-test:sk-personal-5678"]);
    expect(await counted(leeOrganization)).toBe(3);
    expect(await counted(danaOrganization)).toBe(6);
    // The credits that used to be counted separately aren't anymore.
    expect(await backend.run((store) => store.usage.find(usageKey("aiRequests", "day", projectId, day)))).toBeNull();
  });

  test(`${name}: a request refused for want of credits owes the organization's admins the email that none are left`, async () => {
    const plans: Record<string, Plan> = {
      free: { name: "free", label: "Free", limits: [{ metric: "aiCredits", period: "month", max: 1, overage: { defaultCap: 1 } }] },
    };
    const backend = fresh().withPlans(plans);
    const { projectId } = await setup(backend, "Department label is unclear");
    await saveSettings(backend, projectId, { mode: "managed", managedModel: "strong", rule: "either" }, dana, twoModels);
    expect((await searchAs(backend, lee, projectId, twoModels)).used).toEqual([]);
    const organizationId = await organizationOf(backend, projectId);
    const month = utcDay(Date.now()).slice(0, 7);
    expect(await backend.run((store) => store.planAlerts.find(organizationId, "paused", month, "free"))).toMatchObject({ status: "pending", projectId });
    expect(await backend.run((store) => store.planAlerts.find(organizationId, "included", month, "free"))).toBeNull();
  });

  test(`${name}: a connection test refused for want of credits still owes the admins the email that none are left`, async () => {
    const plans: Record<string, Plan> = { free: { name: "free", label: "Free", limits: [{ metric: "aiCredits", period: "month", max: 1 }] } };
    const backend = fresh().withPlans(plans);
    const { projectId } = await setup(backend);
    await saveSettings(backend, projectId, {}, dana, twoModels);
    const { model, prompts } = fakeModel(() => ({ status: "ok" }));
    const month = utcDay(Date.now()).slice(0, 7);
    const paused = (organizationId: string) => backend.run((store) => store.planAlerts.find(organizationId, "paused", month, "free"));
    // Strong costs 3 credits, more than Free's 1.
    const strongDraft = { ...ownSettings, projectId, mode: "managed" as const, managedModel: "strong" };
    await expect(testConnection(testSteps(backend, dana, projectId, twoModels, model), strongDraft)).rejects.toThrow("enough Critiqs AI credits left for this request");
    expect(await paused(await organizationOf(backend, projectId))).toMatchObject({ status: "pending", kind: "paused" });
    const leeOrganization = await homeOrganizationOn(backend, lee, "free");
    await savePersonal(backend, lee, { mode: "managed", managedModel: "strong" }, twoModels);
    await expect(testConnection(personalTestSteps(backend, lee, twoModels, model))).rejects.toThrow("enough Critiqs AI credits left for this request");
    expect(await paused(leeOrganization)).toMatchObject({ status: "pending", kind: "paused" });
    expect(prompts).toEqual([]);
  });

  test(`${name}: under Each person pays, someone who saved nothing uses Critiqs AI on their own plan, never the project's`, async () => {
    const plans: Record<string, Plan> = { free: { name: "free", label: "Free", limits: [{ metric: "aiCredits", period: "month", max: 100 }] } };
    const backend = fresh().withPlans(plans);
    const { projectId } = await setup(backend, "Department label is unclear");
    await saveSettings(backend, projectId, { mode: "managed", managedModel: "strong", rule: "personal" }, dana, twoModels);
    const danaOrganization = await organizationOf(backend, projectId);
    const day = utcDay(Date.now());
    const counted = async (accountId: string) => (await backend.run((store) => store.usage.find(usageKey("aiCredits", "month", accountId, day))))?.count ?? 0;
    // The deployment's first model, not the project's: a search is two requests of Fast, 1 credit each, counted for Lee, who has no organization.
    expect((await searchAs(backend, lee, projectId, twoModels)).used).toEqual(["managed:fast-model:managed-key"]);
    expect(await counted(await userIdOf(backend, lee))).toBe(2);
    expect(await counted(danaOrganization)).toBe(0);
    // Under the default rule the project pays for the same person.
    await saveSettings(backend, projectId, { mode: "managed", managedModel: "strong", rule: "either" }, dana, twoModels);
    expect((await searchAs(backend, lee, projectId, twoModels)).used).toEqual(["managed:strong-model:managed-key"]);
    expect(await counted(danaOrganization)).toBe(6);
    expect(await counted(await userIdOf(backend, lee))).toBe(2);
  });

  test(`${name}: each person sees the Critiqs AI credits of the organization paying for their own, for each period its plan limits`, async () => {
    // Without plans there is nothing to show; signed out, nothing at all.
    const plain = fresh();
    await setup(plain);
    expect(await plain.run((store) => getPersonalAiUsage(store, lee, {}))).toBeNull();
    await expect(plain.run((store) => getPersonalAiUsage(store, null, {}))).rejects.toThrow("Sign in");

    const plans: Record<string, Plan> = {
      free: { name: "free", label: "Free", limits: [{ metric: "aiCredits", period: "day", max: 0 }] },
      plus: {
        name: "plus",
        label: "Plus",
        limits: [
          { metric: "aiCredits", period: "day", max: 10 },
          { metric: "aiCredits", period: "month", max: 25, overage: { defaultCap: 5 } },
        ],
      },
    };
    setSystemTime(new Date("2026-11-10T12:00:00Z"));
    const backend = fresh().withPlans(plans);
    const { projectId } = await setup(backend, "Department label is unclear");
    await backend.run((store) => assignPlan(store, { projectId, plan: "plus" }, Date.now()));
    // Someone not yet recorded has the default plan, which includes none.
    expect(await backend.run((store) => getPersonalAiUsage(store, lee, {}))).toEqual({ plan: "Free", rows: [{ period: "day", used: 0, max: 0 }] });
    // When the project pays, none of it is Lee's.
    await saveSettings(backend, projectId, { mode: "managed", managedModel: "fast", rule: "either" }, dana, twoModels);
    expect((await searchAs(backend, lee, projectId, twoModels)).used).toEqual(["managed:fast-model:managed-key"]);
    expect(await backend.run((store) => getPersonalAiUsage(store, lee, {}))).toEqual({ plan: "Free", rows: [{ period: "day", used: 0, max: 0 }] });

    const leeOrganization = await homeOrganizationOn(backend, lee, "plus");
    await savePersonal(backend, lee, { mode: "managed", managedModel: "fast" }, twoModels);
    await saveSettings(backend, projectId, { mode: "managed", managedModel: "fast", rule: "personal" }, dana, twoModels);
    // Lee pays for his own: a search is two requests of Fast, counted against his home organization.
    expect((await searchAs(backend, lee, projectId, twoModels)).used).toEqual(["managed:fast-model:managed-key"]);
    expect(await backend.run((store) => getPersonalAiUsage(store, lee, {}))).toEqual({
      plan: "Plus",
      organizationId: leeOrganization,
      rows: [
        { period: "day", used: 2, max: 10 },
        { period: "month", used: 2, max: 25, overage: { cap: 5 } },
      ],
    });
    // Dana sees her own home organization, which paid for the project's search, never Lee's.
    expect(await backend.run((store) => getPersonalAiUsage(store, dana, {}))).toEqual({
      plan: "Plus",
      organizationId: await organizationOf(backend, projectId),
      rows: [
        { period: "day", used: 2, max: 10 },
        { period: "month", used: 2, max: 25, overage: { cap: 5 } },
      ],
    });

    // The next day starts a new day's count; the month keeps counting. The day asked about picks the periods.
    setSystemTime(new Date("2026-11-11T09:00:00Z"));
    expect((await backend.run((store) => getPersonalAiUsage(store, lee, {})))!.rows.map((row) => row.used)).toEqual([0, 2]);
    await searchAs(backend, lee, projectId, twoModels);
    expect((await backend.run((store) => getPersonalAiUsage(store, lee, {})))!.rows.map((row) => row.used)).toEqual([2, 4]);
    expect((await backend.run((store) => getPersonalAiUsage(store, lee, { day: "2026-11-10" })))!.rows.map((row) => row.used)).toEqual([2, 4]);
    expect((await backend.run((store) => getPersonalAiUsage(store, lee, { day: "2026-12-01" })))!.rows.map((row) => row.used)).toEqual([0, 0]);
    await expect(backend.run((store) => getPersonalAiUsage(store, lee, { day: "tomorrow" }))).rejects.toThrow("YYYY-MM-DD");
  });

  test(`${name}: connection tests of both kinds share one per-minute limit per person`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend);
    const { model } = fakeModel(() => ({ status: "ok" }));
    for (let i = 0; i < TESTS_PER_MINUTE / 2; i++) {
      await testConnection(personalTestSteps(backend, dana, deployment, model));
      await testConnection(testSteps(backend, dana, projectId, deployment, model));
    }
    await expect(testConnection(personalTestSteps(backend, dana, deployment, model))).rejects.toThrow("Too many connection tests");
    // A draft of one's own settings is tested without saving it.
    expect(await testConnection(personalTestSteps(backend, lee, deployment, model), personalOwn)).toMatchObject({ ok: true });
    expect(await backend.run((store) => getPersonalAiSettings(store, lee, deployment))).toMatchObject({ saved: false });
  });

  test(`${name}: an older client saving project settings keeps the usage rule, Critiqs AI model, allowed models, and picked models`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend);
    const older = (input: Partial<AiSettingsInput>) => {
      const { rule: _rule, managedModel: _managed, allowedModels: _allowed, models: _models, ...rest } = { ...ownSettings, ...input };
      return saveSettings(backend, projectId, rest, dana, twoModels);
    };
    let view = await saveSettings(backend, projectId, { mode: "managed", rule: "personal", managedModel: "strong", allowedModels: ["strong"] }, dana, twoModels);
    expect(view).toMatchObject({ rule: "personal", managedModel: "strong", allowedModels: ["strong"], deployment: { managed: true, managedModels: [{ id: "fast", label: "Fast", credits: 1 }, { id: "strong", label: "Strong", credits: 3 }] } });
    expect(JSON.stringify(view)).not.toContain("strong-model");
    view = await older({ mode: "managed" });
    expect(view).toMatchObject({ rule: "personal", managedModel: "strong", allowedModels: ["strong"] });
    // The project's own Critiqs AI model must be one it allows.
    await expect(saveSettings(backend, projectId, { mode: "managed", managedModel: "fast" }, dana, twoModels)).rejects.toThrow("Allow the project's Critiqs AI model");
    // Picked models stay with the same provider, always with the default among them.
    view = await saveSettings(backend, projectId, { models: ["gpt-test", "gpt-big"] }, dana, twoModels);
    expect(view.models).toEqual(["gpt-test", "gpt-big"]);
    view = await older({ model: "gpt-other", apiKey: undefined });
    expect(view).toMatchObject({ model: "gpt-other", models: ["gpt-other", "gpt-test", "gpt-big"], keyHint: "abcd", rule: "personal" });
    view = await older({ provider: "anthropic", model: "claude-test" });
    expect(view.models).toEqual(["claude-test"]);
    // Switching to an own key with stale Critiqs AI fields a client sends back isn't refused, and leaves them as saved.
    view = await saveSettings(backend, projectId, { managedModel: "retired", allowedModels: ["retired"] }, dana, twoModels);
    expect(view).toMatchObject({ mode: "own", managedModel: "strong", allowedModels: ["strong"] });
    // A newer client clears the rule's choice explicitly, never by leaving it out.
    view = await saveSettings(backend, projectId, { mode: "managed", managedModel: null, rule: "either", allowedModels: [] }, dana, twoModels);
    expect(view).toMatchObject({ rule: "either", allowedModels: [], managedModel: null });
  });

  test(`${name}: without a saved rule or anyone's own AI, people use the project's connection exactly as before`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend, "Department label is unclear");
    const view = await saveSettings(backend, projectId);
    expect(view).toMatchObject({ rule: "either", allowedModels: [], managedModel: null, models: ["gpt-test"] });
    const stored = await backend.run((store) => store.aiSettings.find(projectId));
    expect(stored?.rule).toBeUndefined();
    expect((await searchAs(backend, lee, projectId)).used).toEqual(["own:gpt-test:sk-test-1234567890abcd"]);
    expect((await searchAs(backend, dana, projectId)).used).toEqual(["own:gpt-test:sk-test-1234567890abcd"]);
  });

  test(`${name}: a typed key is never stored unsealed, for a project or a person`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend);
    const unsealed = await prepareSettings({ ...ownSettings, projectId }, deployment);
    expect(unsealed.plainKey).toBe("sk-test-1234567890abcd");
    await expect(backend.run((store) => applyAiSettings(store, dana, { projectId, prepared: unsealed }, deployment, Date.now()))).rejects.toThrow("must be sealed");
    await expect(backend.run((store) => applyPersonalAiSettings(store, dana, { prepared: unsealed }, deployment, Date.now()))).rejects.toThrow("must be sealed");
    expect(await backend.run((store) => store.aiSettings.find(projectId))).toBeNull();
    expect(JSON.stringify(await backend.run(async (store) => store.personalAiSettings.find((await store.users.byToken(dana.tokenIdentifier))!._id)))).toBe("null");
  });

  test(`${name}: turning AI off, or saving other fields, is never refused because the deployment's Critiqs AI models changed`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend);
    await saveSettings(backend, projectId, { mode: "managed", allowedModels: ["fast"] }, dana, twoModels);
    // The operator puts Strong first: the project's unchosen default would be Strong, which it doesn't allow.
    const reordered: AiDeployment = { ...twoModels, managed: { ...twoModels.managed!, models: [...twoModels.managed!.models].reverse() } };
    const older = (input: Partial<AiSettingsInput>) => {
      const { managedModel: _managed, allowedModels: _allowed, models: _models, ...rest } = { ...ownSettings, mode: "managed" as const, ...input };
      return saveSettings(backend, projectId, rest, dana, reordered);
    };
    expect(await older({ enabled: false })).toMatchObject({ enabled: false, allowedModels: ["fast"] });
    expect(await older({ rule: "project" })).toMatchObject({ enabled: true, rule: "project", status: { ready: true } });
    // Requests use the first allowed model still offered.
    const stored = await backend.run((store) => store.aiSettings.find(projectId));
    expect(chooseConnection({ projectId, project: stored, person: null }, reordered)).toMatchObject({ ok: true, model: "fast-model" });
    // Choosing a model it doesn't allow, with AI on, is still refused.
    await expect(saveSettings(backend, projectId, { mode: "managed", managedModel: "strong" }, dana, reordered)).rejects.toThrow("Allow the project's Critiqs AI model");
  });

  test(`${name}: settings sent back as loaded can turn AI off or change the rule after the deployment retired a model or Critiqs AI`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend);
    const loaded = { mode: "managed" as const, managedModel: "strong", allowedModels: ["fast", "strong"] };
    await saveSettings(backend, projectId, loaded, dana, twoModels);
    await savePersonal(backend, lee, { mode: "managed", managedModel: "strong" }, twoModels);
    // The operator drops Strong.
    const fastOnly: AiDeployment = { ...twoModels, managed: { ...twoModels.managed!, models: twoModels.managed!.models.filter((entry) => entry.id === "fast") } };
    expect(await saveSettings(backend, projectId, { ...loaded, enabled: false }, dana, fastOnly)).toMatchObject({ enabled: false, managedModel: "strong", allowedModels: ["fast", "strong"] });
    expect(await saveSettings(backend, projectId, { ...loaded, rule: "project" }, dana, fastOnly)).toMatchObject({ enabled: true, rule: "project", managedModel: "strong" });
    expect(await savePersonal(backend, lee, { mode: "managed", managedModel: "strong", enabled: false }, fastOnly)).toMatchObject({ enabled: false, managedModel: "strong" });
    // A model or allowed models the deployment doesn't offer, newly chosen with AI on, are refused.
    await expect(saveSettings(backend, projectId, { ...loaded, managedModel: "max", allowedModels: ["fast", "strong", "max"] }, dana, fastOnly)).rejects.toThrow("Critiqs AI models this deployment offers");
    await expect(saveSettings(backend, projectId, { ...loaded, allowedModels: ["strong"] }, dana, fastOnly)).rejects.toThrow("Critiqs AI models this deployment offers");
    await expect(savePersonal(backend, lee, { mode: "managed", managedModel: "max" }, fastOnly)).rejects.toThrow("Critiqs AI models this deployment offers");
    // The operator turns Critiqs AI off: a connection already on it can still be turned off or keep its rule, but none can switch to it.
    const noManaged: AiDeployment = { ...twoModels, managed: null };
    expect(await saveSettings(backend, projectId, { ...loaded, rule: "personal" }, dana, noManaged)).toMatchObject({ rule: "personal", status: { ready: false } });
    expect(await saveSettings(backend, projectId, { ...loaded, enabled: false }, dana, noManaged)).toMatchObject({ enabled: false });
    expect(await savePersonal(backend, lee, { mode: "managed", managedModel: "strong", enabled: false }, noManaged)).toMatchObject({ enabled: false });
    const { projectId: other } = await setup(backend);
    await expect(saveSettings(backend, other, { mode: "managed" }, dana, noManaged)).rejects.toThrow("isn't available");
  });

  test(`${name}: without Critiqs AI, a connection already on it keeps its saved models but can't choose new ones or one its project doesn't allow`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend);
    const loaded = { mode: "managed" as const, managedModel: "strong", allowedModels: ["fast", "strong"] };
    await saveSettings(backend, projectId, loaded, dana, twoModels);
    await savePersonal(backend, lee, { mode: "managed", managedModel: "strong" }, twoModels);
    const noManaged: AiDeployment = { ...twoModels, managed: null };
    await expect(saveSettings(backend, projectId, { ...loaded, managedModel: "fast" }, dana, noManaged)).rejects.toThrow("Critiqs AI models this deployment offers");
    await expect(saveSettings(backend, projectId, { ...loaded, allowedModels: ["strong"] }, dana, noManaged)).rejects.toThrow("Critiqs AI models this deployment offers");
    await expect(savePersonal(backend, lee, { mode: "managed", managedModel: "fast" }, noManaged)).rejects.toThrow("Critiqs AI models this deployment offers");
    // Clearing a choice offers nothing new, so it's accepted.
    expect(await saveSettings(backend, projectId, { ...loaded, allowedModels: [] }, dana, noManaged)).toMatchObject({ managedModel: "strong", allowedModels: [] });
    // Saved before, a model the project doesn't allow is refused when AI is saved on, with Critiqs AI off too.
    const stored = await backend.run((store) => store.aiSettings.find(projectId));
    await backend.run((store) => store.aiSettings.patch(stored!._id, { enabled: true, managedModel: "strong", allowedModels: ["fast"] }));
    await expect(saveSettings(backend, projectId, { enabled: true, mode: "managed", rule: "project" }, dana, noManaged)).rejects.toThrow("Allow the project's Critiqs AI model");
    // Turned off, Critiqs AI can't be turned on again until the deployment offers it, even in two steps.
    const { projectId: other } = await setup(backend);
    expect(await saveSettings(backend, other, { enabled: false, mode: "managed" }, dana, noManaged)).toMatchObject({ enabled: false, mode: "managed" });
    await expect(saveSettings(backend, other, { enabled: true, mode: "managed" }, dana, noManaged)).rejects.toThrow("isn't available");
    await savePersonal(backend, lee, { mode: "managed", managedModel: "strong", enabled: false }, noManaged);
    await expect(savePersonal(backend, lee, { mode: "managed", managedModel: "strong" }, noManaged)).rejects.toThrow("isn't available");
  });

  test(`${name}: a project's AI is never left on with a Critiqs AI model it doesn't allow, however the two were saved`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend);
    // Turned off, a save's Critiqs AI fields keep the saved ones, so the off step can't set a model up for later.
    await saveSettings(backend, projectId, { enabled: false, mode: "managed", managedModel: "strong", allowedModels: ["fast"] }, dana, twoModels);
    await saveSettings(backend, projectId, { enabled: true, mode: "managed" }, dana, twoModels);
    const stored = await backend.run((store) => store.aiSettings.find(projectId));
    expect(stored).toMatchObject({ enabled: true, mode: "managed" });
    expect(stored!.managedModel === undefined || stored!.allowedModels === undefined || stored!.allowedModels.includes(stored!.managedModel)).toBe(true);
    // Settings saved that way before, now turned on, are refused until the model is allowed.
    await backend.run((store) => store.aiSettings.patch(stored!._id, { enabled: false, managedModel: "strong", allowedModels: ["fast"] }));
    await expect(saveSettings(backend, projectId, { enabled: true, mode: "managed" }, dana, twoModels)).rejects.toThrow("Allow the project's Critiqs AI model");
    expect(await saveSettings(backend, projectId, { enabled: true, mode: "managed", allowedModels: ["fast", "strong"] }, dana, twoModels)).toMatchObject({ enabled: true, managedModel: "strong" });
  });

  // -------------------------------------------------------------------------
  // Model lists, OpenRouter, and the model choice a person's requests have

  /** A provider's model list, recording each request's address and headers. */
  function fakeProvider(models: unknown = { data: [{ id: "gpt-test" }, { id: "gpt-big" }] }) {
    const requests: { url: string; headers: Record<string, string> }[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers)) });
      return Response.json(models);
    }) as typeof globalThis.fetch;
    return { fetch, requests };
  }

  function listAs(backend: ContractBackend, who: Identity, projectId: string | null, fetch: typeof globalThis.fetch, draft?: AiModelListDraft) {
    return listModels(
      {
        prepare: () =>
          projectId === null
            ? backend.run((store) => preparePersonalModelList(store, who, Date.now()))
            : backend.run((store) => prepareModelList(store, who, { projectId }, Date.now())),
        ...(projectId === null ? {} : { recheck: () => backend.run((store) => recheckAiManager(store, who, { projectId })) }),
        deployment,
        fetch,
      },
      draft,
    );
  }

  test(`${name}: only the owner lists the project's models, with the saved key for the saved provider, or a typed key that is never stored`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend);
    await saveSettings(backend, projectId);
    const provider = fakeProvider();
    expect(await listAs(backend, dana, projectId, provider.fetch)).toEqual({ ok: true, models: [{ id: "gpt-big", label: null }, { id: "gpt-test", label: null }], truncated: false });
    expect(provider.requests).toEqual([{ url: "https://api.openai.com/v1/models", headers: expect.objectContaining({ authorization: "Bearer sk-test-1234567890abcd" }) }]);
    await expect(listAs(backend, lee, projectId, provider.fetch)).rejects.toThrow("Only the person who set up this project");
    // A draft of another provider uses only the key typed for it; it is neither sent elsewhere nor saved.
    const anthropic = fakeProvider({ data: [{ id: "claude-test", display_name: "Claude Test" }] });
    expect(await listAs(backend, dana, projectId, anthropic.fetch, { provider: "anthropic", apiKey: "sk-typed-9999" })).toMatchObject({ ok: true, models: [{ id: "claude-test", label: "Claude Test" }] });
    expect(anthropic.requests[0]!.headers).toMatchObject({ "x-api-key": "sk-typed-9999", "anthropic-version": "2023-06-01" });
    expect(JSON.stringify(anthropic.requests)).not.toContain("sk-test");
    expect(JSON.stringify(await backend.run((store) => store.aiSettings.find(projectId)))).not.toContain("sk-typed");
    // Without a typed key, the saved key isn't used for another provider.
    const unused = fakeProvider();
    expect(await listAs(backend, dana, projectId, unused.fetch, { provider: "anthropic" })).toEqual({ ok: false, code: "config", message: "Enter your Anthropic API key to list its models." });
    expect(unused.requests).toEqual([]);
    // A person lists their own provider's models; nothing is saved for them.
    expect(await listAs(backend, lee, null, provider.fetch, { provider: "openrouter", apiKey: "sk-or-lee" })).toMatchObject({ ok: true });
    expect(provider.requests.at(-1)).toEqual({ url: "https://openrouter.ai/api/v1/models", headers: expect.objectContaining({ authorization: "Bearer sk-or-lee" }) });
    expect(await backend.run((store) => getPersonalAiSettings(store, lee, deployment))).toMatchObject({ saved: false });
  });

  test(`${name}: model lists go only to allowed addresses, and are limited per person per minute`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend);
    const provider = fakeProvider();
    for (const [draft, message] of [
      [{ provider: "compatible", baseUrl: "https://10.0.0.5/v1" }, "private or local network"],
      [{ provider: "compatible", baseUrl: "https://elsewhere.example.com/v1" }, "isn't on this deployment's list"],
      [{ provider: "openrouter", baseUrl: "https://llm.example.com/v1", apiKey: "sk-or" }, "OpenRouter's address is set by Critiqs"],
    ] as const) {
      const result = await listAs(backend, dana, projectId, provider.fetch, draft);
      expect(result).toMatchObject({ ok: false, code: "config" });
      expect((result as { message: string }).message).toContain(message);
    }
    expect(provider.requests).toEqual([]);
    // An allowed custom endpoint is listed under its own address, without a key when it needs none.
    expect(await listAs(backend, dana, projectId, provider.fetch, { provider: "compatible", baseUrl: "https://llm.example.com/v1/" })).toMatchObject({ ok: true });
    expect(provider.requests.at(-1)?.url).toBe("https://llm.example.com/v1/models");
    for (let i = 1; i < MODEL_LISTS_PER_MINUTE - 3; i++) await listAs(backend, dana, null, provider.fetch, { provider: "openai", apiKey: "sk-x" });
    await expect(listAs(backend, dana, null, provider.fetch, { provider: "openai", apiKey: "sk-x" })).rejects.toThrow("Too many model lists");
    // Connection tests have their own limit.
    const { model } = fakeModel(() => ({ status: "ok" }));
    expect(await testConnection(personalTestSteps(backend, dana, deployment, model), personalOwn)).toMatchObject({ ok: true });
  });

  test(`${name}: OpenRouter is saved without an address and offers its picked models`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend);
    await expect(saveSettings(backend, projectId, { provider: "openrouter", model: "openai/gpt-test", baseUrl: "https://llm.example.com/v1" })).rejects.toThrow("OpenRouter's address is set by Critiqs");
    const view = await saveSettings(backend, projectId, { provider: "openrouter", model: "openai/gpt-test", models: ["openai/gpt-test", "anthropic/claude-test"], apiKey: "sk-or-1234" });
    expect(view).toMatchObject({ provider: "openrouter", baseUrl: null, model: "openai/gpt-test", models: ["openai/gpt-test", "anthropic/claude-test"], keyHint: "1234", status: { ready: true } });
    expect(view.deployment.providers).toContain("openrouter");
    const stored = await backend.run((store) => store.aiSettings.find(projectId));
    const chosen = connectionOf("project", projectId, stored, deployment, "anthropic/claude-test");
    if (!chosen.ok) throw new Error(chosen.reason);
    // Its address is OpenRouter's own, which needs no allowlist entry.
    expect(await resolveConnection(chosen, deployment)).toMatchObject({ ready: true, provider: "openrouter", baseUrl: null, model: "anthropic/claude-test", apiKey: "sk-or-1234" });
  });

  test(`${name}: a person's model choice shows the connection the rule gives them and its models, never a key or an address`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend);
    await expect(backend.run((store) => getAiChoice(store, null, { projectId }, deployment))).rejects.toThrow("Sign in");
    // No settings and no AI on the deployment: nothing to choose.
    expect(await backend.run((store) => getAiChoice(store, lee, { projectId }, deployment))).toMatchObject({ source: null, models: [], defaultModel: null });
    await saveSettings(backend, projectId, { models: ["gpt-test", "gpt-big"], baseUrl: "https://llm.example.com/v1" });
    const project = await backend.run((store) => getAiChoice(store, lee, { projectId }, deployment));
    expect(project).toEqual({ source: "project", models: [{ id: "gpt-test", label: "gpt-test" }, { id: "gpt-big", label: "gpt-big" }], defaultModel: "gpt-test" });
    expect(JSON.stringify(project)).not.toMatch(/sk-test|llm\.example/);
    // Each person pays: Lee must set up Your AI, then chooses among his own models.
    await saveSettings(backend, projectId, { rule: "personal", apiKey: undefined, baseUrl: "https://llm.example.com/v1" });
    expect(await backend.run((store) => getAiChoice(store, lee, { projectId }, deployment))).toEqual({ source: null, models: [], defaultModel: null, reason: "Set up your AI to use this.", reasonCode: "setup-ai" });
    await savePersonal(backend, lee, { models: ["claude-test", "claude-big"] });
    expect(await backend.run((store) => getAiChoice(store, lee, { projectId }, deployment))).toMatchObject({ source: "personal", models: [{ id: "claude-test" }, { id: "claude-big" }], defaultModel: "claude-test" });
    // The project's Critiqs AI offers only the models its owner allows, with their credits and never the provider's names.
    await saveSettings(backend, projectId, { mode: "managed", managedModel: "strong", rule: "project", allowedModels: ["strong"] }, dana, twoModels);
    const managed = await backend.run((store) => getAiChoice(store, lee, { projectId }, twoModels));
    expect(managed).toEqual({ source: "project", models: [{ id: "strong", label: "Strong", credits: 3 }], defaultModel: "strong" });
    expect(JSON.stringify(managed)).not.toContain("strong-model");
    await saveSettings(backend, projectId, { mode: "managed", managedModel: "fast", rule: "project", allowedModels: [] }, dana, twoModels);
    expect((await backend.run((store) => getAiChoice(store, lee, { projectId }, twoModels))).models.map((entry) => entry.id)).toEqual(["fast", "strong"]);
  });

  test(`${name}: search and model choices of a project limited to its organization are refused to everyone outside it`, async () => {
    const backend = fresh();
    const { projectId, threadId } = await setup(backend, "Unclear label");
    const scope: SearchScope = { status: "all", screen: null };
    const query = { terms: ["unclear"], tags: [], groupIds: [], status: "all" as const, screen: null, since: null, until: null };
    const retrieved = await backend.run((store) => retrieveSearch(store, lee, { projectId, query, groups: [] }));
    expect(retrieved.results.map((result) => result.threadId)).toEqual([threadId]);
    await backend.run((store) => ops.setReviewAccess(store, dana, { projectId, reviewAccess: "organization" }));
    const response = { mode: "ai" as const, notice: null, query, results: retrieved.results, truncated: false, insights: [], insightNotice: null };
    const refused = "limited to members of its organization";
    await expect(backend.run((store) => prepareSearch(store, lee, { projectId, question: "label", scope }, deployment, Date.now()))).rejects.toThrow(refused);
    await expect(backend.run((store) => retrieveSearch(store, lee, { projectId, query, groups: [] }))).rejects.toThrow(refused);
    // A search begun before the project was limited returns nothing.
    await expect(backend.run((store) => finalizeSearch(store, lee, { projectId, response }))).rejects.toThrow(refused);
    await expect(backend.run((store) => getAiChoice(store, lee, { projectId }, deployment))).rejects.toThrow(refused);
    expect((await backend.run((store) => finalizeSearch(store, dana, { projectId, response }))).results).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Access that ends while Critiqs AI works

  const limit = (backend: ContractBackend, projectId: string) =>
    backend.run((store) => ops.setReviewAccess(store, dana, { projectId, reviewAccess: "organization" }));

  /** Takes Dana out of her project's organization, so she no longer manages it. */
  async function removeDana(backend: ContractBackend, projectId: string) {
    const organizationId = (await backend.run((store) => ops.getProject(store, dana, { projectId }))).organization!.id;
    const danaId = await userIdOf(backend, dana);
    const membership = (await backend.run((store) => store.memberships.find(organizationId, danaId)))!;
    await backend.run((store) => store.memberships.delete(membership._id));
  }

  /** Lee's search of Dana's project with her own key; `after` runs once a step is done, before the model is next asked. */
  function leeSearches(backend: ContractBackend, projectId: string, model: StructuredModel, after: { prepare?: () => Promise<void>; retrieve?: () => Promise<void> } = {}) {
    return runSearch({
      prepare: async () => {
        const plan = await backend.run((store) => prepareSearch(store, lee, { projectId, question: "label", scope: { status: "all", screen: null } }, deployment, Date.now()));
        await after.prepare?.();
        return plan;
      },
      authorize: () => backend.run((store) => authorizeSearch(store, lee, { projectId })),
      retrieve: async (query, groups) => {
        const retrieved = await backend.run((store) => retrieveSearch(store, lee, { projectId, query, groups }));
        await after.retrieve?.();
        return retrieved;
      },
      finalize: (response) => backend.run((store) => finalizeSearch(store, lee, { projectId, response })),
      ...credits(backend),
      model: () => model,
      deployment,
      now: Date.now(),
    });
  }

  test(`${name}: a search whose project is limited to its organization after it starts sends the model nothing`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend);
    await saveSettings(backend, projectId);
    const { model, prompts } = fakeModel(() => ({ terms: ["label"], tags: [], groups: [], status: "unspecified", since: "", until: "", screen: "" }));
    await expect(leeSearches(backend, projectId, model, { prepare: () => limit(backend, projectId) })).rejects.toThrow(ORGANIZATION_ONLY);
    expect(prompts).toEqual([]);
  });

  test(`${name}: a search whose project is limited to its organization after the feedback is found sends the model none of it`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend);
    await saveSettings(backend, projectId);
    const { model, prompts } = fakeModel((request) =>
      request.task === "search" ? { terms: ["label"], tags: [], groups: [], status: "unspecified", since: "", until: "", screen: "" } : { findings: [] },
    );
    // The matching feedback is read; then the project is limited, before that feedback goes to the model for insights.
    await expect(leeSearches(backend, projectId, model, { retrieve: () => limit(backend, projectId) })).rejects.toThrow(ORGANIZATION_ONLY);
    expect(prompts.map((prompt) => prompt.task)).toEqual(["search"]);
  });

  test(`${name}: a connection test by someone who stops managing the project while it runs records nothing`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend);
    await saveSettings(backend, projectId);
    const answering = fakeModel(() => ({ status: "ok" }));
    const model: StructuredModel = {
      ...answering.model,
      generate: async (request) => {
        const answer = await answering.model.generate(request);
        await removeDana(backend, projectId);
        return answer;
      },
    };
    await expect(testConnection(testSteps(backend, dana, projectId, deployment, model))).rejects.toThrow("Only the person who set up this project");
    expect((await backend.run((store) => store.aiSettings.find(projectId)))!.lastTest).toBeUndefined();
  });

  test(`${name}: a managed search whose project is limited to its organization while its credits are held sends the model nothing`, async () => {
    const backend = fresh().withPlans({ free: { name: "free", label: "Free", limits: [{ metric: "aiCredits", period: "month", max: 40 } ] } });
    const { projectId } = await setup(backend);
    await saveSettings(backend, projectId, { mode: "managed" }, dana, priced);
    const { model, prompts } = fakeModel(searchAnswer);
    const steps = credits(backend);
    let reserved = 0;
    const search = runSearch({
      prepare: () => backend.run((store) => prepareSearch(store, lee, { projectId, question: "label", scope: { status: "all", screen: null } }, priced, Date.now())),
      authorize: () => backend.run((store) => authorizeSearch(store, lee, { projectId })),
      retrieve: (query, groups) => backend.run((store) => retrieveSearch(store, lee, { projectId, query, groups })),
      finalize: (response) => backend.run((store) => finalizeSearch(store, lee, { projectId, response })),
      // The credits are held; then Dana limits the project to her organization, before the request is sent.
      reserve: async (payer, amount) => {
        const held = await steps.reserve(payer, amount);
        reserved++;
        await limit(backend, projectId);
        return held;
      },
      settle: steps.settle,
      model: () => model,
      deployment: priced,
      now: Date.now(),
    });
    await expect(search).rejects.toThrow(ORGANIZATION_ONLY);
    expect(reserved).toBe(1);
    expect(prompts).toEqual([]);
    // Nothing is counted, and the hold is released.
    expect(await projectCredits(backend, projectId)()).toBe(0);
    const organizationId = (await backend.run((store) => ops.getProject(store, dana, { projectId }))).organization!.id;
    expect(await backend.run((store) => store.creditHolds.held(`aiCredits:${organizationId}`, Date.now()))).toBe(0);
  });

  test(`${name}: a draft's connection test by someone who stops managing the project while it runs returns them nothing`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend);
    await saveSettings(backend, projectId);
    const answering = fakeModel(() => ({ status: "ok" }));
    const model: StructuredModel = {
      ...answering.model,
      generate: async (request) => {
        const answer = await answering.model.generate(request);
        await removeDana(backend, projectId);
        return answer;
      },
    };
    const draft = { ...ownSettings, projectId, model: "gpt-draft" };
    await expect(testConnection(testSteps(backend, dana, projectId, deployment, model), draft)).rejects.toThrow("Only the person who set up this project");
    expect(answering.prompts).toHaveLength(1);
  });

  test(`${name}: a connection test by someone who stops managing the project before it is sent sends nothing`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend);
    await saveSettings(backend, projectId);
    const { model, prompts } = fakeModel(() => ({ status: "ok" }));
    const organizationId = (await backend.run((store) => ops.getProject(store, dana, { projectId }))).organization!.id;
    const danaId = await userIdOf(backend, dana);
    const { role, createdAt } = (await backend.run((store) => store.memberships.find(organizationId, danaId)))!;
    const membership = { organizationId, userId: danaId, role, createdAt };
    for (const draft of [undefined, { ...ownSettings, projectId, model: "gpt-draft" }]) {
      const steps = testSteps(backend, dana, projectId, deployment, model);
      const prepared = steps.prepare;
      // The test is prepared; then Dana leaves the project's organization, before the request is sent.
      steps.prepare = async () => {
        const plan = await prepared();
        await removeDana(backend, projectId);
        return plan;
      };
      await expect(testConnection(steps, draft)).rejects.toThrow("Only the person who set up this project");
      // Back in the organization for the next case.
      await backend.run((store) => store.memberships.insert(membership));
    }
    expect(prompts).toEqual([]);
  });

  test(`${name}: a project's model list isn't returned to someone who stopped managing it while it was fetched`, async () => {
    const backend = fresh();
    const { projectId } = await setup(backend);
    await saveSettings(backend, projectId);
    const provider = fakeProvider();
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await provider.fetch(input, init);
      await removeDana(backend, projectId);
      return response;
    }) as typeof globalThis.fetch;
    await expect(listAs(backend, dana, projectId, fetch)).rejects.toThrow("Only the person who set up this project");
    expect(provider.requests).toHaveLength(1);
  });
}
