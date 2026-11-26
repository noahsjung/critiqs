import {
  FRAME_LABEL,
  frameHostHash,
  parseReviewResolution,
  RESOLUTION_CACHE_MS,
  REVIEW_LINK_LIMITS,
  type ReviewResolution,
  type ReviewUsageReport,
} from "./review-links.ts";

// The review proxy's view of review links: what a frame host stands for, and
// where its traffic is reported. The proxy depends only on `ReviewDirectory`;
// `convexDirectory` is the implementation backed by a Convex deployment's
// `/internal/review/v1/*` routes, authenticated with the shared proxy secret.
// Answers are reused for at most five seconds and never past the lease's end;
// a backend that fails or answers anything unexpected means "serve nothing".

export interface ReviewDirectory {
  /**
   * What a frame host's label (`v-<…>`) stands for now, or null for any host
   * that serves nothing: unknown, expired, revoked, paused, blocked, denied, or
   * the backend unreachable. The caller passes only the label, lowercased.
   */
  resolve(label: string, signal?: AbortSignal): Promise<ReviewResolution | null>;
  /** Reports traffic per link; returns the links now paused, whose hosts serve nothing until the next day. */
  report(usage: readonly ReviewUsageReport[], signal?: AbortSignal): Promise<{ paused: readonly string[] }>;
}

export interface ConvexDirectoryOptions {
  /** The deployment's HTTP address (`CRITIQS_PROXY_BACKEND`), such as `https://<name>.convex.site`. */
  backend: string | URL;
  /** `CRITIQS_PROXY_SECRET`, the same value the deployment has. */
  secret: string;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  /** How long one request to the backend may take. */
  timeoutMs?: number;
  /** Frame hosts remembered at once; the oldest answers are dropped first. */
  maxCached?: number;
}

/** Usage reports are sent in batches of at most this many. */
const BATCH = REVIEW_LINK_LIMITS.usageReports;

export function convexDirectory(options: ConvexDirectoryOptions): ReviewDirectory {
  const base = new URL(options.backend);
  if (base.pathname !== "/" || base.search !== "" || base.hash !== "") throw new Error("The backend address must be a bare origin.");
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) {
    throw new Error("The backend address must use https://, or http:// on this computer.");
  }
  const send = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const maxCached = options.maxCached ?? 10_000;
  /** Answers by label, in the order they were stored. */
  const cache = new Map<string, { value: ReviewResolution | null; until: number }>();
  const pending = new Map<string, Promise<ReviewResolution | null>>();

  const post = async (path: string, body: unknown, signal?: AbortSignal): Promise<Response | null> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await send(new URL(path, base).toString(), {
        method: "POST",
        headers: { Authorization: `Bearer ${options.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
    } catch {
      return null;
    }
  };

  const remember = (label: string, value: ReviewResolution | null, until: number) => {
    cache.delete(label);
    cache.set(label, { value, until });
    while (cache.size > maxCached) cache.delete(cache.keys().next().value!);
  };

  const ask = async (label: string, signal?: AbortSignal): Promise<ReviewResolution | null> => {
    const asked = now();
    const response = await post("/internal/review/v1/resolve", { hostHash: await frameHostHash(label) }, signal);
    if (response === null) return null;
    if (response.status === 404) {
      // A host that serves nothing stays that way for a moment; a new lease always gets a new host.
      remember(label, null, asked + RESOLUTION_CACHE_MS);
      return null;
    }
    if (!response.ok) return null;
    const resolution = parseReviewResolution(await response.json().catch(() => null));
    if (resolution === null) return null;
    remember(label, resolution, Math.min(resolution.cacheUntil, resolution.expiresAt, asked + RESOLUTION_CACHE_MS));
    return resolution;
  };

  return {
    async resolve(label, signal) {
      if (!FRAME_LABEL.test(label)) return null;
      const cached = cache.get(label);
      const time = now();
      if (cached !== undefined && time < cached.until) {
        if (cached.value === null || time < cached.value.expiresAt) return cached.value;
      }
      cache.delete(label);
      const inFlight = pending.get(label);
      if (inFlight !== undefined) return await inFlight;
      const answer = ask(label, signal).finally(() => pending.delete(label));
      pending.set(label, answer);
      return await answer;
    },

    async report(usage, signal) {
      const paused = new Set<string>();
      for (let start = 0; start < usage.length; start += BATCH) {
        const response = await post("/internal/review/v1/usage", { reports: usage.slice(start, start + BATCH) }, signal);
        if (response === null || !response.ok) throw new Error("The backend didn't take the usage report.");
        const body = (await response.json().catch(() => null)) as { paused?: unknown } | null;
        if (body === null || !Array.isArray(body.paused)) throw new Error("The backend didn't take the usage report.");
        for (const linkId of body.paused) if (typeof linkId === "string") paused.add(linkId);
      }
      // A paused link's hosts are asked about again, and refused, from now on.
      for (const [label, entry] of cache) if (entry.value !== null && paused.has(entry.value.linkId)) cache.delete(label);
      return { paused: [...paused] };
    },
  };
}
