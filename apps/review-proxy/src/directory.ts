import { FRAME_LABEL, type ReviewResolution, type ReviewUsageReport } from "@critiqs/server/review-links";
import { convexDirectory, type ReviewDirectory } from "@critiqs/server/review-directory";
import { ConfigError, type ProxyConfig } from "./config.ts";

// Where the proxy learns what a frame host stands for. Each viewer's lease
// gets its own random host, `v-<26 base32 characters>.<proxy domain>`; the
// backend keeps only a hash of that label and answers
// `POST /internal/review/v1/resolve { hostHash }` with the lease's link,
// origin and owner-approved asset origins while every check still passes
// (lease live, link active, address still listed, member still allowed,
// reputation clean, not denied). The proxy serves nothing for null.
//
// The contract is the backend's own (`@critiqs/server/review-links` and
// `review-directory`); `convexDirectory` asks a Convex deployment, and
// `memoryDirectory` stands in for it in tests.

export { convexDirectory, FRAME_LABEL };
export type { ReviewDirectory, ReviewResolution, ReviewUsageReport };

/** A lease the memory directory serves, by its frame label. */
export interface MemoryLease extends Omit<ReviewResolution, "v" | "kind" | "cacheUntil" | "allow"> {
  label: string;
  allow?: ReviewResolution["allow"];
}

/**
 * Leases held in memory, for tests. Expired leases and leases of paused links
 * resolve to null, as the backend's would.
 */
export function memoryDirectory(leases: Iterable<MemoryLease>, now: () => number = Date.now) {
  const byLabel = new Map<string, MemoryLease>();
  for (const lease of leases) byLabel.set(lease.label, lease);
  const paused = new Set<string>();
  const reports: ReviewUsageReport[] = [];
  const directory = {
    leases: byLabel,
    /** Links to pause, as the backend does past a link's daily limit. */
    paused,
    /** Every usage report received. */
    reports,
    async resolve(label: string): Promise<ReviewResolution | null> {
      if (!FRAME_LABEL.test(label)) return null;
      const lease = byLabel.get(label);
      const time = now();
      if (lease === undefined || lease.expiresAt <= time || paused.has(lease.linkId)) return null;
      const { label: _label, ...rest } = lease;
      return { v: 1, kind: "site", ...rest, assetOrigins: rest.assetOrigins.map((entry) => ({ ...entry })), allow: (rest.allow ?? []).map((entry) => ({ ...entry })), cacheUntil: Math.min(lease.expiresAt, time + 5_000) };
    },
    async report(usage: readonly ReviewUsageReport[]): Promise<{ paused: readonly string[] }> {
      reports.push(...usage.map((entry) => ({ ...entry })));
      return { paused: [...paused] };
    },
  } satisfies ReviewDirectory & Record<string, unknown>;
  return directory;
}

/**
 * The directory the proxy serves from: the backend's (`CRITIQS_PROXY_BACKEND`,
 * authenticated with `CRITIQS_PROXY_SECRET`). On a `.localhost` domain only,
 * `CRITIQS_PROXY_DEV_LEASES` (JSON `MemoryLease[]`) serves test leases instead.
 */
export function directoryFor(config: Pick<ProxyConfig, "backend" | "secret" | "local">, env: Record<string, string | undefined>, options: { fetch?: (input: string, init: RequestInit) => Promise<Response> } = {}): ReviewDirectory {
  const dev = env.CRITIQS_PROXY_DEV_LEASES;
  if (dev !== undefined && dev !== "") {
    if (!config.local) throw new ConfigError("CRITIQS_PROXY_DEV_LEASES is only for a .localhost domain.");
    return memoryDirectory(JSON.parse(dev) as MemoryLease[]);
  }
  try {
    return convexDirectory({ backend: config.backend, secret: config.secret, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
  } catch (error) {
    throw new ConfigError(`CRITIQS_PROXY_BACKEND: ${error instanceof Error ? error.message : String(error)}`);
  }
}
