import { type PanelSignedIn, type PanelSignIn, panelSignIn, parseReviewFrameMessage, type ReviewFrameMessage, windowTransport } from "@critiqs/core";
import { createContext, Fragment, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { failureMessage, type ReviewReady, useAuth, useBackend } from "../backend.ts";
import { copyText } from "../clipboard.ts";
import { copy } from "../copy.ts";
import { framesOnlyFrom, ownFramePolicy } from "../frame-policy.ts";
import { REVIEW_KEY, reviewPathOf } from "../route.ts";
import type { Deployment, MountedPanel, PanelMount, TokenSession } from "../shared.ts";
import { keepThreadWindowsBelow, useSidebarWidth } from "../shared.ts";
import { Logo } from "./Preview.tsx";
import { ReviewSignIn } from "./ReviewSignIn.tsx";

// A review link's page, /r/<key>: the prototype in a sandboxed frame served by
// the review proxy on its own lease host, and Critiqs's panel beside it. The
// reviewer browses or comments, chooses the frame's width, and signs in with
// an email code only when they post their first comment, keeping what they
// picked and wrote. Nothing of the reviewer's (tokens, names, the project)
// enters the frame: the panel talks to the page layer the proxy put there,
// checks every address it reports, and sends threads to it only as aliases.

/** What the review page needs beyond the backend: the deployment, the website's sign-in, and the panel. */
export interface ReviewHost {
  deployment: Deployment;
  session: TokenSession & { acceptPanelSignIn(tokens: { accessToken: string; refreshToken: string; expiresAt: number }): void };
  /** Loads and mounts Critiqs's panel; tests pass a fake. */
  mountPanel: PanelMount;
  /** The email-code sign-in for this site; tests pass a fake. */
  signInClient?: PanelSignIn;
  /** Where "Get the extension" goes; none hides the link. */
  extensionUrl: string | null;
  /** The Content-Security-Policy this page was served with (`ownFramePolicy`); tests pass a fake. */
  framePolicy?: () => Promise<string | null>;
}

export const ReviewHostContext = createContext<ReviewHost | null>(null);

function useReviewHost(): ReviewHost {
  const host = useContext(ReviewHostContext);
  if (host === null) throw new Error("The review page needs its host.");
  return host;
}

/** Frame widths: Fit fills the space; the rest are CSS pixels, as a device would show the page. */
export const DEVICE_WIDTHS = ["fit", 1440, 1280, 768, 390] as const;
export type FrameWidth = "fit" | number;

/** Where the extension banner's Dismiss is kept, across visits; the partial-load notice's lasts for the page. */
const BANNER_KEY = "critiqs:review-extension-banner";
/** The review bar's height on one row, in CSS pixels (`.review-bar` in styles.ts); on a phone it takes two. */
const BAR_HEIGHT = 52;

/**
 * Below this width a sidebar beside the frame would leave the prototype and
 * the bar less than about 600 pixels, so the panel becomes a sheet over the
 * frame's lower part instead, opened from the bar (`.review` in styles.ts).
 */
export const NARROW_QUERY = "(max-width: 959px)";

function subscribeNarrow(listener: () => void) {
  const query = window.matchMedia?.(NARROW_QUERY);
  if (query === undefined) {
    window.addEventListener("resize", listener);
    return () => window.removeEventListener("resize", listener);
  }
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

/** Whether the review page lays out for a narrow screen (`NARROW_QUERY`). */
function useNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, () => window.matchMedia?.(NARROW_QUERY).matches ?? window.innerWidth < 960, () => false);
}

/**
 * The path to show in the bar and copy with Share for a path the frame
 * reports: a path starting with `//` gets `/.` in front, as the proxy writes
 * it, so it never reads as another site's address; null for the proxy's own
 * paths and anything else a review address can't hold.
 */
export function shownPathOf(pathname: string): string | null {
  return reviewPathOf(pathname.startsWith("//") ? `/.${pathname}` : pathname);
}

/** The frame's origin, if it is a lease host: `v-<26 base32 characters>` under the proxy's domain, `https:`, or `http:` on `.localhost`. */
export function leaseOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.origin !== origin || !/^v-[a-z2-7]{26}\./.test(url.hostname)) return null;
    if (url.protocol === "https:" || (url.protocol === "http:" && url.hostname.endsWith(".localhost"))) return url.origin;
    return null;
  } catch {
    return null;
  }
}

