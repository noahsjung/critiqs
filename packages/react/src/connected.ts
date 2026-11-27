// Telling the backend that Critiqs loaded on the prototype with a project's
// ID, so onboarding on the Critiqs website can say Connected. The backend
// keeps the latest load from the project's own address, so each browser
// reports a project at most once an hour: a wrong or cleared record is
// replaced by the next real load without a report on every page.

/** How long a browser waits after a report that arrived before it reports the same project again. */
export const REPORT_AGAIN_MS = 60 * 60_000;

/** Reports sent from this page, so a project is reported once per page load. */
const sent = new Set<string>();

/**
 * Reports that Critiqs loaded here with `projectId`, unless this browser
 * did within `REPORT_AGAIN_MS`. Only from the prototype's own `http:` or `https:` page: the
 * browser extension's panel runs this component too, and the extension isn't
 * an install. The body is plain text, so the browser sends it without asking
 * the backend first, with the page's origin, which the backend records.
 */
export function reportConnected(
  siteUrl: string,
  projectId: string,
  { fetchFn = (input, init) => fetch(input, init), location = globalThis.location, storage = localStore(), now = Date.now() }: {
    fetchFn?: (input: string, init: RequestInit) => Promise<Response>;
    location?: Pick<Location, "protocol"> | undefined;
    storage?: Pick<Storage, "getItem" | "setItem"> | null;
    now?: number;
  } = {},
): void {
  if (location === undefined || (location.protocol !== "https:" && location.protocol !== "http:")) return;
  const key = `critiqs:connected:${siteUrl}:${projectId}`;
  if (sent.has(key) || now < read(storage, key) + REPORT_AGAIN_MS) return;
  sent.add(key);
  fetchFn(`${siteUrl}/critiqs/connected`, { method: "POST", body: projectId, keepalive: true }).then(
    (response) => {
      if (response.ok) write(storage, key, now);
      else sent.delete(key);
    },
    () => sent.delete(key),
  );
}

function localStore(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** When this browser's last report of the project arrived; 0 when none did, or it was stored by an older version. */
function read(storage: Pick<Storage, "getItem"> | null, key: string): number {
  try {
    const at = Number(storage?.getItem(key) ?? 0);
    return Number.isFinite(at) && at > 1 ? at : 0;
  } catch {
    return 0;
  }
}

function write(storage: Pick<Storage, "setItem"> | null, key: string, at: number): void {
  try {
    storage?.setItem(key, String(at));
  } catch {
    // Without storage, the next page load reports again, which the backend's own interval absorbs.
  }
}
