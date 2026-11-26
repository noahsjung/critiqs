import { createRoot } from "react-dom/client";
import { attachHost } from "../../../react/src/connect.tsx";
import { chromeApi } from "../chrome.ts";
import { Shell } from "./Shell.tsx";
import { PANEL_STYLES } from "./styles.ts";

// The side panel's page. The worker opens it for one tab, named in its address.
const address = new URLSearchParams(location.search);
const tabId = Number(address.get("tab"));
// The comment whose pin opened the panel, if one did.
const openThread = address.get("thread") ?? undefined;
const { host, container } = attachHost(document.body);
const style = document.createElement("style");
style.textContent = PANEL_STYLES;
host.shadowRoot!.append(style);
createRoot(container).render(Number.isInteger(tabId) && tabId >= 0 ? <Shell chrome={chromeApi()} tabId={tabId} openThread={openThread} /> : null);
