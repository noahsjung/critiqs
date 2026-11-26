// Where the proxy learns what a frame host stands for. Each viewer's lease
// gets its own random host, `v-<26 base32 characters>.<proxy domain>`; the
// backend keeps only a hash of that label and answers
// `POST /internal/review/v1/resolve { hostHash }` with the lease's link,
// origin and owner-approved asset origins while every check still passes
// (lease live, link active, address still listed, member still allowed,
// reputation clean, not denied). The proxy serves nothing for null.
//
// These types are the contract with the backend's `convexDirectory`
// (`@critiqs/server/review-directory`, H3), which satisfies
// `ReviewDirectory` as is; `memoryDirectory` stands in for it in tests and on
// a computer's own stack.

/** A frame host's label: `v-` and 26 base32 characters, lowercased. */
export const FRAME_LABEL = /^v-[a-z2-7]{26}$/;

/** What a frame host stands for, while every check still passes. */
export interface ReviewResolution {
  v: 1;
  kind: "site";
  linkId: string;
  leaseId: string;
  /** The prototype's origin, served at the root of the frame host. */
  origin: string;
  /** Owner-approved origins the pages may read from, by slot (`/__critiqs/o/<slot>/…`). */
  assetOrigins: { slot: number; origin: string }[];
  /** When the lease ends unless renewed. */
  expiresAt: number;
  /** The proxy may reuse this answer until then, never past `expiresAt`. */
  cacheUntil: number;
}

/** One link's traffic since the proxy's last report. */
export interface ReviewUsageReport {
  linkId: string;
  requests: number;
  bytes: number;
}

export interface ReviewDirectory {
  /**
   * What a frame host's label stands for now, or null for any host that
   * serves nothing: unknown, expired, revoked, paused, blocked, denied, or the
   * backend unreachable. The caller passes only the label, lowercased.
   */
  resolve(label: string, signal?: AbortSignal): Promise<ReviewResolution | null>;
  /** Reports traffic per link; returns the links now paused, whose hosts serve nothing until the next day. */
  report(usage: readonly ReviewUsageReport[], signal?: AbortSignal): Promise<{ paused: readonly string[] }>;
}

/** A lease the memory directory serves, by its frame label. */
export interface MemoryLease extends Omit<ReviewResolution, "v" | "kind" | "cacheUntil"> {
  label: string;
}

/**
 * Leases held in memory, for tests and a computer's own stack. Expired leases
 * and leases of paused links resolve to null, as the backend's would.
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
      return { v: 1, kind: "site", ...rest, assetOrigins: rest.assetOrigins.map((entry) => ({ ...entry })), cacheUntil: Math.min(lease.expiresAt, time + 5_000) };
    },
    async report(usage: readonly ReviewUsageReport[]): Promise<{ paused: readonly string[] }> {
      reports.push(...usage.map((entry) => ({ ...entry })));
      return { paused: [...paused] };
    },
  } satisfies ReviewDirectory & Record<string, unknown>;
  return directory;
}
