import { ConvexProviderWithAuth, ConvexReactClient, useConvexAuth } from "convex/react";
import { type ReactNode, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { type Auth, AuthContext, BackendContext, convexBackend, resolveBackend } from "./backend.ts";
import { copy } from "./copy.ts";
import { clearFlowOnSignOut, sessionStore } from "./flow.ts";
import { routeOf } from "./route.ts";
import { type Deployment, HOSTED_BACKEND_URL, Session } from "./shared.ts";
import { Onboarding } from "./ui/Onboarding.tsx";
import { Account } from "./ui/parts.tsx";
import { Logo } from "./ui/Preview.tsx";
import { SetupPage } from "./ui/SetupPage.tsx";
import { ThreadPage } from "./ui/ThreadPage.tsx";

/** Critiqs Cloud's Convex deployment, or the one `VITE_CRITIQS_BACKEND` names. */
const BACKEND = (import.meta.env.VITE_CRITIQS_BACKEND as string | undefined)?.trim() || HOSTED_BACKEND_URL;
/** What a prototype's <Critiqs /> needs as its `backend` property to reach that backend; none for Critiqs Cloud, its default. */
const COMPONENT_BACKEND = BACKEND === HOSTED_BACKEND_URL ? null : BACKEND;

export function App() {
  const route = useMemo(() => {
    const found = routeOf(window.location.pathname);
    if (found.page === "start" && window.location.pathname !== "/start") window.history.replaceState(null, "", "/start");
    return found;
  }, []);
  const [deployment, setDeployment] = useState<{ status: "loading" } | { status: "ready"; deployment: Deployment; createKeys: boolean } | { status: "error"; message: string }>({
    status: "loading",
  });
  useEffect(() => {
    resolveBackend(BACKEND).then(
      ({ deployment, createKeys }) => setDeployment({ status: "ready", deployment, createKeys }),
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
  return (
    <Connected deployment={deployment.deployment} createKeys={deployment.createKeys}>
      <div className="app">
        {header(true)}
        <main className={route.page === "setup" ? "page narrow" : route.page === "thread" ? "page thread" : "page"}>
          {route.page === "setup" ? <SetupPage id={route.id} /> : route.page === "thread" ? <ThreadPage pageKey={route.key} /> : <Onboarding />}
        </main>
      </div>
    </Connected>
  );
}

/** Critiqs's backend and sign-in, for the page inside. */
function Connected({ deployment, createKeys, children }: { deployment: Deployment; createKeys: boolean; children: ReactNode }) {
  const session = useMemo(() => new Session(deployment.signInUrl), [deployment.signInUrl]);
  const client = useMemo(() => new ConvexReactClient(deployment.backendUrl), [deployment.backendUrl]);
  const backend = useMemo(
    () => convexBackend(client, COMPONENT_BACKEND, { siteUrl: deployment.siteUrl, getToken: () => session.fetchAccessToken({ forceRefreshToken: false }) }, createKeys),
    [client, deployment.siteUrl, session, createKeys],
  );
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
        <SessionAuth session={session}>{children}</SessionAuth>
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
