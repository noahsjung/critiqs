import type { ChromeApi } from "./chrome.ts";

/**
 * "Show comments here automatically": Chrome's access to one site, asked for
 * only when the person turns it on, and the content script registered for
 * that site so pins show on later visits without a click. Turning it off
 * removes both. Installing the extension asks for no site access at all.
 */

/** Chrome's match pattern for every page of one origin, such as `https://acme.dev/*` or `http://localhost:5173/*`. */
export function sitePattern(origin: string): string {
  return `${origin}/*`;
}

/** The registered content script's ID for one origin: a fixed prefix and the origin's bytes in hex. */
export function siteScriptId(origin: string): string {
  return `critiqs-site-${Array.from(new TextEncoder().encode(origin), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** The content script that runs the page layer, as the build names it. */
export const PAGE_SCRIPT = "page.js";

type Api = Pick<ChromeApi, "permissions" | "scripting" | "storage">;

/**
 * Changed whenever a site's automatic comments are turned on or off, so pages
 * already open on it check again: unregistering a script only stops it on
 * pages loaded later.
 */
export const SITES_CHANGED = "sites-changed";
const sitesChanged = (chrome: Api) => chrome.storage.local.set({ [SITES_CHANGED]: Date.now() }).catch(() => undefined);

/** Whether comments show on this site automatically: Chrome still grants the site, and its script is registered. */
export async function showsAutomatically(chrome: Api, origin: string): Promise<boolean> {
  const id = siteScriptId(origin);
  const [granted, scripts] = await Promise.all([
    chrome.permissions.contains({ origins: [sitePattern(origin)] }).catch(() => false),
    chrome.scripting.getRegisteredContentScripts({ ids: [id] }).catch(() => []),
  ]);
  return granted && scripts.some((script) => script.id === id);
}

/**
 * Asks Chrome for this one site, then registers the page layer's script for
 * it. Call it straight from the person's click: Chrome asks only then.
 * Resolves to whether comments now show automatically.
 */
export async function showAutomatically(chrome: Api, origin: string): Promise<boolean> {
  const pattern = sitePattern(origin);
  // Chrome refuses a request that doesn't come straight from the click, so this comes first.
  const granted = await chrome.permissions.request({ origins: [pattern] }).catch(() => false);
  if (!granted) return false;
  const id = siteScriptId(origin);
  // Registering again replaces an older registration, such as one from a previous version of the script.
  await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => undefined);
  try {
    await chrome.scripting.registerContentScripts([{ id, matches: [pattern], js: [PAGE_SCRIPT], runAt: "document_idle", persistAcrossSessions: true, allFrames: false }]);
  } catch {
    await chrome.permissions.remove({ origins: [pattern] }).catch(() => false);
    return false;
  }
  await sitesChanged(chrome);
  return true;
}

/** Stops showing comments automatically: removes the site's script, then gives the site's access back to Chrome. */
export async function stopShowingAutomatically(chrome: Api, origin: string): Promise<void> {
  await chrome.scripting.unregisterContentScripts({ ids: [siteScriptId(origin)] }).catch(() => undefined);
  await chrome.permissions.remove({ origins: [sitePattern(origin)] }).catch(() => false);
  await sitesChanged(chrome);
}
