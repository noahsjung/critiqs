import { hostOf, isIdentityProvider, isLocalAddress } from "@critiqs/core";
import { acceptableAddress, isBlockedHost, type PublicWeb, type PublicWebPolicy, resolvePublicAddress } from "@critiqs/server/public-web";
import type { ProxyLimits } from "./config.ts";
import { lowercaseHeaders, outboundHeaders, type RequestClass } from "./headers.ts";
import type { ReputationCheck } from "./reputation.ts";

// The proxy's only way out to the internet. Every hop, redirects included,
// is checked before any socket opens: a plain http(s) address on its default
// port, not a local name, not the proxy's own hosts, a reputation the
// provider calls safe, and a name whose every address is public and outside
// the proxy's own blocks. The connection then goes only to the address that
// was checked. Redirects are followed here, never handed to the browser, and
// only within the origin the request was approved for.

export interface EgressDeps {
  web: PublicWeb;
  policy: PublicWebPolicy;
  reputation: ReputationCheck;
  /** `Critiqs-Review/1 (...)` for a link's own address, `Critiqs-Asset/1` for third-party assets: two egresses. */
  userAgent: string;
  /**
   * What the reputation check is asked about each hop: its origin and path
   * (`path`, the default), or only its origin (`origin`), which the provider
   * answers once for every file there. A property of the egress, never of a
   * request, so nothing a browser says can narrow the check: the egress for a
   * link's own and owner-approved origins checks paths, the one for
   * third-party static files checks hosts.
   */
  reputationScope?: "path" | "origin";
  limits: Pick<ProxyLimits, "hopTimeoutMs" | "headersTimeoutMs" | "maxRedirects">;
}

export interface EgressRequest {
  url: URL;
  method: "GET" | "HEAD";
  class: RequestClass;
  /** The one origin redirects may stay within: the link's, or the asset's own. */
  origin: string;
  /** Framework headers checked by `frameworkHeaders`, on the prototype's own data requests only. */
  framework?: Readonly<Record<string, string>>;
  /** Aborts the request and its body, such as when the browser goes away. */
  signal: AbortSignal;
}

export type EgressRefusal = "unsafe" | "unreachable";

export type EgressOutcome =
  /** The final response's status and lowercased headers, with its body for the caller to read within its limits. */
  | { kind: "response"; url: URL; status: number; headers: Record<string, string>; body: AsyncIterable<Uint8Array> }
  /** Refused or failed. `unsafe` when the reputation check refused a hop; anything else is `unreachable`, never more detail. */
  | { kind: "refused"; reason: EgressRefusal }
  /** A page redirected to another origin, which the proxy doesn't follow: that origin only, and whether it is a sign-in. */
  | { kind: "left"; url: string; signIn: boolean };

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Sign-in sites the proxy treats as identity providers on top of onboarding's list. */
const MORE_SIGN_IN: readonly { host: string; path?: string }[] = [{ host: "appleid.apple.com" }, { host: "vercel.com", path: "/login" }];

function isSignIn(url: URL): boolean {
  return isIdentityProvider(url) || MORE_SIGN_IN.some(({ host, path }) => hostOf(url) === host && (path === undefined || url.pathname === path || url.pathname.startsWith(`${path}/`)));
}

/**
 * The URL as every later check and the connection see it, with its host in
 * canonical form, or why it may not be fetched, checked without the network.
 */
export function checkedLocally(url: URL, policy: PublicWebPolicy): URL | EgressRefusal {
  const parsed = acceptableAddress(url.href);
  if (typeof parsed === "string") return "unreachable";
  // Only the scheme's default port, as the address check.
  if (parsed.port !== "") return "unreachable";
  if (isLocalAddress(parsed) || isBlockedHost(parsed.hostname, policy)) return "unreachable";
  return parsed;
}

/** Why a URL may not be fetched, checked without the network; null when it may be. */
export function refusedLocally(url: URL, policy: PublicWebPolicy): EgressRefusal | null {
  const checked = checkedLocally(url, policy);
  return typeof checked === "string" ? checked : null;
}

export interface Egress {
  fetch(request: EgressRequest): Promise<EgressOutcome>;
}

export function createEgress(deps: EgressDeps): Egress {
  return {
    async fetch(request) {
      const started = Date.now();
      let url = request.url;
      // The origin redirects must stay within, in the same canonical form as each hop.
      const allowed = acceptableAddress(request.origin);
      if (typeof allowed === "string") return { kind: "refused", reason: "unreachable" };
      let hops = 0;
      for (;;) {
        const checked = checkedLocally(url, deps.policy);
        if (typeof checked === "string") return { kind: "refused", reason: checked };
        url = checked;
        // One deadline for this hop's connection and headers, inside the whole request's.
        const left = deps.limits.headersTimeoutMs - (Date.now() - started);
        if (left <= 0) return { kind: "refused", reason: "unreachable" };
        const hop = new AbortController();
        const signal = AbortSignal.any([request.signal, hop.signal]);
        const timer = setTimeout(() => hop.abort(new Error("The upstream hop took too long.")), Math.min(deps.limits.hopTimeoutMs, left));
        let response: Awaited<ReturnType<PublicWeb["fetchPinned"]>>;
        try {
          const asked = (deps.reputationScope ?? "path") === "path" ? url : new URL("/", url);
          if (!(await deps.reputation.allows(asked, signal))) return { kind: "refused", reason: "unsafe" };
          const address = await resolvePublicAddress(url, deps.web.resolve, signal, deps.policy);
          if (address === null) return { kind: "refused", reason: "unreachable" };
          signal.throwIfAborted();
          response = await deps.web.fetchPinned({ url, address, headers: outboundHeaders(request.class, deps.userAgent, request.framework), signal, method: request.method });
        } catch {
          // DNS, TLS, connection, the deadline: never reported in detail.
          return { kind: "refused", reason: "unreachable" };
        } finally {
          clearTimeout(timer);
        }
        const headers = lowercaseHeaders(response.headers);
        const location = REDIRECTS.has(response.status) ? headers.location : undefined;
        if (location === undefined) return { kind: "response", url, status: response.status, headers, body: response.body };
        void response.body[Symbol.asyncIterator]().return?.()?.catch(() => undefined);
        hops++;
        if (hops > deps.limits.maxRedirects) return { kind: "refused", reason: "unreachable" };
        const next = acceptableAddress(location, url);
        if (typeof next === "string") return { kind: "refused", reason: "unreachable" };
        if (next.origin !== allowed.origin) {
          // Another origin, even http to https: never dialed.
          if (request.class !== "document") return { kind: "refused", reason: "unreachable" };
          return { kind: "left", url: next.origin, signIn: isSignIn(next) };
        }
        url = next;
      }
    },
  };
}
