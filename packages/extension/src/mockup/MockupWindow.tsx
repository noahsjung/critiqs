import { panelSignIn } from "@critiqs/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type Deployment, resolveDeployment } from "../../../react/src/deployment.ts";
import { mountPanel } from "../../../react/src/page-layer/mount.tsx";
import { backendProblem } from "../backend.ts";
import type { ChromeApi } from "../chrome.ts";
import { BACKEND_URL, CHANNEL, MOCKUP_PORT } from "../config.ts";
import { leaveMockupTab } from "../mockup-tab.ts";
import { tabConnection } from "../panel/page-connection.ts";
import { Frame, Screen } from "../panel/Shell.tsx";
import { ExtensionSession } from "../session.ts";

/** How long the tab waits for the reviewed page's page layer before saying how to bring it back. */
const PAGE_WAIT_MS = 2500;

type Connected = { deployment: Deployment; session: ExtensionSession };

/**
 * The Mockup tab: Critiqs's panel in Mockup mode alone, over the whole tab,
 * for the reviewed tab's page. Its copies come from a page layer of its own in
 * that page. The reviewer is the side panel's: the session is the extension's.
 */
export function MockupWindow({ chrome, tabId, projectId, request }: { chrome: ChromeApi; tabId: number; projectId: string; request: { mockupId: string; threadId: string | null } | null }) {
  const [backend, setBackend] = useState<Connected | { error: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    resolveDeployment(BACKEND_URL)
      .then(async (deployment) => {
        const problem = backendProblem(deployment);
        if (problem !== null) throw new Error(problem);
        const session = new ExtensionSession(deployment.signInUrl, panelSignIn(deployment.signInUrl), chrome.storage.local, chrome.storage.onChanged);
        await session.ready;
        if (!cancelled) setBackend({ deployment, session });
      })
      .catch((error) => !cancelled && setBackend({ error: error instanceof Error ? error.message : String(error) }));
    return () => {
      cancelled = true;
    };
  }, [chrome]);
  // The reviewed tab closed: there is no page left to freeze.
  useEffect(() => {
    const onRemoved = (removed: number) => {
      if (removed === tabId) void leaveMockupTab(chrome, tabId);
    };
    chrome.tabs.onRemoved.addListener(onRemoved);
    return () => chrome.tabs.onRemoved.removeListener(onRemoved);
  }, [chrome, tabId]);

  if (backend === null) return <Frame />;
  if ("error" in backend) return <Screen title="Critiqs can't connect" line={backend.error} />;
  return <Signed {...backend} chrome={chrome} tabId={tabId} projectId={projectId} request={request} />;
}

function Signed({ deployment, session, chrome, tabId, projectId, request }: Connected & { chrome: ChromeApi; tabId: number; projectId: string; request: { mockupId: string; threadId: string | null } | null }) {
  const { reviewer } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const box = useRef<HTMLDivElement>(null);
  const [waiting, setWaiting] = useState(false);
  const signedIn = reviewer !== null;
  useEffect(() => {
    if (!signedIn) return;
    const connection = tabConnection(chrome, tabId, MOCKUP_PORT);
    const timer = setTimeout(() => setWaiting(!connection.connected()), PAGE_WAIT_MS);
    const stop = connection.onChange(() => setWaiting(!connection.connected()));
    connection.connect();
    const mounted = mountPanel(box.current!, {
      transport: connection.transport,
      channel: CHANNEL,
      projectId,
      backend: deployment.backendUrl,
      session,
      mockups: { kind: "window", request, leave: () => void leaveMockupTab(chrome, tabId) },
    });
    return () => {
      clearTimeout(timer);
      stop();
      mounted.destroy();
      connection.transport.close();
    };
  }, [signedIn, chrome, tabId, projectId, deployment.backendUrl, session, request]);
  if (!signedIn) return <Screen title="Sign in from the side panel" line="Mockup mode opens once you're signed in to Critiqs in the page's side panel." />;
  return (
    <>
      <div ref={box} />
      {waiting && (
        <Screen title="Click the Critiqs icon on the page" line="Mockup mode freezes the page in the tab you came from. Chrome lets Critiqs see it again after a click on the icon there." />
      )}
    </>
  );
}
