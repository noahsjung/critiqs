import type { ConvexReactClient } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type AccountItem, App, type MockupPlace, type ReviewSurface, type SupplyCapture } from "./App.tsx";
import { HOST_TAG } from "./constants.ts";
import { convexClient } from "./convex/client.ts";
import { convexTransport } from "./convex/transport.tsx";
import { checkProject, type Deployment, HOSTED_BACKEND_URL, type PanelSurface, resolveDeployment } from "./deployment.ts";
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
export function mountShadowRoot(): { root: Root; host: HTMLElement; shadow: ShadowRoot } {
  const { host, shadow, container } = attachHost(document.body);
  return { root: createRoot(container), host, shadow };
}

/**
 * Critiqs's element in `parent`, with a shadow root holding Critiqs's styles
 * and an empty container to render into. The root is open unless `mode` says
 * closed, as the browser extension draws it, so the page can't read Critiqs;
 * either way it is returned, for everything that draws into it.
 */
export function attachHost(parent: Element, { mode = "open" }: { mode?: ShadowRootMode } = {}): { host: HTMLElement; shadow: ShadowRoot; container: HTMLElement } {
  const host = document.createElement(HOST_TAG);
  // Inline and important, so page rules such as `* { font-family: … }` cannot
  // style the host element and be inherited into Critiqs.
  host.style.setProperty("all", "initial", "important");
  // Turbo 8's morph refresh removes elements the server's new page lacks; it
  // leaves permanent ones. (Without an id, the mark does nothing on visits.)
  host.setAttribute("data-turbo-permanent", "");
  parent.appendChild(host);
  const shadow = host.attachShadow({ mode });
  const container = document.createElement("div");
  shadow.append(container);
  adoptStyles(shadow);
  // Keys typed into Critiqs's fields must not trigger the prototype's own shortcuts.
  const contain = (event: Event) => event.stopPropagation();
  for (const type of ["keydown", "keyup", "keypress"]) shadow.addEventListener(type, contain);
  return { host, shadow, container };
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
  /**
   * The browser extension draws the panel in the reviewed page itself: its
   * threads record that they came from the extension, and it never reports
   * the project as Connected, which only an install does.
   */
  surface?: PanelSurface;
  /** Shortcuts ignore key events the page's own scripts make up, as where the panel runs inside a page it doesn't trust. */
  trustedEventsOnly?: boolean;
  /** More items in the account menu, after Critiqs's own, such as the extension's. */
  accountItems?: AccountItem[];
}

/** Critiqs's element, and the shadow root it renders in, which a closed root hides from `host.shadowRoot`. */
type Placed = { props: CritiqsProps; host: HTMLElement; shadow: ShadowRoot };

export function Connect({ props, host, shadow, ...page }: Placed & PanelPage) {
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
  return <Connected props={props} host={host} shadow={shadow} deployment={deployment} {...page} />;
}

type ConnectedProps = Placed & { deployment: Deployment } & PanelPage;

function Connected(args: ConnectedProps) {
  return args.deployment.transport === "http" ? <ConnectedHttp {...args} /> : <ConnectedConvex {...args} />;
}

/** A server in the host app: cookie sign-in on this site, checked for changes every few seconds. */
function ConnectedHttp({ props, host, shadow, deployment, page, supplyCapture, review, surface, trustedEventsOnly, accountItems }: ConnectedProps) {
  const session = useMemo(() => new CookieSession(deployment.backendUrl, deployment.signIn), [deployment.backendUrl, deployment.signIn]);
  const transport = useMemo(() => httpTransport(deployment, session), [deployment, session]);
  useEffect(() => {
    void session.refresh().catch(() => undefined);
  }, [session]);
  return (
    <TransportContext.Provider value={transport}>
      <App props={props} deployment={deployment} session={session} host={host} shadow={shadow} page={page} supplyCapture={supplyCapture} review={review} surface={surface} trustedEventsOnly={trustedEventsOnly} accountItems={accountItems} />
    </TransportContext.Provider>
  );
}

function ConnectedConvex({ props, host, shadow, deployment, session: own, surface, ...panel }: ConnectedProps) {
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
    () => (client === null ? null : convexTransport(client, deployment, session, surface)),
    [client, deployment, session, surface],
  );

  if (transport === null) return null;
  return (
    <TransportContext.Provider value={transport}>
      {transport.wrap(
        <App props={props} deployment={deployment} session={session} host={host} shadow={shadow} surface={surface} {...panel} />,
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
