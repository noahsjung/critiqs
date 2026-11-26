import { buildLink, isThreadPageKey, removeLink, reviewLink } from "@critiqs/core";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { type Backend, failureCode, failureMessage, type ThreadPageData, useAuth, useBackend } from "../backend.ts";
import { copy } from "../copy.ts";
import { Avatar, fullTime, MessageBody, type QueryState, relativeTime, tagDisplay } from "../shared.ts";
import { CheckIcon, CopyButton, CopyIcon, Heading, SignInButton } from "./parts.tsx";

/**
 * A thread page at /t/<key>: one thread's capture, discussion, and reply box,
 * with Open in prototype, for people signed in who may open it. A link can be
 * forwarded to anyone, so everyone else sees one answer that never says
 * whether the thread exists.
 */
export function ThreadPage({ pageKey }: { pageKey: string }) {
  const auth = useAuth();
  if (auth.reviewer === null || !auth.ready) {
    return (
      <>
        <Heading title={copy.threadPage.signInTitle} lead={copy.threadPage.signInLead} />
        <SignInButton />
      </>
    );
  }
  // A new sign-in starts the page again, with its own draft.
  return <SignedIn key={auth.reviewer.id} pageKey={pageKey} email={auth.reviewer.email} onSignOut={() => void auth.signOut()} />;
}

const NOT_FOUND: QueryState<ThreadPageData> = { status: "error", code: "not-found", message: "" };

function SignedIn({ pageKey, email, onSignOut }: { pageKey: string; email: string; onSignOut: () => void }) {
  const backend = useBackend();
  // Accept the person's pending invitations first, so an invitation to the
  // project's organization counts; a failure leaves the access they have.
  const [synced, setSynced] = useState(false);
  useEffect(() => {
    let current = true;
    const done = () => current && setSynced(true);
    backend.syncReviewer().then(done, done);
    return () => void (current = false);
  }, [backend]);
  // A key of the wrong form opens nothing, so it is never sent.
  const valid = isThreadPageKey(pageKey);
  const state = backend.useThreadPage(valid && synced ? pageKey : null);
  return <ThreadPageView state={valid ? state : NOT_FOUND} pageKey={pageKey} email={email} onSignOut={onSignOut} />;
}

/** What a signed-in person sees for each state of the page's query. */
export function ThreadPageView({ state, pageKey, email, onSignOut }: { state: QueryState<ThreadPageData>; pageKey: string; email: string; onSignOut: () => void }) {
  if (state.status === "loading") return <p className="note">{copy.loading}</p>;
  if (state.status === "error") {
    // Only people who could have opened it learn that it was deleted; everyone else gets `not-found`.
    if (state.code === "unavailable") return <Heading title={copy.threadPage.deletedTitle} lead={copy.threadPage.deletedLead} />;
    if (state.code === "not-found" || state.code === "forbidden" || state.code === "email-unverified") {
      return (
        <>
          <Heading title={copy.threadPage.unavailableTitle} lead={copy.threadPage.unavailableLead} />
          <ul className="reasons">
            <li>{copy.threadPage.unavailableOtherEmail}</li>
            <li>{copy.threadPage.unavailableAsk}</li>
          </ul>
          <p className="note">{copy.signIn.signedInAs(email)}</p>
          <div className="actions">
            <button type="button" className="btn" onClick={onSignOut}>
              {copy.threadPage.otherEmail}
            </button>
          </div>
        </>
      );
    }
    return <Heading title={copy.threadPage.failedTitle} lead={state.message} />;
  }
  return <Thread thread={state.data} pageKey={pageKey} />;
}

/**
 * Where Open in prototype goes: the page the comment was left on, at the
 * project's review address, with the Critiqs link that opens the thread there
 * once Critiqs is installed. A saved page address that can't be read opens
 * the review address itself, as email links do. Null without a usable review
 * address.
 */
