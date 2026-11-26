import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { api, internal } from "../convex/_generated/api";
import { anchor, reviewer, setup } from "./harness";

// Critiqs's Convex AI actions through the real AI SDK path, against a local
// stand-in for an OpenAI-compatible endpoint configured as the deployment's
// provider. Fixtures check behavior, not real providers.

const ENV = [
  "CRITIQS_AI_PROVIDER",
  "CRITIQS_AI_MODEL",
  "CRITIQS_AI_API_KEY",
  "CRITIQS_AI_BASE_URL",
  "CRITIQS_AI_ENCRYPTION_KEY",
  "CRITIQS_AI_ALLOWED_ENDPOINTS",
  "CRITIQS_AI_LOCAL_ENDPOINTS",
  "CRITIQS_MANAGED_AI",
  "CRITIQS_MANAGED_AI_MODELS",
  "CRITIQS_MANAGED_AI_PROVIDER",
  "CRITIQS_MANAGED_AI_MODEL",
  "CRITIQS_MANAGED_AI_API_KEY",
  "CRITIQS_MANAGED_AI_BASE_URL",
  "CRITIQS_MANAGED_AI_PRICE",
  "CRITIQS_PLANS",
];
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  requests.length = 0;
  lists.length = 0;
  usage = ONE_TOKEN;
});
const ONE_TOKEN = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
let usage: Record<string, unknown> = ONE_TOKEN;
/** The key each model list request carried. */
const lists: (string | null)[] = [];

const requests: { system: string; prompt: string; authorization: string | null; model: string }[] = [];
let endpoint: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "GET" && new URL(request.url).pathname === "/v1/models") {
        lists.push(request.headers.get("Authorization"));
        return Response.json({ object: "list", data: [{ id: "listed-b" }, { id: "listed-a" }] });
      }
      const body = (await request.json()) as { model: string; messages: { role: string; content: string }[] };
      const system = body.messages.find((message) => message.role === "system")?.content ?? "";
      const prompt = body.messages.find((message) => message.role === "user")?.content ?? "";
      requests.push({ system, prompt, authorization: request.headers.get("Authorization"), model: body.model });
      if (request.headers.get("Authorization") === "Bearer bad-key") return Response.json({ error: { message: "bad key bad-key" } }, { status: 401 });
      const answer = system.includes("turn a question")
        ? { terms: ["label"], tags: [], groups: [], status: "unspecified", since: "", until: "", screen: "" }
        : system.includes("summarize")
          ? { findings: [{ title: "Labels are unclear", detail: "Reviewers ask for clearer labels.", threads: ["T1", "T5"] }] }
          : system.includes("organize the tags")
            ? { assignments: [...prompt.matchAll(/"([^"]+)"/g)].map((match) => ({ tag: match[1], groups: [], newGroups: match[1] === "layout" ? ["Visual design"] : [] })) }
            : { status: "ok" };
      return Response.json({
        id: "chat",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(answer) }, finish_reason: "stop" }],
        usage,
      });
    },
  });
});
afterAll(() => endpoint.stop(true));

const base = () => `http://127.0.0.1:${endpoint.port}/v1`;
const failed = { status: "failed" as const, failureReason: "x" };

async function project() {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const lee = t.withIdentity(reviewer("Lee"));
  const projectId = await dana.mutation(api.projects.create, { name: "Pilot" });
  const threadId = await dana.mutation(api.threads.create, { projectId, anchor, body: "The department label is unclear #layout #wording", tags: [], capture: failed });
  return { t, dana, lee, projectId, threadId };
}

function deploymentProvider() {
  process.env.CRITIQS_AI_PROVIDER = "compatible";
  process.env.CRITIQS_AI_MODEL = "local-model";
  process.env.CRITIQS_AI_API_KEY = "deployment-key";
  process.env.CRITIQS_AI_BASE_URL = base();
}

test("search interprets the question with the deployment's provider and cites only returned threads", async () => {
  deploymentProvider();
  const { lee, projectId, threadId } = await project();
  const result = await lee.action(api.ai.search, { projectId, question: "What do people say about labels?", scope: { status: "open", screen: null } });
  expect(result).toMatchObject({ mode: "ai", notice: null, query: { terms: ["label"], status: "open" } });
  expect(result.results.map((entry) => entry.threadId)).toEqual([threadId]);
  expect(result.insights).toEqual([{ title: "Labels are unclear", detail: "Reviewers ask for clearer labels.", threadIds: [threadId] }]);
  expect(requests.map((request) => request.authorization)).toEqual(["Bearer deployment-key", "Bearer deployment-key"]);
  expect(JSON.stringify(result)).not.toContain("deployment-key");
});

