// Which sites may sign in, and which of them are Critiqs's own.
//
// Any HTTPS site (or plain HTTP on this computer) may sign in through the
// popup, once the reviewer allows it. Critiqs's own panels are different: its
// website (`CRITIQS_WEB_ORIGINS`) and its browser extension's side panel
// (`chrome-extension://<id>` for each ID in `CRITIQS_EXTENSION_IDS`). They may
// also sign in without a popup (`/auth/panel/*`), and they never need a site
// grant. Both settings list exact values; nothing is matched by pattern.

/** Chrome extension IDs are 32 letters from a to p. */
const EXTENSION_ID = /^[a-p]{32}$/;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})\/?$/;

/**
 * Accepts only a bare origin, such as `https://proto.example`. Plain HTTP is
 * allowed only on this computer, where a network cannot tamper with the page.
 * An extension's origin is accepted only for an allowed extension ID.
 */
export function normalizeOrigin(value: string | null): string | null {
  if (value === null) return null;
  const extension = EXTENSION_ORIGIN.exec(value);
  if (extension !== null) return extensionIds().has(extension[1]!) ? `chrome-extension://${extension[1]}` : null;
  return webOrigin(value);
}

/** An `https:` origin, or an `http:` one on this computer; null for anything else. */
function webOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.origin !== value.replace(/\/$/, "")) return null;
    if (url.protocol === "https:") return url.origin;
    return url.protocol === "http:" && isLoopback(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

export function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Values of a list setting, split on commas or whitespace. */
function listSetting(name: string): string[] {
  return (process.env[name] ?? "").split(/[\s,]+/).filter((value) => value !== "");
}

function extensionIds(): Set<string> {
  return new Set(listSetting("CRITIQS_EXTENSION_IDS").filter((id) => EXTENSION_ID.test(id)));
}

/**
 * Critiqs's own panels: its website's origins and its extension's. Entries
 * that aren't an exact origin (or extension ID) are ignored.
 */
export function panelOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const value of listSetting("CRITIQS_WEB_ORIGINS")) {
    const origin = webOrigin(value);
    if (origin !== null) origins.add(origin);
  }
  for (const id of extensionIds()) origins.add(`chrome-extension://${id}`);
  return origins;
}

/** Whether an origin is one of Critiqs's own panels, by exact match. */
export function isPanelOrigin(origin: string | null): origin is string {
  return origin !== null && panelOrigins().has(origin);
}
