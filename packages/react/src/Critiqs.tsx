import { ConvexReactClient } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App.tsx";
import { HOST_TAG } from "./constants.ts";
import { convexTransport } from "./convex/transport.tsx";
import { checkProject, type Deployment, HOSTED_BACKEND_URL, PROJECT_ID_PATTERN, resolveDeployment } from "./deployment.ts";
import type { CritiqsProps } from "./host.ts";
import { CookieSession } from "./http/session.ts";
import { httpTransport } from "./http/transport.tsx";
import { Session } from "./session.ts";
import { STYLES } from "./styles.ts";
import { TransportContext } from "./transport.ts";

/**
 * Critiqs's one component. Add it anywhere in the prototype; it renders its
 * toolbar, sidebar, and pins above the app in a shadow root, with its own
 * sign-in, backend connection, and styles. It renders nothing in place.
 * With `requireProjectId`, it adds nothing to the page until `projectId` is a
 * valid project ID, and removes everything it added when the ID goes away.
 */
export function Critiqs(props: CritiqsProps) {
  const mounted = useRef<{ root: Root; host: HTMLElement } | null>(null);
  const required = props.requireProjectId === true;
  const projectId = required ? requiredProjectId(props.projectId) : props.projectId;
  const active = !required || projectId !== undefined;

  useEffect(() => {
    if (!active) return;
    const { root, host } = mountShadowRoot();
    mounted.current = { root, host };
    return () => {
      mounted.current = null;
      // Unmounting a root while the host app is rendering is not allowed; wait a tick.
      setTimeout(() => {
        root.unmount();
        host.remove();
      });
    };
  }, [active]);

  // A value that is set but isn't a project ID is a mistake worth telling the developer about; an unset one is how Critiqs is turned off.
  const malformed = required && !active && typeof props.projectId === "string" && props.projectId.trim() !== "" ? props.projectId : null;
  useEffect(() => {
    if (malformed !== null) {
      console.warn(
        `Critiqs: ${JSON.stringify(malformed.slice(0, 80))} is not a Critiqs project ID, so Critiqs stays hidden. ` +
          "Set this app's project ID setting to the ID from project setup in the Critiqs sidebar, or run npx critiqs-react doctor.",
      );
    }
  }, [malformed]);

  // A separate React root, rather than a portal: events inside Critiqs do not
  // bubble through the host app's components, and host contexts do not leak in.
  useEffect(() => {
    if (mounted.current === null) return;
    mounted.current.root.render(<Connect props={required ? { ...props, projectId } : props} host={mounted.current.host} />);
  });

  return null;
}

/** A required project ID, trimmed, or undefined when it is missing or isn't a project ID. */
function requiredProjectId(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return PROJECT_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** A shadow root on the page's body, isolating Critiqs's styles from the app's in both directions. */
function mountShadowRoot(): { root: Root; host: HTMLElement } {
  const host = document.createElement(HOST_TAG);
  // Inline and important, so page rules such as `* { font-family: … }` cannot
  // style the host element and be inherited into Critiqs.
  host.style.setProperty("all", "initial", "important");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = STYLES;
  const container = document.createElement("div");
  shadow.append(style, container);
  // Keys typed into Critiqs's fields must not trigger the prototype's own shortcuts.
  const contain = (event: Event) => event.stopPropagation();
  for (const type of ["keydown", "keyup", "keypress"]) shadow.addEventListener(type, contain);
  return { root: createRoot(container), host };
}

function Connect({ props, host }: { props: CritiqsProps; host: HTMLElement }) {
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
        if (required) console.warn(`Critiqs: ${message} Critiqs stays hidden; run npx critiqs-react doctor to check the setup.`);
        setDeployment({ error: message });
      });
    return () => {
      cancelled = true;
    };
  }, [backendUrl, required, projectId]);

  if (deployment === null) return null;
  if ("error" in deployment) return required ? null : <Unavailable message={deployment.error} />;
  return <Connected props={props} host={host} deployment={deployment} />;
}

function Connected(args: { props: CritiqsProps; host: HTMLElement; deployment: Deployment }) {
  return args.deployment.transport === "http" ? <ConnectedHttp {...args} /> : <ConnectedConvex {...args} />;
}

/** A server in the host app: cookie sign-in on this site, checked for changes every few seconds. */
function ConnectedHttp({ props, host, deployment }: { props: CritiqsProps; host: HTMLElement; deployment: Deployment }) {
  const session = useMemo(() => new CookieSession(deployment.backendUrl, deployment.signIn), [deployment.backendUrl, deployment.signIn]);
  const transport = useMemo(() => httpTransport(deployment, session), [deployment, session]);
  useEffect(() => {
    void session.refresh().catch(() => undefined);
  }, [session]);
  return (
    <TransportContext.Provider value={transport}>
      <App props={props} deployment={deployment} session={session} host={host} />
    </TransportContext.Provider>
  );
}

function ConnectedConvex({ props, host, deployment }: { props: CritiqsProps; host: HTMLElement; deployment: Deployment }) {
  const session = useMemo(() => new Session(deployment.signInUrl), [deployment.signInUrl]);
  // Created in an effect so its cleanup closes the same client; StrictMode
  // remounts would otherwise reuse a closed one.
  const [client, setClient] = useState<ConvexReactClient | null>(null);
  useEffect(() => {
    const created = new ConvexReactClient(deployment.backendUrl);
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
      {transport.wrap(<App props={props} deployment={deployment} session={session} host={host} />)}
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
