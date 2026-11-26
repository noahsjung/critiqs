import { ConvexProviderWithAuth, ConvexReactClient, useConvexAuth } from "convex/react";
import { type ReactNode, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { type Auth, AuthContext, BackendContext, convexBackend } from "./backend.ts";
import { copy } from "./copy.ts";
import { clearFlowOnSignOut, sessionStore } from "./flow.ts";
import { routeOf } from "./route.ts";
import { type Deployment, HOSTED_BACKEND_URL, resolveDeployment, Session } from "./shared.ts";
import { Onboarding } from "./ui/Onboarding.tsx";
import { SetupPage } from "./ui/SetupPage.tsx";

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
  const [deployment, setDeployment] = useState<{ status: "loading" } | { status: "ready"; deployment: Deployment } | { status: "error"; message: string }>({ status: "loading" });
  useEffect(() => {
    resolveDeployment(BACKEND).then(
      (deployment) => setDeployment({ status: "ready", deployment }),
      (error: unknown) => setDeployment({ status: "error", message: error instanceof Error ? error.message : String(error) }),
    );
  }, []);

  return (
    <main className="page">
      <p className="brand">{copy.appName}</p>
      {deployment.status === "loading" && <p className="note">{copy.loading}</p>}
      {deployment.status === "error" && (
        <>
          <h1>{copy.deployment.title}</h1>
          <p className="error">{deployment.message}</p>
        </>
      )}
      {deployment.status === "ready" && (
        <Connected deployment={deployment.deployment}>{route.page === "setup" ? <SetupPage id={route.id} /> : <Onboarding />}</Connected>
      )}
    </main>
  );
}

/** Critiqs's backend and sign-in, for the page inside. */
function Connected({ deployment, children }: { deployment: Deployment; children: ReactNode }) {
  const session = useMemo(() => new Session(deployment.signInUrl), [deployment.signInUrl]);
  const client = useMemo(() => new ConvexReactClient(deployment.backendUrl), [deployment.backendUrl]);
  const backend = useMemo(() => convexBackend(client, COMPONENT_BACKEND), [client]);
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
