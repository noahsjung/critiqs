import { describe, expect, test } from "bun:test";
import { testConnection } from "../src/ai/connection.ts";
import { chargeFor, worstCaseCredits } from "../src/ai/credits.ts";
import { decryptSecret, encryptSecret, keyBinding } from "../src/ai/secrets.ts";
import {
  type AiDeployment,
  aiDeploymentFromEnv,
  checkManagedChoice,
  chooseConnection,
  type ConnectionChoice,
  type ConnectionRequest,
  connectionOf,
  connectionStatus,
  draftConnection,
  managedModelList,
  parseManagedModels,
  personalSettingsView,
  prepareSettings,
  resolveConnection,
  SETUP_AI,
  settingsView,
} from "../src/ai/settings.ts";
import type { AiSettingsInput } from "@critiqs/core";
import type { AiSettingsRecord, PersonalAiSettingsRecord } from "../src/store.ts";

// Which connection a request uses, who pays, and which model, decided before
// any key is decrypted (docs/ai-connections.md).

const KEY = "operator-encryption-key-".padEnd(48, "x");
const deployment: AiDeployment = {
  managed: {
    provider: "openai",
    apiKey: "managed-key",
    models: [
      { id: "fast", label: "Fast", model: "fast-model", credits: 1 },
      { id: "strong", label: "Strong", model: "strong-model", credits: 5 },
    ],
  },
  defaultProvider: null,
  encryptionKey: KEY,
  endpoints: { allowed: [], allowLocal: false },
};

const secret = { ciphertext: "x", iv: "y", hint: "abcd" };
function project(changes: Partial<AiSettingsRecord> = {}): AiSettingsRecord {
  return { _id: "s1", projectId: "p1", enabled: true, mode: "managed", epoch: 1, updatedAt: 0, updatedBy: "owner", ...changes };
}
function personal(changes: Partial<PersonalAiSettingsRecord> = {}): PersonalAiSettingsRecord {
  return { _id: "y1", userId: "u1", enabled: true, mode: "own", provider: "anthropic", model: "claude-test", secret, epoch: 1, updatedAt: 0, ...changes };
}

/** A person's request under `rule`, with personal settings ready, absent, or present but not ready. */
function ask(rule: AiSettingsRecord["rule"], mine: "ready" | "absent" | "not-ready" | "off", extra: Partial<ConnectionRequest> = {}, on: AiDeployment = deployment): ConnectionChoice {
  const settings = mine === "ready" ? personal() : mine === "absent" ? null : mine === "off" ? personal({ enabled: false }) : personal({ secret: undefined });
  return chooseConnection({ projectId: "p1", project: project(rule === undefined ? {} : { rule }), person: { userId: "u1", settings }, ...extra }, on);
}

const summary = (choice: ConnectionChoice) => (choice.ok ? { source: choice.source, payer: choice.payer } : { refused: choice.code });

