import type { ConvexReactClient } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App, type MockupPlace, type ReviewSurface, type SupplyCapture } from "./App.tsx";
import { HOST_TAG } from "./constants.ts";
import { convexClient } from "./convex/client.ts";
import { convexTransport } from "./convex/transport.tsx";
import { checkProject, type Deployment, HOSTED_BACKEND_URL, resolveDeployment } from "./deployment.ts";
import type { CritiqsProps } from "./host.ts";
import { CookieSession } from "./http/session.ts";
import { httpTransport } from "./http/transport.tsx";
import type { PageLink } from "./page-layer/link.ts";
import { Session, type TokenSession } from "./session.ts";
import { STYLES } from "./styles.ts";
import { TransportContext } from "./transport.ts";

// Critiqs's own element on a page, and the panel's connection to its backend.

/**
 * Critiqs's styles as a constructed stylesheet, which a page's Content
 * Security Policy doesn't block the way it blocks a <style> element without
 * the page's nonce; a <style> element where constructed stylesheets aren't
 * supported.
 */
function adoptStyles(shadow: ShadowRoot) {
  // Where they aren't supported, setting adoptedStyleSheets throws nothing and styles nothing.
  if ("adoptedStyleSheets" in ShadowRoot.prototype && "replaceSync" in CSSStyleSheet.prototype) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(STYLES);
    shadow.adoptedStyleSheets = [sheet];
    return;
  }
  const style = document.createElement("style");
  style.textContent = STYLES;
  shadow.prepend(style);
}

/** A shadow root on the page's body, isolating Critiqs's styles from the app's in both directions. */
export function mountShadowRoot(): { root: Root; host: HTMLElement } {
  const { host, container } = attachHost(document.body);
  return { root: createRoot(container), host };
}

/**
 * Critiqs's element in `parent`, with a shadow root holding Critiqs's styles
 * and an empty container to render into.
 */
export function attachHost(parent: Element): { host: HTMLElement; container: HTMLElement } {
  const host = document.createElement(HOST_TAG);
  // Inline and important, so page rules such as `* { font-family: … }` cannot
  // style the host element and be inherited into Critiqs.
  host.style.setProperty("all", "initial", "important");
  // Turbo 8's morph refresh removes elements the server's new page lacks; it
  // leaves permanent ones. (Without an id, the mark does nothing on visits.)
  host.setAttribute("data-turbo-permanent", "");
  parent.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const container = document.createElement("div");
  shadow.append(container);
  adoptStyles(shadow);
  // Keys typed into Critiqs's fields must not trigger the prototype's own shortcuts.
  const contain = (event: Event) => event.stopPropagation();
  for (const type of ["keydown", "keyup", "keypress"]) shadow.addEventListener(type, contain);
  return { host, container };
}

/** Where the panel's page layer runs, when not in this document, and where captures come from. */
export interface PanelPage {
  page?: PageLink;
  supplyCapture?: SupplyCapture;
  /**
   * The reviewer's sign-in where the panel keeps its own, such as the
   * extension's side panel, which signs in without a popup and stores the
   * session in the extension. Convex backends only; otherwise the popup's.
   */
  session?: TokenSession;
  /** A comment to open as a link to it would, such as the one whose pin opened the side panel. */
  openThread?: string;
  /** Where Mockup mode opens when the panel isn't drawn over the page, such as the extension's side panel. Convex backends only. */
  mockups?: MockupPlace;
  /** A review link's page around the panel, which owns its mode, sign-in and widths. */
  review?: ReviewSurface;
}

export function Connect({ props, host, page, supplyCapture, session, openThread, mockups, review }: { props: CritiqsProps; host: HTMLElement } & PanelPage) {
  const backendUrl = props.backend ?? HOSTED_BACKEND_URL;
  const required = props.requireProjectId === true;
  // Only a required project is checked against the backend, so only its changes start a new check.
  const projectId = required ? props.projectId : undefined;
  const [deployment, setDeployment] = useState<Deployment | { error: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDeployment(null);
    (async () => {
      const resolved = await resolveDeployment(backendUrl);
      // Configured through the environment: a project the backend doesn't know stays hidden from visitors.
      if (projectId !== undefined && (await checkProject(resolved, projectId)) === "missing") {
        throw new Error(`The project ${projectId} doesn't exist on the Critiqs backend at ${resolved.backendUrl}. Check this app's project ID setting and backend.`);
      }
      return resolved;
    })()
      .then((resolved) => !cancelled && setDeployment(resolved))
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        if (required) console.warn(`Critiqs: ${message} Critiqs stays hidden; run npx critiqs doctor to check the setup.`);
        setDeployment({ error: message });
      });
    return () => {
      cancelled = true;
    };
  }, [backendUrl, required, projectId]);

  if (deployment === null) return null;
  if ("error" in deployment) return required ? null : <Unavailable message={deployment.error} />;
  return <Connected props={props} host={host} deployment={deployment} page={page} supplyCapture={supplyCapture} session={session} openThread={openThread} mockups={mockups} review={review} />;
}

type ConnectedProps = { props: CritiqsProps; host: HTMLElement; deployment: Deployment } & PanelPage;

function Connected(args: ConnectedProps) {
  return args.deployment.transport === "http" ? <ConnectedHttp {...args} /> : <ConnectedConvex {...args} />;
}

/** A server in the host app: cookie sign-in on this site, checked for changes every few seconds. */
function ConnectedHttp({ props, host, deployment, page, supplyCapture, review }: ConnectedProps) {
  const session = useMemo(() => new CookieSession(deployment.backendUrl, deployment.signIn), [deployment.backendUrl, deployment.signIn]);
  const transport = useMemo(() => httpTransport(deployment, session), [deployment, session]);
  useEffect(() => {
    void session.refresh().catch(() => undefined);
  }, [session]);
  return (
    <TransportContext.Provider value={transport}>
      <App props={props} deployment={deployment} session={session} host={host} page={page} supplyCapture={supplyCapture} review={review} />
    </TransportContext.Provider>
  );
}

function ConnectedConvex({ props, host, deployment, page, supplyCapture, session: own, openThread, mockups, review }: ConnectedProps) {
  const session = useMemo(() => own ?? new Session(deployment.signInUrl), [own, deployment.signInUrl]);
  // Created in an effect so its cleanup closes the same client; StrictMode
  // remounts would otherwise reuse a closed one.
  const [client, setClient] = useState<ConvexReactClient | null>(null);
  useEffect(() => {
    const created = convexClient(deployment.backendUrl);
    setClient(created);
    // Close after the Convex provider's own cleanup, which still uses the client.
    return () => void setTimeout(() => void created.close());
  }, [deployment.backendUrl]);

  const transport = useMemo(
    () => (client === null ? null : convexTransport(client, deployment, session)),
    [client, deployment, session],
  );

  if (transport === null) return null;
  return (
    <TransportContext.Provider value={transport}>
      {transport.wrap(
        <App props={props} deployment={deployment} session={session} host={host} page={page} supplyCapture={supplyCapture} openThread={openThread} mockups={mockups} review={review} />,
      )}
    </TransportContext.Provider>
  );
}

function Unavailable({ message }: { message: string }) {
  return (
    <div className="layer">
      <div className="toolbar" style={{ left: "50%", bottom: 16, transform: "translateX(-50%)" }} role="status">
        <span className="hint">{message}</span>
      </div>
    </div>
  );
}