test("search needs sign-in, and without AI is basic and labeled", async () => {
  const { t, lee, projectId, threadId } = await project();
  await expect(t.action(api.ai.search, { projectId, question: "label", scope: { status: "all", screen: null } })).rejects.toThrow("Sign in");
  const result = await lee.action(api.ai.search, { projectId, question: "#layout", scope: { status: "all", screen: null } });
  expect(result.mode).toBe("basic");
  expect(result.notice).toStartWith("AI unavailable: basic search.");
  expect(result.results.map((entry) => entry.threadId)).toEqual([threadId]);
  expect(requests).toEqual([]);
});

test("the grouping job groups new tags in the background", async () => {
  deploymentProvider();
  const { t, dana, projectId } = await project();
  await t.action(internal.ai.groupTags, {});
  const tags = await dana.query(api.tags.list, { projectId });
  const visual = tags.groups.find((group) => group.name === "Visual design")!;
  expect(visual.origin).toBe("ai");
  expect(tags.tags.find((tag) => tag.key === "layout")).toMatchObject({ groupIds: [visual._id], grouping: "ai" });
  // #wording joined the starter group without AI.
  expect(tags.tags.find((tag) => tag.key === "wording")!.grouping).toBe("starter");
});

test("owners save their own provider: the key is stored encrypted, shown only as a hint, and tested", async () => {
  process.env.CRITIQS_AI_ENCRYPTION_KEY = "e".repeat(44);
  process.env.CRITIQS_AI_ALLOWED_ENDPOINTS = "https://llm.example.com/v1";
  const { t, dana, lee, projectId } = await project();
  const input = { projectId, enabled: true, mode: "own" as const, provider: "openai" as const, model: "gpt-test", apiKey: "sk-owner-secret-4321" };
  await expect(lee.action(api.ai.saveSettings, input)).rejects.toThrow("Only the person");
  await expect(lee.query(api.aiSettings.get, { projectId })).rejects.toThrow("Only the person");
  const view = await dana.action(api.ai.saveSettings, input);
  expect(view).toMatchObject({ provider: "openai", keyHint: "4321", status: { ready: true }, deployment: { keysStorable: true, managed: false } });
  const stored = await t.run(async (ctx) => await ctx.db.query("aiSettings").unique());
  expect(stored!.secret!.ciphertext).not.toContain("sk-owner");
  expect(JSON.stringify(stored)).not.toContain("sk-owner-secret");
  expect(JSON.stringify(await dana.query(api.aiSettings.get, { projectId }))).not.toContain("sk-owner");
  await expect(dana.action(api.ai.saveSettings, { ...input, provider: "compatible", baseUrl: "https://evil.example/v1" })).rejects.toThrow("allowed AI endpoints");
  // A draft aimed at an address the deployment doesn't allow is never contacted.
  const draft = await dana.action(api.ai.testSettings, { projectId, draft: { ...input, provider: "compatible", baseUrl: base() } });
  expect(draft).toMatchObject({ ok: false, code: "config" });
  expect(requests).toEqual([]);
});

test("a deployment provider's failure is reported, never replaced by managed AI", async () => {
  deploymentProvider();
  process.env.CRITIQS_AI_API_KEY = "bad-key";
  const { dana, projectId } = await project();
  const result = await dana.action(api.ai.testSettings, { projectId });
  expect(result).toEqual({ ok: false, code: "auth", message: "The provider refused the key. Check that it is correct and active." });
  expect(requests.map((request) => request.model)).toEqual(["local-model"]);
  expect((await dana.query(api.aiSettings.get, { projectId })).lastTest).toBeNull();
});

