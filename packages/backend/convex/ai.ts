"use node";

import type {
  AiModelListDraft,
  AiModelListResult,
  AiSettingsInput,
  AiSettingsView,
  AiTestResult,
  AiTicketDraft,
  PersonalAiSettingsInput,
  PersonalAiSettingsView,
  SearchResponse,
} from "@critiqs/core";
import {
  type CreditSteps,
  draftTicketWithAi,
  groupDueTags,
  keyBinding,
  listModels as listProviderModels,
  MOCKUP_AI,
  prepareSettings,
  type ResolvedConnection,
  runMockupTurn,
  runSearch,
  sealKey,
  testConnection,
  TICKET_AI,
} from "@critiqs/server";
import { createStructuredModel } from "@critiqs/server/ai-providers";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, action, internalAction } from "./_generated/server";
import { deployment } from "./lib/ai";
import { exportPages, ticketsDeployment, trackerToken } from "./lib/tickets";
import { trackerValidator } from "./lib/validators";
import { run } from "./lib/store";

// Critiqs's model calls: natural-language search with insights, saving and
// testing a project's AI connection or a person's own, automatic tag
// grouping, Critiqs AI's turns in mockup threads, and ticket drafts. They run in
// Convex's Node runtime, where the AI SDK and provider packages load; every
// read and write is a separate transaction, with authorization checked in
// each before any model call.

const model = (connection: Extract<ResolvedConnection, { ready: true }>) => createStructuredModel(connection);
const credits = (ctx: ActionCtx): CreditSteps => ({
  reserve: (payer, amount) => ctx.runMutation(internal.aiSettings.reserve, { ...payer, credits: amount }),
  settle: async (hold, charge) => void (await ctx.runMutation(internal.aiSettings.settle, { hold, charge })),
});

const scope = v.object({ status: v.union(v.literal("open"), v.literal("resolved"), v.literal("all")), screen: v.union(v.string(), v.null()) });
const provider = v.union(v.literal("openai"), v.literal("anthropic"), v.literal("google"), v.literal("openrouter"), v.literal("gateway"), v.literal("compatible"));
/** A provider to list models from before saving; its typed key is used for that request only. */
const modelListDraft = v.object({ provider, baseUrl: v.optional(v.union(v.string(), v.null())), apiKey: v.optional(v.string()) });
/** One connection's settings, a project's or a person's own. */
const connectionInput = {
  enabled: v.boolean(),
  mode: v.union(v.literal("managed"), v.literal("own")),
  managedModel: v.optional(v.union(v.string(), v.null())),
  provider: v.optional(v.union(v.null(), provider)),
  model: v.optional(v.union(v.string(), v.null())),
  models: v.optional(v.array(v.string())),
  baseUrl: v.optional(v.union(v.string(), v.null())),
  apiKey: v.optional(v.string()),
};
const settingsInput = {
  projectId: v.id("projects"),
  ...connectionInput,
  rule: v.optional(v.union(v.literal("project"), v.literal("personal"), v.literal("either"))),
  allowedModels: v.optional(v.array(v.string())),
};

/** Searches a project's feedback: AI interpretation and cited insights when the project has AI, basic search otherwise. */
export const search = action({
  args: { projectId: v.id("projects"), question: v.string(), scope },
  handler: async (ctx, args): Promise<SearchResponse> =>
    run(() =>
      runSearch({
        prepare: () => ctx.runMutation(internal.search.prepare, args),
        authorize: async () => void (await ctx.runQuery(internal.search.authorize, { projectId: args.projectId })),
        retrieve: (query, groups) => ctx.runQuery(internal.search.retrieve, { projectId: args.projectId, query, groups }),
        finalize: (response) => ctx.runQuery(internal.search.finalize, { projectId: args.projectId, response }),
        ...credits(ctx),
        model,
        deployment: deployment(),
        now: Date.now(),
      }),
    ),
});

/**
 * Critiqs AI's turn in a mockup thread, after the reviewer's message: the
 * component describes each page copy it asks about (`describePage`). Saves
 * the reply and, when it changed anything, a new version. `remaining` asks
 * the component to call again with `continuation` for the rest of the page.
 * `model` names one of the chosen connection's models; without it, its default.
 */
export const mockupReply = action({
  args: {
    threadId: v.id("threads"),
    snapshots: v.array(v.object({ snapshotId: v.id("mockupSnapshots"), description: v.string(), complete: v.boolean() })),
    continuation: v.boolean(),
    model: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ messageId: Id<"messages">; version: number | null; remaining: boolean }> =>
    run(async () => {
      const result = await runMockupTurn({
        prepare: () => ctx.runMutation(internal.mockups.prepareAi, args),
        authorize: async () => void (await ctx.runQuery(internal.mockups.recheckAi, { threadId: args.threadId })),
        finalize: (answer, head) => ctx.runMutation(internal.mockups.finishAi, { threadId: args.threadId, head, answer }),
        ...credits(ctx),
        model: (connection) => createStructuredModel(connection, { timeoutMs: MOCKUP_AI.timeoutMs }),
        deployment: deployment(),
      });
      return { ...result, messageId: result.messageId as Id<"messages"> };
    }),
});

/**
 * A ticket's title and text drafted by Critiqs AI from the thread, in the
 * template the person chose, if any, for them to edit in the Create dialog.
 * When Critiqs AI can't draft it (AI off, out of credits, the provider
 * failed), the draft is filled without AI and says why.
 */
