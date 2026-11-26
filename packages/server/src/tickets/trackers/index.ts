import {
  isPrivateHost,
  type TicketDestination,
  type TicketLabel,
  type TicketMarkdown,
  type TicketRef,
  type TicketStatus,
  type TicketStatusCategory,
  TRACKER_LIMITS,
  type TrackerId,
  type TrackerTemplateGroup,
  type WebAddress,
  webAddress,
} from "@critiqs/core";
import { CritiqsError } from "../../errors.ts";
import { linearAdapter } from "./linear.ts";

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
 * signs), never to this computer or a private network, and sends the
 * person's token and cookies only to the tracker's own address; never follows a
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
    // The person's token and cookies go only to the tracker's own address, never to an address it names, such as an upload's.
    // A Request's own headers count, with those given in `init` on top, so none escapes the check below.
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    if (url.origin !== base.origin) for (const name of ["authorization", "proxy-authorization", "cookie"]) headers.delete(name);
    try {
      const response = await send(input, { ...init, headers, redirect: "manual", signal: controller.signal });
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

const CATEGORIES: readonly TicketStatusCategory[] = ["open", "started", "done", "canceled", "unknown"];

/** A status a tracker sent: its label cut, and a category Critiqs knows. */
export function checkedStatus(status: TicketStatus): TicketStatus {
  const label = trackerText(status.label, TRACKER_LIMITS.status);
  return { label: label === "" ? "Unknown" : label, category: CATEGORIES.includes(status.category) ? status.category : "unknown" };
}

/**
 * Each tracker's rule for where its tickets are: the address to keep for a
 * ticket the tracker answered with, or one Critiqs holds, when it is the
 * tracker's page for that ticket's key in its site; null when it isn't. Where
 * Critiqs can work the address out from the key and site (GitHub, Jira), it
 * must be that one; where it can't (Linear), it must be on the tracker's own
 * address and name the key.
 */
export type TicketPlace = (ticket: { key: string; site: string | null; url: string }, token: TrackerToken) => WebAddress | null;

/**
 * A ticket a tracker sent, held to Critiqs's limits: its ID within
 * `TRACKER_LIMITS.id`, its key and title cut, its status checked, its site's
 * ID kept only within the limit, and its address only where the tracker's
 * `place` says it is that ticket's page. Null when its ID, key, or address
 * can't be kept.
 */
function checkedTicket<T extends TicketRef & { status?: TicketStatus; site?: string | null }>(ticket: T, place: TicketPlace, token: TrackerToken): T | null {
  const externalId = trackerId(ticket.externalId);
  const key = trackerText(ticket.key, TRACKER_LIMITS.key);
  const site = ticket.site === undefined || ticket.site === null ? null : trackerId(ticket.site);
  if (externalId === null || key === "" || (ticket.site != null && site === null)) return null;
  const url = webAddress(ticket.url) === null ? null : place({ key, site, url: ticket.url }, token);
  if (url === null) return null;
  return {
    ...ticket,
    externalId,
    key,
    url,
    title: trackerText(ticket.title, TRACKER_LIMITS.title),
    ...(ticket.status === undefined ? {} : { status: checkedStatus(ticket.status) }),
    ...(ticket.site === undefined ? {} : { site }),
  };
}

/**
 * A ticket Critiqs holds, before anything is written to it: its address must
 * still be the tracker's page for its key in its site, so a write goes to the
 * ticket Critiqs linked, worked out from what Critiqs holds, never to an
 * address an answer named.
 */
function heldTicket(ticket: HeldTicket, place: TicketPlace, token: TrackerToken): HeldTicket {
  if (webAddress(ticket.url) === null || place({ key: ticket.key, site: ticket.site, url: ticket.url }, token) === null) {
    throw new TrackerRefusal("invalid", "Critiqs's record of this ticket doesn't match its tracker. Unlink it and link it again.");
  }
  return ticket;
}

function checkedDestination(destination: TicketDestination): TicketDestination | null {
  const id = trackerId(destination.id);
  if (id === null) return null;
  const key = destination.key === null ? "" : trackerText(destination.key, TRACKER_LIMITS.key);
  return { id, name: trackerText(destination.name, TRACKER_LIMITS.name), key: key === "" ? null : key };
}

/** A template or label a tracker sent: its ID checked, its name cut; null without a usable ID. */
function checkedChoice(choice: { id: string; name: string }): { id: string; name: string } | null {
  const id = trackerId(choice.id);
  return id === null ? null : { id, name: trackerText(choice.name, TRACKER_LIMITS.name) };
}

const some = <T>(items: (T | null)[]) => items.filter((item): item is T => item !== null).slice(0, TRACKER_LIMITS.list);

/**
 * An adapter whose answers are held to Critiqs's limits, whatever its own
 * parsing missed: IDs and addresses checked, names and labels cut, lists
 * capped. An answer about one ticket must be about the ticket asked for (its
 * `externalId`), and every ticket's address must be where the tracker's
 * `place` says that ticket is; a write goes only to a ticket Critiqs holds
 * whose address agrees with its key and site. Each tracker's factory returns
 * its adapter through this, and a test fails any that doesn't.
 */
export function checkedAdapter(adapter: UncheckedAdapter, place: TicketPlace): TrackerAdapter {
  const { verify, destinations, search, get, create, findCreated, linkBack, comment, status, uploadImage, ...rest } = adapter;
  const unreadable = (what: string) => refused(what);
  const checked: TrackerAdapter = {
    ...rest,
    verify: async (token) => checkedIdentity(await verify(token)),
    destinations: async (token) => some((await destinations(token)).map(checkedDestination)),
    search: async (token, query, destinationId) =>
      some((await search(token, query, destinationId)).map((found) => checkedTicket(found, place, token))).map(({ site: _site, ...ticket }) => ticket),
    get: async (token, externalId) => {
      const ticket = await get(token, externalId);
      // An answer about another ticket than the one asked for is never linked, or written to later.
      if (ticket.externalId !== externalId) throw unreadable("another ticket");
      return checkedTicket(ticket, place, token) ?? Promise.reject(unreadable("ticket"));
    },
    create: async (token, input) => {
      const outcome = await create(token, input);
      if (outcome.status !== "created") return outcome;
      const ticket = checkedTicket(outcome.ticket, place, token);
      // Made, but not a ticket Critiqs can keep: the next attempt finds it again.
      return ticket === null ? { status: "unknown", error: unreadable("ticket") } : { status: "created", ticket };
    },
    findCreated: async (token, created) => {
      const found = await findCreated(token, created);
      return found === null ? null : (checkedTicket(found, place, token) ?? Promise.reject(unreadable("ticket")));
    },
    linkBack: async (token, ticket, link) => await linkBack(token, heldTicket(ticket, place, token), link),
    comment: async (token, ticket, body) => await comment(token, heldTicket(ticket, place, token), body),
    status: async (token, ticket) => {
      const answer = await status(token, ticket);
      // Another ticket's status is never saved as this one's.
      if (answer.externalId !== ticket.externalId) throw unreadable("another ticket");
      return checkedStatus(answer.status);
    },
  };
  if (uploadImage) checked.uploadImage = async (token, image) => webAddress(await uploadImage(token, image)) ?? Promise.reject(unreadable("upload address"));
  const { templates, template, labels } = adapter;
  if (templates) {
    checked.templates = async (token, destinationId) =>
      some(
        (await templates(token, destinationId)).map((group) => {
          const destination = checkedDestination(group.destination);
          return destination === null ? null : { destination, templates: some(group.templates.map(checkedChoice)) };
        }),
      );
  }
  if (template) {
    checked.template = async (token, templateId) => {
      const found = await template(token, templateId);
      if (found === null) return null;
      const choice = checkedChoice(found);
      const destinationId = trackerId(found.destinationId);
      // A template's text longer than a ticket's couldn't make one.
      if (choice === null || destinationId === null || found.body.length > TRACKER_LIMITS.templateText) throw unreadable("template");
      return { ...choice, destinationId, body: found.body };
    };
  }
  if (labels) {
    checked.labels = async (token, destinationId) =>
      some(
        (await labels(token, destinationId)).map((label) => {
          const choice = checkedChoice(label);
          return choice === null ? null : { ...choice, exclusiveGroup: label.exclusiveGroup === null ? null : trackerId(label.exclusiveGroup) };
        }),
      );
  }
  checkedAdapters.add(checked);
  return checked;
}

/**
 * Where a tracker's pages are: its own web address, and the address Critiqs
 * calls its API at (`baseUrl`), which only the operator sets: the tracker's
 * API in production, a local stand-in in tests.
 */
export function trackerWebOrigins(endpoint: TrackerEndpointOptions, own: string): string[] {
  return [...new Set([new URL(own).origin, ...(endpoint.baseUrl === undefined ? [] : [new URL(endpoint.baseUrl).origin])])];
}

/** A ticket Critiqs holds: what it linked, with the site it is in, as status updates match it. Writes go by these, never by an address a tracker named. */
export interface HeldTicket extends TicketRef {
  site: string | null;
}

/** What an adapter answers before `checkedAdapter` checks it: a search's tickets with their sites, and a status with the ticket it was read from. */
export interface UncheckedAdapter extends Omit<TrackerAdapter, "search" | "status"> {
  search(token: TrackerToken, query: string, destinationId?: string): Promise<(TicketRef & { status: TicketStatus; site: string | null })[]>;
  status(token: TrackerToken, ticket: HeldTicket): Promise<{ externalId: string; status: TicketStatus }>;
}

/** A ticket Critiqs created, as the tracker reports it. */
export interface CreatedTicket extends TicketRef {
  status: TicketStatus;
  /** The tracker's workspace, organization, or site the ticket is in, to match status updates; null where the tracker has none. */
  site: string | null;
}

/** An image to put in a ticket, such as a thread's capture. */
export interface TicketImage {
  data: Blob;
  contentType: string;
  name: string;
}

/**
 * A refusal the tracker answered with, so it did nothing: a token it doesn't
 * accept, a rate limit, or input it turned down, such as a team that no longer
 * exists. Any other failure (no answer, a server error, an answer Critiqs
 * can't read) may have done what was asked.
 */
export class TrackerRefusal extends CritiqsError {}

/** How a creation ended, as far as Critiqs can tell. */
export type CreateOutcome =
  | { status: "created"; ticket: CreatedTicket }
  /** The tracker answered that it created nothing. */
  | { status: "refused"; error: CritiqsError }
  /** The tracker may have created it: no answer, a server error, or an answer Critiqs couldn't read. */
  | { status: "unknown"; error: CritiqsError };

/** One tracker's API, as Critiqs uses it. */
export interface TrackerAdapter {
  /** Who the token belongs to; refuses a token the tracker doesn't accept. */
  verify(token: TrackerToken): Promise<TrackerIdentity>;
  /** Where the person can create tickets: Linear teams, GitHub repositories, or Jira projects. */
  destinations(token: TrackerToken): Promise<TicketDestination[]>;
  /** Tickets the person can see, by key (such as `ENG-123`) or words, optionally in one destination. */
  search(token: TrackerToken, query: string, destinationId?: string): Promise<(TicketRef & { status: TicketStatus })[]>;
  /** One ticket, by the tracker's permanent ID; refused when the person can't see it. */
  get(token: TrackerToken, externalId: string): Promise<CreatedTicket>;
  /**
   * Creates a ticket. `creationId` (a UUID v4) names the creation and stays
   * the same across its attempts: a tracker that lets callers choose the new
   * ticket's ID takes it, so one creation can't make two tickets.
   */
  create(token: TrackerToken, input: NewTrackerTicket): Promise<CreateOutcome>;
  /**
   * The ticket a creation made, when an attempt's outcome is unknown: found by
   * `creationId` where the tracker took it as the ticket's ID, else by the
   * thread's link. Null when the creation made no ticket.
   */
  findCreated(token: TrackerToken, created: { creationId: string; link: WebAddress | null }): Promise<CreatedTicket | null>;
  /** Adds a link back to the thread: a Linear attachment, a Jira remote link, or a GitHub comment. Safe to repeat: the ticket keeps one link to the thread. */
  linkBack(token: TrackerToken, ticket: HeldTicket, link: { url: WebAddress; title: string }): Promise<void>;
  /** Adds a comment: text Critiqs made (`ticketLinkComment`), never a plain string. */
  comment(token: TrackerToken, ticket: HeldTicket, body: TicketMarkdown): Promise<void>;
  status(token: TrackerToken, ticket: HeldTicket): Promise<TicketStatus>;
  /** Uploads an image for a new ticket's text and returns the address to embed; absent where the tracker can't take images (GitHub). */
  uploadImage?(token: TrackerToken, image: TicketImage): Promise<WebAddress>;
  /**
   * The ticket templates of each destination the person can see, by
   * destination, or of one destination; absent where the tracker has none.
   */
  templates?(token: TrackerToken, destinationId?: string): Promise<TrackerTemplateGroup[]>;
  /** One ticket template with its text, read fresh for a draft; null when the tracker no longer has it. */
  template?(token: TrackerToken, templateId: string): Promise<TrackerTemplate | null>;
  /** The labels a ticket in the destination can take; absent where the tracker has none. */
  labels?(token: TrackerToken, destinationId: string): Promise<TrackerLabel[]>;
}

/** A label as a tracker lists it, with the group a ticket may take only one label from, if any. */
export interface TrackerLabel extends TicketLabel {
  /** The ID of the label's single-select group, such as a Linear label group; null when the label can go with any other. */
  exclusiveGroup: string | null;
}

/** What creating a ticket sends the tracker. */
export interface NewTrackerTicket {
  destinationId: string;
  title: string;
  /** Ticket text Critiqs made (`ticketBody`), never a plain string. */
  body: TicketMarkdown;
  /** Label IDs to add. */
  labels: string[];
  /** The template the tracker applies its other defaults from, such as labels; null for none. */
  templateId: string | null;
  creationId: string;
}

/** A ticket template as the tracker has it now. */
export interface TrackerTemplate {
  id: string;
  name: string;
  /** The destination it belongs to. */
  destinationId: string;
  /** Its text, in Markdown, with headings marking its sections. */
  body: string;
}

/** Tokens from a tracker's sign-in: the access token, the refresh token when it issues one, and when the access token expires. */
export interface SignInTokens {
  access: string;
  refresh: string | null;
  expiresAt: number | null;
}

/** Each tracker's adapter, at the given address; trackers not built yet are missing. */
export const TRACKER_ADAPTERS: Partial<Record<TrackerId, (endpoint: TrackerEndpointOptions) => TrackerAdapter>> = {
  linear: linearAdapter,
};

/**
 * `fetchFn` for calls that must finish by `deadline` (a time from `now`): a
 * request isn't started at or after it, and one still running then is
 * aborted. An attempt that holds a lease calls trackers through it, so none
 * of its requests outlives the lease.
 */
export function fetchUntil(fetchFn: typeof fetch, deadline: number, now: () => number): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const left = deadline - now();
    if (left <= 0) throw new Error("The attempt's time ran out before this request.");
    const controller = new AbortController();
    // Left running after the answer arrives, so reading its body is cut off at the deadline too.
    const timer = setTimeout(() => controller.abort(new Error("The attempt's time ran out.")), left);
    (timer as { unref?: () => void }).unref?.();
    const outer = init?.signal;
    if (outer) {
      if (outer.aborted) controller.abort(outer.reason);
      else outer.addEventListener("abort", () => controller.abort(outer.reason), { once: true });
    }
    try {
      return await fetchFn(input, { ...init, signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
  }) as typeof fetch;
}
