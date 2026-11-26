import { TRACKERS, type TicketsConfig, type TrackerAccountView, type TrackerDisconnected, type TrackerId, type TrackerSignInStart } from "@critiqs/core";
import { useEffect, useRef, useState } from "react";
import { errorMessage, type TicketTransport, useTransport } from "../transport.ts";
import { Dialog } from "./common.tsx";
import { DialogHeader, NavRow, SettingRow, Switch, usePageFocus } from "./ds.tsx";

/** Where people create a personal token, for trackers Critiqs connects so far. */
const TOKEN_PAGES: Partial<Record<TrackerId, string>> = {
  linear: "https://linear.app/settings/account/security",
  github: "https://github.com/settings/personal-access-tokens/new",
  jira: "https://id.atlassian.com/manage-profile/security/api-tokens",
};

/** Trackers whose accounts are on one of several sites, chosen when connecting (Jira Cloud): the site, and for a pasted token the account's email, go with it. */
const hasSites = (tracker: TrackerId) => tracker === "jira";

/** What each tracker calls the personal token people paste, and how to make one; an API key where a tracker isn't listed. */
const TOKEN_KINDS: Partial<Record<TrackerId, { field: string; instead: string; help: string; settings: string }>> = {
  github: {
    field: "Personal access token",
    instead: "Use a personal access token instead",
    help: "Create a fine-grained personal access token for the repositories you want, with read and write access to Issues and read access to Contents, then paste it here.",
    settings: "Open GitHub token settings",
  },
  jira: {
    field: "API token",
    instead: "Use an API token instead",
    help: "Create an API token in your Atlassian account's security settings, then paste it here with your Jira site and the email you sign in to Atlassian with.",
    settings: "Open Atlassian settings",
  },
};

function tokenKind(tracker: TrackerId) {
  const name = label(tracker);
  return (
    TOKEN_KINDS[tracker] ?? {
      field: "API key",
      instead: "Use an API key instead",
      help: `Create a personal API key in ${name}'s settings, then paste it here.`,
      settings: `Open ${name} settings`,
    }
  );
}

const label = (tracker: TrackerId) => TRACKERS.find((entry) => entry.id === tracker)?.label ?? tracker;

/**
 * What a disconnect left working at the tracker, for the person to know:
 * a pasted key, which only they can delete there; or a sign-in Critiqs
 * couldn't end, which they can end by removing Critiqs in the tracker.
 */
/** The service a tracker's accounts belong to, where it differs from the tracker's name: GitHub Issues' are GitHub accounts. */
const TRACKER_ACCOUNT: Partial<Record<TrackerId, string>> = { github: "GitHub" };

function leftAtTracker(tracker: TrackerId, outcome: TrackerDisconnected): { text: string; alert: boolean } | null {
  const name = label(tracker);
  if (outcome === "kept") return { text: `Critiqs no longer has your ${name} API key, but the key still works in ${name} until you delete it there.`, alert: false };
  if (outcome === "shared") {
    return {
      text: `${name} is disconnected here. Another Critiqs account is still connected to the same ${TRACKER_ACCOUNT[tracker] ?? name} account, which shares Critiqs's access at ${TRACKER_ACCOUNT[tracker] ?? name}, so that access stays until it disconnects too, or you remove Critiqs in ${TRACKER_ACCOUNT[tracker] ?? name}'s settings.`,
      alert: false,
    };
  }
  if (outcome === "failed") {
    return {
      text: `${name} is disconnected here, but Critiqs couldn't tell ${name} to end its access, so Critiqs can still reach your ${name} account. Critiqs will try again for about an hour; to end it now, remove Critiqs in ${name}'s settings.`,
      alert: true,
    };
  }
  return null;
}

const SIGN_IN_WINDOW = "critiqs-tracker-sign-in";
/** How long after posting the sign-in form a page's refusal of it (`form-action`) is still taken for that form's. */
const BLOCKED_WATCH_MS = 5_000;

/**
 * Sends the sign-in window to the backend's start by posting the state and
 * binding secret: never in an address, so a forwarded or logged link can't
 * open the sign-in in another browser.
 */
/** Whether a reported address is on `origin`; browsers may report a refused address as its origin only. */
function sameOrigin(reported: string, origin: string): boolean {
  try {
    return new URL(reported).origin === origin;
  } catch {
    return false;
  }
}

