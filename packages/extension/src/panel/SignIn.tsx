import { type PanelSignIn, PanelSignInError } from "@critiqs/core";
import { type FormEvent, useRef, useState } from "react";
import type { ExtensionSession } from "../session.ts";

type Step =
  | { name: "email" }
  | { name: "code"; attempt: string; email: string; developmentCode?: string }
  | { name: "name"; attempt: string };

/**
 * Signing in inside the side panel, with no popup: an email address, the code
 * sent to it, and on a first sign-in a display name. The panel keeps the
 * session in the extension.
 */
export function SignIn({ client, session }: { client: PanelSignIn; session: ExtensionSession }) {
  const [step, setStep] = useState<Step>({ name: "email" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const email = useRef<HTMLInputElement>(null);
  const code = useRef<HTMLInputElement>(null);
  const name = useRef<HTMLInputElement>(null);

  const run = async (work: () => Promise<void>) => {
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
  const submit = (work: () => Promise<void>) => (event: FormEvent) => {
    event.preventDefault();
    if (!busy) void run(work);
  };
  const sendCode = async (address: string, attempt?: string) => {
    const sent = await client.sendCode(address, attempt);
    setStep({ name: "code", ...sent });
  };

  if (step.name === "email") {
    return (
      <div className="xt-screen">
        <h1>Sign in to Critiqs</h1>
        <p className="xt-line">We'll email you a code.</p>
        <form onSubmit={submit(() => sendCode(email.current?.value ?? ""))}>
          <label>
            Email
            <input ref={email} className="field" type="email" name="email" autoComplete="email" required autoFocus />
          </label>
          {error !== null && <p className="error" role="alert">{error}</p>}
          <div className="ds-actions">
            <button type="submit" className="btn primary" disabled={busy}>Send code</button>
          </div>
        </form>
      </div>
    );
  }

  if (step.name === "code") {
    return (
      <div className="xt-screen">
        <h1>Check your email</h1>
        <p className="xt-line">Enter the code we sent to {step.email}.</p>
        <form
          onSubmit={submit(async () => {
            const result = await client.checkCode(step.attempt, code.current?.value.trim() ?? "");
            if (result.status === "needs-name") setStep({ name: "name", attempt: step.attempt });
            else await session.signedIn(result);
          })}
        >
          <label>
            Code
            <input ref={code} key={step.attempt} className="field" name="code" inputMode="numeric" autoComplete="one-time-code" required autoFocus />
          </label>
          {step.developmentCode !== undefined && <p className="note">Development code: {step.developmentCode}</p>}
          {error !== null && <p className="error" role="alert">{error}</p>}
          <div className="ds-actions">
            <button type="submit" className="btn primary" disabled={busy}>Continue</button>
          </div>
        </form>
        <div className="xt-quiet">
          <button type="button" className="btn ghost" disabled={busy} onClick={() => void run(() => sendCode(step.email, step.attempt))}>Send a new code</button>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => (setError(null), setStep({ name: "email" }))}>Use another email</button>
        </div>
      </div>
    );
  }

  return (
    <div className="xt-screen">
      <h1>Choose your name</h1>
      <p className="xt-line">People see it beside your comments.</p>
      <form onSubmit={submit(async () => void (await session.signedIn(await client.chooseName(step.attempt, name.current?.value.trim() ?? ""))))}>
        <label>
          Name
          <input ref={name} className="field" name="name" autoComplete="name" maxLength={60} required autoFocus />
        </label>
        {error !== null && <p className="error" role="alert">{error}</p>}
        <div className="ds-actions">
          <button type="submit" className="btn primary" disabled={busy}>Continue</button>
        </div>
      </form>
    </div>
  );
}

function messageOf(error: unknown): string {
  if (error instanceof PanelSignInError) {
    if (error.code === "wrong-code" && error.guessesLeft !== undefined) return `That code isn't right. ${error.guessesLeft === 1 ? "1 try" : `${error.guessesLeft} tries`} left.`;
    if (error.code === "rate-limited" && error.retryAfter !== undefined) return `Too many tries. Wait ${Math.ceil(error.retryAfter / 60)} min and try again.`;
    return error.message;
  }
  return "Sign-in failed. Try again.";
}
