import { type ManageableProjects, type PanelSignIn, type ProjectInfo, panelSignIn } from "@critiqs/core";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type Deployment, resolveDeployment } from "../../../react/src/deployment.ts";
import { NavRow, Switch } from "../../../react/src/ui/ds.tsx";
import { BackIcon } from "../../../react/src/ui/icons.tsx";
import { backendMessage, backendProblem, convexProjects } from "../backend.ts";
import { tabScreenshots } from "../capture.ts";
import type { ChromeApi } from "../chrome.ts";
import { BACKEND_URL, type TabState, tabKey } from "../config.ts";
import { addToProject, Choices, findProject, inSeveralOrganizations, StartKeys, waitingFor, type ProjectChoice, type ProjectsApi, pageOrigin, siteName, startReviewing } from "../lookup.ts";
import { ExtensionSession } from "../session.ts";
import { showAutomatically, showsAutomatically, stopShowingAutomatically } from "../site-access.ts";
import { type TabConnection, tabConnection } from "./page-connection.ts";
import { type PageFacts, pageView } from "./page-view.ts";
import { Review } from "./Review.tsx";
import { SignIn } from "./SignIn.tsx";

/** How long the panel waits for the page layer before asking for a click on the icon. */
const PAGE_WAIT_MS = 2500;

type Connected = { deployment: Deployment; client: PanelSignIn; session: ExtensionSession };

/**
 * The side panel for one tab: sign-in, then the page's project, then
 * Critiqs's own panel. `openThread` is the comment whose pin opened it, opened
 * once, the first time Critiqs's panel shows.
 */
export function Shell({ chrome, tabId, openThread }: { chrome: ChromeApi; tabId: number; openThread?: string }) {
  const pending = useRef(openThread);
  const takeOpenThread = useCallback(() => {
    const threadId = pending.current;
    pending.current = undefined;
    return threadId;
  }, []);
  const [backend, setBackend] = useState<Connected | { error: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setBackend(null);
    resolveDeployment(BACKEND_URL).then(
      async (deployment) => {
        const problem = backendProblem(deployment);
        if (problem !== null) throw new Error(problem);
        const client = panelSignIn(deployment.signInUrl);
        const session = new ExtensionSession(deployment.signInUrl, client, chrome.storage.local, chrome.storage.onChanged);
        await session.ready;
        if (!cancelled) setBackend({ deployment, client, session });
      },
    ).catch((error) => !cancelled && setBackend({ error: error instanceof Error ? error.message : String(error) }));
    return () => {
      cancelled = true;
    };
  }, [chrome, attempt]);

  const page = useTabPage(chrome, tabId);
  if (backend === null) return <Frame />;
  if ("error" in backend) {
    return (
      <Screen title="Critiqs can't connect" line={backend.error}>
        <Actions>
          <button type="button" className="btn primary" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
        </Actions>
      </Screen>
    );
  }
  return <Signed {...backend} chrome={chrome} tabId={tabId} page={page} takeOpenThread={takeOpenThread} />;
}

function Signed({ deployment, client, session, chrome, tabId, page, takeOpenThread }: Connected & { chrome: ChromeApi; tabId: number; page: TabPage; takeOpenThread: () => string | undefined }) {
  const { reviewer } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const view = pageView(page.facts);
  if (view === "built-in") {
    return <Screen title="Built in" line="This site has Critiqs installed. Use the Critiqs button on the page." />;
  }
  if (view === "unsupported") {
    return <Screen title="Critiqs can't open here" line="Chrome doesn't let extensions use pages like this one." />;
  }
  if (reviewer === null) return <Frame><SignIn client={client} session={session} /></Frame>;
  if (view === "checking") return <Frame />;
  if (view === "needs-click" || page.facts.origin === null) {
    return <Screen title="Click the Critiqs icon on this page" line="Chrome lets Critiqs see a page only after you click its icon there." />;
  }
  return <Project key={`${reviewer.id} ${page.facts.origin}`} deployment={deployment} session={session} chrome={chrome} tabId={tabId} origin={page.facts.origin} connection={page.connection} reviewerId={reviewer.id} takeOpenThread={takeOpenThread} />;
}

