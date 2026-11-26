import { type SearchQuery, type SearchResponse, type SearchResult, type SearchScope, hashtagLabels, tagKey } from "@critiqs/core";
import { CritiqsError, fail } from "../errors.ts";
import { currentReviewer, requireProject, requireUser } from "../operations.ts";
import type { Identity, MessageRecord, Store, ThreadRecord } from "../store.ts";
import { MAX_GROUPS, threadTags } from "../tags.ts";
import { accessCheck, toAiError, type StructuredModel, type StructuredRequest } from "./model.ts";
import { fitCandidates, type InsightCandidate, insightsRequest, interpretRequest } from "./prompts.ts";
import { askPaid, type CreditSteps } from "./credits.ts";
import { type AiDeployment, type ChosenConnection, chooseConnection, type ResolvedConnection, resolveConnection } from "./settings.ts";

// Natural-language search over a project's feedback, with cited insights.
// No embeddings: the model of the connection the project's AI usage rule
// chooses for the searcher, when there is one, turns the question
// into words, tags, groups, status, dates, and screen; the backend then finds
// matching threads and replies with its own indexes, within fixed budgets.
// Without AI, or when the model fails, the same retrieval runs on the
// question's own words and #tags, labeled as basic search. Insights may cite
// only threads the search returned, and every thread is checked again for
// access and deletion just before the answer is returned. Mockup threads are
// never searched.

export const MAX_QUESTION = 500;
export const SEARCH_RESULTS = 50;
export const SEARCHES_PER_MINUTE = 20;
/** Messages and tagged threads each source reads at most. */
const MESSAGE_HITS = 120;
const TAG_HITS = 60;
const RECENT_THREADS = 100;
/** Threads one search loads at most, best evidence first. */
const CANDIDATE_THREADS = 200;
/** Tags one search looks up, after expanding groups; more make the results incomplete. */
const MAX_SEARCH_TAGS = 30;
/** Tags read to learn groups' members; a project with more may have groups only partly known. */
const GROUP_MEMBER_TAGS = 500;

const STOP_WORDS = new Set(
  "a an and any are as at be been but by can could did do does for from had has have how i in is it its me my of on or our show that the their them there these this those to us was we were what when where which who why will with would you your about all comments comment feedback find give list me threads thread".split(
    " ",
  ),
);

/** What search needs from the first step: who asks, the project's vocabulary, and whether AI may run. */
export interface SearchPlan {
  projectId: string;
  question: string;
  scope: SearchScope;
  tags: { key: string; label: string }[];
  groups: SearchGroup[];
  /** The connection chosen for the searcher, keys still encrypted; null when AI won't run. Server-side only. */
  connection: ChosenConnection | null;
  /** Why AI won't run, or null when it may. */
  aiUnavailable: string | null;
  /** `setup-ai` when AI won't run because the searcher must set up Your AI. */
  aiUnavailableCode?: "setup-ai";
}

/** A group's member tags, as search expands it. `partial` when not all its members could be read. */
export interface SearchGroup {
  id: string;
  name: string;
  tagKeys: string[];
  partial?: boolean;
}

