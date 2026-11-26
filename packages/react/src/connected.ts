// Telling the backend that Critiqs loaded on the prototype with a project's
// ID, so onboarding on the Critiqs website can say Connected. The backend
// keeps only the first time, so each browser reports a project once: on its
// first page load with it, and again only if that report didn't arrive.

/** Reports sent from this page, so a project is reported once per page load. */
const sent = new Set<string>();

/**
 * Reports that Critiqs loaded here with `projectId`, unless this browser
 * already has. Only from the prototype's own `http:` or `https:` page: the
 * browser extension's panel runs this component too, and the extension isn't
 * an install. The body is plain text, so the browser sends it without asking
 * the backend first, with the page's origin, which the backend records.
 */
export function reportConnected(
  siteUrl: string,
  projectId: string,
  { fetchFn = (input, init) => fetch(input, init), location = globalThis.location, storage = localStore() }: {
    fetchFn?: (input: string, init: RequestInit) => Promise<Response>;
    location?: Pick<Location, "protocol"> | undefined;
    storage?: Pick<Storage, "getItem" | "setItem"> | null;
  } = {},
): void {
  if (location === undefined || (location.protocol !== "https:" && location.protocol !== "http:")) return;
  const key = `critiqs:connected:${siteUrl}:${projectId}`;
  if (sent.has(key) || read(storage, key)) return;
  sent.add(key);
  fetchFn(`${siteUrl}/critiqs/connected`, { method: "POST", body: projectId, keepalive: true }).then(
    (response) => {
      if (response.ok) write(storage, key);
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

function read(storage: Pick<Storage, "getItem"> | null, key: string): boolean {
  try {
    return storage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

function write(storage: Pick<Storage, "setItem"> | null, key: string): void {
  try {
    storage?.setItem(key, "1");
  } catch {
    // Without storage, the next page load reports again, which changes nothing.
  }
}
