import {
  FRAME_LABEL,
  frameHostHash,
  parseReviewResolution,
  RESOLUTION_CACHE_MS,
  REVIEW_LINK_LIMITS,
  type ReviewResolution,
  type ReviewUsageReport,
} from "./review-links.ts";
import { BUILD_LIMITS, BUILD_TYPES, type BuildFileAnswer, sha256Hex } from "./review-builds.ts";

export type { BuildFileAnswer };

// The review proxy's view of review links: what a frame host stands for, and
// where its traffic is reported. The proxy depends only on `ReviewDirectory`;
// `convexDirectory` is the implementation backed by a Convex deployment's
// `/internal/review/v1/*` routes, authenticated with the shared proxy secret.
// Answers are reused for at most five seconds and never past the lease's end.
// A backend that can't be reached, fails, or answers anything unexpected
// serves nothing either, but is said apart, as an error, from a host the
// backend says serves nothing: the proxy then tells its viewer it can't check
// the link right now, and never counts it against them.

export interface ReviewDirectory {
  /**
   * What a frame host's label (`v-<…>`) stands for now, or null for any host
   * the backend says serves nothing: unknown, expired, revoked, paused,
   * blocked, denied. Rejects, without an answer, when the backend couldn't be
   * asked (unreachable, an error, an answer it can't read, or the caller went
   * away). The caller passes only the label, lowercased.
   */
  resolve(label: string, signal?: AbortSignal): Promise<ReviewResolution | null>;
  /** Reports traffic per link; returns the links now paused, whose hosts serve nothing until the next day. */
  report(usage: readonly ReviewUsageReport[], signal?: AbortSignal): Promise<{ paused: readonly string[] }>;
  /**
   * For a shared build's frame host: the file a request's path is, with the
   * status to serve it with (`buildLookup`), or null when the host serves
   * nothing now or no file matches. Asked on every request, so a build that
   * is deleted or expires stops at once.
   */
  buildFile(label: string, path: string, signal?: AbortSignal): Promise<BuildFileAnswer | null>;
  /** A shared build's file's bytes, by its SHA-256, while the host still serves that build and it holds that file; null otherwise. */
  buildBlob(label: string, sha256: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | null>;
}

const SERVED_TYPES = new Set(Object.values(BUILD_TYPES));

/** A build file answer from the backend, or null for anything else. */
export function parseBuildFileAnswer(raw: unknown): BuildFileAnswer | null {
  if (raw === null || typeof raw !== "object") return null;
  const { status, sha256, size, contentType } = raw as Record<string, unknown>;
  if (status !== 200 && status !== 404) return null;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > BUILD_LIMITS.fileBytes) return null;
  if (typeof contentType !== "string" || !SERVED_TYPES.has(contentType)) return null;
  return { status, sha256, size, contentType };
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
  /**
   * Answers by label, in the order they were stored: hosts that serve and
   * hosts that serve nothing apart, so asking about random hosts can only
   * push out other misses, never a host a viewer is using.
   */
  const cache = new Map<string, { value: ReviewResolution; until: number }>();
  const misses = new Map<string, number>();
  const pending = new Map<string, Promise<ReviewResolution | null>>();
  const couldNotAsk = () => new Error("The backend couldn't be asked about this frame host.");

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
    misses.delete(label);
    const into: Map<string, unknown> = value === null ? misses : cache;
    if (value === null) misses.set(label, until);
    else cache.set(label, { value, until });
    while (into.size > maxCached) into.delete(into.keys().next().value!);
  };

  /** One lookup, shared by every request for the label: bounded by its own deadline, never by one caller's. */
  const ask = async (label: string): Promise<ReviewResolution | null> => {
    const asked = now();
    const response = await post("/internal/review/v1/resolve", { hostHash: await frameHostHash(label) });
    if (response === null) throw couldNotAsk();
    if (response.status === 404) {
      // A host that serves nothing stays that way for a moment; a new lease always gets a new host.
      remember(label, null, asked + RESOLUTION_CACHE_MS);
      return null;
    }
    if (!response.ok) throw couldNotAsk();
    const resolution = parseReviewResolution(await response.json().catch(() => null));
    if (resolution === null) throw couldNotAsk();
    remember(label, resolution, Math.min(resolution.cacheUntil, resolution.expiresAt, asked + RESOLUTION_CACHE_MS));
    return resolution;
  };

  return {
    async resolve(label, signal) {
      if (!FRAME_LABEL.test(label)) return null;
      const time = now();
      const cached = cache.get(label);
      if (cached !== undefined && time < cached.until && time < cached.value.expiresAt) return cached.value;
      cache.delete(label);
      const missed = misses.get(label);
      if (missed !== undefined && time < missed) return null;
      misses.delete(label);
      let answer = pending.get(label);
      if (answer === undefined) {
        answer = ask(label).finally(() => pending.delete(label));
        pending.set(label, answer);
      }
      if (signal === undefined) return await answer;
      // A caller that goes away stops waiting, without an answer; the lookup goes on for the others.
      if (signal.aborted) throw couldNotAsk();
      return await new Promise<ReviewResolution | null>((resolve, reject) => {
        const stop = () => reject(couldNotAsk());
        signal.addEventListener("abort", stop, { once: true });
        void answer.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
      });
    },

    async buildFile(label, path, signal) {
      if (!FRAME_LABEL.test(label) || !path.startsWith("/") || path.length > 4_096) return null;
      const response = await post("/internal/review/v1/build-file", { hostHash: await frameHostHash(label), path }, signal);
      if (response === null || !response.ok) return null;
      return parseBuildFileAnswer(await response.json().catch(() => null));
    },

    async buildBlob(label, sha256, signal) {
      if (!FRAME_LABEL.test(label) || !/^[0-9a-f]{64}$/.test(sha256)) return null;
      const response = await post("/internal/review/v1/build-blob", { hostHash: await frameHostHash(label), sha256 }, signal);
      if (response === null || !response.ok || response.body === null) return null;
      const length = Number(response.headers.get("content-length") ?? "0");
      if (!Number.isFinite(length) || length > BUILD_LIMITS.fileBytes) return null;
      // Read within the largest file a build holds, then check it is the file asked for.
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const step = await reader.read().catch(() => null);
        if (step === null) return null;
        if (step.done) break;
        size += step.value.byteLength;
        if (size > BUILD_LIMITS.fileBytes) {
          await reader.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(step.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return (await sha256Hex(bytes)) === sha256 ? bytes : null;
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
      for (const [label, entry] of cache) if (paused.has(entry.value.linkId)) cache.delete(label);
      return { paused: [...paused] };
    },
  };
}
