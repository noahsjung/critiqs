import { ConvexProviderWithAuth, useConvexAuth } from "convex/react";
import { type ReactNode, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { type Auth, AuthContext, BackendContext, type BackendFeatures, convexBackend, resolveBackend } from "./backend.ts";
import { copy } from "./copy.ts";
import { clearFlowOnSignOut, sessionStore } from "./flow.ts";
import { routeOf } from "./route.ts";
import { convexClient, type Deployment, HOSTED_BACKEND_URL, loadPanel, Session } from "./shared.ts";
import { Onboarding } from "./ui/Onboarding.tsx";
import { Account } from "./ui/parts.tsx";
import { Logo } from "./ui/Preview.tsx";
import { ReviewHostContext, ReviewPage } from "./ui/ReviewPage.tsx";
import { ReviewLinksPage } from "./ui/ReviewLinks.tsx";
import { SetupPage } from "./ui/SetupPage.tsx";
import { ThreadPage } from "./ui/ThreadPage.tsx";
import { extensionLink } from "./ui/Ways.tsx";

/** Critiqs Cloud's Convex deployment, or the one `VITE_CRITIQS_BACKEND` names. */
const BACKEND = (import.meta.env.VITE_CRITIQS_BACKEND as string | undefined)?.trim() || HOSTED_BACKEND_URL;
/** What a prototype's <Critiqs /> needs as its `backend` property to reach that backend; none for Critiqs Cloud, its default. */
const COMPONENT_BACKEND = BACKEND === HOSTED_BACKEND_URL ? null : BACKEND;
/** Where a review link's page sends people for the browser extension: its store listing, or how to load it. */
const EXTENSION_URL = extensionLink(import.meta.env.VITE_CRITIQS_EXTENSION_URL as string | undefined);

export function App() {
  const route = useMemo(() => {
    const found = routeOf(window.location.pathname);
    if (found.page === "start" && window.location.pathname !== "/start") window.history.replaceState(null, "", "/start");
    return found;
  }, []);
  const [deployment, setDeployment] = useState<{ status: "loading" } | { status: "ready"; deployment: Deployment; features: BackendFeatures } | { status: "error"; message: string }>({
    status: "loading",
  });
  useEffect(() => {
    resolveBackend(BACKEND).then(
      ({ deployment, ...features }) => setDeployment({ status: "ready", deployment, features }),
      (error: unknown) => setDeployment({ status: "error", message: error instanceof Error ? error.message : String(error) }),
    );
  }, []);

  const header = (account: boolean) => (
    <header className="topbar">
      <a className="brand" href="https://critiqs.app/">
        <Logo />
        {copy.appName}
      </a>
      {account && <Account />}
    </header>
  );
  if (deployment.status !== "ready") {
    return (
      <div className="app">
        {header(false)}
        <main className="page">
          {deployment.status === "loading" && <p className="note">{copy.loading}</p>}
          {deployment.status === "error" && (
            <>
              <h1>{copy.deployment.title}</h1>
              <p className="error">{deployment.message}</p>
            </>
          )}
        </main>
      </div>
    );
  }
  // A review link's page fills the window: the prototype's frame and the panel, under its own bar.
  if (route.page === "review") {
    return (
      <Connected deployment={deployment.deployment} features={deployment.features}>
        <ReviewPage linkKey={route.key} />
      </Connected>
    );
  }
  return (
    <Connected deployment={deployment.deployment} features={deployment.features}>
      <div className="app">
        {header(true)}
        <main className={route.page === "setup" ? "page narrow" : route.page === "thread" ? "page thread" : "page"}>
          {route.page === "setup" ? (
            <SetupPage id={route.id} />
          ) : route.page === "thread" ? (
            <ThreadPage pageKey={route.key} />
          ) : route.page === "review-links" ? (
            <ReviewLinksPage projectId={route.projectId} />
          ) : (
            <Onboarding />
          )}
        </main>
      </div>
    </Connected>
  );
}

/** Critiqs's backend and sign-in, for the page inside. */
export function Connected({ deployment, features, children }: { deployment: Deployment; features: BackendFeatures; children: ReactNode }) {
  const session = useMemo(() => new Session(deployment.signInUrl), [deployment.signInUrl]);
  // Built to reuse a saved token that is still good, so loading a page doesn't refresh the sign-in.
  const client = useMemo(() => convexClient(deployment.backendUrl), [deployment.backendUrl]);
  const backend = useMemo(
    () => convexBackend(client, COMPONENT_BACKEND, { siteUrl: deployment.siteUrl, getToken: () => session.fetchAccessToken({ forceRefreshToken: false }) }, features),
    [client, deployment.siteUrl, session, features],
  );
  const reviewHost = useMemo(() => ({ deployment, session, mountPanel: loadPanel, extensionUrl: EXTENSION_URL }), [deployment, session]);
  const { reviewer } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  // Signing out on any page, or in another tab, removes the onboarding draft.
  useEffect(() => clearFlowOnSignOut(session, sessionStore()), [session]);
  // Convex asks for a new token when the reviewer changes.
  const useSessionAuth = useCallback(
    function useSessionAuth() {
      const fetchAccessToken = useCallback((args: { forceRefreshToken: boolean }) => session.fetchAccessToken(args), [reviewer?.id]);
      return { isLoading: false, isAuthenticated: reviewer !== null, fetchAccessToken };
    },
    [session, reviewer?.id],
  );
  return (
    <ConvexProviderWithAuth client={client} useAuth={useSessionAuth}>
      <BackendContext.Provider value={backend}>
        <ReviewHostContext.Provider value={reviewHost}>
          <SessionAuth session={session}>{children}</SessionAuth>
        </ReviewHostContext.Provider>
      </BackendContext.Provider>
    </ConvexProviderWithAuth>
  );
}

function SessionAuth({ session, children }: { session: Session; children: ReactNode }) {
  const { reviewer } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { isAuthenticated } = useConvexAuth();
  const auth = useMemo<Auth>(
    () => ({ reviewer, ready: reviewer !== null && isAuthenticated, signIn: () => session.signIn(), signOut: () => session.signOut() }),
    [reviewer, isAuthenticated, session],
  );
  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}