test("Critiqs-managed AI counts its requests toward the project's plan", async () => {
  process.env.CRITIQS_MANAGED_AI = "enabled";
  process.env.CRITIQS_MANAGED_AI_PROVIDER = "compatible";
  process.env.CRITIQS_MANAGED_AI_MODEL = "managed-model";
  process.env.CRITIQS_MANAGED_AI_API_KEY = "managed-key";
  process.env.CRITIQS_MANAGED_AI_BASE_URL = base();
  process.env.CRITIQS_PLANS = "enabled";
  const { dana, projectId } = await project();
  const settings = await dana.query(api.aiSettings.get, { projectId });
  expect(settings).toMatchObject({ mode: "managed", enabled: true, deployment: { managed: true }, status: { ready: true } });
  const result = await dana.action(api.ai.search, { projectId, question: "labels", scope: { status: "all", screen: null } });
  expect(result.mode).toBe("ai");
  expect(requests.every((request) => request.model === "managed-model" && request.authorization === "Bearer managed-key")).toBe(true);
  const usage = await dana.query(api.projects.usage, { projectId, day: new Date().toISOString().slice(0, 10), aiCredits: true });
  expect(usage!.rows.find((row) => row.metric === "aiCredits")).toMatchObject({ used: 2, max: 200 });
});

test("a priced Critiqs AI model charges each answered request by the tokens the provider reports, at twice its price", async () => {
  process.env.CRITIQS_MANAGED_AI = "enabled";
  process.env.CRITIQS_MANAGED_AI_PROVIDER = "compatible";
  process.env.CRITIQS_MANAGED_AI_MODEL = "managed-model";
  process.env.CRITIQS_MANAGED_AI_PRICE = JSON.stringify({ input: 4, output: 20 });
  process.env.CRITIQS_MANAGED_AI_API_KEY = "managed-key";
  process.env.CRITIQS_MANAGED_AI_BASE_URL = base();
  process.env.CRITIQS_PLANS = "enabled";
  const { t, dana, projectId } = await project();
  // Free includes 200 credits a month; start with 100 of them used.
  await t.mutation(internal.aiSettings.settle, { hold: null, charge: { payer: "project", ownerId: projectId, credits: 100 } });
  const settings = await dana.query(api.aiSettings.get, { projectId });
  // Shown as about what 2,000 input and 1,000 output tokens cost: $0.028, 6 credits.
  expect(settings.deployment.managedModels).toEqual([{ id: "default", label: "Critiqs AI", credits: 6, estimated: true }]);
  // 20,000 input tokens (5,000 cached) and 3,000 output tokens (1,000 reasoning): $0.08 + $0.06 = $0.14, 28 credits a request.
  usage = { prompt_tokens: 20_000, completion_tokens: 3_000, total_tokens: 23_000, prompt_tokens_details: { cached_tokens: 5_000 }, completion_tokens_details: { reasoning_tokens: 1_000 } };
  const result = await dana.action(api.ai.search, { projectId, question: "labels", scope: { status: "all", screen: null } });
  expect(result.mode).toBe("ai");
  expect(requests).toHaveLength(2);
  const used = async () => (await dana.query(api.projects.usage, { projectId, day: new Date().toISOString().slice(0, 10), aiCredits: true }))!.rows.find((row) => row.metric === "aiCredits");
  expect(await used()).toMatchObject({ used: 156, max: 200 });
  process.env.CRITIQS_MANAGED_AI_API_KEY = "bad-key";
  expect(await dana.action(api.ai.testSettings, { projectId })).toMatchObject({ ok: false, code: "auth" });
  expect(await used()).toMatchObject({ used: 156 });
  // With 44 credits left, a test of 28 runs, and the one after it, with 16 left, is counted past the allowance.
  process.env.CRITIQS_MANAGED_AI_API_KEY = "managed-key";
  expect(await dana.action(api.ai.testSettings, { projectId })).toMatchObject({ ok: true });
  expect(await dana.action(api.ai.testSettings, { projectId })).toMatchObject({ ok: true });
  expect(await used()).toMatchObject({ used: 212, max: 200 });
  const before = requests.length;
  await expect(dana.action(api.ai.testSettings, { projectId })).rejects.toThrow("no Critiqs AI credits left");
  expect(requests).toHaveLength(before);
  expect(await used()).toMatchObject({ used: 212 });
});

