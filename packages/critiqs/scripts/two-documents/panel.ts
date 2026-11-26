// The panel's half of the two-document check: Critiqs's toolbar, sidebar,
// threads, and backend connection, in the page around the prototype's frame.
import { windowTransport } from "@critiqs/core";
import { mountPanel } from "../../../react/src/page-layer/mount.tsx";

const script = document.currentScript as HTMLScriptElement;
const frame = document.querySelector<HTMLIFrameElement>("#prototype")!;
const supplied = new URL(location.href).searchParams.has("supply");

/** A screenshot "from elsewhere", as an extension's captureVisibleTab would give: here, a teal image of the frame's size at twice its pixels. */
async function supplyCapture(): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = frame.clientWidth * 2;
  canvas.height = frame.clientHeight * 2;
  const drawing = canvas.getContext("2d")!;
  drawing.fillStyle = "#14b8a6";
  drawing.fillRect(0, 0, canvas.width, canvas.height);
  (window as { suppliedCaptures?: number }).suppliedCaptures = ((window as { suppliedCaptures?: number }).suppliedCaptures ?? 0) + 1;
  return await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"));
}

mountPanel(document.body, {
  transport: windowTransport({ self: window, peer: frame.contentWindow!, peerOrigin: script.dataset.pageOrigin! }),
  channel: "two-documents",
  projectId: script.dataset.projectId!,
  backend: "/critiqs",
  ...(supplied ? { supplyCapture } : {}),
});
