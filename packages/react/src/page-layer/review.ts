import {
  type PageCopy,
  type PageDisplay,
  type PageEvent,
  type PageEvents,
  PageLayerError,
  type PageMeasure,
  type PageMethod,
  type PagePanelEndpoint,
  type PageParams,
  type PageResult,
  type PageState,
} from "@critiqs/core";

// The panel's side of a review link's frame. The frame runs other people's
// scripts beside the page layer, so everything it reports is a claim, and
// nothing it doesn't need is sent to it:
//
// - Every address it reports (the page's, a measurement's, a page copy's)
//   must be on the frame's own lease origin; the review page maps it to the
//   prototype's address (`mapUrl`). Anything else fails the request, or the
//   state is ignored, so a forged address never reaches a comment's evidence.
// - Threads go to the frame only as aliases (`p1`, `p2`, …) for this panel,
//   with one generic name in place of the author's and none of their
//   tickets; the frame's answers are mapped back, and an alias the panel
//   never sent is ignored.

export interface ReviewFrame {
  /** The frame's lease origin, `https://v-<label>.<proxy domain>`. */
  frameOrigin: string;
  /**
   * The prototype's address for an address in the frame, already checked to
   * be on `frameOrigin`; null refuses it.
   */
  mapUrl(frameUrl: URL): string | null;
  /** Each page state the frame reports, with its mapped address. */
  onState?(state: PageState): void;
}

/** The name every pin in a review frame shows: never the author's, which stays in the panel. */
const PIN_NAME = "Reviewer";

/** An address the frame reported, mapped to the prototype's, or null. */
export function mapFrameUrl(frame: Pick<ReviewFrame, "frameOrigin" | "mapUrl">, raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== frame.frameOrigin) return null;
  return frame.mapUrl(url);
}

/** Wraps the panel's endpoint for a review frame (see above). */
export function reviewEndpoint(inner: PagePanelEndpoint, frame: ReviewFrame): PagePanelEndpoint {
  const aliases = new Map<string, string>();
  const threads = new Map<string, string>();
  const alias = (threadId: string) => {
    let found = aliases.get(threadId);
    if (found === undefined) {
      found = `p${aliases.size + 1}`;
      aliases.set(threadId, found);
      threads.set(found, threadId);
    }
    return found;
  };
  const refused = (what: string) => new PageLayerError("failed", `The prototype's frame reported ${what} outside this review link.`);

  const mapState = (state: PageState): PageState | null => {
    const url = mapFrameUrl(frame, state.url);
    if (url === null) return null;
    const located: PageState["located"] = {};
    for (const [key, value] of Object.entries(state.located)) {
      const threadId = threads.get(key);
      if (threadId !== undefined) located[threadId] = value;
    }
    const mapped = { ...state, url, located };
    frame.onState?.(mapped);
    return mapped;
  };
  const mapDisplay = (display: PageDisplay): PageDisplay => ({
    ...display,
    watch: display.watch.map((watched) => ({ ...watched, threadId: alias(watched.threadId) })),
    // A pin's tickets name the team's tracker issues and their status, which the prototype's scripts have no need of.
    pins: display.pins.map((pin) => ({ ...pin, threadId: alias(pin.threadId), authorName: PIN_NAME, tickets: [] })),
    selected: display.selected === null ? null : { ...display.selected, threadId: alias(display.selected.threadId) },
  });

  const outgoing = <M extends PageMethod>(method: M, params: PageParams<M>): PageParams<M> => {
    switch (method) {
      case "display":
        return mapDisplay(params as PageDisplay) as PageParams<M>;
      case "reveal":
      case "showPage": {
        const given = params as PageParams<"reveal"> | PageParams<"showPage">;
        return { ...given, threadId: alias(given.threadId) } as PageParams<M>;
      }
      default:
        return params;
    }
  };
  const incoming = <M extends PageMethod>(method: M, result: PageResult<M>): PageResult<M> => {
    switch (method) {
      case "connect": {
        const given = result as PageResult<"connect">;
        const state = mapState(given.state);
        if (state === null) throw refused("a page");
        return { ...given, state } as PageResult<M>;
      }
      case "display": {
        const state = mapState(result as PageState);
        if (state === null) throw refused("a page");
        return state as PageResult<M>;
      }
      case "measure": {
        const given = result as PageMeasure;
        const url = mapFrameUrl(frame, given.url);
        if (url === null) throw refused("an address");
        return { ...given, url } as PageResult<M>;
      }
      case "copyPage": {
        const given = result as PageCopy;
        const url = mapFrameUrl(frame, given.url);
        if (url === null) throw refused("an address");
        return { ...given, url } as PageResult<M>;
      }
      default:
        return result;
    }
  };

  return {
    async request(method, params, options) {
      return incoming(method, await inner.request(method, outgoing(method, params), options));
    },
    on<E extends PageEvent>(event: E, handler: (data: PageEvents[E]) => void) {
      return inner.on(event, (data) => {
        if (event === "state") {
          const state = mapState(data as PageState);
          if (state !== null) handler(state as PageEvents[E]);
          return;
        }
        if (event === "pin") {
          const pin = data as PageEvents["pin"];
          const threadId = threads.get(pin.threadId);
          if (threadId !== undefined) handler({ ...pin, threadId } as PageEvents[E]);
          return;
        }
        handler(data);
      });
    },
    close: () => inner.close(),
  };
}
