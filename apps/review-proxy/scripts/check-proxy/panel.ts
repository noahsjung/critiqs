// The review page's half of the proxy check: Critiqs's panel around a frame
// served by the review proxy, talking to the page layer the proxy injected,
// with the limits for an untrusted frame. Frame messages are kept on
// `window.frameMessages` for the check to read.
import { parseReviewFrameMessage, UNTRUSTED_PAGE_LIMITS, windowTransport } from "@critiqs/core";
import { mountPanel } from "../../../../packages/react/src/page-layer/mount.tsx";

const script = document.currentScript as HTMLScriptElement;
const frame = document.querySelector<HTMLIFrameElement>("#prototype")!;
const frameOrigin = new URL(frame.src).origin;
const kept: unknown[] = [];
(window as { frameMessages?: unknown[] }).frameMessages = kept;
window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow || event.origin !== frameOrigin) return;
  const message = parseReviewFrameMessage(event.data);
  if (message !== null) kept.push(message);
});

mountPanel(document.body, {
  transport: windowTransport({ self: window, peer: frame.contentWindow!, peerOrigin: frameOrigin }),
  channel: "review-link",
  projectId: script.dataset.projectId!,
  backend: "/critiqs",
  pageLimits: UNTRUSTED_PAGE_LIMITS,
});
