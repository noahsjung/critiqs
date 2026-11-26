// The prototype's half of the two-document check: only the page layer, in a
// page that knows nothing of Critiqs's interface. It answers the page around
// its frame, and only that page at that origin.
import { windowTransport } from "@critiqs/core";
import { mountPageLayer } from "../../../react/src/page-layer/mount.tsx";

const script = document.currentScript as HTMLScriptElement;
mountPageLayer({
  transport: windowTransport({ self: window, peer: window.parent, peerOrigin: script.dataset.panelOrigin! }),
  channel: "two-documents",
  host: { getContext: () => ({ screen: "team-settings", viewState: { tab: "members" } }) },
});