export function prototypeLink(reviewUrl: string | null, pageUrl: string, threadId: string): string | null {
  if (reviewUrl === null) return null;
  let base: URL;
  try {
    base = new URL(reviewUrl);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return null;
  try {
    return buildLink(base.origin, pageUrl, { threadId, messageId: null });
  } catch {
    return reviewLink(base.toString(), { threadId, messageId: null });
  }
}

/** An address as people read it: no scheme, no trailing slash. */
function shownAddress(href: string): string {
  try {
    const url = new URL(href);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}${url.search}`;
  } catch {
    return href;
  }
}

function Thread({ thread, pageKey }: { thread: ThreadPageData; pageKey: string }) {
  const resolved = thread.status === "resolved";
  const title = resolved ? copy.threadPage.resolvedTitle(thread.project.name) : copy.threadPage.title(thread.project.name);
  // The tab names no project: browsers keep titles in history after the page closes.
  useEffect(() => {
    document.title = `${copy.threadPage.tabTitle} · ${copy.appName}`;
    return () => void (document.title = copy.appName);
  }, []);
  const target = prototypeLink(thread.project.reviewUrl, thread.prototype.pageUrl, thread._id);
  const ownLink = `${window.location.origin}${window.location.pathname}`;

  return (
    <article className="thread-page">
      <div className="thread-head">
        <ThreadHeading
          title={title}
          lead={
            <>
              {copy.threadPage.screen} <code>{thread.prototype.screen}</code>
            </>
          }
        />
        <div className="thread-actions">
          {target !== null && (
            <a className="btn" href={target} target="_blank" rel="noopener noreferrer">
              <OpenIcon />
              {copy.threadPage.openInPrototype}
            </a>
          )}
          <CopyButton text={ownLink} label={copy.threadPage.copyLink} copiedLabel={copy.threadPage.linkCopied} className="btn">
            <CopyIcon />
            <CheckIcon />
          </CopyButton>
        </div>
        <p className="note">
          {target === null ? copy.threadPage.noAddress(shownAddress(thread.prototype.pageUrl)) : copy.threadPage.opensAt(shownAddress(removeLink(target)))}
        </p>
      </div>
      {resolved && (
        <p className="resolved" role="status">
          {copy.threadPage.resolved(thread.statusChangedByName, thread.statusChangedAt === undefined ? null : fullTime(thread.statusChangedAt))}
        </p>
      )}
      <Capture thread={thread} pageKey={pageKey} />
      {thread.tags.length > 0 && (
        <ul className="thread-tags" aria-label="Tags">
          {thread.tags.map((tag) => (
            <li key={tag} className="tag-chip">
              {tagDisplay(tag)}
            </li>
          ))}
        </ul>
      )}
      <section className="discussion" aria-label={copy.threadPage.discussion}>
        <ol className="thread-messages">
          {thread.messages.map((message) => (
            <li key={message._id} className="message">
              <Avatar name={message.author.name} imageUrl={message.author.imageUrl} large />
              <div className="grow">
                <div className="meta">
                  <span className="author">{message.author.name}</span>
                  {message.via === "agent" && <span className="via">{copy.threadPage.viaAgent}</span>}
                  <time className="time" dateTime={new Date(message.createdAt).toISOString()} title={fullTime(message.createdAt)}>
                    {relativeTime(message.createdAt)}
                  </time>
                  {message.editedAt !== null && (
                    <span className="edited" title={fullTime(message.editedAt)}>
                      {copy.threadPage.edited}
                    </span>
                  )}
                </div>
                <div className="body">
                  <MessageBody body={message.body} mentions={message.mentions} />
                </div>
              </div>
            </li>
          ))}
        </ol>
        <ReplyBox threadId={thread._id} />
      </section>
    </article>
  );
}

/**
 * The thread's heading, as `Heading` draws it, taking focus only when the
 * page opens: a live change such as someone resolving the thread changes the
 * title without taking the person out of the reply box.
 */
function ThreadHeading({ title, lead }: { title: string; lead: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  return (
    <div className="heading">
      <h1 ref={ref} tabIndex={-1}>
        {title}
      </h1>
      <p className="lead">{lead}</p>
    </div>
  );
}

/** The image from when the comment was left, through the page's own check. */
function Capture({ thread, pageKey }: { thread: ThreadPageData; pageKey: string }) {
  const image = useCapture(useBackend(), pageKey, thread.capture.status);
  const { width, height } = thread.anchor.evidence.viewport;
  if (thread.capture.status === "failed") return <p className="note capture-none">{copy.threadPage.noCapture}</p>;
  return (
    // While the image loads, its space is the shape of the window it was left in, so nothing jumps.
    <figure className="thread-capture" style={{ aspectRatio: image.status === "loading" && width > 0 && height > 0 ? `${width} / ${height}` : undefined }}>
      {image.status === "shown" ? (
        <img src={image.url} alt={copy.threadPage.captureAlt} />
      ) : image.status === "loading" ? (
        <span className="note">{copy.threadPage.captureLoading}</span>
      ) : image.status === "failed" ? (
        <span className="capture-failed">
          <span className="note">{copy.threadPage.captureFailed}</span>
          {/* Stays mounted, and focusable, while it retries, so the keyboard keeps its place. */}
          <button type="button" className="btn small" aria-disabled={image.retrying} onClick={image.retrying ? undefined : image.retry}>
            {image.retrying ? copy.threadPage.retrying : copy.threadPage.tryAgain}
          </button>
        </span>
      ) : (
        <span className="note">{copy.threadPage.noCapture}</span>
      )}
      {thread.capture.status === "supplied" && image.status === "shown" && <figcaption className="note">{copy.threadPage.supplied}</figcaption>}
    </figure>
  );
}

type CaptureImage = { status: "loading" } | { status: "none" } | { status: "failed"; retrying: boolean; retry: () => void } | { status: "shown"; url: string };

/** The page's image: none when the backend has none to give, failed (with a retry) when the download didn't finish. */
function useCapture(backend: Backend, key: string, status: string): CaptureImage {
  const [image, setImage] = useState<CaptureImage>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (status === "failed") return;
    let cancelled = false;
    let objectUrl: string | null = null;
    // A retry keeps its button; anything else shows the image loading.
    setImage((current) => (current.status === "failed" ? { ...current, retrying: true } : { status: "loading" }));
    backend.loadThreadPageCapture(key).then(
      (blob) => {
        if (cancelled) return;
        if (blob === null) return setImage({ status: "none" });
        objectUrl = URL.createObjectURL(blob);
        setImage({ status: "shown", url: objectUrl });
      },
      () => !cancelled && setImage({ status: "failed", retrying: false, retry: () => setAttempt((count) => count + 1) }),
    );
    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [backend, key, status, attempt]);
  return image;
}

/**
 * The reply box, as in the installed thread window: Reply sends, as does
 * Ctrl or Cmd with Enter. Hashtags tag the thread. The new reply shows when
 * the live page does; a refused one keeps its text.
 */
function ReplyBox({ threadId }: { threadId: string }) {
  const backend = useBackend();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = draft.trim() === "";
  const send = async () => {
    if (empty || sending) return;
    setSending(true);
    setError(null);
    try {
      const sent = draft;
      await backend.replyOnThreadPage(threadId, sent);
      // Text typed while it was sending stays.
      setDraft((current) => (current === sent ? "" : current));
    } catch (failure) {
      const code = failureCode(failure);
      setError(code === "not-found" || code === "forbidden" ? copy.threadPage.replyRefused : failureMessage(failure, copy.threadPage.replyFailed));
    } finally {
      setSending(false);
    }
  };
  return (
    <form
      className="reply"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void send();
      }}
    >
      <textarea
        className="field"
        aria-label={copy.threadPage.replyLabel}
        placeholder={copy.threadPage.replyPlaceholder}
        rows={3}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
        }}
      />
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="reply-actions">
        <button type="submit" className="btn primary" disabled={empty || sending}>
          {sending ? copy.threadPage.sending : copy.threadPage.reply}
        </button>
      </div>
    </form>
  );
}

function OpenIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
