import { TRACKERS, type TrackerAccountView, type TrackerId, type TrackerSignInStart } from "@critiqs/core";
import { type FormEvent, useId, useState } from "react";
import { failureMessage, type TrackersBackend, useBackend } from "../backend.ts";
import { copy } from "../copy.ts";

// Your trackers on the website, after the prototype's setup: each tracker the
// backend offers, and the person's own account in it, connected as in the
// panel's Your trackers: the tracker's sign-in in a window the backend
// serves (state and binding posted, never in an address), or a personal
// token pasted here. Jira asks for the site first. Only where the backend
// offers tickets.

const SIGN_IN_WINDOW = "critiqs-tracker-sign-in";
const label = (tracker: TrackerId) => TRACKERS.find((entry) => entry.id === tracker)?.label ?? tracker;

/** Posts the sign-in's state and binding to the window, never in an address. */
function postToWindow(start: TrackerSignInStart) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = start.url;
  form.target = SIGN_IN_WINDOW;
  form.hidden = true;
  for (const [name, value] of [
    ["state", start.state],
    ["binding", start.binding],
  ] as const) {
    const field = document.createElement("input");
    field.type = "hidden";
    field.name = name;
    field.value = value;
    form.append(field);
  }
  document.body.append(form);
  try {
    form.submit();
  } finally {
    form.remove();
  }
}

/** Your trackers, where the backend offers tickets; nothing elsewhere. */
export function YourTrackers() {
  const trackers = useBackend().trackers;
  if (trackers === undefined) return null;
  return <TrackersSection trackers={trackers} />;
}

function TrackersSection({ trackers }: { trackers: TrackersBackend }) {
  const accounts = trackers.useAccounts(true);
  return (
    <section className="trackers" aria-label={copy.trackers.heading}>
      <h2>{copy.trackers.heading}</h2>
      <p className="note">{copy.trackers.lead}</p>
      {accounts.status === "error" && <p className="error">{accounts.message}</p>}
      <ul className="tracker-rows">
        {trackers.offered.trackers.map((offer) => (
          <TrackerRow
            key={offer.id}
            trackers={trackers}
            tracker={offer.id}
            signIn={offer.signIn}
            account={accounts.status === "ready" ? (accounts.data.find((account) => account.tracker === offer.id) ?? null) : undefined}
          />
        ))}
      </ul>
      <p className="note">{copy.trackers.later}</p>
    </section>
  );
}

function TrackerRow({ trackers, tracker, signIn, account }: { trackers: TrackersBackend; tracker: TrackerId; signIn: "oauth" | "token"; account: TrackerAccountView | null | undefined }) {
  const [form, setForm] = useState<"none" | "site" | "token">("none");
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [site, setSite] = useState("");
  const ids = { token: useId(), email: useId(), site: useId() };
  const name = label(tracker);
  const jira = tracker === "jira";

  const startSignIn = async (chosenSite?: string) => {
    // Opened at once, from the click, so the browser allows it; the address follows.
    const popup = window.open("", SIGN_IN_WINDOW, "popup,width=520,height=720");
    if (popup === null) {
      setError(copy.trackers.blocked);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      postToWindow(await trackers.startSignIn(tracker, chosenSite));
      setWaiting(true);
      setForm("none");
    } catch (failure) {
      popup.close();
      setError(failureMessage(failure, "Couldn't start signing in. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const connect = (event: FormEvent) => {
    event.preventDefault();
    if (form === "site") {
      void startSignIn(site.trim());
      return;
    }
    setBusy(true);
    setError(null);
    trackers
      .connectWithToken(tracker, token.trim(), jira ? { email: email.trim(), site: site.trim() } : undefined)
      .then(
        () => {
          setForm("none");
          setToken("");
        },
        (failure) => setError(failureMessage(failure, "Couldn't connect. Check the key and try again.")),
      )
      .finally(() => setBusy(false));
  };

  const connected = account !== null && account !== undefined;
  return (
    <li className="tracker-row">
      <div className="tracker-head">
        <strong>{name}</strong>
        {account === undefined ? null : connected ? (
          <span className="note">{copy.trackers.connected(account.accountName, account.site)}</span>
        ) : form === "none" ? (
          <span className="tracker-actions">
            {signIn === "oauth" && (
              <button type="button" className="btn" disabled={busy} onClick={() => (jira ? setForm("site") : void startSignIn())}>
                {copy.trackers.connect}
              </button>
            )}
            <button type="button" className={signIn === "oauth" ? "quiet" : "btn"} disabled={busy} onClick={() => setForm("token")}>
              {signIn === "oauth" ? copy.trackers.useKey : copy.trackers.connect}
            </button>
          </span>
        ) : null}
      </div>
      {!connected && waiting && form === "none" && <p className="note" role="status">{copy.trackers.waiting}</p>}
      {!connected && form !== "none" && (
        <form className="tracker-form" onSubmit={connect}>
          {(form === "site" || jira) && (
            <label htmlFor={ids.site}>
              <span className="field-label">{copy.trackers.site}</span>
              <input id={ids.site} className="field" value={site} placeholder={copy.trackers.sitePlaceholder} autoComplete="off" onChange={(event) => setSite(event.target.value)} />
            </label>
          )}
          {form === "token" && jira && (
            <label htmlFor={ids.email}>
              <span className="field-label">{copy.trackers.email}</span>
              <input id={ids.email} className="field" type="email" value={email} autoComplete="email" onChange={(event) => setEmail(event.target.value)} />
            </label>
          )}
          {form === "token" && (
            <label htmlFor={ids.token}>
              <span className="field-label">{copy.trackers.keyLabel(name)}</span>
              <input id={ids.token} className="field" type="password" value={token} autoComplete="off" onChange={(event) => setToken(event.target.value)} />
            </label>
          )}
          <div className="field-row">
            <button
              type="submit"
              className="btn primary"
              disabled={busy || (form === "site" ? site.trim() === "" : token.trim() === "" || (jira && (email.trim() === "" || site.trim() === "")))}
            >
              {copy.trackers.save}
            </button>
            <button type="button" className="quiet" disabled={busy} onClick={() => setForm("none")}>
              {copy.trackers.cancel}
            </button>
          </div>
        </form>
      )}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
