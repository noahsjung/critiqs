import type { TicketDestination, TicketRef, TicketStatus } from "@critiqs/core";

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

/** Where an adapter sends its requests: the tracker's API, or a local stand-in in tests. */
export interface TrackerEndpoint {
  fetch: typeof fetch;
  baseUrl: string;
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