describe("chooseConnection", () => {
  const cases: [AiSettingsRecord["rule"], "ready" | "absent" | "not-ready" | "off", ReturnType<typeof summary>][] = [
    // Project pays: always the project's connection.
    ["project", "ready", { source: "project", payer: "project" }],
    ["project", "absent", { source: "project", payer: "project" }],
    ["project", "not-ready", { source: "project", payer: "project" }],
    // Each person pays: the person's connection; one who saved nothing has Critiqs AI on their own plan.
    ["personal", "ready", { source: "personal", payer: "none" }],
    ["personal", "absent", { source: "personal", payer: "person" }],
    ["personal", "not-ready", { refused: "setup-ai" }],
    ["personal", "off", { refused: "setup-ai" }],
    // Project pays, personal allowed: the person's when ready, otherwise the project's.
    ["either", "ready", { source: "personal", payer: "none" }],
    ["either", "absent", { source: "project", payer: "project" }],
    ["either", "not-ready", { source: "project", payer: "project" }],
    ["either", "off", { source: "project", payer: "project" }],
    // No rule saved (older settings) means `either`.
    [undefined, "ready", { source: "personal", payer: "none" }],
    [undefined, "absent", { source: "project", payer: "project" }],
  ];
  for (const [rule, mine, expected] of cases) {
    test(`rule ${rule ?? "absent"}, personal settings ${mine}`, () => {
      expect(summary(ask(rule, mine))).toEqual(expected);
    });
  }

  test("background work uses the project's connection under every rule, and none without one", () => {
    for (const rule of ["project", "personal", "either"] as const) {
      const choice = chooseConnection({ projectId: "p1", project: project({ rule }), person: null }, deployment);
      expect(summary(choice)).toEqual({ source: "project", payer: "project" });
    }
    const none = chooseConnection({ projectId: "p1", project: project({ rule: "personal", enabled: false }), person: null }, deployment);
    expect(none).toMatchObject({ ok: false, code: "unavailable", reason: "AI is turned off for this project." });
    expect(chooseConnection({ projectId: "p1", project: null, person: null }, { ...deployment, managed: null })).toMatchObject({ ok: false, code: "unavailable" });
  });

  test("the refusal asks the person to set up their AI, saying what's missing only for a connection they turned on", () => {
    expect(ask("personal", "absent", {}, { ...deployment, managed: null })).toEqual({ ok: false, code: "setup-ai", reason: SETUP_AI });
    expect(ask("personal", "off")).toEqual({ ok: false, code: "setup-ai", reason: SETUP_AI });
    expect(ask("personal", "not-ready")).toEqual({ ok: false, code: "setup-ai", reason: `${SETUP_AI} Add the provider's API key in Your AI.` });
  });

  test("a project whose AI is turned off keeps people's own connections out too", () => {
    const choice = chooseConnection({ projectId: "p1", project: project({ enabled: false }), person: { userId: "u1", settings: personal() } }, deployment);
    expect(choice).toMatchObject({ ok: false, code: "unavailable", reason: "AI is turned off for this project." });
  });

  test("Critiqs AI is paid by whoever's connection it is, costing the model's credits", () => {
    expect(ask("project", "absent")).toMatchObject({ ok: true, payer: "project", model: "fast-model", managedModel: { id: "fast", label: "Fast", credits: 1 }, credits: 1 });
    const mine = chooseConnection(
      { projectId: "p1", project: project(), person: { userId: "u1", settings: personal({ mode: "managed", managedModel: "strong", provider: undefined, secret: undefined }) } },
      deployment,
    );
    expect(mine).toMatchObject({ ok: true, source: "personal", ownerId: "u1", payer: "person", model: "strong-model", credits: 5 });
    expect(ask("either", "ready")).toMatchObject({ ok: true, payer: "none", credits: 0, managedModel: null });
    // A person who saved nothing pays for their own Critiqs AI only where each person pays.
    expect(ask("personal", "absent")).toMatchObject({ ok: true, source: "personal", payer: "person", model: "fast-model", credits: 1 });
    expect(ask("either", "absent")).toMatchObject({ ok: true, source: "project", payer: "project" });
  });

  test("a person who saved nothing sees Critiqs AI on, where the deployment offers it", () => {
    expect(personalSettingsView(null, deployment)).toMatchObject({ saved: false, enabled: true, mode: "managed", status: { ready: true } });
    expect(personalSettingsView(null, { ...deployment, managed: null })).toMatchObject({ saved: false, enabled: false, mode: "own", status: { ready: false, reason: SETUP_AI } });
  });
});