type Step =
  | { name: "loading" }
  | { name: "error"; message: string }
  | { name: "choose"; projects: ProjectInfo[] }
  | { name: "none" }
  /** `request` tells this picker's answer from one the person already left. */
  | { name: "add"; request: number; projects: ManageableProjects | null; failure: string | null }
  | { name: "review"; project: ProjectInfo; choices: ProjectInfo[] | null }
  | { name: "settings"; project: ProjectInfo; choices: ProjectInfo[] | null };

function Project({
  deployment,
  session,
  chrome,
  tabId,
  origin,
  connection,
  reviewerId,
  takeOpenThread,
}: {
  deployment: Deployment;
  session: ExtensionSession;
  chrome: ChromeApi;
  tabId: number;
  origin: string;
  connection: TabConnection;
  reviewerId: string;
  takeOpenThread: () => string | undefined;
}) {
  const projects: ProjectsApi = useMemo(() => convexProjects(deployment.backendUrl, session), [deployment.backendUrl, session]);
  const choices = useMemo(() => new Choices(chrome.storage.local, deployment.signInUrl), [chrome, deployment.signInUrl]);
  const [step, setStep] = useState<Step>({ name: "loading" });
  const pickerRequests = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [screenshotNote, setScreenshotNote] = useState(false);
  const supplyCapture = useMemo(() => tabScreenshots(chrome, tabId, () => setScreenshotNote(true)), [chrome, tabId]);

  const show = (choice: ProjectChoice) => {
    if (choice.kind === "show") setStep({ name: "review", project: choice.project, choices: choice.choices });
    else if (choice.kind === "choose") setStep({ name: "choose", projects: choice.projects });
    else setStep({ name: "none" });
  };
  const lookUp = useCallback(() => {
    setStep({ name: "loading" });
    findProject(projects, choices, reviewerId, origin).then(show, (failure) => setStep({ name: "error", message: backendMessage(failure) }));
  }, [projects, choices, reviewerId, origin]);
  useEffect(lookUp, [lookUp]);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(backendMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const site = siteName(origin);

  switch (step.name) {
    case "loading":
      return <Frame />;
    case "error":
      return (
        <Screen title="Critiqs can't find this site's project" line={step.message}>
          <Actions>
            <button type="button" className="btn primary" onClick={lookUp}>Try again</button>
          </Actions>
        </Screen>
      );
    case "choose":
      return (
        <Screen title="Which project is this?" line={<>Projects you can reach list <span className="xt-site">{site}</span>.</>}>
          <div className="xt-list">
            {step.projects.map((project) => (
              <NavRow
                key={project._id}
                label={project.name}
                value={project.organization?.name}
                onClick={() => {
                  void choices.remember(reviewerId, origin, project._id);
                  setStep({ name: "review", project, choices: step.projects });
                }}
              />
            ))}
          </div>
        </Screen>
      );
    case "none":
      return (
        <Screen title="No project for this site yet" line={<span className="xt-site">{site}</span>}>
          {error !== null && <p className="error" role="alert">{error}</p>}
          <Actions>
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const keys = new StartKeys(chrome.storage.local, deployment.signInUrl, reviewerId, origin);
                  const started = await startReviewing(projects, origin, keys, globalThis.navigator?.locks ?? null);
                  // The person's answer for this origin, so an origin such as localhost doesn't ask again.
                  if (started.kind === "show" && started.choices === null) await choices.remember(reviewerId, origin, started.project._id);
                  show(started);
                })
              }
            >
              Start reviewing this site
            </button>
          </Actions>
          <Quiet>
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => {
                setError(null);
                const request = ++pickerRequests.current;
                setStep({ name: "add", request, projects: null, failure: null });
                // An answer that comes after the person went back is dropped.
                const answer = (change: Pick<Extract<Step, { name: "add" }>, "projects" | "failure">) =>
                  setStep((current) => (waitingFor(current, request) ? { ...current, ...change } : current));
                projects.manageable().then(
                  (manageable) => answer({ projects: manageable, failure: null }),
                  (failure) => answer({ projects: null, failure: backendMessage(failure) }),
                );
              }}
            >
              Add to a project
            </button>
          </Quiet>
        </Screen>
      );
    case "add": {
      const named = step.projects !== null && inSeveralOrganizations(step.projects.projects);
      return (
        <Screen title="Add this site to a project" line={<span className="xt-site">{site}</span>} onBack={() => (setError(null), setStep({ name: "none" }))}>
          {error !== null && <p className="error" role="alert">{error}</p>}
          {step.failure !== null && <p className="error" role="alert">{step.failure}</p>}
          {step.projects === null ? null : step.projects.projects.length === 0 ? (
            <p className="note">
              {step.projects.complete
                ? "Projects you created, and projects in organizations you're an admin of, show here. You don't have one yet."
                : "Critiqs couldn't list the projects you manage here. You belong to more organizations than it reads."}
            </p>
          ) : (
            <>
              <div className="xt-list">
                {step.projects.projects.map((project) => (
                  <NavRow
                    key={project._id}
                    label={project.name}
                    value={named ? project.organization?.name : undefined}
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await addToProject(projects, project._id, origin);
                        await choices.remember(reviewerId, origin, project._id);
                        setStep({ name: "review", project, choices: null });
                      })
                    }
                  />
                ))}
              </div>
              {!step.projects.complete && <p className="note">Showing the first {step.projects.projects.length} projects.</p>}
            </>
          )}
        </Screen>
      );
    }
    case "review":
    case "settings":
      return (
        <Frame>
          <div className="xt-header">
            <span className="xt-title" title={step.project.name}>{step.project.name}</span>
            <button type="button" className="btn ghost small" onClick={() => setStep({ ...step, name: "settings" })}>Settings</button>
          </div>
          {screenshotNote && (
            <div className="xt-notice" role="status">
              <span>For screenshots with real pixels, click the Critiqs icon on this page.</span>
              <button type="button" className="btn ghost small" onClick={() => setScreenshotNote(false)}>OK</button>
            </div>
          )}
          <Review project={step.project} deployment={deployment} connection={connection} session={session} supplyCapture={supplyCapture} takeOpenThread={takeOpenThread} />
          {step.name === "settings" && (
            <Settings chrome={chrome} origin={origin} session={session} step={step} onBack={() => setStep({ ...step, name: "review" })} onChange={() => setStep({ name: "choose", projects: step.choices ?? [] })} />
          )}
        </Frame>
      );
  }
}

