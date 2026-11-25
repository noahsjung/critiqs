// Tag groups, AI connections, natural-language search, and insights, as
// backends return them. See docs/technical-direction.md#tags-and-tag-groups.

/** How a tag came to be in its groups, or out of all of them. */
export type TagGrouping =
  /** Waiting for automatic grouping. */
  | "pending"
  /** Grouped, or left ungrouped, by the project's AI. */
  | "ai"
  /** Grouped by Critiqs's built-in starter groups, such as Copy & wording. */
  | "starter"
  /** Set by a person; automatic grouping never changes it. */
  | "human"
  /** Not grouped: AI is off or unconfigured, or grouping gave up. */
  | "none";

/** A tag used or offered in a project, for suggestions, filters, and groups. */
export interface TagInfo {
  key: string;
  /** The first spelling seen. */
  label: string;
  /** A project tag offered to everyone, such as Bug; otherwise a free tag someone used. */
  preset: boolean;
  /** When a thread last gained this tag; null for a preset nobody used yet. */
  lastUsedAt: number | null;
  /** Groups the tag belongs to; a tag may belong to several. */
  groupIds: string[];
  grouping: TagGrouping;
}

/** A shared group of tags, such as Copy & wording, that filters expand into its tags. */
export interface TagGroupInfo {
  _id: string;
  name: string;
  /** Who created it. */
  origin: "ai" | "human" | "starter";
}

export interface ProjectTags {
  tags: TagInfo[];
  groups: TagGroupInfo[];
  /** Whether the signed-in reviewer may organize groups: the project's owner. */
  canOrganize: boolean;
}

/** Providers a project or a person can connect as their own. */
export type AiProvider = "openai" | "anthropic" | "google" | "openrouter" | "gateway" | "compatible";

/**
 * Each provider: whether it needs a key, and its address: `optional` (the
 * provider's own unless an allowed one is entered), `required` (an
 * OpenAI-compatible endpoint), or `fixed` by Critiqs, as OpenRouter's is.
 */
export const AI_PROVIDERS: { id: AiProvider; label: string; needsKey: boolean; address: "optional" | "required" | "fixed" }[] = [
  { id: "openai", label: "OpenAI", needsKey: true, address: "optional" },
  { id: "anthropic", label: "Anthropic", needsKey: true, address: "optional" },
  { id: "google", label: "Google Gemini", needsKey: true, address: "optional" },
  { id: "openrouter", label: "OpenRouter", needsKey: true, address: "fixed" },
  { id: "gateway", label: "Vercel AI Gateway", needsKey: true, address: "optional" },
  { id: "compatible", label: "OpenAI-compatible endpoint", needsKey: false, address: "required" },
];

/** The providers every backend with AI settings accepts; newer backends list theirs in `deployment.providers`. */
export const BASE_AI_PROVIDERS: AiProvider[] = ["openai", "anthropic", "google", "gateway", "compatible"];

/** The two ways a project or a person connects to AI: Critiqs AI, or their own key. */
export type AiMode = "managed" | "own";

/**
 * Whose connection requests a person starts use, chosen by the project's
 * owner: `project` (the project pays), `personal` (each person pays), or
 * `either` (the person's connection when they have one, otherwise the
 * project's). Background work always uses the project's connection.
 */
export type AiRule = "project" | "personal" | "either";

/** A Critiqs AI model the deployment offers, such as Fast or Strong. Never names the provider or its key. */
export interface ManagedModelInfo {
  id: string;
  label: string;
  /** Critiqs AI credits one request with this model costs; with `estimated`, about what a typical request costs. */
  credits: number;
  /** Requests cost their real token use, so `credits` is an estimate. */
  estimated?: true;
}

/** One AI connection, a project's or a person's, as its owner sees it. Secrets never leave the server; only a hint does. */
export interface AiConnectionView {
  /** Whether this connection is used. */
  enabled: boolean;
  mode: AiMode;
  /** The Critiqs AI model's id; null means the deployment's first model. */
  managedModel: string | null;
  provider: AiProvider | null;
  /** The own key's default model. */
  model: string | null;
  /** The own key's models a request may use; `model` is always one of them. Empty without an own key. */
  models: string[];
  baseUrl: string | null;
  /** The saved key's last four characters, or null when none is saved. */
  keyHint: string | null;
  /** What this deployment offers. */
  deployment: {
    /** Critiqs-managed AI is configured on this deployment. */
    managed: boolean;
    /** The Critiqs AI models on offer, first is the default; empty without Critiqs AI. */
    managedModels: ManagedModelInfo[];
    /** A provider the deployment's operator configured, used by projects that save none. Always null for personal settings. */
    defaultProvider: { provider: AiProvider; model: string } | null;
    /** Keys entered here can be stored, encrypted; false until the operator sets an encryption key. */
    keysStorable: boolean;
    /** Custom endpoints this deployment allows, beyond each provider's own. */
    allowedEndpoints: string[];
    /** The providers this backend accepts. Absent from backends before OpenRouter, which accept `BASE_AI_PROVIDERS`. */
    providers?: AiProvider[];
  };
  /** Whether this connection is usable now, and if not, why. */
  status: { ready: true } | { ready: false; reason: string };
  lastTest: { ok: boolean; at: number; message: string } | null;
}

/**
 * A project's AI settings as its owner sees them. The usage rule and the
 * model fields come from backends whose configuration reports `personalAi`;
 * an older backend leaves them out and behaves as rule `either`.
 */