describe("naming a model", () => {
  test("an own connection offers its picked models; anything else is refused, never replaced", () => {
    const settings = personal({ models: ["claude-test", "claude-big"] });
    const request = (model: string) => chooseConnection({ projectId: "p1", project: project(), person: { userId: "u1", settings }, model }, deployment);
    expect(request("claude-big")).toMatchObject({ ok: true, source: "personal", model: "claude-big" });
    expect(request("gpt-5")).toMatchObject({ ok: false, code: "invalid" });
    // A connection without picked models offers only its default.
    expect(connectionOf("personal", "u1", personal(), deployment, "claude-big")).toMatchObject({ ok: false, code: "invalid" });
    expect(connectionOf("personal", "u1", personal(), deployment, "claude-test")).toMatchObject({ ok: true, model: "claude-test" });
  });

  test("the project's Critiqs AI may use only the models its owner allows; a person's own Critiqs AI isn't limited", () => {
    const limited = project({ allowedModels: ["fast"] });
    const request = (model: string, settings: PersonalAiSettingsRecord | null = null) =>
      chooseConnection({ projectId: "p1", project: limited, person: { userId: "u1", settings }, model }, deployment);
    expect(request("fast")).toMatchObject({ ok: true, credits: 1 });
    expect(request("strong")).toMatchObject({ ok: false, code: "invalid", reason: expect.stringContaining("doesn't allow Strong") });
    expect(request("unknown")).toMatchObject({ ok: false, code: "invalid", reason: "Critiqs AI doesn't offer that model." });
    const mine = personal({ mode: "managed", provider: undefined, secret: undefined });
    expect(request("strong", mine)).toMatchObject({ ok: true, source: "personal", payer: "person", credits: 5 });
  });

  test("a default the project no longer allows falls to its first allowed model", () => {
    const choice = chooseConnection({ projectId: "p1", project: project({ managedModel: "fast", allowedModels: ["strong"] }), person: null }, deployment);
    expect(choice).toMatchObject({ ok: true, model: "strong-model", credits: 5 });
    const gone = chooseConnection({ projectId: "p1", project: project({ managedModel: "retired" }), person: null }, deployment);
    expect(gone).toMatchObject({ ok: false, code: "unavailable", reason: expect.stringContaining("no longer offered") });
  });
});

