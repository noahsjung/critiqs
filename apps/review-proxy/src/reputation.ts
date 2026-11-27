import { hostOf } from "@critiqs/core";
// URL reputation: before the proxy serves a page or fetches an asset host, a
// reputation provider says whether the address is known for phishing,
// malware or unwanted software. Only the normalized origin and path are sent,
// never the query or fragment. When the provider can't answer, an address
// not already known to be safe is refused: the check fails closed.

export type Verdict = "safe" | "unsafe";

export interface ReputationProvider {
  /** The verdict for each address, by `reputationKey`. Throws when the provider can't answer. */
  lookup(keys: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, Verdict>>;
}

/**
 * What the proxy asks about a URL: its origin, with the host in canonical
 * form (so `evil.example.` is `evil.example`), and its path, without query or
 * fragment.
 */
export function reputationKey(url: URL): string {
  const host = hostOf(url);
  if (host === null || url.hostname.startsWith("[")) return `${url.origin}${url.pathname}`;
  return `${url.protocol}//${host}${url.port === "" ? "" : `:${url.port}`}${url.pathname}`;
}

export interface ReputationCheck {
  /** Whether `url` may be fetched: true only for an address the provider called safe, now or within the cache's time. */
  allows(url: URL, signal: AbortSignal): Promise<boolean>;
}

export interface ReputationCacheOptions {
  /** How long a safe answer is trusted. */
  safeMs?: number;
  /** How long an unsafe answer is kept. */
  unsafeMs?: number;
  /** Answers kept at most; the oldest go first. */
  maxEntries?: number;
  now?: () => number;
}

/**
 * A provider's answers, cached. Each answer is kept for its time and the cache
 * holds at most `maxEntries`. An error from the provider is never cached and
 * refuses the URL.
 */
export function cachedReputation(provider: ReputationProvider, options: ReputationCacheOptions = {}): ReputationCheck {
  const safeMs = options.safeMs ?? 30 * 60_000;
  const unsafeMs = options.unsafeMs ?? 5 * 60_000;
  const maxEntries = options.maxEntries ?? 10_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { verdict: Verdict; until: number }>();
  return {
    async allows(url, signal) {
      const key = reputationKey(url);
      const cached = cache.get(key);
      if (cached !== undefined && cached.until > now()) return cached.verdict === "safe";
      cache.delete(key);
      let verdict: Verdict | undefined;
      try {
        verdict = (await provider.lookup([key], signal)).get(key);
      } catch {
        return false;
      }
      if (verdict === undefined) return false;
      cache.set(key, { verdict, until: now() + (verdict === "safe" ? safeMs : unsafeMs) });
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
      return verdict === "safe";
    },
  };
}

/** Google Cloud Web Risk's Lookup API (`uris.search`). */
export const WEB_RISK_ENDPOINT = "https://webrisk.googleapis.com/v1/uris:search";
const WEB_RISK_THREATS = ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE"];

/**
 * Google Web Risk. Each address is one `uris.search` call; a reply with a
 * `threat` means unsafe, an empty reply means safe, and anything else (an
 * error status, a malformed reply, no network) throws, so the address is
 * refused.
 */
export function webRiskProvider(apiKey: string, fetcher: (input: URL, init: RequestInit) => Promise<Response> = fetch): ReputationProvider {
  return {
    async lookup(keys, signal) {
      const verdicts = new Map<string, Verdict>();
      for (const key of keys) {
        const url = new URL(WEB_RISK_ENDPOINT);
        for (const threat of WEB_RISK_THREATS) url.searchParams.append("threatTypes", threat);
        url.searchParams.set("uri", key);
        // The key goes in a header, so it never appears in a logged URL.
        const response = await fetcher(url, { signal, redirect: "error", headers: { "X-Goog-Api-Key": apiKey } });
        if (!response.ok) throw new Error(`Web Risk answered ${response.status}.`);
        const body = (await response.json()) as unknown;
        if (typeof body !== "object" || body === null) throw new Error("Web Risk's answer wasn't an object.");
        verdicts.set(key, "threat" in body && (body as { threat?: unknown }).threat != null ? "unsafe" : "safe");
      }
      return verdicts;
    },
  };
}

/**
 * For tests and a `.localhost` stack only: every address is safe except those
 * listed, by `reputationKey` or by origin. `parseProxyConfig` refuses to start
 * without a real provider on any other domain.
 */
export function fixtureReputation(unsafe: Iterable<string> = []): ReputationProvider & { unsafe: Set<string> } {
  const listed = new Set(unsafe);
  return {
    unsafe: listed,
    async lookup(keys) {
      return new Map(keys.map((key) => [key, listed.has(key) || listed.has(new URL(key).origin) ? "unsafe" : "safe"] as const));
    },
  };
}

/** A provider that can never answer: what a deployment without one gets, so every uncached address is refused. */
export const noReputation: ReputationProvider = {
  async lookup() {
    throw new Error("No URL reputation provider is configured.");
  },
};
