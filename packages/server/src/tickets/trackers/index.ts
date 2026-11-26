import { isPrivateHost, type TicketDestination, type TicketRef, type TicketStatus, TRACKER_LIMITS } from "@critiqs/core";
import { CritiqsError } from "../../errors.ts";

// What Critiqs asks of each tracker. Each adapter calls one tracker's API with
// the person's own token, parses its answers where they arrive, and turns its
// refusals into CritiqsErrors people can act on.

/** A token to call a tracker with: from the tracker's sign-in, or a personal token the person pasted. Trackers send the two differently. */
export interface TrackerToken {
  method: "oauth" | "token";
  value: string;
}

/** Whom a token belongs to, as the tracker reports it. */
export interface TrackerIdentity {
  accountId: string;
  accountName: string;
  /** The account's email address, as the tracker reports it; null when it doesn't share one. Only checked, never stored. */
  email: string | null;
  /** The workspace, organization, or Jira site the account is in, where the tracker has one. */
  site: { id: string; name: string } | null;
}

declare const checked: unique symbol;
/** A `fetch` made by `trackerEndpoint`, which enforces its limits on every request. */
export type TrackerFetch = typeof fetch & { readonly [checked]: true };

/**
 * Where an adapter sends its requests: the tracker's API, or a local stand-in
 * in tests. Adapters call trackers only through its `fetch`, never another.
 */
export interface TrackerEndpoint {
  fetch: TrackerFetch;
  /** The tracker's API, without a trailing slash. */
  baseUrl: string;
}

/** How an endpoint is set up: the operator's or a test's address and fetch, and, for tests, a shorter wait. */
export interface TrackerEndpointOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

/** How long Critiqs waits for a tracker's whole answer. */
export const TRACKER_TIMEOUT_MS = 15_000;
/** The most of one answer Critiqs reads from a tracker. */
export const MAX_TRACKER_ANSWER_BYTES = 2 * 1024 * 1024;

/**
 * The endpoint an adapter calls a tracker through. Its `fetch` sends a
 * request only to the tracker's own address (`baseUrl`, which the operator
 * sets) or to a public HTTPS address (such as an upload address the tracker
 * signs), never to this computer or a private network; never follows a
 * redirect; gives up after `TRACKER_TIMEOUT_MS`; and reads at most
 * `MAX_TRACKER_ANSWER_BYTES` of an answer. Any of these throws, as a request
 * that got no answer does.
 */
export function trackerEndpoint(options: TrackerEndpointOptions, defaultBaseUrl: string): TrackerEndpoint {
  const baseUrl = (options.baseUrl ?? defaultBaseUrl).replace(/\/$/, "");
  const send = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? TRACKER_TIMEOUT_MS;
  const base = new URL(baseUrl);
  const checkedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!trackerMayCall(url, base)) throw new Error("A tracker named an address Critiqs doesn't call.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("The tracker didn't answer in time.")), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    const outer = init?.signal;
    if (outer) {
      if (outer.aborted) controller.abort(outer.reason);
      else outer.addEventListener("abort", () => controller.abort(outer.reason), { once: true });
    }
    try {
      const response = await send(input, { ...init, redirect: "manual", signal: controller.signal });
      if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("The tracker answered with a redirect, which Critiqs doesn't follow.");
      }
      const body = await boundedBytes(response, MAX_TRACKER_ANSWER_BYTES);
      // Statuses that can't carry a body (No Content, say) get none.
      const empty = response.status === 204 || response.status === 205 || response.status === 304;
      return new Response(empty ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } finally {
      clearTimeout(timer);
    }
  };
  return { fetch: checkedFetch as TrackerFetch, baseUrl };
}

/** Whether a tracker's endpoint may send a request to `url`: the tracker's own address, or a public HTTPS one. */
function trackerMayCall(url: URL, base: URL): boolean {
  if (url.username !== "" || url.password !== "") return false;
  if (url.origin === base.origin) return true;
  return url.protocol === "https:" && !isPrivateHost(url.hostname);
}