describe("Critiqs AI models from the deployment", () => {
  const base = { CRITIQS_MANAGED_AI: "enabled", CRITIQS_MANAGED_AI_PROVIDER: "openai", CRITIQS_MANAGED_AI_API_KEY: "managed-key" };

  test("a list of models shares the provider, key, and address", () => {
    const models = JSON.stringify([
      { id: "fast", label: "Fast", model: "gpt-fast", credits: 1 },
      { id: "strong", label: "Strong", model: "gpt-strong", credits: 4 },
    ]);
    const config = aiDeploymentFromEnv({ ...base, CRITIQS_MANAGED_AI_MODELS: models, CRITIQS_MANAGED_AI_BASE_URL: "https://ai.example/v1" });
    expect(config.managed).toEqual({
      provider: "openai",
      apiKey: "managed-key",
      baseUrl: "https://ai.example/v1",
      models: [
        { id: "fast", label: "Fast", model: "gpt-fast", credits: 1 },
        { id: "strong", label: "Strong", model: "gpt-strong", credits: 4 },
      ],
    });
    expect(config.managedProblem).toBeNull();
  });

  test("without a list, the single model is Critiqs AI, costing 1 credit", () => {
    const config = aiDeploymentFromEnv({ ...base, CRITIQS_MANAGED_AI_MODEL: "gpt-one" });
    expect(config.managed?.models).toEqual([{ id: "default", label: "Critiqs AI", model: "gpt-one", credits: 1 }]);
    expect(aiDeploymentFromEnv({ CRITIQS_MANAGED_AI_MODEL: "gpt-one" }).managed).toBeNull();
  });

  test("a bad list turns Critiqs AI off and says why, without naming the key", () => {
    for (const [raw, problem] of [
      ["not json", "isn't valid JSON"],
      ["[]", "list of 1 to 20"],
      ['[{"id":"a","label":"A","model":"m","credits":0}]', "credits must be a whole number"],
      ['[{"id":"a","label":"A","model":"m","credits":1.5}]', "credits must be a whole number"],
      ['[{"id":"a","label":"A","model":"m","credits":1},{"id":"a","label":"B","model":"n","credits":1}]', 'repeats "a"'],
      ['[{"id":"a","label":"A","model":"m","credit":1}]', "unexpected credit"],
      ['[{"id":"a b","label":"A","model":"m","credits":1}]', ".id must be"],
    ] as const) {
      const config = aiDeploymentFromEnv({ ...base, CRITIQS_MANAGED_AI_MODEL: "fallback", CRITIQS_MANAGED_AI_MODELS: raw });
      expect(config.managed).toBeNull();
      expect(config.managedProblem).toContain(problem);
      expect(config.managedProblem).not.toContain("managed-key");
    }
    expect(aiDeploymentFromEnv({ ...base, CRITIQS_MANAGED_AI_API_KEY: "" }).managedProblem).toContain("CRITIQS_MANAGED_AI_API_KEY");
    expect(typeof parseManagedModels('[{"id":"x","label":"X","model":"m","credits":1}]')).toBe("object");
  });

  test("a priced model shows about what a request of 2,000 input and 1,000 output tokens costs, at 200 credits a dollar", () => {
    const models = JSON.stringify([
      { id: "opus", label: "Claude Opus 5.5", model: "anthropic/claude-opus-5.5", price: { input: 4, output: 20 } },
      { id: "haiku", label: "Claude Haiku 5.5", model: "anthropic/claude-haiku-5.5", price: { input: 0.1, output: 0.5 } },
      { id: "neon", label: "Gemini 4 Neon", model: "google/gemini-4-neon", price: { input: 3, output: 15 } },
      { id: "sol", label: "GPT-6.2 Sol", model: "openai/gpt-6.2-sol", price: { input: 2, output: 10 } },
      { id: "flat", label: "Flat", model: "flat-model", credits: 2 },
    ]);
    const config = aiDeploymentFromEnv({ ...base, CRITIQS_MANAGED_AI_MODELS: models });
    // $0.028 → 5.6, $0.0007 → 0.14 (at least 1), $0.021 → 4.2, $0.014 → 2.8, each rounded up.
    expect(managedModelList(config)).toEqual([
      { id: "opus", label: "Claude Opus 5.5", credits: 6, estimated: true },
      { id: "haiku", label: "Claude Haiku 5.5", credits: 1, estimated: true },
      { id: "neon", label: "Gemini 4 Neon", credits: 5, estimated: true },
      { id: "sol", label: "GPT-6.2 Sol", credits: 3, estimated: true },
      { id: "flat", label: "Flat", credits: 2 },
    ]);
    const single = aiDeploymentFromEnv({ ...base, CRITIQS_MANAGED_AI_MODEL: "gpt-one", CRITIQS_MANAGED_AI_PRICE: '{"input":2,"output":10}' });
    expect(single.managed?.models).toEqual([{ id: "default", label: "Critiqs AI", model: "gpt-one", credits: 3, estimated: true, price: { input: 2, output: 10 } }]);
  });

  test("a bad price turns Critiqs AI off and says why", () => {
    for (const [raw, problem] of [
      ['[{"id":"a","label":"A","model":"m","credits":1,"price":{"input":1,"output":1}}]', "has both credits and price"],
      ['[{"id":"a","label":"A","model":"m","price":{"input":1}}]', '.price must be { "input", "output" }'],
      ['[{"id":"a","label":"A","model":"m","price":{"input":-1,"output":1}}]', ".price must be"],
      ['[{"id":"a","label":"A","model":"m","price":{"input":"4","output":20}}]', ".price must be"],
      ['[{"id":"a","label":"A","model":"m","price":{"input":4,"output":20000}}]', "each from 0 to 1000"],
      ['[{"id":"a","label":"A","model":"m","price":{"input":4,"output":20,"cached":1}}]', ".price must be"],
      ['[{"id":"a","label":"A","model":"m"}]', "credits must be a whole number"],
    ] as const) {
      const config = aiDeploymentFromEnv({ ...base, CRITIQS_MANAGED_AI_MODELS: raw });
      expect(config.managed).toBeNull();
      expect(config.managedProblem).toContain(problem);
    }
    for (const [raw, problem] of [
      ["4/20", "CRITIQS_MANAGED_AI_PRICE isn't valid JSON."],
      ['{"input":4}', "CRITIQS_MANAGED_AI_PRICE must be"],
    ] as const) {
      expect(aiDeploymentFromEnv({ ...base, CRITIQS_MANAGED_AI_MODEL: "gpt-one", CRITIQS_MANAGED_AI_PRICE: raw }).managedProblem).toContain(problem);
    }
  });
});