/**
 * The prototype's address for an address in the frame: the source's origin
 * with the frame's path, never its query or fragment (they can hold anything,
 * and the evidence a comment keeps doesn't need them). Null for the proxy's
 * own paths.
 */
export function prototypeUrl(source: string, frameUrl: URL): string | null {
  if (frameUrl.pathname.startsWith("/__critiqs/")) return null;
  return `${source}${frameUrl.pathname}`;
}

type Opening =
  | { status: "opening" }
  | { status: "sign-in" }
  | { status: "unavailable" }
  | { status: "pending" }
  | { status: "limited" }
  | { status: "failed"; message: string }
  | { status: "ended" }
  | { status: "ready"; ready: ReviewReady };

export function ReviewPage({ linkKey }: { linkKey: string }) {
  const backend = useBackend();
  const auth = useAuth();
  const host = useReviewHost();
  const [opening, setOpening] = useState<Opening>({ status: "opening" });
  const [attempt, setAttempt] = useState(0);
  const [signingIn, setSigningIn] = useState<{ lead: string; done: (signedIn: boolean) => void } | null>(null);
  const client = useMemo(() => host.signInClient ?? panelSignIn(host.deployment.signInUrl), [host]);
  const settled = auth.reviewer === null || auth.ready;
  const openingRef = useRef(opening);
  openingRef.current = opening;
  // Whether the website's host sent the frame policy that keeps the frame on the review proxy (frame-policy.ts): no frame without it.
  const [walled, setWalled] = useState<{ origin: string; walled: boolean } | null>(null);
  const leaseOriginNow = opening.status === "ready" ? opening.ready.entry.origin : null;
  useEffect(() => {
    if (leaseOriginNow === null || walled?.origin === leaseOriginNow) return;
    let cancelled = false;
    (host.framePolicy ?? ownFramePolicy)().then(
      (header) => !cancelled && setWalled({ origin: leaseOriginNow, walled: framesOnlyFrom(header, leaseOriginNow) }),
      () => !cancelled && setWalled({ origin: leaseOriginNow, walled: false }),
    );
    return () => {
      cancelled = true;
    };
  }, [leaseOriginNow, host]);

  useEffect(() => {
    document.title = "Review · Critiqs";
    // Kept out of search engines and referrers.
    const metas = [meta("robots", "noindex, nofollow"), meta("referrer", "no-referrer")];
    return () => metas.forEach((restore) => restore());
  }, []);

  useEffect(() => {
    if (!REVIEW_KEY.test(linkKey)) return setOpening({ status: "unavailable" });
    // Wait for a saved sign-in to be accepted, so a member opens as themselves.
    if (!settled) return;
    // A lease is opened once; signing in on the page adopts it instead (`adopt`).
    if (openingRef.current.status === "ready") return;
    let cancelled = false;
    setOpening((current) => (current.status === "ready" ? current : { status: "opening" }));
    backend.openReviewLink(linkKey).then(
      (opened) => {
        if (cancelled) return;
        setOpening(opened.kind === "ready" ? (leaseOrigin(opened.entry.origin) === null ? { status: "unavailable" } : { status: "ready", ready: opened }) : { status: opened.kind });
      },
      (error) => !cancelled && setOpening({ status: "failed", message: failureMessage(error, copy.review.failed) }),
    );
    return () => {
      cancelled = true;
    };
  }, [linkKey, attempt, settled]);

  // Checking the address takes a moment: ask again until it's done.
  useEffect(() => {
    if (opening.status !== "pending") return;
    const timer = setTimeout(() => setAttempt((value) => value + 1), 2_000);
    return () => clearTimeout(timer);
  }, [opening.status, attempt]);

  /** Shows the email-code sign-in; resolves to whether the person signed in. */
  const askToSignIn = useCallback((lead: string) => new Promise<boolean>((resolve) => setSigningIn({ lead, done: resolve })), []);
  const signedIn = async (result: PanelSignedIn) => {
    // Only the tokens are kept, in the website's own session, as its other pages keep them.
    host.session.acceptPanelSignIn({ accessToken: result.accessToken, refreshToken: result.refreshToken, expiresAt: result.expiresAt });
    signingIn?.done(true);
    setSigningIn(null);
  };
  const cancelSignIn = useCallback(() => {
    setSigningIn((current) => {
      current?.done(false);
      return null;
    });
  }, []);

  const dialog = signingIn === null ? null : <ReviewSignIn client={client} lead={signingIn.lead} onSignedIn={signedIn} onCancel={cancelSignIn} />;

  // A review page framed by another site could trick people into clicking; it shows only on its own.
  if (window.top !== window.self) return null;
  const policyKnown = opening.status === "ready" && walled?.origin === opening.ready.entry.origin;
  if (opening.status === "ready" && policyKnown && walled.walled) {
    return (
      <>
        <ReviewCanvas
          key={opening.ready.entry.leaseId}
          linkKey={linkKey}
          ready={opening.ready}
          askToSignIn={askToSignIn}
          onEnded={() => setOpening({ status: "ended" })}
          onSignedOut={() => {
            setOpening({ status: "opening" });
            setAttempt((value) => value + 1);
          }}
        />
        {dialog}
      </>
    );
  }
  const again = () => setAttempt((value) => value + 1);
  return (
    <div className="app review-message-page">
      <header className="topbar">
        <span className="brand">
          <Logo />
          {copy.appName}
        </span>
      </header>
      <main className="page narrow" aria-live="polite">
        {(opening.status === "opening" || (opening.status === "ready" && !policyKnown)) && <p className="note">{copy.review.opening}</p>}
        {opening.status === "ready" && policyKnown && !walled.walled && <Message title={copy.review.unwalledTitle} line={copy.review.unwalled} />}
        {opening.status === "sign-in" && (
          <Message title={copy.review.signIn.title} line={copy.review.signIn.toOpen}>
            <button type="button" className="btn primary" onClick={() => void askToSignIn(copy.review.signIn.toOpen)}>
              {copy.review.signIn.button}
            </button>
          </Message>
        )}
        {opening.status === "unavailable" && <Message title={copy.review.unavailableTitle} line={copy.review.unavailable} />}
        {opening.status === "pending" && <Message title={copy.review.pendingTitle} line={copy.review.pending} />}
        {opening.status === "limited" && (
          <Message title={copy.review.limitedTitle} line={copy.review.limited}>
            <button type="button" className="btn" onClick={again}>{copy.review.tryAgain}</button>
          </Message>
        )}
        {opening.status === "failed" && (
          <Message title={copy.review.unavailableTitle} line={opening.message}>
            <button type="button" className="btn" onClick={again}>{copy.review.tryAgain}</button>
          </Message>
        )}
        {opening.status === "ended" && (
          <Message title={copy.review.endedTitle} line={copy.review.ended}>
            <button type="button" className="btn primary" onClick={again}>{copy.review.openAgain}</button>
          </Message>
        )}
      </main>
      {dialog}
    </div>
  );
}

