import type { ProjectInfo } from "@critiqs/core";
import { useEffect, useRef } from "react";
import type { Deployment } from "../../../react/src/deployment.ts";
import { mountPanel } from "../../../react/src/page-layer/mount.tsx";
import type { TokenSession } from "../../../react/src/session.ts";
import { setSidebarWidth, sidebarFillsWindow } from "../../../react/src/ui/sidebar-width.tsx";
import { CHANNEL } from "../config.ts";
import type { TabConnection } from "./page-connection.ts";

/** Where Critiqs's panel keeps whether its sidebar is open (`useStoredState` in App.tsx). */
const SIDEBAR_OPEN = "critiqs:sidebar-open";

/**
 * Critiqs's own panel (toolbar, sidebar, threads) for the chosen project,
 * connected to the page layer in the tab. It is the same panel an install
 * shows, drawn in the side panel instead of over the page. Mockup mode isn't
 * offered here: its page copy is drawn over the page, which a side panel
 * can't do yet.
 */
export function Review({
  project,
  deployment,
  connection,
  session,
  supplyCapture,
  takeOpenThread,
}: {
  project: ProjectInfo;
  deployment: Deployment;
  connection: TabConnection;
  session: TokenSession;
  supplyCapture: () => Promise<Blob | null>;
  /** The comment whose pin opened the side panel, to open first. */
  takeOpenThread: () => string | undefined;
}) {
  const box = useRef<HTMLDivElement>(null);
  const capture = useRef(supplyCapture);
  capture.current = supplyCapture;
  useEffect(() => {
    // The side panel is where the list belongs: Critiqs's sidebar opens with it, rather than as installed, closed until asked,
    // and fills the side panel, which has no page beside it.
    try {
      localStorage.setItem(SIDEBAR_OPEN, "true");
    } catch {
      // Without storage the sidebar starts closed, as installed.
    }
    sidebarFillsWindow();
    const fill = () => setSidebarWidth(window.innerWidth);
    fill();
    window.addEventListener("resize", fill);
    const mounted = mountPanel(box.current!, {
      transport: connection.transport,
      channel: CHANNEL,
      projectId: project._id,
      backend: deployment.backendUrl,
      session,
      supplyCapture: () => capture.current(),
      openThread: takeOpenThread(),
    });
    return () => {
      window.removeEventListener("resize", fill);
      mounted.destroy();
    };
  }, [project._id, deployment.backendUrl, connection, session]);
  return <div ref={box} className="xt-review" />;
}
