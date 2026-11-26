/**
 * What the side panel can do with its tab's page right now, from what Chrome
 * and the content script have said. Chrome shows the extension a page's
 * address, and lets it add the page layer, only after a click on the icon
 * there or on a site the person allowed, so the panel never assumes access.
 */
export type PageView =
  /** Still waiting to hear from the page. */
  | "checking"
  /** The page layer is connected. */
  | "ready"
  /** The site has Critiqs installed: the extension stays out of the way. */
  | "built-in"
  /** A page no extension may use, such as `chrome://` pages, files, or the Web Store. */
  | "unsupported"
  /** Chrome hasn't given this page to Critiqs: the person clicks the icon on it. */
  | "needs-click";

export interface PageFacts {
  /** The tab's address, when Chrome shows it to the extension. */
  url: string | undefined;
  /** The address's origin, when a project could list it (http or https). */
  origin: string | null;
  builtIn: boolean;
  /** Why adding the page layer failed after the last click. */
  refused: string | undefined;
  connected: boolean;
  /** Whether the panel has waited long enough for a page layer that should have answered. */
  waited: boolean;
}

export function pageView(facts: PageFacts): PageView {
  // The extension's page layer answering means this page has no Critiqs of its own, whatever a note from another page says.
  if (facts.connected) return "ready";
  if (facts.builtIn) return "built-in";
  // An address Chrome shows but no project could list, such as chrome://extensions.
  if (facts.url !== undefined && facts.origin === null) return "unsupported";
  if (facts.refused !== undefined) return /cannot be scripted|chrome:\/\/|extensions gallery|Cannot access contents of url "(?:chrome|edge|about|devtools|view-source)/i.test(facts.refused) ? "unsupported" : "needs-click";
  return facts.waited ? "needs-click" : "checking";
}