/** The project's settings in the side panel: this site's automatic comments, another project, and signing out. */
function Settings({
  chrome,
  origin,
  session,
  step,
  onBack,
  onChange,
}: {
  chrome: ChromeApi;
  origin: string;
  session: ExtensionSession;
  step: { project: ProjectInfo; choices: ProjectInfo[] | null };
  onBack: () => void;
  onChange: () => void;
}) {
  const [automatic, setAutomatic] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void showsAutomatically(chrome, origin).then(setAutomatic);
  }, [chrome, origin]);
  const { reviewer } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return (
    <div className="xt-settings">
      <div className="ds-dialog-header">
        <button type="button" className="icon-btn" aria-label="Back" onClick={onBack}>
          <BackIcon />
        </button>
        <h3>Settings</h3>
      </div>
      <div className="ds-page">
        <div className="ds-group">
          <div className="ds-row">
            <span className="ds-row-label" id="xt-automatic">Show comments here automatically</span>
            <div className="ds-row-control">
              <Switch
                checked={automatic === true}
                disabled={automatic === null}
                labelledBy="xt-automatic"
                onChange={(on) => {
                  setError(null);
                  // Chrome asks for this site only straight from the click.
                  const change = on ? showAutomatically(chrome, origin) : stopShowingAutomatically(chrome, origin).then(() => false);
                  void change.then((now) => {
                    setAutomatic(now);
                    if (on && !now) setError("Chrome didn't allow Critiqs on this site.");
                  });
                }}
              />
            </div>
          </div>
          {error !== null && <p className="error" role="alert">{error}</p>}
          {step.choices !== null && step.choices.length > 1 && <NavRow label="Project" value={step.project.name} onClick={onChange} />}
        </div>
        <div className="xt-who">
          Signed in as {reviewer?.name} ({reviewer?.email})
        </div>
        <Quiet>
          <button type="button" className="btn ghost danger" onClick={() => void session.signOut()}>Sign out</button>
        </Quiet>
      </div>
    </div>
  );
}

