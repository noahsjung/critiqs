// The page layer in a review frame: Critiqs's picking, pins and captures on
// the prototype, answering only the review page around the frame, at one of
// the website origins the proxy names and only from the parent window
// (windowTransport). It holds no token and never talks to Critiqs's backend.
import { windowTransport } from "@critiqs/core";
import { mountPageLayer } from "../../../packages/react/src/page-layer/mount.tsx";

const script = document.currentScript as HTMLScriptElement;
const origins = JSON.parse(script.dataset.panelOrigins ?? "[]") as string[];
// The review page's origin, where the browser reports it; otherwise the website's first.
const ancestor = (location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins?.[0];
const panelOrigin = ancestor !== undefined && origins.includes(ancestor) ? ancestor : origins[0];

if (panelOrigin !== undefined && window.parent !== window) {
  mountPageLayer({ transport: windowTransport({ self: window, peer: window.parent, peerOrigin: panelOrigin }), channel: script.dataset.channel ?? "review-link" });
}