describe("what a Critiqs AI request costs", () => {
  const chosen = (price: { input: number; output: number } | null, payer: "project" | "person" | "none" = "project") => ({ payer, ownerId: "p1", credits: 5, price });

  test("a priced model costs twice its API cost in cents, rounded up, at least 1 credit", () => {
    const opus = { input: 4, output: 20 };
    // 2,000 × $4 + 1,000 × $20 per million = $0.028 → 5.6 → 6.
    expect(chargeFor(chosen(opus), { inputTokens: 2_000, outputTokens: 1_000 })).toEqual({ payer: "project", ownerId: "p1", credits: 6 });
    // $0.07 exactly is 14 credits, not 15 from floating-point error.
    expect(chargeFor(chosen({ input: 0, output: 7 }), { inputTokens: 0, outputTokens: 10_000 })?.credits).toBe(14);
    expect(chargeFor(chosen(opus), { inputTokens: 10, outputTokens: 1 })?.credits).toBe(1);
    expect(chargeFor(chosen(opus), { inputTokens: 0, outputTokens: 0 })?.credits).toBe(1);
    // Larger requests scale: 50,000 in, 8,000 out of Opus is $0.36 → 72.
    expect(chargeFor(chosen(opus, "person"), { inputTokens: 50_000, outputTokens: 8_000 })).toEqual({ payer: "person", ownerId: "p1", credits: 72 });
  });

  test("the provider's reported cost wins over tokens at the configured price", () => {
    expect(chargeFor(chosen({ input: 4, output: 20 }), { inputTokens: 2_000, outputTokens: 1_000, costUsd: 0.01 })?.credits).toBe(2);
  });

  test("a model without a price keeps its flat credits, and an own key costs nothing", () => {
    expect(chargeFor(chosen(null), { inputTokens: 1_000_000, outputTokens: 1_000_000, costUsd: 50 })?.credits).toBe(5);
    expect(chargeFor({ ...chosen(null, "none"), credits: 0 }, { inputTokens: 2_000, outputTokens: 1_000 })).toBeNull();
  });

  test("a request holds the most it could cost: every byte of its text as an input token, plus 500 for framing, and its largest answer", () => {
    const request = { system: "", prompt: "é".repeat(1_000), schema: {}, maxOutputTokens: 1_000 };
    // 2,000 bytes of text and 2 of schema, plus 500: 2,502 × $4 + 1,000 × $20 per million = $0.030008 → 6.0016 → 7.
    expect(worstCaseCredits(chosen({ input: 4, output: 20 }), request)).toBe(7);
    expect(worstCaseCredits(chosen(null), { ...request, maxOutputTokens: 1_000_000 })).toBe(5);
  });
});

describe("keys bound to their owner", () => {
  test("a project's ciphertext doesn't decrypt as a person's own key, nor the other way", async () => {
    const forProject = await encryptSecret(KEY, keyBinding("project", "abc"), "sk-project-1234");
    const forPerson = await encryptSecret(KEY, keyBinding("personal", "abc"), "sk-person-5678");
    expect(await decryptSecret(KEY, keyBinding("project", "abc"), forProject)).toBe("sk-project-1234");
    expect(await decryptSecret(KEY, keyBinding("personal", "abc"), forProject)).toBeNull();
    expect(await decryptSecret(KEY, keyBinding("personal", "abc"), forPerson)).toBe("sk-person-5678");
    expect(await decryptSecret(KEY, keyBinding("project", "abc"), forPerson)).toBeNull();
    expect(await decryptSecret(KEY, keyBinding("personal", "another"), forPerson)).toBeNull();
    // Resolution decrypts with the chosen connection's owner.
    const mine = personal({ secret: forPerson, userId: "abc" });
    const chosen = connectionOf("personal", "abc", mine, deployment);
    if (!chosen.ok) throw new Error(chosen.reason);
    expect(await resolveConnection(chosen, deployment)).toMatchObject({ ready: true, apiKey: "sk-person-5678", model: "claude-test" });
    const copied = connectionOf("project", "abc", { ...project({ mode: "own", provider: "anthropic", model: "claude-test" }), secret: forPerson }, deployment);
    if (!copied.ok) throw new Error(copied.reason);
    expect(await resolveConnection(copied, deployment)).toMatchObject({ ready: false, reason: expect.stringContaining("Enter the key again") });
  });
});