/** A host name that wraps after its dots on a narrow bar (`acme.` / `example.com`), never inside a word. */
function breakableHost(host: string): ReactNode {
  return host.split(".").map((part, index, parts) => (
    <Fragment key={index}>
      {part}
      {index < parts.length - 1 && (
        <>
          .<wbr />
        </>
      )}
    </Fragment>
  ));
}

function Message({ title, line, children }: { title: string; line: string; children?: ReactNode }) {
  return (
    <div className="review-message">
      <h1>{title}</h1>
      <p className="lead">{line}</p>
      {children !== undefined && <div className="actions">{children}</div>}
    </div>
  );
}

/** Sets a meta tag for as long as the page shows; returns what puts it back. */
function meta(name: string, content: string): () => void {
  let element = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  const before = element?.content ?? null;
  if (element === null) {
    element = document.createElement("meta");
    element.name = name;
    document.head.append(element);
  }
  element.content = content;
  return () => {
    if (before === null) element!.remove();
    else element!.content = before;
  };
}

function ReviewCanvas({
  linkKey,
  ready,
  askToSignIn,
  onEnded,
  onSignedOut,
}: {
  linkKey: string;
  ready: ReviewReady;
  askToSignIn: (lead: string) => Promise<boolean>;
  onEnded: () => void;
  onSignedOut: () => void;
}) {
  const backend = useBackend();
  const auth = useAuth();
  const host = useReviewHost();
  const { entry, source } = ready;
  // A shared build has no address of its own: the bar says what it is and until when.
  const sourceHost = source.kind === "share" ? copy.review.sharedBuild(source.expiresAt) : new URL(source.origin).host;
  const [mode, setMode] = useState<"browse" | "comment">("comment");
  const [width, setWidth] = useState<FrameWidth>("fit");
  const [shownAt, setShownAt] = useState<{ width: number; before: FrameWidth } | null>(null);
  const [projectId, setProjectId] = useState<string | null>(ready.projectId);
  const [path, setPath] = useState(() => reviewPathOf(window.location.hash) ?? entry.path);
  const [notice, setNotice] = useState<ReviewFrameMessage | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(() => {
    try {
      return localStorage.getItem(BANNER_KEY) === "dismissed";
    } catch {
      return false;
    }
  });
  // The partial-load notice has its own Dismiss, for this page only: a page that partly loads is worth saying again on the next one.
  const [partialDismissed, setPartialDismissed] = useState(false);
  const [shared, setShared] = useState(false);
  const narrow = useNarrow();
  // On a narrow screen the panel is a sheet, closed until the reviewer opens it from the bar.
  const [sheetOpen, setSheetOpen] = useState(false);
  const bar = useRef<HTMLElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const panelBox = useRef<HTMLDivElement>(null);
  const mounted = useRef<MountedPanel | null>(null);
  const viewport = useRef<number | null>(null);
  const sideWidth = useSidebarWidth();
  // The frame opens once at the path the link or its address names; afterwards it navigates itself.
  const [src] = useState(() => `${entry.origin}${path.startsWith("/") ? path : `/${path}`}`);

  // The panel's thread windows stay below the bar, so Browse, Comment, widths and Share stay reachable, however many rows it takes.
  useEffect(() => {
    const element = bar.current;
    const below = () => keepThreadWindowsBelow(Math.ceil(element?.getBoundingClientRect().bottom ?? BAR_HEIGHT) || BAR_HEIGHT);
    below();
    const observer = typeof ResizeObserver === "function" && element !== null ? new ResizeObserver(below) : null;
    if (observer !== null && element !== null) observer.observe(element);
    return () => {
      observer?.disconnect();
      keepThreadWindowsBelow(0);
    };
  }, []);

  // The lease, watched: a link removed or closed to this viewer ends the session here at once, as the proxy stops serving it.
  const leaseState = backend.useReviewLease(entry.leaseId, entry.renewalSecret);
  const leaseEnded = leaseState.status === "ready" && leaseState.data.kind === "ended";
  useEffect(() => {
    if (leaseEnded) onEnded();
  }, [leaseEnded, onEnded]);

  // Keep the lease while the page is open; when it can't be kept, the frame has stopped serving anyway.
  useEffect(() => {
    const timer = setInterval(() => {
      backend.renewReviewLease(entry.leaseId, entry.renewalSecret).then(
        (renewal) => renewal.kind === "ended" && onEnded(),
        () => undefined,
      );
    }, entry.renewEveryMs);
    return () => clearInterval(timer);
  }, [backend, entry, onEnded]);

  // What the frame says about itself: shown, never acted on beyond that.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== entry.origin) return;
      const message = parseReviewFrameMessage(event.data);
      if (message !== null) setNotice(message);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [entry.origin]);

  /** Binds the lease to the person who just signed in and learns the project; false when the link no longer opens for them. */
  const adopt = useCallback(async (): Promise<boolean> => {
    const adopted = await backend.adoptReviewLease(entry.leaseId, entry.renewalSecret).catch(() => null);
    if (adopted === null || adopted.kind !== "adopted") {
      setProblem(copy.review.adoptEnded);
      return false;
    }
    setProjectId(adopted.projectId);
    return true;
  }, [backend, entry]);

  const authRef = useRef(auth);
  authRef.current = auth;
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const ensureReviewer = useCallback(async () => {
    if (authRef.current.reviewer === null && !(await askToSignIn(copy.review.signIn.toComment))) return false;
    if (projectRef.current !== null) return true;
    return await adopt();
  }, [askToSignIn, adopt]);

  const onThreadOpened = useCallback(async (threadWidth: number) => {
    // On a narrow screen the sheet goes down, so the thread shows over the frame beside its pin.
    setSheetOpen(false);
    if (!Number.isFinite(threadWidth) || threadWidth < 200 || threadWidth > 4000) return;
    const rounded = Math.round(threadWidth);
    setWidth((before) => {
      if (before !== rounded) setShownAt({ width: rounded, before });
      return rounded;
    });
    // Wait until the frame shows that width, briefly, so the thread is revealed in it.
    const started = Date.now();
    while (Date.now() - started < 1_500 && viewport.current !== rounded) await new Promise((resolve) => setTimeout(resolve, 50));
  }, []);

  const onState = useCallback(
    (state: { url: string; viewport: { width: number } }) => {
      viewport.current = state.viewport.width;
      const shownPath = shownPathOf(new URL(state.url).pathname);
      // The proxy's own pages, or a path no review address can hold: the bar keeps the last one.
      if (shownPath === null) return;
      setPath(shownPath);
      // The address bar follows the frame, so a copied address reopens this page. A browser that
      // limits how often a page may change its address refuses some of these; the bar still shows the path.
      if (window.location.hash === `#${shownPath}`) return;
      try {
        window.history.replaceState(window.history.state, "", `/r/${linkKey}#${shownPath}`);
      } catch {
        // Kept as it was.
      }
    },
    [linkKey],
  );

  /** Browse or Comment, from the bar or the panel. Commenting picks on the frame, so a sheet over it goes down. */
  const chooseMode = useCallback((next: "browse" | "comment") => {
    setMode(next);
    if (next === "comment") setSheetOpen(false);
  }, []);

  const surface = useCallback(
    (currentMode: "browse" | "comment") => ({
      frameOrigin: entry.origin,
      mapUrl: (url: URL) => prototypeUrl(source.origin, url),
      onState,
      mode: currentMode,
      onModeChange: chooseMode,
      ensureReviewer,
      onThreadOpened,
      panel: narrow ? { layout: "sheet" as const, open: sheetOpen, onClose: () => setSheetOpen(false) } : { layout: "side" as const },
    }),
    [entry.origin, source.origin, onState, chooseMode, ensureReviewer, onThreadOpened, narrow, sheetOpen],
  );

  // Critiqs's panel, for this lease's frame.
  useEffect(() => {
    let cancelled = false;
    void host.mountPanel().then((mount) => {
      if (cancelled || panelBox.current === null || frame.current?.contentWindow == null) return;
      const panel = mount(panelBox.current, {
        transport: windowTransport({ self: window, peer: frame.current.contentWindow, peerOrigin: entry.origin }),
        channel: "review-link",
        backend: host.deployment.backendUrl,
        session: host.session,
        ...(projectRef.current === null ? {} : { projectId: projectRef.current }),
        review: surface(mode),
      });
      mounted.current = panel;
      // Opening the project through a review link counts as opening it, as an install does.
      void panel.ready.then(() => {
        if (projectRef.current !== null) void backend.recordReviewOpened(entry.leaseId, entry.renewalSecret).catch(() => undefined);
      });
    });
    return () => {
      cancelled = true;
      mounted.current?.destroy();
      mounted.current = null;
    };
    // One panel per lease; later changes go through `update`.
  }, [entry.leaseId]);
  useEffect(() => {
    mounted.current?.update({ ...(projectId === null ? {} : { projectId }), review: surface(mode) });
  }, [mode, projectId, surface]);

  const signOut = async () => {
    await auth.signOut();
    onSignedOut();
  };
  const share = async () => {
    const copied = await copyText(`${window.location.origin}/r/${linkKey}#${path}`);
    setShared(copied);
    if (copied) setTimeout(() => setShared(false), 2_000);
  };

  // What a notice is: a sign-in or form the extension handles (its banner, dismissed for good), part of the
  // page not loading (its own quiet strip, dismissed for this page), files held back for a moment (a quiet
  // line: waiting helps), or anything else (one line, as a problem).
  const extensionNotice = notice !== null && ((notice.kind === "left" && notice.signIn) || (notice.kind === "failed" && notice.reason === "needs-sign-in") || (notice.kind === "unsupported" && (notice.feature === "form" || notice.feature === "password")));
  const partialNotice = notice?.kind === "unsupported" && notice.feature === "load";
  const heldNotice = notice?.kind === "unsupported" && notice.feature === "limit";
  const showBanner = (extensionNotice && !bannerDismissed) || (partialNotice && !partialDismissed);
  const noticeLine =
    notice === null || extensionNotice || partialNotice || heldNotice
      ? null
      : notice.kind === "failed"
        ? copy.review.frame[notice.reason] ?? null
        : notice.kind === "left"
          ? copy.review.left(notice.url)
          : copy.review.unsupportedForm;
  // Part of the page didn't load: one quiet line with the extension as the way to see it all.
  const bannerLine = partialNotice ? copy.review.partialBanner : copy.review.extension;
  const widthLabel = (value: FrameWidth) => copy.review.widths[String(value)] ?? copy.review.customWidth(value as number);

  const source_ = (
    <span className={source.kind === "share" ? "review-source shared" : "review-source"} title={source.kind === "share" ? sourceHost : `${source.origin}${path}`}>
      <strong>{source.kind === "share" ? sourceHost : breakableHost(sourceHost)}</strong>
      <span>{path}</span>
    </span>
  );
  const modes = (
    <div className="review-modes" role="group" aria-label={copy.review.modeLabel}>
      {(["browse", "comment"] as const).map((value) => (
        <button key={value} type="button" aria-pressed={mode === value} onClick={() => chooseMode(value)}>
          {value === "browse" ? copy.review.browse : copy.review.comment}
        </button>
      ))}
    </div>
  );
  const widths = (
    <label className="review-width">
      <span className="visually-hidden">{copy.review.width}</span>
      <select
        value={String(width)}
        onChange={(event) => {
          setShownAt(null);
          setWidth(event.target.value === "fit" ? "fit" : Number(event.target.value));
        }}
      >
        {DEVICE_WIDTHS.map((value) => (
          <option key={value} value={String(value)}>{widthLabel(value)}</option>
        ))}
        {typeof width === "number" && !DEVICE_WIDTHS.includes(width as never) && <option value={String(width)}>{widthLabel(width)}</option>}
      </select>
    </label>
  );
  const shareButton = (
    <button type="button" className="btn small" onClick={() => void share()}>
      {shared ? copy.review.shareCopied : copy.review.share}
    </button>
  );
  const account = (
    <span className="review-account">
      {auth.reviewer !== null ? (
        <>
          <span className="account-email" title={auth.reviewer.email}>{auth.reviewer.name}</span>
          <button type="button" className="quiet" onClick={() => void signOut()}>{copy.review.signOut}</button>
        </>
      ) : (
        <button type="button" className="quiet" onClick={() => void ensureReviewer()}>{copy.review.signIn.button}</button>
      )}
    </span>
  );
  const brand = (
    <a className="brand" href="https://critiqs.app/" target="_blank" rel="noreferrer noopener">
      <Logo />
      <span className="visually-hidden">{copy.appName}</span>
    </a>
  );

  return (
    <div className={narrow ? "review narrow" : "review"} style={{ right: narrow ? 0 : sideWidth }}>
      <header ref={bar} className="review-bar">
        {narrow ? (
          <>
            {brand}
            {modes}
            {/* The sheet shows the project in Browse and its comments in Comment, as the panel's own title says. */}
            <button type="button" className="btn small review-comments" aria-expanded={sheetOpen} onClick={() => setSheetOpen((open) => !open)}>
              {sheetOpen ? copy.review.hideComments : mode === "browse" ? copy.review.project : copy.review.comments}
            </button>
            <span className="review-break" aria-hidden="true" />
            {source_}
            {widths}
            {shareButton}
            {account}
          </>
        ) : (
          <>
            {brand}
            {source_}
            {modes}
            {widths}
            {shareButton}
            {account}
          </>
        )}
      </header>
      {shownAt !== null && (
        <p className="review-strip" role="status">
          {copy.review.shownAt(shownAt.width)}{" "}
          <button type="button" className="link-btn" onClick={() => (setWidth(shownAt.before), setShownAt(null))}>
            {copy.review.backToWidth(widthLabel(shownAt.before))}
          </button>
        </p>
      )}
      {showBanner && (
        <p className="review-strip extension" role="status">
          {bannerLine}{" "}
          {host.extensionUrl !== null && (
            <a href={host.extensionUrl} target="_blank" rel="noreferrer noopener">{copy.review.getExtension}</a>
          )}
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              if (partialNotice) return setPartialDismissed(true);
              setBannerDismissed(true);
              try {
                localStorage.setItem(BANNER_KEY, "dismissed");
              } catch {
                // Shown again on the next visit.
              }
            }}
          >
            {copy.review.dismiss}
          </button>
        </p>
      )}
      {heldNotice && (
        <p className="review-strip" role="status">
          {copy.review.held}
        </p>
      )}
      {(problem !== null || noticeLine !== null) && (
        <p className="review-strip problem" role="alert">
          {problem ?? noticeLine}
        </p>
      )}
      <div className="review-canvas">
        <iframe
          ref={frame}
          className="review-frame"
          title={copy.review.frameTitle(sourceHost)}
          src={src}
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
          style={width === "fit" ? { width: "100%" } : { width, flex: "none" }}
        />
      </div>
      <div ref={panelBox} className="review-panel" />
    </div>
  );
}