function postToWindow(start: TrackerSignInStart, parent: HTMLElement) {
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
  parent.append(form);
  try {
    form.submit();
  } finally {
    form.remove();
  }
}

/**
 * The signed-in person's own tracker accounts: each tracker the backend
 * offers, connected through the tracker's sign-in in a window served by the
 * backend, or with a personal token pasted here, which is also offered where
 * the tracker has sign-in. Each change saves at once.
 * Only offered on backends whose transport has `tickets`.
 */
export function YourTrackersDialog({ offered, onClose, notify }: { offered: TicketsConfig; onClose: () => void; notify: (message: string) => void }) {
  const tickets = useTransport().tickets!;
  const state = tickets.useTrackerAccounts(true);
  const [page, setPage] = useState<{ kind: "main" } | { kind: "token"; tracker: TrackerId } | { kind: "site"; tracker: TrackerId }>({ kind: "main" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the last disconnect left working at the tracker, said plainly.
  const [left, setLeft] = useState<{ text: string; alert: boolean } | null>(null);
  // A sign-in window opened for this tracker; the account appears when it finishes.
  const [waiting, setWaiting] = useState<TrackerId | null>(null);
  const [confirming, setConfirming] = useState<TrackerId | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  usePageFocus(mainRef, page.kind);
  // Stops watching for the page refusing the sign-in form; called when the dialog closes.
  const stopWatching = useRef<(() => void) | null>(null);
  useEffect(() => () => stopWatching.current?.(), []);

  const accounts = state.status === "ready" ? state.data : [];
  const connectedNow = waiting !== null && accounts.some((account) => account.tracker === waiting);
  useEffect(() => {
    if (!connectedNow) return;
    notify(`${label(waiting!)} connected`);
    setWaiting(null);
  }, [connectedNow]);

  /** Runs one change at a time; false when it failed, with its reason shown. */
  const attempt = async (work: () => Promise<unknown>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    setLeft(null);
    try {
      await work();
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const signIn = (tracker: TrackerId, site?: string) => {
    // Opened at once, from the click, so the browser allows it; the address follows.
    const popup = window.open("", SIGN_IN_WINDOW, "popup,width=520,height=720");
    if (popup === null) {
      setError("Your browser blocked the sign-in window. Allow pop-ups for this site and try again.");
      return;
    }
    void attempt(async () => {
      try {
        const start = await tickets.startTrackerSignIn(tracker, site);
        watchBlocked(tracker, popup, start.url);
        postToWindow(start, mainRef.current ?? document.body);
        setWaiting(tracker);
      } catch (failure) {
        popup.close();
        throw failure;
      }
    });
  };

  /**
   * A page whose content security policy doesn't let forms post to the
   * backend (`form-action`) blocks the sign-in; the browser says so with an
   * event, shortly after the post. The window then stays blank, so it closes.
   * Only an enforced refusal of a post to the sign-in's own address counts: a
   * report-only policy lets the post through, and another form's refusal is
   * someone else's.
   */
  const watchBlocked = (tracker: TrackerId, popup: Window, url: string) => {
    stopWatching.current?.();
    const target = new URL(url).origin;
    const onViolation = (event: SecurityPolicyViolationEvent) => {
      if (event.effectiveDirective !== "form-action" || event.disposition !== "enforce" || !sameOrigin(event.blockedURI, target)) return;
      stop();
      popup.close();
      setWaiting(null);
      setError(`This page doesn't allow the ${label(tracker)} sign-in window. ${tokenKind(tracker).instead}.`);
    };
    const timer = setTimeout(() => stop(), BLOCKED_WATCH_MS);
    const stop = () => {
      clearTimeout(timer);
      document.removeEventListener("securitypolicyviolation", onViolation);
      stopWatching.current = null;
    };
    document.addEventListener("securitypolicyviolation", onViolation);
    stopWatching.current = stop;
  };

  const go = (next: typeof page) => {
    setError(null);
    setConfirming(null);
    setPage(next);
  };

  if (page.kind === "site") {
    return (
      <Dialog label="Your trackers" onClose={onClose}>
        <SitePage
          tracker={page.tracker}
          busy={busy}
          onBack={() => go({ kind: "main" })}
          onToken={() => go({ kind: "token", tracker: page.tracker })}
          onSignIn={(site) => {
            signIn(page.tracker, site);
            setPage({ kind: "main" });
          }}
        />
      </Dialog>
    );
  }

  if (page.kind === "token") {
    return (
      <Dialog label="Your trackers" onClose={onClose}>
        <TokenPage
          tracker={page.tracker}
          tickets={tickets}
          onBack={() => go({ kind: "main" })}
          onConnected={(account) => {
            notify(`${label(account.tracker)} connected`);
            go({ kind: "main" });
          }}
        />
      </Dialog>
    );
  }

  return (
    <Dialog label="Your trackers" onClose={onClose}>
      <div ref={mainRef} className="ds-page">
        <DialogHeader title="Your trackers" onClose={onClose} />
        {state.status === "error" && <p className="error">{state.message}</p>}
        {state.status === "loading" && <p className="note">Loading…</p>}
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {left !== null && (
          <p className={left.alert ? "error" : "note"} role={left.alert ? "alert" : "status"}>
            {left.text}
          </p>
        )}
        {waiting !== null && (
          <p className="note" role="status">
            Finish connecting in the {label(waiting)} window.
          </p>
        )}
        {state.status === "ready" &&
          offered.trackers.map(({ id, signIn: method, installUrl }) => {
            const account = accounts.find((entry) => entry.tracker === id);
            return (
              <div key={id} className="ds-group" role="group" aria-label={label(id)}>
                <h4 className="ds-group-label">{label(id)}</h4>
                {account === undefined ? (
                  <>
                    <NavRow
                      label={`Connect ${label(id)}`}
                      disabled={busy}
                      onClick={() => (method !== "oauth" ? go({ kind: "token", tracker: id }) : hasSites(id) ? go({ kind: "site", tracker: id }) : signIn(id))}
                    />
                    {method === "oauth" && (
                      <div className="row">
                        <button type="button" className="link-btn" disabled={busy} onClick={() => go({ kind: "token", tracker: id })}>
                          {tokenKind(id).instead}
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <Connected
                    account={account}
                    installUrl={account.method === "oauth" ? (installUrl ?? null) : null}
                    busy={busy}
                    confirming={confirming === id}
                    onConfirm={(on) => setConfirming(on ? id : null)}
                    onAttribution={(on) =>
                      void attempt(() => tickets.setTrackerAttribution(id, on)).then((ok) => ok && notify(on ? "New tickets say they came from Critiqs" : "New tickets won't say they came from Critiqs"))
                    }
                    onDisconnect={() => {
                      let outcome: TrackerDisconnected = "none";
                      void attempt(async () => {
                        outcome = await tickets.disconnectTracker(id);
                      }).then((ok) => {
                        if (!ok) return;
                        setConfirming(null);
                        setLeft(leftAtTracker(id, outcome));
                        notify(`${label(id)} disconnected`);
                        // The rows that held focus are gone; the dialog keeps it.
                        mainRef.current?.closest<HTMLElement>('[role="dialog"]')?.focus();
                      });
                    }}
                  />
                )}
              </div>
            );
          })}
      </div>
    </Dialog>
  );
}

function Connected({
  account,
  installUrl,
  busy,
  confirming,
  onConfirm,
  onAttribution,
  onDisconnect,
}: {
  account: TrackerAccountView;
  /** Where an organization installs the tracker's app to reach more of its repositories (GitHub); null where there is none. */
  installUrl: string | null;
  busy: boolean;
  confirming: boolean;
  onConfirm: (on: boolean) => void;
  onAttribution: (on: boolean) => void;
  onDisconnect: () => void;
}) {
  const keepButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) keepButton.current?.focus();
  }, [confirming]);
  const name = label(account.tracker);
  return (
    <>
      <div className="ds-row">
        <span className="ds-row-label stacked">
          <span className="ellipsis">{account.accountName}</span>
          {account.site !== null && <span className="note ellipsis">{account.site}</span>}
        </span>
      </div>
      {installUrl !== null && (
        <div className="row">
          <a className="link-btn" href={installUrl} target="_blank" rel="noreferrer noopener">
            Choose repositories in GitHub
          </a>
        </div>
      )}
      <SettingRow label="Created from Critiqs">{(labelId) => <Switch checked={account.attribution} labelledBy={labelId} disabled={busy} onChange={onAttribution} />}</SettingRow>
      {confirming ? (
        <div className="warning stacked" role="alert">
          <span>Disconnect {name}? Tickets already linked keep their links.</span>
          {account.tracker === "github" && account.method === "oauth" && (
            <span>
              At GitHub, this ends Critiqs's access to the GitHub account {account.accountName}, unless another Critiqs account is connected to it: GitHub gives
              Critiqs one access per GitHub account, so it stays until the last Critiqs account connected to it disconnects.
            </span>
          )}
          <div className="row end">
            <button ref={keepButton} type="button" className="btn small" disabled={busy} onClick={() => onConfirm(false)}>
              Keep {name}
            </button>
            <button type="button" className="btn small danger solid" disabled={busy} onClick={onDisconnect}>
              {busy ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        </div>
      ) : (
        <NavRow label="Disconnect" onClick={() => onConfirm(true)} />
      )}
    </>
  );
}

/** Connecting with a pasted personal token: where the backend has no sign-in for the tracker, or instead of it. */
function TokenPage({ tracker, tickets, onBack, onConnected }: { tracker: TrackerId; tickets: TicketTransport; onBack: () => void; onConnected: (account: TrackerAccountView) => void }) {
  const [token, setToken] = useState("");
  const [site, setSite] = useState("");
  const [email, setEmail] = useState("");
  const sited = hasSites(tracker);
  const filled = token.trim() !== "" && (!sited || (site.trim() !== "" && email.trim() !== ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  usePageFocus(pageRef, tracker, { initial: true });
  const name = label(tracker);
  const kind = tokenKind(tracker);
  const submit = async () => {
    if (busy || !filled) return;
    setBusy(true);
    setError(null);
    try {
      onConnected(await (sited ? tickets.connectTrackerWithToken(tracker, token, { email, site }) : tickets.connectTrackerWithToken(tracker, token)));
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };
  return (
    <div ref={pageRef}>
      <form
        className="ds-page"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <DialogHeader title={`Connect ${name}`} onBack={onBack} />
        <p className="note">{kind.help}</p>
        {sited && (
          <>
            <label className="stacked">
              <span className="field-label">Jira site</span>
              <input className="field" autoComplete="url" value={site} placeholder="your-team.atlassian.net" onChange={(event) => setSite(event.target.value)} />
            </label>
            <label className="stacked">
              <span className="field-label">Atlassian email</span>
              <input className="field" type="email" autoComplete="email" value={email} placeholder="you@example.com" onChange={(event) => setEmail(event.target.value)} />
            </label>
          </>
        )}
        <label className="stacked">
          <span className="field-label">{kind.field}</span>
          <input className="field" type="password" autoComplete="off" value={token} placeholder={`Paste the ${kind.field === "API key" ? "key" : "token"}`} onChange={(event) => setToken(event.target.value)} />
        </label>
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="ds-actions between">
          {TOKEN_PAGES[tracker] !== undefined ? (
            <a className="link-btn" href={TOKEN_PAGES[tracker]} target="_blank" rel="noreferrer noopener">
              {kind.settings}
            </a>
          ) : (
            <span />
          )}
          <button type="submit" className="btn primary" disabled={busy || !filled}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Choosing the site before a tracker's sign-in, where accounts are on one of
 * several sites (Jira Cloud): the sign-in connects that site only.
 */
function SitePage({ tracker, busy, onBack, onToken, onSignIn }: { tracker: TrackerId; busy: boolean; onBack: () => void; onToken: () => void; onSignIn: (site: string) => void }) {
  const [site, setSite] = useState("");
  const pageRef = useRef<HTMLDivElement>(null);
  usePageFocus(pageRef, tracker, { initial: true });
  return (
    <div ref={pageRef}>
      <form
        className="ds-page"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && site.trim() !== "") onSignIn(site.trim());
        }}
      >
        <DialogHeader title={`Connect ${label(tracker)}`} onBack={onBack} />
        <p className="note">Enter your Jira site's address, then sign in with Atlassian and allow Critiqs. If Atlassian asks which site to use, choose this one.</p>
        <label className="stacked">
          <span className="field-label">Jira site</span>
          <input className="field" autoComplete="url" value={site} placeholder="your-team.atlassian.net" onChange={(event) => setSite(event.target.value)} />
        </label>
        <div className="ds-actions between">
          <button type="button" className="link-btn" disabled={busy} onClick={onToken}>
            {tokenKind(tracker).instead}
          </button>
          <button type="submit" className="btn primary" disabled={busy || site.trim() === ""}>
            Sign in with Atlassian
          </button>
        </div>
      </form>
    </div>
  );
}
