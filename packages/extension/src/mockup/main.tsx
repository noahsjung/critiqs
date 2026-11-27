import { createRoot } from "react-dom/client";
import { attachHost } from "../../../react/src/connect.tsx";
import { chromeApi } from "../chrome.ts";
import { PANEL_STYLES } from "../panel/styles.ts";
import { MockupWindow } from "./MockupWindow.tsx";

// The Mockup tab's page: Mockup mode for one tab's page and project, named in its address.
const address = new URLSearchParams(location.search);
const tabId = Number(address.get("tab"));
const projectId = address.get("project");
const mockupId = address.get("mockup");
const request = mockupId === null ? null : { mockupId, threadId: address.get("thread") };
const { host, container } = attachHost(document.body);
const style = document.createElement("style");
style.textContent = PANEL_STYLES;
host.shadowRoot!.append(style);
createRoot(container).render(
  Number.isInteger(tabId) && tabId >= 0 && projectId !== null ? <MockupWindow chrome={chromeApi()} tabId={tabId} projectId={projectId} request={request} /> : null,
);
