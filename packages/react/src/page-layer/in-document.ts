import { directTransports, panelEndpoint } from "@critiqs/core";
import { createPageLayer, type PageHost, type PageLayer } from "./layer.tsx";
import { PageLink } from "./link.ts";

/** The channel both halves use when they share a document; nothing else listens on a direct transport. */
const CHANNEL = "in-document";

/**
 * Both halves in one document, as when Critiqs is installed: the page layer
 * draws into the same shadow root as the panel (`shadow`, passed in, since a
 * closed root is hidden from `host.shadowRoot`), under it, and the two talk
 * through direct calls.
 */
export function inDocumentPage(host: HTMLElement, shadow: ShadowRoot, pageHost: PageHost): { layer: PageLayer; link: PageLink; destroy(): void } {
  const [panelSide, pageSide] = directTransports();
  // After the panel's own content; its layer sits under the panel's, so the toolbar, sidebar, and windows stay above pins.
  const container = document.createElement("div");
  shadow.append(container);
  const layer = createPageLayer({ transport: pageSide, channel: CHANNEL, host, shadow, container, pageHost });
  const link = new PageLink(panelEndpoint(panelSide, { channel: CHANNEL }), { initial: layer.state(), element: layer.element });
  return {
    layer,
    link,
    destroy() {
      link.close();
      layer.destroy();
      panelSide.close();
      queueMicrotask(() => container.remove());
    },
  };
}