describe("preparing settings", () => {
  const own = { enabled: true, mode: "own" as const, provider: "openai" as const, model: "gpt-a" };

  test("picked models always include the default, once each", async () => {
    expect((await prepareSettings({ ...own, models: ["gpt-b", "gpt-a", "gpt-b"] }, deployment)).models).toEqual(["gpt-a", "gpt-b"]);
    await expect(prepareSettings({ ...own, models: ["bad model"] }, deployment)).rejects.toThrow("each model's name");
  });

  test("Critiqs AI's fields are ignored for an own key, so stale ones a client sends back can't refuse a save", async () => {
    const prepared = await prepareSettings({ ...own, managedModel: "retired", allowedModels: ["retired"] }, deployment);
    expect("managedModel" in prepared || "allowedModels" in prepared).toBe(false);
  });

  test("the rule, Critiqs AI model, and allowed models must be ones on offer; leaving them out keeps the saved ones", async () => {
    const managed = { enabled: true, mode: "managed" as const };
    expect(await prepareSettings({ ...managed, rule: "personal", managedModel: "strong", allowedModels: ["strong", "fast", "strong"] }, deployment)).toMatchObject({
      rule: "personal",
      managedModel: "strong",
      allowedModels: ["strong", "fast"],
    });
    const omitted = await prepareSettings(managed, deployment);
    expect("rule" in omitted || "managedModel" in omitted || "allowedModels" in omitted || "models" in omitted).toBe(false);
    await expect(prepareSettings({ ...managed, rule: "nobody" as never }, deployment)).rejects.toThrow("Choose who pays");
    // Whether the deployment offers them is checked when saved, against the saved ones.
    const choose = async (input: Partial<AiSettingsInput>, saved: Parameters<typeof checkManagedChoice>[0] = null) =>
      checkManagedChoice(saved, await prepareSettings({ ...managed, ...input }, deployment), deployment);
    await expect(choose({ managedModel: "retired" })).rejects.toThrow("Critiqs AI models this deployment offers");
    await expect(choose({ allowedModels: ["retired"] })).rejects.toThrow("Critiqs AI models this deployment offers");
    // Sent back as saved, they aren't checked; with AI turned off, they aren't even read.
    const saved = { enabled: true, mode: "managed" as const, managedModel: "retired", allowedModels: ["retired", "fast"] };
    await choose({ managedModel: "retired", allowedModels: ["fast", "retired"], rule: "project" }, saved);
    expect(await prepareSettings({ ...managed, enabled: false, managedModel: "retired", allowedModels: ["retired"] }, deployment)).not.toContainKeys(["managedModel", "allowedModels"]);
  });
});