export interface AiSettingsView extends Omit<AiConnectionView, "managedModel" | "models" | "deployment"> {
  /** Whether automatic grouping and AI search run for this project. */
  enabled: boolean;
  managedModel?: string | null;
  models?: string[];
  deployment: Omit<AiConnectionView["deployment"], "managedModels"> & { managedModels?: ManagedModelInfo[] };
  /** Whose connection requests people start use. */
  rule?: AiRule;
  /** Critiqs AI model ids the project's connection may use; empty means all. */
  allowedModels?: string[];
}

/** The signed-in person's own AI connection, used in every project whose rule allows it. */
export interface PersonalAiSettingsView extends AiConnectionView {
  /** Whether the person has saved settings; false shows the defaults. */
  saved: boolean;
}

/** One connection's settings as submitted. Fields left out keep their saved values, so older clients change only what they know. */
export interface AiConnectionInput {
  enabled: boolean;
  mode: AiMode;
  /** A Critiqs AI model's id; null resets to the deployment's first model. */
  managedModel?: string | null;
  provider?: AiProvider | null;
  model?: string | null;
  /** Models picked for the own key; `model` is added when it isn't among them. */
  models?: string[];
  baseUrl?: string | null;
  /** A new key; omitted keeps the saved one, an empty string removes it. */
  apiKey?: string;
}

export interface AiSettingsInput extends AiConnectionInput {
  projectId: string;
  rule?: AiRule;
  /** Critiqs AI model ids the project's connection may use; empty allows all. */
  allowedModels?: string[];
}

export type PersonalAiSettingsInput = AiConnectionInput;

/** What a connection test found. Messages never include provider responses, which can echo keys. */
export type AiTestResult =
  | { ok: true; message: string }
  | { ok: false; code: "auth" | "model" | "capability" | "network" | "rate-limit" | "config" | "unknown"; message: string };

/**
 * Whose provider to list models from, before or after saving: the provider,
 * its address, and a key typed for this one request, which is never stored.
 * Without a typed key, the saved key is used when the provider and address
 * are the saved ones.
 */
export interface AiModelListDraft {
  provider: AiProvider;
  baseUrl?: string | null;
  apiKey?: string;
}

/** One model a provider lists: its id, as requests name it, and the provider's display name, when it gives one. */
export interface AiModelOption {
  id: string;
  label: string | null;
}

/**
 * A provider's model list, sorted by name (the display name, else the id), or
 * why it couldn't be read, with the same failure kinds as a connection test.
 * `truncated`: the provider listed more than Critiqs keeps, so only the first
 * in that order are here.
 */
export type AiModelListResult = { ok: true; models: AiModelOption[]; truncated: boolean } | Exclude<AiTestResult, { ok: true }>;

/**
 * Which connection the signed-in person's requests in a project use, as the
 * project's AI usage rule decides, and the models they may choose among.
 * Never a key, an address, or a Critiqs AI model's provider name.
 */
export interface AiChoiceView {
  /** The project's connection, the person's own, or none. */
  source: "project" | "personal" | null;
  /** Models a request may name: Critiqs AI models with their credits, or an own key's picked models. Empty without a connection. */
  models: { id: string; label: string; credits?: number; estimated?: true }[];
  /** The model a request uses when it names none; null without a connection. */
  defaultModel: string | null;
  /** Why there is no connection. */
  reason?: string;
  /** `setup-ai` when the person must set up Your AI first. */
  reasonCode?: "setup-ai";
}

/**
 * The Critiqs AI credits counted where the signed-in person's own Critiqs AI
 * counts, for the person only: their home organization's, against its plan,
 * or their own on the default plan when they belong to none. Null where the
 * deployment has no plans.
 */
export interface PersonalAiUsage {
  /** The plan's label, such as "Plus". */
  plan: string;
  /** The organization whose plan it is; absent for someone in none, and from older backends. */
  organizationId?: string;
  /**
   * One row per period the plan limits, in the plan's order; `max` 0 with no
   * overage means the plan doesn't include Critiqs AI. `overage` is as in
   * `ProjectUsage`.
   */
  rows: { period: "total" | "month" | "day"; used: number; max: number; overage?: { cap: number | null } }[];
  /** Where to upgrade the plan, when the deployment names a page. */
  upgradeUrl?: string;
}

/** The scope the sidebar already shows, which search keeps unless the question asks otherwise. */
export interface SearchScope {
  status: "open" | "resolved" | "all";
  /** The current screen, or null for all screens. */
  screen: string | null;
}

/** A question turned into filters. Shown with results so people can see what was searched. */
export interface SearchQuery {
  terms: string[];
  /** Tag keys. */
  tags: string[];
  groupIds: string[];
  status: "open" | "resolved" | "all";
  screen: string | null;
  /** Times in milliseconds, inclusive. */
  since: number | null;
  until: number | null;
}

export interface SearchResult {
  threadId: string;
  status: "open" | "resolved";
  screen: string;
  tags: string[];
  lastMessageAt: number;
  messageCount: number;
  preview: { body: string; authorName: string } | null;
  /** Messages whose text matched, with a short excerpt; empty when the thread matched by tag or filter only. */
  matches: { messageId: string; excerpt: string }[];
}

/** A finding supported by the threads it cites; every cited thread is one of the results. */
export interface Insight {
  title: string;
  detail: string;
  threadIds: string[];
}

export interface SearchResponse {
  /** `ai` when the project's AI interpreted the question; `basic` for word and tag matching. */
  mode: "ai" | "basic";
  /** Why AI wasn't used, when it wasn't. */
  notice: string | null;
  /** `setup-ai` when AI wasn't used because the searcher must set up Your AI first. Absent otherwise, and from older backends. */
  noticeCode?: "setup-ai";
  query: SearchQuery;
  results: SearchResult[];
  /** More threads matched than are shown. */
  truncated: boolean;
  insights: Insight[];
  /** Why there are no insights despite results, such as a provider error. */
  insightNotice: string | null;
}
