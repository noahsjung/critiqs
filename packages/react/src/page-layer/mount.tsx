import { type PageLimits, type PageTransport, panelEndpoint } from "@critiqs/core";
import { createRoot } from "react-dom/client";
import type { MockupPlace, SupplyCapture } from "../App.tsx";
import { attachHost, Connect } from "../connect.tsx";
import type { CritiqsProps } from "../host.ts";
import type { TokenSession } from "../session.ts";
import { createPageLayer, type PageHost } from "./layer.tsx";
import { PageLink } from "./link.ts";

// Critiqs's two halves in two documents. Installed, `mountCritiqs` runs both
// in the page; a review link runs the page layer in the prototype's frame and
// the panel in the page around it; the extension runs the page layer as a
// content script and the panel in Chrome's side panel.

/** A running page layer: change the host's functions, or remove it. */
export interface MountedPageLayer {
  setHost(host: PageHost): void;
  destroy(): void;
}

/**
 * Starts the page layer on this page, with nothing of Critiqs's interface
 * but what it draws on the page: pins, outlines, and Comment mode's
 * selection. It answers the panel at the other end of `transport`.
 */
export function mountPageLayer({ transport, channel, host: pageHost = {} }: { transport: PageTransport; channel: string; host?: PageHost }): MountedPageLayer {
  const { host, container } = attachHost(document.body);
  const layer = createPageLayer({ transport, channel, host, container, pageHost });
  return {
    setHost: (next) => layer.setHost(next),
    destroy() {
      layer.destroy();
      queueMicrotask(() => host.remove());
    },
  };
}

/** The panel's settings: Critiqs's own, without the host's functions, which belong to the page layer. */
export type PanelOptions = Omit<CritiqsProps, "getContext" | "restoreContext"> & {
  transport: PageTransport;
  channel: string;
  /** A screenshot of the view from outside the page, such as `captureVisibleTab`; the page's own capture otherwise. */
  supplyCapture?: SupplyCapture;
  /** The panel's own sign-in, such as the extension's; Critiqs's sign-in popup otherwise. Convex backends only. */
  session?: TokenSession;
  /** A comment to open once the panel shows, as a link to it would. */
  openThread?: string;
  /** Where Mockup mode opens, since the panel isn't drawn over the page: such as a window of its own. */
  mockups?: MockupPlace;
  /** How much the page layer's messages may carry: `UNTRUSTED_PAGE_LIMITS` for a frame Critiqs doesn't trust, such as a review link's. */
  pageLimits?: PageLimits;
};

/** A running panel: remove it, closing its connection to the page layer. */
export interface MountedPanel {
  /** Resolves once the page layer has answered and the panel is shown. */
  ready: Promise<void>;
  destroy(): void;
}

/**
 * Shows Critiqs's panel (toolbar, sidebar, threads, sign-in, and backend
 * connection) in `container`, for a page layer in another document. The panel
 * draws over its own window, so it belongs in a document of its own, such as
 * a side panel or the page around a prototype's frame. It appears once the
 * page layer answers, and connects again whenever the page layer restarts,
 * such as after the frame loads another page.
 */
export function mountPanel(container: Element, { transport, channel, supplyCapture, session, openThread, mockups, pageLimits, ...props }: PanelOptions): MountedPanel {
  const { host, container: inner } = attachHost(container);
  const root = createRoot(inner);
  const link = new PageLink(panelEndpoint(transport, { channel, ...(pageLimits === undefined ? {} : { limits: pageLimits }) }));
  let destroyed = false;
  const ready = new Promise<void>((resolve) => {
    const stop = link.subscribe(() => {
      stop();
      resolve();
    });
    // When the page layer isn't listening yet, this gets no answer; once it
    // starts, it says so and the link connects then.
    void link.connect({ timeoutMs: 5000 }).catch(() => undefined);
  }).then(() => {
    if (!destroyed) root.render(<Connect props={props} host={host} page={link} supplyCapture={supplyCapture} session={session} openThread={openThread} mockups={mockups} />);
  });
  return {
    ready,
    destroy() {
      destroyed = true;
      link.close();
      setTimeout(() => {
        root.unmount();
        host.remove();
      });
    },
  };
}