test("a connection test refused for want of credits still owes the organization's admins the email that none are left", async () => {
  process.env.CRITIQS_MANAGED_AI = "enabled";
  process.env.CRITIQS_MANAGED_AI_PROVIDER = "compatible";
  process.env.CRITIQS_MANAGED_AI_MODELS = JSON.stringify([{ id: "big", label: "Big", model: "big-model", credits: 150 }]);
  process.env.CRITIQS_MANAGED_AI_API_KEY = "managed-key";
  process.env.CRITIQS_MANAGED_AI_BASE_URL = base();
  process.env.CRITIQS_PLANS = "enabled";
  const { t, dana, projectId } = await project();
  expect(await dana.action(api.ai.testSettings, { projectId })).toMatchObject({ ok: true });
  await expect(dana.action(api.ai.testSettings, { projectId })).rejects.toThrow("enough Critiqs AI credits left for this request");
  expect(requests).toHaveLength(1);
  expect(await t.run((ctx) => ctx.db.query("planAlerts").collect())).toEqual([expect.objectContaining({ kind: "paused", plan: "free", planLabel: "Free", status: "pending" })]);
});

test("Your AI on Convex: each person saves, sees, tests, and removes only their own settings", async () => {
  process.env.CRITIQS_AI_ENCRYPTION_KEY = "e".repeat(44);
  process.env.CRITIQS_AI_ALLOWED_ENDPOINTS = base();
  process.env.CRITIQS_AI_LOCAL_ENDPOINTS = "enabled";
  const { t, dana, lee } = await project();
  await expect(t.query(api.aiSettings.getPersonal, {})).rejects.toThrow("Sign in");
  await expect(t.action(api.ai.savePersonalSettings, { enabled: false, mode: "own" })).rejects.toThrow("Sign in");
  const input = { enabled: true, mode: "own" as const, provider: "compatible" as const, model: "dana-model", baseUrl: base(), apiKey: "dana-secret-9876" };
  const view = await dana.action(api.ai.savePersonalSettings, input);
  expect(view).toMatchObject({ saved: true, keyHint: "9876", model: "dana-model", status: { ready: true } });
  const stored = await t.run(async (ctx) => await ctx.db.query("personalAiSettings").unique());
  expect(JSON.stringify(stored)).not.toContain("dana-secret");
  expect(JSON.stringify(await dana.query(api.aiSettings.getPersonal, {}))).not.toContain("dana-secret");
  expect(await lee.query(api.aiSettings.getPersonal, {})).toMatchObject({ saved: false, keyHint: null });
  expect(await dana.action(api.ai.testPersonalSettings, {})).toMatchObject({ ok: true });
  expect(requests.map((request) => `${request.model} ${request.authorization}`)).toEqual(["dana-model Bearer dana-secret-9876"]);
  expect((await dana.query(api.aiSettings.getPersonal, {})).lastTest).toMatchObject({ ok: true });
  // A draft is tested without being saved.
  expect(await lee.action(api.ai.testPersonalSettings, { draft: { ...input, model: "lee-draft", apiKey: "lee-draft-key" } })).toMatchObject({ ok: true });
  expect(await lee.query(api.aiSettings.getPersonal, {})).toMatchObject({ saved: false });
  expect(await dana.mutation(api.aiSettings.removePersonal, {})).toMatchObject({ saved: false });
  expect(await t.run(async (ctx) => await ctx.db.query("personalAiSettings").collect())).toEqual([]);
});