interface TabPage {
  facts: PageFacts;
  connection: TabConnection;
}

/** What the panel knows about its tab's page: its address, the worker's notes, and the page layer's connection. */
function useTabPage(chrome: ChromeApi, tabId: number): TabPage {
  const connection = useMemo(() => tabConnection(chrome, tabId), [chrome, tabId]);
  const [url, setUrl] = useState<string | undefined>(undefined);
  const [state, setState] = useState<TabState>({});
  const [connected, setConnected] = useState(false);
  const [waited, setWaited] = useState(false);

  useEffect(() => {
    let alive = true;
    const key = tabKey(tabId);
    const readUrl = () => void chrome.tabs.get(tabId).then((tab) => alive && setUrl(tab.url), () => alive && setUrl(undefined));
    const readState = () => void chrome.storage.session.get(key).then((items) => alive && setState((items[key] ?? {}) as TabState));
    const onStorage = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === "session" && key in changes) setState((changes[key]!.newValue ?? {}) as TabState);
    };
    const onUpdated = (updated: number, change: { status?: string }) => {
      if (updated !== tabId) return;
      readUrl();
      // Another page: wait for its page layer again before asking for a click.
      if (change.status === "loading") restartWait();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const restartWait = () => {
      clearTimeout(timer);
      setWaited(false);
      timer = setTimeout(() => alive && setWaited(true), PAGE_WAIT_MS);
    };
    const stop = connection.onChange(() => {
      setConnected(connection.connected());
      readUrl();
    });
    chrome.storage.onChanged.addListener(onStorage);
    chrome.tabs.onUpdated.addListener(onUpdated);
    readUrl();
    readState();
    restartWait();
    connection.connect();
    return () => {
      alive = false;
      clearTimeout(timer);
      stop();
      chrome.storage.onChanged.removeListener(onStorage);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [chrome, tabId, connection]);
  useEffect(() => () => connection.transport.close(), [connection]);

  return { facts: { url, origin: pageOrigin(url), builtIn: state.builtIn === true, refused: state.refused, connected, waited }, connection };
}

function Frame({ children }: { children?: ReactNode }) {
  return <div className="xt">{children}</div>;
}

function Screen({ title, line, onBack, children }: { title: string; line?: ReactNode; onBack?: () => void; children?: ReactNode }) {
  return (
    <Frame>
      <div className="xt-screen">
        {onBack !== undefined && (
          <div>
            <button type="button" className="icon-btn" aria-label="Back" onClick={onBack}>
              <BackIcon />
            </button>
          </div>
        )}
        <h1>{title}</h1>
        {line !== undefined && <p className="xt-line">{line}</p>}
        {children}
      </div>
    </Frame>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="ds-actions">{children}</div>;
}

function Quiet({ children }: { children: ReactNode }) {
  return <div className="xt-quiet">{children}</div>;
}
