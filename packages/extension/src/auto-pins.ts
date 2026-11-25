import type { PageDisplay, ThreadSummary } from "@critiqs/core";
import { locationOf } from "../../react/src/model.ts";

/**
 * What the page layer draws on a site whose comments show automatically,
 * with no side panel open: a pin beside each open comment's element, as the
 * panel draws them when it opens on Browse mode. Mockup comments belong to
 * Mockup mode, which shows them on its copy of the page in the Mockup tab.
 */
export function pinsDisplay(threads: ThreadSummary[]): PageDisplay {
  const shown = threads.filter((thread) => thread.mockup === undefined && thread.status === "open");
  return {
    hidden: false,
    exposedRight: null,
    watch: shown.map((thread) => ({ threadId: thread._id, location: locationOf(thread) })),
    pins: shown.map((thread) => ({ threadId: thread._id, authorName: thread.preview?.authorName ?? "Unknown", unread: thread.unread, resolved: false, tickets: thread.tickets ?? [] })),
    selected: null,
    highlight: null,
    picking: null,
    picked: null,
  };
}

/** The worker's answer to `critiqs:auto-pins`: what to draw, or nothing (signed out, no project, or the site's access ended). */
export type AutoPins = { display: PageDisplay } | { display: null };
