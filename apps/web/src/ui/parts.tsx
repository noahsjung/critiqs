import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { copy } from "../copy.ts";
import { copyText } from "../clipboard.ts";
import { BackIcon, SignInError, StepDots } from "../shared.ts";
import { useAuth } from "../backend.ts";

// Pieces every page of the website's app is built from, on top of the design
// system's (docs/design-system.md).

/**
 * A page's title, with Back after the first step and where the flow is. The
 * title takes focus when the page changes, since the control that changed it
 * is gone, and screen readers then read the new page's name.
 */
export function PageHeader({
  title,
  id,
  onBack,
  backDisabled = false,
  step,
}: {
  title: string;
  id?: string;
  onBack?: () => void;
  /** Back is shown but waits, such as while the project is being created. */
  backDisabled?: boolean;
  step?: { current: number; count: number };
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), [title]);
  return (
    <div className="ds-dialog-header">
      {onBack !== undefined && (
        <button type="button" className="icon-btn" aria-label={copy.back} disabled={backDisabled} onClick={onBack}>
          <BackIcon />
        </button>
      )}
      <h1 ref={ref} id={id} tabIndex={-1}>
        {title}
      </h1>
      {step !== undefined && <StepDots current={step.current} count={step.count} />}
    </div>
  );
}

/** A page's actions, bottom right: the quiet Skip beside the one primary action. */
export function Actions({ onSkip, children }: { onSkip?: () => void; children?: ReactNode }) {
  return (
    <div className="ds-actions">
      {onSkip !== undefined && (
        <button type="button" className="btn ghost" onClick={onSkip}>
          {copy.skip}
        </button>
      )}
      {children}
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
  className = "btn small",
}: {
  text: string;
  label: string;
  copiedLabel: string;
  name?: string;
  shown?: boolean;
  className?: string;
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
        className={className}
        aria-label={result === "idle" ? name : shownLabel}
        onClick={async () => setResult((await copyText(text)) ? "copied" : "failed")}
      >
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

/** Install commands, each on its own line with its own copy button. */
export function Commands({ commands }: { commands: readonly string[] }) {
  return (
    <div className="commands">
      {commands.map((command) => (
        <div key={command} className="code light">
          <code>{command}</code>
          <CopyButton text={command} label={copy.install.copyCommand} copiedLabel={copy.install.commandCopied} name={copy.install.copyCommandOf(command)} shown />
        </div>
      ))}
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
      <div className="commands">
        <div className="code light">
          <code>{property}</code>
          <CopyButton text={property} label={copy.install.copyProperty} copiedLabel={copy.install.propertyCopied} shown />
        </div>
      </div>
    </div>
  );
}

/** One answer from a list, as radio buttons labelled by the page's title. */
export function RadioList<T extends string>({
  labelledBy,
  options,
  value,
  onChange,
}: {
  labelledBy: string;
  options: Readonly<Record<T, string>>;
  value: T | undefined;
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="options">
      {(Object.entries(options) as [T, string][]).map(([option, label]) => (
        <label key={option} className="option">
          <input type="radio" name={name} value={option} checked={value === option} onChange={() => onChange(option)} />
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}

/** Any answers from a list, as checkboxes labelled by the page's title. */
export function CheckList<T extends string>({
  labelledBy,
  options,
  value,
  onChange,
}: {
  labelledBy: string;
  options: Readonly<Record<T, string>>;
  value: readonly T[];
  onChange: (value: T[]) => void;
}) {
  const all = Object.keys(options) as T[];
  return (
    <div role="group" aria-labelledby={labelledBy} className="options">
      {all.map((option) => (
        <label key={option} className="option">
          <input
            type="checkbox"
            checked={value.includes(option)}
            // In the question's order, whatever order they were chosen in.
            onChange={(event) => onChange(all.filter((each) => (each === option ? event.target.checked : value.includes(each))))}
          />
          <span>{options[option]}</span>
        </label>
      ))}
    </div>
  );
}

/** The sign-in button and what happened to the sign-in window. */
export function SignInButton() {
  const auth = useAuth();
  const [state, setState] = useState<{ status: "idle" | "waiting" } | { status: "failed"; reason: SignInError["reason"]; message: string }>({ status: "idle" });
  const signIn = async () => {
    setState({ status: "waiting" });
    try {
      await auth.signIn();
      setState({ status: "idle" });
    } catch (error) {
      setState(error instanceof SignInError ? { status: "failed", reason: error.reason, message: error.message } : { status: "failed", reason: "cancelled", message: String(error) });
    }
  };
  const waiting = state.status === "waiting" || (auth.reviewer !== null && !auth.ready);
  return (
    <>
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
      <Actions>
        <button type="button" className="btn primary" disabled={waiting} onClick={() => void signIn()}>
          {state.status === "failed" ? copy.signIn.tryAgain : copy.signIn.button}
        </button>
      </Actions>
    </>
  );
}