describe("status and requests agree", () => {
  test("when none of the project's allowed models is offered any more, its status isn't ready either", () => {
    // Saved while Retired was offered; the deployment has since dropped it.
    const settings = project({ allowedModels: ["retired"] });
    const reason = "None of the Critiqs AI models this project allows is offered any more. Its owner can choose others in AI settings.";
    expect(connectionStatus(settings, deployment)).toEqual({ ready: false, reason });
    expect(settingsView(settings, deployment).status).toEqual({ ready: false, reason });
    expect(chooseConnection({ projectId: "p1", project: settings, person: null }, deployment)).toMatchObject({ ok: false, reason });
  });

  test("a retired Critiqs AI model falls to the first allowed one in the deployment's order, and a request may still name another allowed model", () => {
    const settings = project({ managedModel: "retired", allowedModels: ["strong", "fast"] });
    const request = (model?: string) => chooseConnection({ projectId: "p1", project: settings, person: null, ...(model === undefined ? {} : { model }) }, deployment);
    expect(connectionStatus(settings, deployment)).toEqual({ ready: true });
    expect(request()).toMatchObject({ ok: true, model: "fast-model", credits: 1 });
    expect(request("strong")).toMatchObject({ ok: true, model: "strong-model", credits: 5 });
    // Without allowed models, a retired choice is refused by default, but a request naming an offered model is honored.
    const unlimited = project({ managedModel: "retired" });
    expect(connectionStatus(unlimited, deployment)).toMatchObject({ ready: false, reason: expect.stringContaining("no longer offered") });
    expect(chooseConnection({ projectId: "p1", project: unlimited, person: null, model: "strong" }, deployment)).toMatchObject({ ok: true, model: "strong-model" });
  });

  test("a person's connection that isn't ready is never used, whatever model the request names", () => {
    // Their saved Critiqs AI model retired: their settings say not ready.
    const mine = personal({ mode: "managed", managedModel: "retired", provider: undefined, secret: undefined });
    expect(connectionStatus(mine, deployment, "personal")).toMatchObject({ ready: false });
    const projectOwn = project({ mode: "own", provider: "openai", model: "gpt-5", models: ["gpt-5", "gpt-5-mini"], secret });
    const request = (rule: AiSettingsRecord["rule"], model?: string) =>
      chooseConnection({ projectId: "p1", project: { ...projectOwn, rule }, person: { userId: "u1", settings: mine }, ...(model === undefined ? {} : { model }) }, deployment);
    // Project pays, personal allowed: always the project's, so its models can be named.
    expect(request("either")).toMatchObject({ ok: true, source: "project", model: "gpt-5" });
    expect(request("either", "gpt-5-mini")).toMatchObject({ ok: true, source: "project", payer: "none", model: "gpt-5-mini" });
    // A Critiqs AI model is checked against the project's connection, never charged to the person.
    expect(request("either", "fast")).toMatchObject({ ok: false, code: "invalid" });
    // Each person pays: set up Your AI, whatever the model.
    for (const model of [undefined, "fast", "gpt-5"]) expect(request("personal", model)).toMatchObject({ ok: false, code: "setup-ai" });
    // A ready connection checks the named model against itself.
    const ready = personal({ mode: "managed", managedModel: "fast", provider: undefined, secret: undefined });
    const named = (model: string) => chooseConnection({ projectId: "p1", project: { ...projectOwn, rule: "either" }, person: { userId: "u1", settings: ready }, model }, deployment);
    expect(named("strong")).toMatchObject({ ok: true, source: "personal", payer: "person", credits: 5 });
    expect(named("gpt-5")).toMatchObject({ ok: false, code: "invalid" });
  });

  test("a project draft whose Critiqs AI model it wouldn't allow isn't tested or charged", async () => {
    const prepared = await prepareSettings({ enabled: true, mode: "managed", managedModel: "fast", allowedModels: ["strong"] }, deployment);
    const draft = await draftConnection("project", "p1", null, prepared, deployment);
    expect(draft).toEqual({ connection: { ready: false, reason: "Allow the project's Critiqs AI model, or choose one of the allowed models." }, chosen: null });
    const charged: unknown[] = [];
    const called: string[] = [];
    const result = await testConnection(
      {
        prepare: async () => ({ source: "project", ownerId: "p1", settings: null }),
        record: async () => undefined,
        reserve: async (payer, credits) => (charged.push({ payer, credits }), { ok: true, hold: "h" }),
        settle: async (hold, due) => void charged.push({ hold, due }),
        model: (connection) => {
          called.push(connection.model);
          throw new Error("No model expected");
        },
        deployment,
      },
      { enabled: true, mode: "managed", managedModel: "fast", allowedModels: ["strong"] },
    );
    expect(result).toEqual({ ok: false, code: "config", message: "Allow the project's Critiqs AI model, or choose one of the allowed models." });
    expect(charged).toEqual([]);
    expect(called).toEqual([]);
    // The same draft allowing its model is tested at its own model's cost.
    const allowed = await draftConnection("project", "p1", null, await prepareSettings({ enabled: true, mode: "managed", managedModel: "fast", allowedModels: ["fast"] }, deployment), deployment);
    expect(allowed.chosen).toMatchObject({ model: "fast-model", credits: 1 });
  });

  test("a project with no saved settings has AI on under rule either, so people's own AI works, and says when it has no connection of its own", () => {
    const bare: AiDeployment = { ...deployment, managed: null, defaultProvider: null };
    const view = settingsView(null, bare);
    expect(view).toMatchObject({ enabled: true, rule: "either", status: { ready: false, reason: "AI isn't set up for this project. Its owner can connect a provider in AI settings." } });
    expect(chooseConnection({ projectId: "p1", project: null, person: { userId: "u1", settings: personal() } }, bare)).toMatchObject({ ok: true, source: "personal" });
    expect(settingsView(null, deployment)).toMatchObject({ enabled: true, mode: "managed", status: { ready: true } });
    // A person's own AI is off until they save it.
    expect(personalSettingsView(null, bare)).toMatchObject({ enabled: false, saved: false });
  });
});