test("Critiqs AI's models come from the deployment, and each request costs its model's credits", async () => {
  process.env.CRITIQS_MANAGED_AI = "enabled";
  process.env.CRITIQS_MANAGED_AI_PROVIDER = "compatible";
  process.env.CRITIQS_MANAGED_AI_MODELS = JSON.stringify([
    { id: "fast", label: "Fast", model: "fast-model", credits: 1 },
    { id: "strong", label: "Strong", model: "strong-model", credits: 3 },
  ]);
  process.env.CRITIQS_MANAGED_AI_API_KEY = "managed-key";
  process.env.CRITIQS_MANAGED_AI_BASE_URL = base();
  process.env.CRITIQS_PLANS = "enabled";
  const { t, dana, lee, projectId } = await project();
  const view = await dana.action(api.ai.saveSettings, { projectId, enabled: true, mode: "managed", managedModel: "strong", allowedModels: ["strong"], rule: "project" });
  expect(view).toMatchObject({ rule: "project", managedModel: "strong", allowedModels: ["strong"], deployment: { managedModels: [{ id: "fast", label: "Fast", credits: 1 }, { id: "strong", label: "Strong", credits: 3 }] } });
  expect(JSON.stringify(view)).not.toContain("strong-model");
  const result = await lee.action(api.ai.search, { projectId, question: "labels", scope: { status: "all", screen: null } });
  expect(result.mode).toBe("ai");
  expect(requests.map((request) => request.model)).toEqual(["strong-model", "strong-model"]);
  const usage = await dana.query(api.projects.usage, { projectId, day: new Date().toISOString().slice(0, 10), aiCredits: true });
  expect(usage!.rows.find((row) => row.metric === "aiCredits")).toMatchObject({ used: 6, max: 200 });
  // Lee's own Critiqs AI isn't in a Free plan configured without it.
  await t.mutation(internal.plans.set, { name: "free", label: "Free", limits: [{ metric: "aiCredits", period: "month", max: 0 }] });
  await expect(lee.action(api.ai.savePersonalSettings, { enabled: true, mode: "managed", managedModel: "fast" })).rejects.toThrow("doesn't include Critiqs AI");
  // A bad model list turns Critiqs AI off; health says why, never with the key.
  process.env.CRITIQS_MANAGED_AI_MODELS = "[{";
  const health = await (await t.fetch("/critiqs/health")).json();
  expect(health.ai).toMatchObject({ managed: false, managedProblem: "CRITIQS_MANAGED_AI_MODELS isn't valid JSON." });
  expect(JSON.stringify(health)).not.toContain("managed-key");
  process.env.CRITIQS_MANAGED_AI_MODELS = "";
  expect((await (await t.fetch("/critiqs/health")).json()).ai).toEqual({ managed: false, defaultProvider: null, keysStorable: false, managedProblem: "Set CRITIQS_MANAGED_AI_MODELS, or CRITIQS_MANAGED_AI_MODEL for a single model." });
});

test("the tag backfill derives tags for feedback written before tags were derived", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const projectId = await dana.mutation(api.projects.create, { name: "Pilot" });
  // A thread and messages as an earlier backend stored them: no hashtags, project, or text tags.
  const threadId = await t.run(async (ctx) => {
    const project = (await ctx.db.get(projectId))!;
    const id = await ctx.db.insert("threads", {
      projectId,
      status: "open",
      anchor,
      tags: ["Bug"],
      capture: failed,
      createdBy: project.createdBy,
      createdAt: 1,
      lastMessageAt: 2,
      messageCount: 2,
    });
    await ctx.db.insert("messages", { threadId: id, authorId: project.createdBy, body: "Vague label #Wording", createdAt: 1, editedAt: null, revision: null });
    await ctx.db.insert("messages", { threadId: id, authorId: project.createdBy, body: "Agreed #wording #layout", createdAt: 2, editedAt: null, revision: null });
    return id;
  });
  await t.mutation(internal.tags.backfill, {});
  await t.finishAllScheduledFunctions(() => undefined);
  const page = await dana.query(api.threads.get, { threadId, paginationOpts: { numItems: 40, cursor: null } });
  expect(page).toMatchObject({ tags: ["Bug", "Wording", "layout"], textTags: ["Wording", "layout"] });
  const tags = await dana.query(api.tags.list, { projectId });
  expect(tags.tags.find((tag) => tag.key === "wording")).toMatchObject({ label: "Wording", grouping: "starter" });
  expect(tags.tags.find((tag) => tag.key === "bug")).toMatchObject({ preset: true, grouping: "pending" });
  const found = await dana.action(api.ai.search, { projectId, question: "vague", scope: { status: "all", screen: null } });
  expect(found.results.map((entry) => entry.threadId)).toEqual([threadId]);
  // Running it again changes nothing.
  await t.mutation(internal.tags.backfill, {});
  await t.finishAllScheduledFunctions(() => undefined);
  expect((await dana.query(api.threads.get, { threadId, paginationOpts: { numItems: 40, cursor: null } })).tags).toEqual(["Bug", "Wording", "layout"]);
});

test("Convex's functions take an older client's whole tag list and refuse hashtags beyond a message's limit", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const projectId = await dana.mutation(api.projects.create, { name: "Pilot" });
  const hashtags = (count: number, from = 0) => Array.from({ length: count }, (_, i) => `#w${from + i}`).join(" ");
  const threadId = await dana.mutation(api.threads.create, { projectId, anchor, body: hashtags(30), tags: ["Bug"], capture: failed });
  await dana.mutation(api.threads.reply, { threadId, body: hashtags(30, 30), revision: null });
  const thread = () => dana.query(api.threads.get, { threadId, paginationOpts: { numItems: 40, cursor: null } });
  const shown = (await thread()).tags;
  expect(shown).toHaveLength(61);
  await dana.mutation(api.threads.setTags, { threadId, tags: [...shown, "UX copy change"] });
  expect((await thread()).tags.slice(0, 3)).toEqual(["Bug", "UX copy change", "w0"]);
  await expect(dana.mutation(api.threads.reply, { threadId, body: hashtags(31, 100), revision: null })).rejects.toThrow(
    "A message can use up to 30 different hashtags; this one uses 31.",
  );
  expect((await thread()).messageCount).toBe(2);
});

