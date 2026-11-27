import { backendSetting, type DeveloperSendResult, type DeveloperSendSummary, type ProjectSetup, SCRIPT_TAG_GUIDE, type StackId } from "@critiqs/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useAuth, useBackend } from "../backend.ts";
import { copyText } from "../clipboard.ts";
import { copy } from "../copy.ts";
import type { QueryState } from "../shared.ts";

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
 * The step for a backend other than Critiqs Cloud: `init <projectId>` and
 * the script tag's guide don't set it, so it is added by hand, in the form
 * the stack's package reads.
 */
export function BackendStep({ backend, whose, stack }: { backend: string; whose: string; stack: StackId | null }) {
  const { where, setting: property } = backendSetting(stack, backend);
  return (
    <div className="stacked">
      <p className="note">{copy.install.customBackend(whose, where)}</p>
      <div className="property">
        <code>{property}</code>
        <CopyButton text={property} label={copy.install.copyProperty} copiedLabel={copy.install.propertyCopied} className="btn small" shown />
      </div>
    </div>
  );
}

/** For a stack with no Critiqs package: the script tag's guide and the project ID to give it. */
export function ScriptTagStep({ label, projectId, onCopied }: { label: string; projectId: string; onCopied?: () => void }) {
  return (
    <div className="stacked">
      <p className="note">{copy.install.scriptTag(label)}</p>
      <div>
        <a className="btn" href={SCRIPT_TAG_GUIDE} target="_blank" rel="noopener noreferrer">
          {copy.install.scriptTagGuide}
        </a>
      </div>
      <div className="property">
        <code>{projectId}</code>
        <CopyButton text={projectId} label={copy.install.copyProjectId} copiedLabel={copy.install.projectIdCopied} className="btn small" shown onCopied={onCopied} />
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

/**
 * Whether Critiqs has loaded at the project's own address yet, live:
 * waiting, then Connected with where and when. The people who manage the
 * project can clear it, and the next load from its address records it
 * again. Nothing on a backend that doesn't record it (no `connected` in its
 * setup), so it never waits forever.
 */
export function ConnectionStatus({
  setup,
  host,
  waiting,
  waitingNote,
}: {
  setup: QueryState<ProjectSetup>;
  host: string | null;
  /** What to say while waiting, in place of waiting for Critiqs to load on `host`. */
  waiting?: string;
  waitingNote?: string;
}) {
  const { clearConnected } = useBackend();
  const [clearing, setClearing] = useState<"idle" | "clearing" | "failed">("idle");
  if (setup.status !== "ready" || setup.data.connected === undefined) return null;
  const connected = setup.data.connected;
  if (connected === null) {
    return (
      <div className="connection waiting" role="status">
        <span className="pulse" aria-hidden="true" />
        <span className="stacked tight">
          <span>{waiting ?? copy.connection.waiting(host)}</span>
          {waitingNote !== undefined && <span className="note">{waitingNote}</span>}
        </span>
      </div>
    );
  }
  const clear = () => {
    setClearing("clearing");
    clearConnected(setup.data.projectId).then(
      () => setClearing("idle"),
      () => setClearing("failed"),
    );
  };
  return (
    <div className="connection connected" role="status">
      <CheckIcon />
      <span className="stacked tight grow">
        <span>{copy.connection.connected(connected.origin)}</span>
        <span className="note">{copy.connection.when(connected.at)}</span>
        {clearing === "failed" && <span className="note">{copy.connection.clearFailed}</span>}
      </span>
      {connected.clearable === true && (
        <button type="button" className="quiet" disabled={clearing === "clearing"} title={copy.connection.clearHint} onClick={clear}>
          {copy.connection.clear}
        </button>
      )}
    </div>
  );
}

/**
 * What the project's owners see about its setup emails while it waits:
 * "Waiting for install", who the steps went to, and when the last went out.
 * Null with no email that went out, or may have; a failed one isn't waiting.
 */
export function waitingForInstall(sends: readonly DeveloperSendSummary[]): string | null {
  const out = sends.filter((send) => send.status !== "failed");
  if (out.length === 0) return null;
  return copy.connection.waitingForInstall(
    out.map((send) => send.email),
    Math.max(...out.map((send) => send.lastSentAt)),
  );
}

/** Whether the clock has reached `at`, rendering again when it does; false for null. */
export function useReached(at: number | null | undefined, now: () => number = Date.now): boolean {
  const [, setTick] = useState(0);
  const reached = at != null && now() >= at;
  useEffect(() => {
    if (at == null || reached) return;
    // Timers longer than about 24.8 days fire at once, so a far time is checked again daily.
    const timer = setTimeout(() => setTick((tick) => tick + 1), Math.min(at - now() + 250, 86_400_000));
    return () => clearTimeout(timer);
  }, [at, reached]);
  return reached;
}

/**
 * The project's setup emails, for its owners: each address, and when its
 * email went out, or Not sent after a confirmed failure. With `resend`, an
 * address can be sent the steps again once its `resendAt` comes, or says
 * when it can. Nothing for anyone else, who can't read them.
 */
export function SendList({ sends, resend }: { sends: QueryState<DeveloperSendSummary[]>; resend?: (email: string) => Promise<DeveloperSendResult[]> }) {
  if (sends.status !== "ready" || sends.data.length === 0) return null;
  return (
    <section className="stacked" aria-label={copy.sends.title}>
      <h2 className="section-title">{copy.sends.title}</h2>
      <ul className="send-list">
        {sends.data.map((send) => (
          <SendRow key={send.sendId} send={send} resend={resend} />
        ))}
      </ul>
    </section>
  );
}

function SendRow({ send, resend }: { send: DeveloperSendSummary; resend?: (email: string) => Promise<DeveloperSendResult[]> }) {
  const due = useReached(send.resendAt);
  const [state, setState] = useState<{ status: "idle" | "sending" } | { status: "done"; text: string; error: boolean }>({ status: "idle" });
  const again = async () => {
    if (resend === undefined) return;
    setState({ status: "sending" });
    try {
      const [result] = await resend(send.email);
      setState(
        result?.status === "sent"
          ? { status: "done", text: copy.sends.resent, error: false }
          : { status: "done", text: result !== undefined && "message" in result ? result.message : copy.sends.resendFailed, error: true },
      );
    } catch {
      setState({ status: "done", text: copy.sends.resendFailed, error: true });
    }
  };
  return (
    <li className={send.status === "failed" ? "error" : undefined}>
      <span className="send-email">{send.email}</span>
      <span className="send-state">
        <span className="note">{send.status === "failed" ? copy.sends.notSent : copy.sends.sentAt(send.lastSentAt)}</span>
        {resend !== undefined && send.resendAt != null && state.status !== "done" &&
          (due ? (
            <button type="button" className="btn small" disabled={state.status === "sending"} aria-label={copy.sends.resendTo(send.email)} onClick={() => void again()}>
              {state.status === "sending" ? copy.sends.sending : copy.sends.resend}
            </button>
          ) : (
            <span className="note">{copy.sends.resendAfter(send.resendAt)}</span>
          ))}
        {state.status === "done" && (
          <span className={state.error ? "error" : "note"} role="status">
            {state.text}
          </span>
        )}
      </span>
    </li>
  );
}
