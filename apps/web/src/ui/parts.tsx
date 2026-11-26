import { type ReactNode, useEffect, useRef, useState } from "react";
import { useAuth } from "../backend.ts";
import { copyText } from "../clipboard.ts";
import { copy } from "../copy.ts";

// Pieces every page of the website's app is built from. The look follows
// the landing page (site/styles.css): Geist, near-black buttons, one blue.

/**
 * A screen's heading and the line under it. The heading takes focus when the
 * screen changes, since the control that changed it is gone, and screen
 * readers then read the new screen's name.
 */
export function Heading({ title, lead, id }: { title: string; lead?: ReactNode; id?: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), [title]);
  return (
    <div className="heading">
      <h1 ref={ref} id={id} tabIndex={-1}>
        {title}
      </h1>
      {lead !== undefined && <p className="lead">{lead}</p>}
    </div>
  );
}

/** Where the flow is: one short bar per screen, the done ones filled. */
export function Progress({ step, count }: { step: number; count: number }) {
  return (
    <div className="progress" role="img" aria-label={copy.progress(step, count)}>
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className={index < step ? "done" : undefined} />
      ))}
    </div>
  );
}

/**
 * Copies `text`, then says so in its label for a moment. When the browser
 * won't copy, it says so and asks the person to select the text: `shown` text
 * is already on the page, such as a command; otherwise a field below holds it,
 * selected. `name` tells two copy buttons apart for screen readers.
 */
export function CopyButton({
  text,
  label,
  copiedLabel,
  name,
  shown = false,
  className = "btn",
  onCopied,
  children,
}: {
  text: string;
  label: string;
  copiedLabel: string;
  name?: string;
  shown?: boolean;
  className?: string;
  onCopied?: () => void;
  children?: ReactNode;
}) {
  const [result, setResult] = useState<"idle" | "copied" | "failed">("idle");
  const fallback = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (result !== "copied") return;
    const timer = setTimeout(() => setResult("idle"), 2000);
    return () => clearTimeout(timer);
  }, [result]);
  useEffect(() => {
    if (result === "failed") fallback.current?.select();
  }, [result]);
  const shownLabel = result === "copied" ? copiedLabel : result === "failed" ? copy.copyFailed : label;
  return (
    <>
      <button
        type="button"
        className={result === "copied" ? `${className} copied` : className}
        aria-label={result === "idle" ? name : shownLabel}
        onClick={async () => {
          const copied = await copyText(text);
          setResult(copied ? "copied" : "failed");
          if (copied) onCopied?.();
        }}
      >
        {children}
        <span aria-live="polite">{shownLabel}</span>
      </button>
      {result === "failed" && (
        <span className="copy-fallback" role="alert">
          <span className="note">{shown ? copy.selectToCopy : copy.selectBelowToCopy}</span>
          {!shown && <textarea ref={fallback} className="field" readOnly value={text} aria-label={label} rows={4} onFocus={(event) => event.currentTarget.select()} />}
        </span>
      )}
    </>
  );
}

export function CopyIcon() {
  return (
    <svg className="icon i-copy" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg className="icon i-check" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Install commands joined into the one line people paste into a terminal. */
export function oneCommand(commands: readonly string[]): string {
  return commands.join(" && ");
}

/**
 * The install command in a block, each part on its own line, with Copy
 * below it as the screen's one action; Copy copies it as one line. `after`
 * sits beside Copy, such as the coding agent's instructions.
 */
export function Command({ commands, onCopied, after }: { commands: readonly string[]; onCopied?: () => void; after?: ReactNode }) {
  const command = oneCommand(commands);
  return (
    <div className="stacked">
      <pre className="command" aria-label={command}>
        <code>{commands.map((part, index) => (index < commands.length - 1 ? `${part} &&\n` : part)).join("")}</code>
      </pre>
      <div className="actions">
        <CopyButton text={command} label={copy.install.copyCommand} copiedLabel={copy.install.copied} className="btn primary large" shown onCopied={onCopied}>
          <CopyIcon />
          <CheckIcon />
        </CopyButton>
        {after}
      </div>
    </div>
  );
}

/**
 * The step for a backend other than Critiqs Cloud: `init <projectId>`
 * doesn't write the component's `backend` property, so it is added by hand.
 */
export function BackendStep({ backend, whose }: { backend: string; whose: string }) {
  const property = copy.install.backendProperty(backend);
  return (
    <div className="stacked">
      <p className="note">{copy.install.customBackend(whose)}</p>
      <div className="property">
        <code>{property}</code>
        <CopyButton text={property} label={copy.install.copyProperty} copiedLabel={copy.install.propertyCopied} className="btn small" shown />
      </div>
    </div>
  );
}

/** The sign-in button and what happened to the sign-in window. */
export function SignInButton({ label = copy.signIn.button }: { label?: string }) {
  const auth = useAuth();
  const [state, setState] = useState<{ status: "idle" | "waiting" } | { status: "failed"; message: string }>({ status: "idle" });
  const signIn = async () => {
    setState({ status: "waiting" });
    try {
      await auth.signIn();
      setState({ status: "idle" });
    } catch (error) {
      setState({ status: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  };
  const waiting = state.status === "waiting" || (auth.reviewer !== null && !auth.ready);
  return (
    <>
      <div className="actions">
        <button type="button" className="btn primary large" disabled={waiting} onClick={() => void signIn()}>
          {state.status === "failed" ? copy.signIn.tryAgain : label}
        </button>
      </div>
      {waiting && (
        <p className="note" role="status">
          {copy.signIn.waiting}
        </p>
      )}
      {state.status === "failed" && (
        <p className="error" role="alert">
          {state.message}
        </p>
      )}
    </>
  );
}

/** Who is signed in, with Sign out, for the top bar. */
export function Account() {
  const auth = useAuth();
  if (auth.reviewer === null || !auth.ready) return null;
  return (
    <div className="account">
      <span className="account-email" title={copy.signIn.signedInAs(auth.reviewer.email)}>
        {auth.reviewer.email}
      </span>
      <button type="button" className="quiet" onClick={() => void auth.signOut()}>
        {copy.signIn.signOut}
      </button>
    </div>
  );
}