test("the tag backfill keeps a message's first hashtags when it has more than new messages may use", async () => {
  const t = setup();
  const dana = t.withIdentity(reviewer("Dana"));
  const projectId = await dana.mutation(api.projects.create, { name: "Pilot" });
  const body = `Older ${Array.from({ length: 31 }, (_, i) => `#w${i}`).join(" ")}`;
  const { threadId, messageId } = await t.run(async (ctx) => {
    const project = (await ctx.db.get(projectId))!;
    const threadId = await ctx.db.insert("threads", {
      projectId,
      status: "open",
      anchor,
      tags: [],
      capture: failed,
      createdBy: project.createdBy,
      createdAt: 1,
      lastMessageAt: 1,
      messageCount: 1,
    });
    const messageId = await ctx.db.insert("messages", { threadId, authorId: project.createdBy, body, createdAt: 1, editedAt: null, revision: null });
    return { threadId, messageId };
  });
  await t.mutation(internal.tags.backfill, {});
  await t.finishAllScheduledFunctions(() => undefined);
  const thread = () => dana.query(api.threads.get, { threadId, paginationOpts: { numItems: 40, cursor: null } });
  expect((await thread()).textTags).toEqual(Array.from({ length: 30 }, (_, i) => `w${i}`));
  expect((await thread()).page[0]!.body).toBe(body);
  // Editing it is a new write, held to the limit; dropping one hashtag is enough.
  await expect(dana.mutation(api.threads.editMessage, { messageId, body: `${body} again` })).rejects.toThrow("up to 30 different hashtags");
  await dana.mutation(api.threads.editMessage, { messageId, body: body.replace(" #w30", "") });
  expect((await thread()).textTags).toHaveLength(30);
});

test("model lists on Convex: the owner lists the project's models, each person their own, and people see which models they may choose", async () => {
  process.env.CRITIQS_AI_ENCRYPTION_KEY = "e".repeat(44);
  process.env.CRITIQS_AI_ALLOWED_ENDPOINTS = base();
  process.env.CRITIQS_AI_LOCAL_ENDPOINTS = "enabled";
  const { t, dana, lee, projectId } = await project();
  const input = { projectId, enabled: true, mode: "own" as const, provider: "compatible" as const, model: "listed-a", models: ["listed-a", "listed-b"], baseUrl: base(), apiKey: "dana-list-1111" };
  await dana.action(api.ai.saveSettings, input);
  expect(await dana.action(api.ai.listModels, { projectId })).toEqual({ ok: true, models: [{ id: "listed-a", label: null }, { id: "listed-b", label: null }], truncated: false });
  expect(lists).toEqual(["Bearer dana-list-1111"]);
  await expect(lee.action(api.ai.listModels, { projectId })).rejects.toThrow("Only the person");
  // A draft's typed key lists the models and is never stored.
  expect(await lee.action(api.ai.listPersonalModels, { draft: { provider: "compatible", baseUrl: base(), apiKey: "lee-typed-2222" } })).toMatchObject({ ok: true });
  expect(lists.at(-1)).toBe("Bearer lee-typed-2222");
  expect(await t.run(async (ctx) => await ctx.db.query("personalAiSettings").collect())).toEqual([]);
  expect(await dana.action(api.ai.listPersonalModels, { draft: { provider: "compatible", baseUrl: "https://evil.example/v1" } })).toMatchObject({ ok: false, code: "config" });
  // Lee sees the models he may choose among, never the key or the address.
  const choice = await lee.query(api.aiSettings.myChoice, { projectId });
  expect(choice).toEqual({ source: "project", models: [{ id: "listed-a", label: "listed-a" }, { id: "listed-b", label: "listed-b" }], defaultModel: "listed-a" });
  expect(JSON.stringify(choice)).not.toMatch(/dana-list|127\.0\.0\.1/);
});
