/**
 * A project's address list: the origins its prototype runs at, such as
 * `https://acme-proto.vercel.app`, or patterns with one wildcard in the
 * leftmost label, such as `https://*-acme.vercel.app`. The browser extension
 * finds a page's project by its origin, searching only projects the person can
 * already reach. Separate from the review address, which only sets the page
 * mention emails open.
 */
import type { ProjectInfo } from "./protocol.ts";
import { isPrivateReviewAddress } from "./review-address.ts";

/** Addresses one project may list. */
export const MAX_PROJECT_ADDRESSES = 20;
/** Longest address a project may list, as typed and once normalized. */
export const MAX_PROJECT_ADDRESS_LENGTH = 200;

/** An address as a project lists it, normalized, and what the lookup matches it by. */
export interface ProjectAddress {
  /** As saved and shown: lowercase, without a default port or trailing slash. */
  address: string;
  /** An origin, or a pattern with one wildcard in its leftmost label. */
  exact: boolean;
  /**
   * What the lookup searches by: the origin itself, or for a pattern, the
   * address with its whole leftmost label as `*`, such as `https://*.vercel.app`.
   */
  key: string;
}

/** Longest page origin the lookup reads: a pattern can match an origin longer than any listed address. */
const MAX_ORIGIN_LENGTH = 300;

/** What a pattern's `*` stands in as while its address is parsed: letters any host label may hold. */
const WILDCARD = "critiqswildcard";

/** The address as a project lists it, or why it can't be listed. */
export function parseProjectAddress(value: string): ProjectAddress | { error: string } {
  return parseAddress(value, MAX_PROJECT_ADDRESS_LENGTH);
}

function parseAddress(value: string, maxLength: number): ProjectAddress | { error: string } {
  const given = value.trim();
  const refuse = (reason: string) => ({ error: `${JSON.stringify(given.slice(0, 80))} ${reason}` });
  const tooLong = `is longer than ${maxLength} characters.`;
  if (given.length > maxLength) return refuse(tooLong);
  // The browser's parser silently drops tabs and line breaks, which would save a different address than typed.
  if (/[\s\u0000-\u001f\u007f]/.test(given)) return refuse("can't include a space or line break.");
  // Browsers read `\` as `/`, so it would start a path too.
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\\]*)\/?$/i.exec(given);
  if (scheme === null) return refuse("isn't an address such as https://acme-proto.vercel.app, without a path, ? or #.");
  if (scheme[2]!.includes("@")) return refuse("can't include a username or password.");
  const protocol = scheme[1]!.toLowerCase();
  if (protocol !== "https" && protocol !== "http") return refuse("must start with https://.");
  const wildcards = given.split("*").length - 1;
  if (wildcards > 1) return refuse("can have only one *.");
  // Browsers differ on a `*` in a host: Chrome writes it as `%2A`, Node and Bun keep it. The wildcard is parsed
  // as a run of letters and put back, so every runtime reads a pattern the same way.
  if (wildcards === 1 && given.toLowerCase().includes(WILDCARD)) return refuse("isn't a valid address.");
  let url: URL;
  try {
    url = new URL(wildcards === 1 ? given.replace("*", WILDCARD) : given);
  } catch {
    return refuse("isn't a valid address.");
  }
  // A host written with its final dot, such as `preview.acme.com.`, is the same site.
  if (url.hostname.endsWith(".") && url.hostname.length > 1) url.hostname = url.hostname.slice(0, -1);
  const host = url.hostname.replace(WILDCARD, "*");
  const origin = url.origin.replace(WILDCARD, "*");
  if (host === "") return refuse("isn't a valid address.");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return refuse("isn't an address such as https://acme-proto.vercel.app, without a path, ? or #.");
  // A pattern's literal stands in for its wildcard while the host is checked as a name.
  const literal = wildcards === 1 ? host.replace("*", "x") : host;
  if (protocol === "http" && !isPrivateReviewAddress(`http://${bracketed(literal)}`)) {
    return refuse("must start with https://. Plain http:// works only on this computer or a private network.");
  }
  const ip = literal.startsWith("[") || /^\d+(?:\.\d+){3}$/.test(literal);
  if (!ip && !literal.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    return refuse("has a host name that isn't valid.");
  }
  if (origin.length > maxLength) return refuse(tooLong);
  if (wildcards === 0) return { address: origin, exact: true, key: origin };
  const [first, ...rest] = host.split(".");
  // Checked as typed: the browser would rewrite a label with other letters, such as `ü`, into an `xn--` name.
  const typed = scheme[2]!.split(".")[0]!.toLowerCase();
  if (ip || !first!.includes("*")) return refuse("can have * only in the leftmost part of the host, such as https://*-acme.vercel.app.");
  if (typed !== first || !/^[a-z0-9-]*\*[a-z0-9-]*$/.test(first)) return refuse("can use only letters a to z, digits, and hyphens around its *.");
  if (rest.length < 2) return refuse("matches too much: put * in front of a site's name, such as https://*.acme.com.");
  return { address: origin, exact: false, key: origin.replace(`//${first}.`, "//*.") };
}

