import { type PanelSignedIn, type PanelSignIn, PanelSignInError } from "@critiqs/core";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { copy } from "../copy.ts";

type Step = { name: "email" } | { name: "code"; attempt: string; email: string; developmentCode?: string } | { name: "name"; attempt: string };

/**
 * Signing in inside a review link's page, without a popup: an email address,
 * the code sent to it, and on a first sign-in a display name. `onSignedIn`
 * gets the tokens to keep; `onCancel` closes it, keeping everything else on
 * the page as it was.
 */
export function ReviewSignIn({ client, lead, onSignedIn, onCancel }: { client: PanelSignIn; lead: string; onSignedIn: (signedIn: PanelSignedIn) => Promise<void>; onCancel: () => void }) {
  const [step, setStep] = useState<Step>({ name: "email" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const titleId = useId();
  useEffect(() => field.current?.focus(), [step.name]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  const run = (work: () => Promise<void>) => async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      if (failure instanceof PanelSignInError && (failure.code === "expired" || failure.code === "locked" || failure.code === "too-many-codes")) setStep({ name: "email" });
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };
  const sendCode = async (email: string, attempt?: string) => setStep({ name: "code", ...(await client.sendCode(email, attempt)) });
  const value = () => field.current?.value.trim() ?? "";

  return (
    <div className="review-dialog-backdrop">
      <div className="review-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        {step.name === "email" && (
          <form onSubmit={run(() => sendCode(value()))}>
            <h2 id={titleId}>{copy.review.signIn.title}</h2>
            <p className="note">{lead}</p>
            <label className="review-field">
              {copy.review.signIn.email}
              <input ref={field} className="field" type="email" name="email" autoComplete="email" required />
            </label>
            {error !== null && <p className="error" role="alert">{error}</p>}
            <div className="review-dialog-actions">
              <button type="button" className="btn" onClick={onCancel}>{copy.review.signIn.cancel}</button>
              <button type="submit" className="btn primary" disabled={busy}>{copy.review.signIn.sendCode}</button>
            </div>
          </form>
        )}
        {step.name === "code" && (
          <form
            onSubmit={run(async () => {
              const result = await client.checkCode(step.attempt, value());
              if (result.status === "needs-name") setStep({ name: "name", attempt: step.attempt });
              else await onSignedIn(result);
            })}
          >
            <h2 id={titleId}>{copy.review.signIn.checkEmail}</h2>
            <p className="note">{copy.review.signIn.codeSent(step.email)}</p>
            <label className="review-field">
              {copy.review.signIn.code}
              <input ref={field} key={step.attempt} className="field" name="code" inputMode="numeric" autoComplete="one-time-code" required />
            </label>
            {step.developmentCode !== undefined && <p className="note">{copy.review.signIn.developmentCode(step.developmentCode)}</p>}
            {error !== null && <p className="error" role="alert">{error}</p>}
            <div className="review-dialog-actions">
              <button type="button" className="quiet" disabled={busy} onClick={() => void run(() => sendCode(step.email, step.attempt))()}>{copy.review.signIn.newCode}</button>
              <button type="button" className="btn" onClick={onCancel}>{copy.review.signIn.cancel}</button>
              <button type="submit" className="btn primary" disabled={busy}>{copy.continue}</button>
            </div>
          </form>
        )}
        {step.name === "name" && (
          <form onSubmit={run(async () => onSignedIn(await client.chooseName(step.attempt, value())))}>
            <h2 id={titleId}>{copy.review.signIn.chooseName}</h2>
            <p className="note">{copy.review.signIn.nameLead}</p>
            <label className="review-field">
              {copy.review.signIn.name}
              <input ref={field} className="field" name="name" autoComplete="name" maxLength={60} required />
            </label>
            {error !== null && <p className="error" role="alert">{error}</p>}
            <div className="review-dialog-actions">
              <button type="button" className="btn" onClick={onCancel}>{copy.review.signIn.cancel}</button>
              <button type="submit" className="btn primary" disabled={busy}>{copy.continue}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function messageOf(error: unknown): string {
  if (error instanceof PanelSignInError) {
    if (error.code === "wrong-code" && error.guessesLeft !== undefined) return copy.review.signIn.wrongCode(error.guessesLeft);
    if (error.code === "rate-limited" && error.retryAfter !== undefined) return copy.review.signIn.rateLimited(Math.ceil(error.retryAfter / 60));
    return error.message;
  }
  return error instanceof Error ? error.message : copy.review.signIn.failed;
}