/** Words and #tags from the question itself, for basic search. */
export function basicQuery(question: string, scope: SearchScope): SearchQuery {
  const tags = hashtagLabels(question).map(tagKey);
  const words = question
    .replace(/(^|[\s\p{Ps}\p{Pi}])#[\p{L}][\p{L}\p{N}\p{M}_-]*/gu, " ")
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  const terms = [...new Set(words.filter((word) => word.length >= 2 && !STOP_WORDS.has(word)))].slice(0, 8);
  return { terms, tags, groupIds: [], status: scope.status, screen: scope.screen, since: null, until: null };
}

/**
 * Checks the reviewer may search the project, counts the search against the
 * reviewer's per-minute limit, and gathers what interpreting it needs. One transaction.
 */
export async function prepareSearch(
  store: Store,
  identity: Identity | null,
  args: { projectId: string; question: string; scope: SearchScope },
  deployment: AiDeployment,
  now: number,
): Promise<SearchPlan> {
  const user = await requireUser(store, identity);
  const project = await requireProject(store, user, args.projectId);
  const question = args.question.trim();
  if (question === "") fail("invalid", "Type what to look for.");
  if (question.length > MAX_QUESTION) fail("invalid", `Searches are limited to ${MAX_QUESTION} characters.`);
  if (!(await store.rateLimits.hit(`search:${user._id}`, SEARCHES_PER_MINUTE, 60_000, now))) {
    fail("limit", "That's a lot of searches in a minute. Wait a moment and try again.");
  }
  const choice = chooseConnection(
    {
      projectId: project._id,
      project: await store.aiSettings.find(project._id),
      person: { userId: user._id, settings: await store.personalAiSettings.find(user._id) },
    },
    deployment,
  );
  const tags = await store.tags.list(project._id, 150);
  const groups = await store.tagGroups.list(project._id, MAX_GROUPS);
  const allTags = await store.tags.list(project._id, GROUP_MEMBER_TAGS);
  const partial = allTags.length >= GROUP_MEMBER_TAGS;
  return {
    projectId: project._id,
    question,
    scope: args.scope,
    tags: tags.map((tag) => ({ key: tag.key, label: tag.label })),
    groups: groups.map((group) => ({
      id: group._id,
      name: group.name,
      tagKeys: allTags.filter((tag) => tag.groupIds.includes(group._id)).map((tag) => tag.key),
      ...(partial ? { partial } : {}),
    })),
    connection: choice.ok ? choice : null,
    aiUnavailable: choice.ok ? null : choice.reason,
    ...(!choice.ok && choice.code === "setup-ai" ? { aiUnavailableCode: "setup-ai" as const } : {}),
  };
}

/** What retrieval found: results to show, and the text insights may draw on. */
export interface Retrieved {
  query: SearchQuery;
  results: SearchResult[];
  truncated: boolean;
  candidates: InsightCandidate[];
}

function excerpt(body: string, terms: string[]): string {
  const lower = body.toLowerCase();
  const at = terms.map((term) => lower.indexOf(term.toLowerCase())).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - 60);
  const text = body.slice(start, start + 160).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${text}${start + 160 < body.length ? "…" : ""}`;
}

/**
 * Finds threads matching a query, using the backend's message search and
 * thread-tag records, within fixed budgets. Deleted threads and other
 * projects never appear. One transaction (a query).
 */
export async function retrieveSearch(
  store: Store,
  identity: Identity | null,
  args: { projectId: string; query: SearchQuery; groups: Pick<SearchGroup, "id" | "tagKeys" | "partial">[] },
): Promise<Retrieved> {
  const { user } = await currentReviewer(store, identity);
  const project = await requireProject(store, user, args.projectId);
  const { query } = args;
  let truncated = false;
  const matched = new Map<string, MessageRecord[]>();
  if (query.terms.length > 0) {
    const hits = await store.messages.search(project._id, query.terms, MESSAGE_HITS);
    if (hits.length >= MESSAGE_HITS) truncated = true;
    for (const message of hits) {
      if (message.projectId !== undefined && message.projectId !== project._id) continue;
      matched.set(message.threadId, [...(matched.get(message.threadId) ?? []), message]);
    }
  }
  const tagKeys = new Set(query.tags);
  for (const groupId of query.groupIds) {
    const group = args.groups.find((entry) => entry.id === groupId);
    if (group?.partial) truncated = true;
    for (const key of group?.tagKeys ?? []) tagKeys.add(key);
  }
  // Looking up only some of the tags asked for leaves results out.
  if (tagKeys.size > MAX_SEARCH_TAGS) truncated = true;
  const tagged = new Map<string, number>();
  for (const key of [...tagKeys].slice(0, MAX_SEARCH_TAGS)) {
    const rows = await store.threadTags.byKey(project._id, key, TAG_HITS);
    if (rows.length >= TAG_HITS) truncated = true;
    for (const row of rows) tagged.set(row.threadId, (tagged.get(row.threadId) ?? 0) + 1);
  }
  // Threads matching both words and tags first, then words, then tags.
  const ordered = [...new Set([...[...matched.keys()].filter((id) => tagged.has(id)), ...matched.keys(), ...tagged.keys()])];
  if (ordered.length > CANDIDATE_THREADS) truncated = true;
  const ids = ordered.slice(0, CANDIDATE_THREADS);
  const browsing = query.terms.length === 0 && tagKeys.size === 0;
  const threads: ThreadRecord[] = [];
  if (browsing) {
    const recent = await store.threads.recent(project._id, RECENT_THREADS);
    if (recent.length >= RECENT_THREADS) truncated = true;
    threads.push(...recent);
  } else {
    for (const id of ids) {
      const thread = await store.threads.get(id);
      if (thread !== null) threads.push(thread);
    }
  }
  const filtered = threads.filter((thread) => {
    if (thread.projectId !== project._id || thread.status === "deleted" || thread.mockup !== undefined) return false;
    // With words and tags both asked for, a thread matches either.
    if (query.status !== "all" && thread.status !== query.status) return false;
    const screen = thread.reattachment?.location.screen ?? thread.anchor.screen;
    if (query.screen !== null && screen.toLowerCase() !== query.screen.toLowerCase()) return false;
    if (query.since !== null && thread.lastMessageAt < query.since) return false;
    if (query.until !== null && thread.createdAt > query.until) return false;
    return true;
  });
  const score = (thread: ThreadRecord) => (matched.get(thread._id)?.length ?? 0) * 3 + (tagged.get(thread._id) ?? 0) * 2;
  filtered.sort((a, b) => score(b) - score(a) || b.lastMessageAt - a.lastMessageAt);
  if (filtered.length > SEARCH_RESULTS) truncated = true;
  const shown = filtered.slice(0, SEARCH_RESULTS);
  const results: SearchResult[] = [];
  const candidates: InsightCandidate[] = [];
  for (const thread of shown) {
    const first = await store.messages.first(thread._id);
    const author = first === null ? null : await store.users.get(first.authorId);
    const hits = (matched.get(thread._id) ?? []).slice(0, 3);
    const screen = thread.reattachment?.location.screen ?? thread.anchor.screen;
    const tags = threadTags(thread);
    results.push({
      threadId: thread._id,
      status: thread.status === "resolved" ? "resolved" : "open",
      screen,
      tags,
      lastMessageAt: thread.lastMessageAt,
      messageCount: thread.messageCount,
      preview: first === null ? null : { body: first.body, authorName: author?.name ?? "Unknown" },
      matches: hits.map((message) => ({ messageId: message._id, excerpt: excerpt(message.body, query.terms) })),
    });
    const messages = [first, ...hits.filter((hit) => hit._id !== first?._id)].filter((message) => message !== null);
    const named = [];
    for (const message of messages) named.push({ author: (await store.users.get(message.authorId))?.name ?? "Unknown", body: message.body });
    candidates.push({ threadId: thread._id, status: thread.status, screen, tags, messages: named });
  }
  return { query, results, truncated, candidates };
}

/**
 * Checks every result again just before answering: the reviewer still has
 * access, and each thread still exists in the project and isn't deleted.
 * Insights keep only citations of results still shown. One transaction.
 */
export async function finalizeSearch(store: Store, identity: Identity | null, args: { projectId: string; response: SearchResponse }): Promise<SearchResponse> {
  const { user } = await currentReviewer(store, identity);
  const project = await requireProject(store, user, args.projectId);
  const results: SearchResult[] = [];
  for (const result of args.response.results) {
    const id = store.normalizeId("threads", result.threadId);
    const thread = id === null ? null : await store.threads.get(id);
    if (thread === null || thread.projectId !== project._id || thread.status === "deleted" || thread.mockup !== undefined) continue;
    results.push({ ...result, status: thread.status === "resolved" ? "resolved" : "open", tags: threadTags(thread) });
  }
  const shown = new Set(results.map((result) => result.threadId));
  const insights = args.response.insights
    .map((insight) => ({ ...insight, threadIds: insight.threadIds.filter((id) => shown.has(id)) }))
    .filter((insight) => insight.threadIds.length > 0);
  return { ...args.response, results, insights };
}

/**
 * Checks the reviewer may still search the project, right before each
 * attempt to send a request to the model, retries included: access can end
 * while a search runs, even while its credits are held, and the request
 * carries the project's tags, groups, and feedback. One transaction.
 */
export async function authorizeSearch(store: Store, identity: Identity | null, args: { projectId: string }): Promise<void> {
  const { user } = await currentReviewer(store, identity);
  await requireProject(store, user, args.projectId);
}

/** What a search needs from its backend: each step its own transaction, and a model for a connection. */
export interface SearchSteps extends CreditSteps {
  prepare(): Promise<SearchPlan>;
  /** See `authorizeSearch`; throws when the reviewer may no longer search the project. Runs before each attempt to send a request to the model. */
  authorize(): Promise<void>;
  retrieve(query: SearchQuery, groups: SearchGroup[]): Promise<Retrieved>;
  finalize(response: SearchResponse): Promise<SearchResponse>;
  model(connection: Extract<ResolvedConnection, { ready: true }>): StructuredModel;
  deployment: AiDeployment;
  now: number;
}

function refusalOrAiError(error: unknown): string {
  // Refusals other than an exhausted allowance, such as lost access, end the search.
  if (error instanceof CritiqsError && error.code !== "limit") throw error;
  return error instanceof CritiqsError && error.code === "limit" ? error.message : toAiError(error).message;
}

/** Runs a search: interpret with AI when available, retrieve, summarize with citations, and check access again. */
export async function runSearch(steps: SearchSteps): Promise<SearchResponse> {
  const plan = await steps.prepare();
  const access = accessCheck(steps.authorize);
  const basic = basicQuery(plan.question, plan.scope);
  let notice = plan.aiUnavailable;
  let ask: (<T>(request: StructuredRequest<T>) => Promise<T>) | null = null;
  const chosen = plan.connection;
  if (notice === null && chosen !== null) {
    const connection = await resolveConnection(chosen, steps.deployment);
    if (connection.ready) {
      const model = steps.model(connection);
      ask = async (request) => (await askPaid(steps, chosen, model, { ...request, beforeSend: access.beforeSend })).output;
    } else notice = connection.reason;
  }
  let query = basic;
  let mode: SearchResponse["mode"] = "basic";
  if (ask !== null) {
    try {
      const answer = await ask(
        interpretRequest({ question: plan.question, tags: plan.tags, groups: plan.groups, today: new Date(steps.now).toISOString().slice(0, 10) }),
      );
      // A question only about status, dates, or screen needs no words; the
      // question's own words stand in only when the model found nothing at all.
      const understood =
        answer.terms.length > 0 ||
        answer.tags.length > 0 ||
        answer.groupIds.length > 0 ||
        answer.status !== null ||
        answer.screen !== null ||
        answer.since !== null ||
        answer.until !== null;
      query = {
        terms: understood ? answer.terms : basic.terms,
        // #tags typed in the question always count.
        tags: [...new Set([...basic.tags, ...answer.tags])],
        groupIds: answer.groupIds,
        status: answer.status ?? plan.scope.status,
        screen: answer.screen ?? plan.scope.screen,
        since: answer.since,
        until: answer.until,
      };
      mode = "ai";
    } catch (error) {
      // Lost access ends the search, whatever the model code made of it.
      access.rethrow();
      notice = refusalOrAiError(error);
      ask = null;
    }
  }
  const retrieved = await steps.retrieve(query, plan.groups);
  let insights: SearchResponse["insights"] = [];
  let insightNotice: string | null = null;
  if (ask !== null && retrieved.results.length > 0) {
    try {
      const answer = await ask(insightsRequest(plan.question, fitCandidates(retrieved.candidates)));
      insights = answer.findings;
      if (insights.length === 0) insightNotice = "The model found no finding it could support with these threads.";
    } catch (error) {
      access.rethrow();
      insightNotice = `No insights: ${refusalOrAiError(error)}`;
    }
  }
  return await steps.finalize({
    mode,
    notice: notice === null ? null : `AI unavailable: basic search. ${notice}`,
    ...(plan.aiUnavailableCode === undefined ? {} : { noticeCode: plan.aiUnavailableCode }),
    query: retrieved.query,
    results: retrieved.results,
    truncated: retrieved.truncated,
    insights,
    insightNotice,
  });
}