/**
 * What the lookup searches for a page's origin: the origin, the pattern key
 * it would fall under, and whether it is ambiguous. Null for an origin no
 * project can list.
 */
export function originLookupKeys(origin: string): { origin: string; patternKey: string | null; ambiguous: boolean } | null {
  if (origin.includes("*")) return null;
  const parsed = parseAddress(origin, MAX_ORIGIN_LENGTH);
  if ("error" in parsed) return null;
  const url = new URL(parsed.address);
  const labels = url.hostname.split(".");
  const named = !url.hostname.startsWith("[") && !/^\d+(?:\.\d+){3}$/.test(url.hostname);
  return {
    origin: parsed.address,
    patternKey: named && labels.length >= 3 ? parsed.address.replace(`//${labels[0]}.`, "//*.") : null,
    ambiguous: isAmbiguousOrigin(parsed.address),
  };
}

/** Whether a listed pattern, such as `https://*-acme.vercel.app`, matches a normalized origin. */
export function patternMatches(pattern: string, origin: string): boolean {
  const star = pattern.indexOf("*");
  if (star === -1) return pattern === origin;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (origin.length <= prefix.length + suffix.length || !origin.startsWith(prefix) || !origin.endsWith(suffix)) return false;
  // The wildcard covers part of one label: at least one character, never a dot.
  const covered = origin.slice(prefix.length, origin.length - suffix.length);
  return /^[a-z0-9-]+$/.test(covered);
}

/**
 * Whether many unrelated projects may use the same origin, on different
 * computers or networks: this computer (`localhost`, loopback), private
 * networks, and local names such as `.local`. The lookup always asks which
 * project such an origin is.
 */
export function isAmbiguousOrigin(origin: string): boolean {
  return isPrivateReviewAddress(origin);
}

function bracketed(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** What the browser extension's project lookup found for a page's origin. */
export type ProjectLookup =
  /** One project matches, and the origin isn't ambiguous: show it. */
  | { status: "found"; project: ProjectInfo }
  /** Several projects match, or the origin is ambiguous: ask which to show. */
  | { status: "choose"; projects: ProjectInfo[] }
  /** Nothing the person can reach lists this origin. */
  | { status: "none" };

/** Most projects `projects:manageable` (`manageableProjects`) returns. */
export const MAX_MANAGEABLE_PROJECTS = 200;

/**
 * The projects whose address lists a person may change, by name, for adding a
 * site to one: those in organizations they're an admin of, and those they
 * created while still a member. At most `MAX_MANAGEABLE_PROJECTS`; `complete`
 * is false when there may be more.
 */
/**
 * An address in a project's list that matches no site now: a pattern listed
 * before the rule that refuses it, with why and what to do, for its owners.
 */
export interface AddressNote {
  address: string;
  note: string;
}

export interface ManageableProjects {
  projects: ProjectInfo[];
  complete: boolean;
}