/** An answer's body, refused past `max` bytes without reading the rest. */
async function boundedBytes(response: Response, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get("Content-Length") ?? Number.NaN);
  if (declared > max) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("The tracker's answer is too large.");
  }
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error("The tracker's answer is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// What adapters answer, checked for every adapter: Critiqs keeps no ID, key,
// or address longer than TRACKER_LIMITS and cuts names, titles, and status
// labels to theirs. Adapters parse their tracker's answers; `checkedAdapter`
// holds every adapter to these limits, whatever its parser misses.

/** A tracker's ID or key, or null when it is empty or longer than `max`. */
export function trackerId(value: unknown, max: number = TRACKER_LIMITS.id): string | null {
  return typeof value === "string" && value.trim() !== "" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

/** Text a tracker sent, on one line, cut to `max` characters. */
export function trackerText(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const checkedAdapters = new WeakSet<object>();

/** Whether an adapter's answers are checked: every adapter a tracker's factory makes is. */
export function isCheckedAdapter(adapter: object): boolean {
  return checkedAdapters.has(adapter);
}

const refused = (what: string) => new CritiqsError("unavailable", `The tracker's answer wasn't what Critiqs expected (${what}). Try again in a moment.`);

function checkedIdentity(identity: TrackerIdentity): TrackerIdentity {
  const accountId = trackerId(identity.accountId);
  if (accountId === null) throw refused("account ID");
  const siteId = identity.site === null ? null : trackerId(identity.site.id);
  return {
    accountId,
    accountName: trackerText(identity.accountName, TRACKER_LIMITS.name),
    email: identity.email !== null && identity.email.length <= 320 ? identity.email : null,
    site: identity.site === null || siteId === null ? null : { id: siteId, name: trackerText(identity.site.name, TRACKER_LIMITS.name) },
  };
}

/**
 * An adapter whose answers are held to Critiqs's limits, whatever its own
 * parsing missed. Each tracker's factory returns its adapter through this.
 */
export function checkedAdapter<T extends Partial<TrackerAdapter>>(adapter: T): T {
  const checked = { ...adapter };
  if (adapter.verify) {
    const verify = adapter.verify;
    checked.verify = async (token) => checkedIdentity(await verify(token));
  }
  checkedAdapters.add(checked);
  return checked;
}

/** One tracker's API, as Critiqs uses it. */
export interface TrackerAdapter {
  /** Who the token belongs to; refuses a token the tracker doesn't accept. */
  verify(token: TrackerToken): Promise<TrackerIdentity>;
  /** Where the person can create tickets: Linear teams, GitHub repositories, or Jira projects. */
  destinations(token: TrackerToken): Promise<TicketDestination[]>;
  /** Tickets the person can see, by key or words, optionally in one destination. */
  search(token: TrackerToken, query: string, destinationId?: string): Promise<(TicketRef & { status: TicketStatus })[]>;
  create(
    token: TrackerToken,
    input: { destinationId: string; title: string; body: string; labels: string[] },
  ): Promise<TicketRef & { status: TicketStatus; site: string | null }>;
  /** Adds a link back to the thread: a Linear attachment, a Jira remote link, or a GitHub comment. */
  linkBack(token: TrackerToken, ticket: TicketRef, link: { url: string; title: string }): Promise<void>;
  comment(token: TrackerToken, ticket: TicketRef, body: string): Promise<void>;
  status(token: TrackerToken, ticket: TicketRef): Promise<TicketStatus>;
  /** The destination's own ticket templates, where the tracker has them. */
  templates?(token: TrackerToken, destinationId: string): Promise<{ id: string; name: string; body: string }[]>;
}

/** Tokens from a tracker's sign-in: the access token, the refresh token when it issues one, and when the access token expires. */
export interface SignInTokens {
  access: string;
  refresh: string | null;
  expiresAt: number | null;
}