export const draftTicket = action({
  args: {
    threadId: v.id("threads"),
    tracker: trackerValidator,
    destinationId: v.string(),
    templateId: v.union(v.string(), v.null()),
    model: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<AiTicketDraft> =>
    run(() =>
      draftTicketWithAi(
        {
          prepare: () => ctx.runMutation(internal.tickets.prepareAiDraft, args),
          token: (person) => trackerToken(ctx, person, args.tracker),
          loadPage: exportPages(ctx),
          ...credits(ctx),
          model: (connection) => createStructuredModel(connection, { timeoutMs: TICKET_AI.timeoutMs }),
          ai: deployment(),
        },
        ticketsDeployment(),
        args,
      ),
    ),
});

/** Saves a project's AI settings. A new key is encrypted here and only its ciphertext is stored. */
export const saveSettings = action({
  args: settingsInput,
  handler: async (ctx, input): Promise<AiSettingsView> =>
    run(async () => {
      await ctx.runQuery(internal.aiSettings.requireOwner, { projectId: input.projectId });
      const config = deployment();
      const prepared = await sealKey(await prepareSettings(input as AiSettingsInput, config), keyBinding("project", input.projectId), config);
      return await ctx.runMutation(internal.aiSettings.apply, { projectId: input.projectId, prepared });
    }),
});

/** Tests the saved connection, or a draft before saving it. */
export const testSettings = action({
  args: { projectId: v.id("projects"), draft: v.optional(v.object(settingsInput)) },
  handler: async (ctx, { projectId, draft }): Promise<AiTestResult> =>
    run(() =>
      testConnection(
        {
          prepare: () => ctx.runMutation(internal.aiSettings.prepareTest, { projectId }),
          record: async (epoch, result) => void (await ctx.runMutation(internal.aiSettings.recordTest, { projectId, epoch, result })),
          recheck: async () => void (await ctx.runQuery(internal.aiSettings.recheckManager, { projectId })),
          ...credits(ctx),
          model,
          deployment: deployment(),
        },
        draft === undefined ? undefined : ({ ...draft, projectId } as AiSettingsInput),
      ),
    ),
});

/** Saves the signed-in person's own AI settings ("Your AI"). A new key is encrypted here, bound to the person, and only its ciphertext is stored. */
export const savePersonalSettings = action({
  args: connectionInput,
  handler: async (ctx, input): Promise<PersonalAiSettingsView> =>
    run(async () => {
      const { userId } = await ctx.runMutation(internal.aiSettings.requirePerson, {});
      const config = deployment();
      const prepared = await sealKey(await prepareSettings(input as PersonalAiSettingsInput, config), keyBinding("personal", userId), config);
      return await ctx.runMutation(internal.aiSettings.applyPersonal, { prepared });
    }),
});

/** Tests the signed-in person's own saved connection, or a draft before saving it. Critiqs AI tests count against their plan. */
export const testPersonalSettings = action({
  args: { draft: v.optional(v.object(connectionInput)) },
  handler: async (ctx, { draft }): Promise<AiTestResult> =>
    run(async () => {
      let userId = "";
      return await testConnection(
        {
          prepare: async () => {
            const prepared = await ctx.runMutation(internal.aiSettings.preparePersonalTest, {});
            userId = prepared.ownerId;
            return prepared;
          },
          record: async (epoch, result) => void (await ctx.runMutation(internal.aiSettings.recordPersonalTest, { userId, epoch, result })),
          ...credits(ctx),
          model,
          deployment: deployment(),
        },
        draft as PersonalAiSettingsInput | undefined,
      );
    }),
});

/** Lists the models the project's provider offers its key, saved or typed into a draft, for its owner. The typed key is never stored. */
export const listModels = action({
  args: { projectId: v.id("projects"), draft: v.optional(modelListDraft) },
  handler: async (ctx, { projectId, draft }): Promise<AiModelListResult> =>
    run(() =>
      listProviderModels(
        {
          prepare: () => ctx.runMutation(internal.aiSettings.prepareModelList, { projectId }),
          recheck: async () => void (await ctx.runQuery(internal.aiSettings.recheckManager, { projectId })),
          deployment: deployment(),
        },
        draft as AiModelListDraft | undefined,
      ),
    ),
});

/** Lists the models the signed-in person's own provider offers their key, saved or typed into a draft. The typed key is never stored. */
export const listPersonalModels = action({
  args: { draft: v.optional(modelListDraft) },
  handler: async (ctx, { draft }): Promise<AiModelListResult> =>
    run(() =>
      listProviderModels(
        { prepare: () => ctx.runMutation(internal.aiSettings.preparePersonalModelList, {}), deployment: deployment() },
        draft as AiModelListDraft | undefined,
      ),
    ),
});

/** Groups tags waiting for automatic grouping, a project at a time. Runs every minute. */
export const groupTags = internalAction({
  args: {},
  handler: async (ctx) => {
    await groupDueTags({
      claim: (claimToken) => ctx.runMutation(internal.grouping.claim, { claimToken }),
      apply: (claim, answer) =>
        ctx.runMutation(internal.grouping.apply, {
          claim,
          assignments: [...answer.assignments].map(([key, assignment]) => ({ key, ...assignment })),
        }),
      fail: async (claim, message) => void (await ctx.runMutation(internal.grouping.fail, { claim, message })),
      ...credits(ctx),
      model,
      deployment: deployment(),
    });
  },
});
