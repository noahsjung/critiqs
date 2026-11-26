import { type AddressCheck, classifyAddress, type FetchedAddress, isLocalAddress, type PageHop } from "@critiqs/core";
import { fail } from "./errors.ts";
import { acceptableAddress, parsePrototypeAddress, type PinnedResponse, type PublicWeb, resolvePublicAddress } from "./public-web.ts";

// Onboarding's address check: Critiqs's server fetches an address anyone
// signed in can type, and reports what it found (core's `classifyAddress`).
// So the fetch must never reach Critiqs's own network or probe other
// services. Only ports 80 and 443 are allowed. Every host is resolved
// first and refused when any of its addresses isn't public; the connection
// then goes to the address that was checked, so a second DNS answer can't
// swap in a private one. Redirects are checked the same way, hop by hop.
// Callers learn only the coarse result, never addresses, statuses, or errors.
// The public-address rules and the pinned connection live in `public-web.ts`,
// shared with the review-link proxy.

export {
  acceptableAddress,
  isPublicAddress,
  type NodeNetwork,
  nodeNetwork,
  parsePrototypeAddress,
  type PinnedRequest,
  type PinnedResponse,
  type ResolvedAddress,
} from "./public-web.ts";

export const ADDRESS_CHECK_TIMEOUT_MS = 5_000;
export const MAX_ADDRESS_REDIRECTS = 3;
export const MAX_ADDRESS_BODY_BYTES = 256 * 1024;
export const ADDRESS_CHECK_USER_AGENT = "Critiqs-Check/1 (+https://critiqs.app)";
/**
 * Address checks one process runs at once. The hourly limits
 * (`claimAddressCheck`) use fixed UTC hours, so a burst at an hour's edge can
 * spend two hours' worth; this cap bounds what runs at any moment.
 */
export const MAX_CONCURRENT_ADDRESS_CHECKS = 16;

const REQUEST_HEADERS = { "User-Agent": ADDRESS_CHECK_USER_AGENT, Accept: "text/html", "Accept-Encoding": "identity" };

export interface AddressCheckDeps extends PublicWeb {
  /** The whole check's deadline, DNS included. Default `ADDRESS_CHECK_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * What's at an address someone typed: `local` without any network access for
 * an address on their computer or network, otherwise what core's
 * `classifyAddress` makes of the responses. Anything refused or failed is
 * `unreachable`. Invalid input throws (see `parsePrototypeAddress`).
 */
export async function checkAddress(input: string | URL, deps: AddressCheckDeps): Promise<AddressCheck> {
  const url = typeof input === "string" ? parsePrototypeAddress(input) : input;
  if (isLocalAddress(url)) return { kind: "local" };
  const signal = AbortSignal.timeout(deps.timeoutMs ?? ADDRESS_CHECK_TIMEOUT_MS);
  try {
    const fetched = await fetchAddress(url, deps, signal);
    return fetched === null ? { kind: "unreachable" } : classifyAddress(fetched);
  } catch {
    // A network or TLS error, the deadline, or a misbehaving server. Never reported in detail.
    return { kind: "unreachable" };
  }
}

let checksRunning = 0;

/**
 * The onboarding operation: checks the address, counts the check with
 * `claim` (`claimAddressCheck` in its own transaction, which requires sign-in
 * and applies the hourly limits), then fetches. An invalid address, or one
 * past `MAX_CONCURRENT_ADDRESS_CHECKS`, is refused before anything is counted.
 */
export async function checkPrototypeAddress(
  run: { claim: () => Promise<void>; deps: AddressCheckDeps },
  args: { address: string },
): Promise<AddressCheck> {
  const url = parsePrototypeAddress(args.address);
  if (isLocalAddress(url)) {
    await run.claim();
    return { kind: "local" };
  }
  if (checksRunning >= MAX_CONCURRENT_ADDRESS_CHECKS) fail("limit", "Critiqs is busy checking other addresses. Try again in a moment, or skip this step.");
  checksRunning++;
  try {
    await run.claim();
    return await checkAddress(url, run.deps);
  } finally {
    checksRunning--;
  }
}

/**
 * The responses, following at most `MAX_ADDRESS_REDIRECTS` redirects; null
 * when a hop is refused or there are more redirects. `hops` holds only
 * addresses that passed every check and were fetched.
 */
async function fetchAddress(start: URL, deps: AddressCheckDeps, signal: AbortSignal): Promise<FetchedAddress | null> {
  const hops: PageHop[] = [];
  let url = start;
  for (;;) {
    // Only the scheme's default port (80 for http, 443 for https; URL leaves
    // `port` empty for it, written or not), so the check can't probe other services.
    if (url.port !== "") return null;
    const address = await beforeDeadline(resolvePublicAddress(url, deps.resolve, signal), signal);
    if (address === null) return null;
    const response = await beforeDeadline(deps.fetchPinned({ url, address, headers: REQUEST_HEADERS, signal }), signal);
    const hop: PageHop = { url: url.href, status: response.status, headers: lowercaseHeaders(response.headers) };
    hops.push(hop);
    const redirect = hop.status >= 300 && hop.status < 400 ? hop.headers.location : undefined;
    if (redirect !== undefined) {
      stop(response.body);
      // Past the limit, unreachable. Core reads every Location in `hops`, and
      // this one's destination was never checked, so it mustn't reach core.
      if (hops.length > MAX_ADDRESS_REDIRECTS) return null;
      const next = acceptableAddress(redirect, url);
      if (typeof next === "string" || isLocalAddress(next)) return null;
      url = next;
      continue;
    }
    if (!NEEDS_BODY(hop.status)) {
      stop(response.body);
      return { hops, html: null };
    }
    return { hops, html: await readCapped(response.body, MAX_ADDRESS_BODY_BYTES, signal) };
  }
}

/** Responses `classifyAddress` reads a body for: pages, and refusals that may be a sign-in page or a bot wall. */
const NEEDS_BODY = (status: number) => (status >= 200 && status < 300) || [401, 403, 429, 503].includes(status);

function lowercaseHeaders(raw: PinnedResponse["headers"]): Record<string, string> {
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const key = name.toLowerCase();
    const text = typeof value === "string" ? value : value.join(", ");
    const before = headers.get(key);
    headers.set(key, before === undefined ? text : `${before}, ${text}`);
  }
  return Object.fromEntries(headers);
}

/** Reads at most `max` bytes, then stops the transfer. */
async function readCapped(body: AsyncIterable<Uint8Array>, max: number, signal: AbortSignal): Promise<string> {
  const chunks = body[Symbol.asyncIterator]();
  const kept: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await beforeDeadline(chunks.next(), signal);
      if (done) break;
      const part = value.subarray(0, max - size);
      kept.push(part);
      size += part.byteLength;
    }
  } finally {
    // Not awaited: a body stuck at the deadline may never answer.
    void chunks.return?.()?.catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of kept) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function stop(body: AsyncIterable<Uint8Array>): void {
  void body[Symbol.asyncIterator]().return?.()?.catch(() => undefined);
}

/** `work`, or a rejection at the deadline even when `work` ignores the signal. */
function beforeDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
