import { withSessionLock } from "./session-lock.ts";
/**
 * The reviewer's sign-in for this site. Tokens come from Critiqs's sign-in
 * popup, never from the host app, and refresh through Critiqs's server from
 * this site only. Tabs on the same site share one session.
 */

export interface Reviewer {
  /** The reviewer's permanent Critiqs ID. */
  id: string;
  name: string;
  email: string;
  pictureUrl: string | null;
}

/** What the interface needs from a sign-in, whichever kind of backend it uses. */
export interface ReviewerSession {
  getSnapshot(): { reviewer: Reviewer | null };
  subscribe(listener: () => void): () => void;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** Resolves to whether the backend already shows the new name. */
  setDisplayName(name: string): Promise<boolean>;
}

/** A sign-in that hands Convex its token, such as the popup's or a panel's own. */
export interface TokenSession extends ReviewerSession {
  /** The current access token, renewed when asked or shortly before it expires; null when signed out. */
  fetchAccessToken(args: { forceRefreshToken: boolean }): Promise<string | null>;
}

interface StoredSession {
  accessToken: string;
  refreshToken: string;
  /** Access token expiry, in milliseconds. */
  expiresAt: number;
  /**
   * The refresh token this site chose to replace `refreshToken` with, saved
   * before asking for it. If the answer never arrives (the page closed, the
   * network dropped), the service may already have made the switch, so the
   * same request is sent again until it has an answer.
   */
  nextRefreshToken?: string;
}

export class SignInError extends Error {
  constructor(
    readonly reason: "popup-blocked" | "closed" | "cancelled",
    message: string,
  ) {
    super(message);
  }
}

/** Refresh this long before the access token expires. */
const REFRESH_LEEWAY_MS = 60_000;

export class Session implements TokenSession {
  private readonly storageKey: string;
  private readonly listeners = new Set<() => void>();
  private refreshing: Promise<string | null> | null = null;
  private snapshot: { reviewer: Reviewer | null } = { reviewer: null };

  constructor(
    readonly signInUrl: string,
    private readonly storage: Storage = window.localStorage,
    private readonly fetchFn: (input: URL, init: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
  ) {
    this.storageKey = `critiqs:session:${signInUrl}`;
    this.snapshot = { reviewer: reviewerOf(this.read()) };
  }

  /** Stable snapshot for `useSyncExternalStore`. */
  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      if (event.key === this.storageKey) this.changed();
    };
    const onSameSite = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string; source: Session }>).detail;
      if (detail.key === this.storageKey && detail.source !== this) this.changed();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("critiqs:session-changed", onSameSite);
    return () => {
      this.listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("critiqs:session-changed", onSameSite);
    };
  };

  /**
   * Opens Critiqs's sign-in popup. Call it directly from a click so the browser
   * allows the popup. Resolves once the popup delivers tokens for this site.
   */
  signIn(): Promise<void> {
    const state = randomState();
    const url = new URL("/auth/start", this.signInUrl);
    url.search = new URLSearchParams({ origin: window.location.origin, state }).toString();
    const popup = window.open(url.toString(), "critiqs-sign-in", "popup,width=480,height=640");
    if (popup === null) {
      return Promise.reject(new SignInError("popup-blocked", "Your browser blocked the sign-in window. Allow pop-ups for this site and try again."));
    }
    const signInOrigin = new URL(this.signInUrl).origin;

    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error?: SignInError) => {
        if (done) return;
        done = true;
        window.removeEventListener("message", onMessage);
        clearInterval(closedPoll);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onMessage = (event: MessageEvent) => {
        const data = event.data as Record<string, unknown> | null;
        // Only this sign-in's own popup, from Critiqs's sign-in service, with this sign-in's nonce.
        if (event.source !== popup || event.origin !== signInOrigin || data?.type !== "critiqs:sign-in" || data.state !== state) return;
        if (typeof data.accessToken !== "string" || typeof data.refreshToken !== "string") {
          return finish(new SignInError("cancelled", "Sign-in was cancelled."));
        }
        this.write({ accessToken: data.accessToken, refreshToken: data.refreshToken, expiresAt: Number(data.expiresAt) });
        finish();
      };
      // The popup may be closed without finishing. Its last message can arrive
      // just after it closes, so wait briefly before giving up.
      const closedPoll = setInterval(() => {
        if (!popup.closed) return;
        clearInterval(closedPoll);
        setTimeout(() => finish(new SignInError("closed", "The sign-in window was closed.")), 500);
      }, 500);
      window.addEventListener("message", onMessage);
    });
  }

  /**
   * Keeps tokens a panel on this site signed in with itself, without the
   * popup, such as a review link's page asking for an email code at the
   * first comment. Only Critiqs's own pages call it, with tokens the sign-in
   * service just gave them; tabs on this site share the session as usual.
   */
  acceptPanelSignIn(tokens: { accessToken: string; refreshToken: string; expiresAt: number }): void {
    if (typeof tokens.accessToken !== "string" || typeof tokens.refreshToken !== "string" || !Number.isFinite(tokens.expiresAt)) {
      throw new Error("Critiqs: those sign-in tokens aren't complete.");
    }
    this.write({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt });
  }

  async signOut(): Promise<void> {
    const stored = this.read();
    this.write(null);
    if (stored === null) return;
    // After a refresh whose answer was lost, the service holds whichever token it switched to.
    const tokens = [stored.refreshToken, ...(stored.nextRefreshToken === undefined ? [] : [stored.nextRefreshToken])];
    await Promise.all(tokens.map((refreshToken) => this.fetchFn(new URL("/auth/sign-out", this.signInUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    }).catch(() => undefined)));
  }

  /**
   * Changes the reviewer's display name everywhere they sign in, then
   * refreshes this site's token so it carries the new name. Both steps run
   * under the session lock, so a refresh in another tab can neither consume
   * the token being used nor deliver a token issued before the change.
   * Resolves to whether this site's token now carries the new name; the name
   * is saved either way.
   */
  async setDisplayName(name: string): Promise<boolean> {
    const stored = this.read();
    if (stored === null) throw new Error("Sign in to change your name.");
    // The rename belongs to the reviewer who asked for it. If someone else
    // signs in on this site while it waits, it must not rename them.
    const reviewerId = reviewerOf(stored)?.id;
    const sameReviewer = (session: StoredSession) => reviewerOf(session)?.id === reviewerId;
    // Wait for any refresh this instance started, so the lock sees its result.
    await this.refreshing;
    // Without Web Locks the lock is claimed per refresh token, so it protects
    // only the token it was claimed for. If another tab rotated the token while
    // this one waited, claim again for the current token.
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = this.read();
      if (current === null || !sameReviewer(current)) throw new Error("You signed out, so your name wasn't changed.");
      const result = await withSessionLock(this.storageKey, current.refreshToken, async () => {
        const latest = this.read();
        if (latest === null || !sameReviewer(latest)) throw new Error("You signed out, so your name wasn't changed.");
        if (latest.refreshToken !== current.refreshToken) return "rotated" as const;
        // A refresh whose answer was lost may have replaced this token; finish it first.
        if (latest.nextRefreshToken !== undefined) {
          await this.refresh(latest);
          // Still pending: the service couldn't be reached or didn't answer.
          if (this.read()?.refreshToken === latest.refreshToken) throw new Error("Your name couldn't be changed. Check your connection and try again.");
          return "rotated" as const;
        }
        const response = await this.fetchFn(new URL("/auth/profile", this.signInUrl), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: latest.refreshToken, name }),
        });
        if (response.status === 400) {
          const { error } = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(error ?? "Use a name of 1 to 60 characters.");
        }
        if (response.status === 401) throw new Error("Your sign-in has ended. Sign in again to change your name.");
        if (!response.ok) throw new Error("Your name couldn't be changed. Try again.");
        return (await this.refresh(latest)) !== null;
      });
      if (result !== "rotated") return result;
    }
    throw new Error("Your name couldn't be changed while another tab was signing in. Try again.");
  }

  /** Token for Convex. Refreshes when asked, or shortly before expiry. */
  fetchAccessToken = async ({ forceRefreshToken }: { forceRefreshToken: boolean }): Promise<string | null> => {
    const stored = this.read();
    if (stored === null) return null;
    if (!forceRefreshToken && stored.expiresAt - Date.now() > REFRESH_LEEWAY_MS) return stored.accessToken;
    // Without Web Locks, a claim left by a page that closed mid-refresh never
    // clears. Sending the saved pair again is safe from any page (the service
    // repeats that refresh), so it goes ahead once a saved pair is there.
    const savedPair = () => {
      const current = this.read();
      return current?.refreshToken === stored.refreshToken && current.nextRefreshToken !== undefined;
    };
    this.refreshing ??= withSessionLock(this.storageKey, stored.refreshToken, async () => {
      const current = this.read();
      if (current === null) return null;
      // A competing instance/tab already rotated this token while we waited.
      if (current.refreshToken !== stored.refreshToken) return current.accessToken;
      return await this.refresh(current);
    }, savedPair).catch(() => null).finally(() => {
      this.refreshing = null;
    });
    return await this.refreshing;
  };

  private async refresh(seen: StoredSession): Promise<string | null> {
    // The caller may have waited (a rename's request): if the reviewer signed
    // out or in since, this refresh belongs to a session that is gone.
    const stored = this.read();
    if (stored?.refreshToken !== seen.refreshToken) return stored?.accessToken ?? null;
    // Saved before it is sent, so the page can finish this refresh even if it closes before the answer.
    const nextRefreshToken = stored.nextRefreshToken ?? randomRefreshToken();
    // Nothing to show changes, so listeners aren't told.
    if (stored.nextRefreshToken === undefined) this.storage.setItem(this.storageKey, JSON.stringify({ ...stored, nextRefreshToken }));
    let response: Response;
    try {
      response = await this.fetchFn(new URL("/auth/refresh", this.signInUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: stored.refreshToken, nextRefreshToken }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // Offline: keep the session and let Convex retry.
      return null;
    }
    // The reviewer may have signed out or in again while this request ran;
    // its result then belongs to a session that no longer exists.
    const isCurrent = () => this.read()?.refreshToken === stored.refreshToken;
    if (response.status === 401) {
      if (isCurrent()) this.write(null);
      return null;
    }
    if (!response.ok) return null;
    let next: StoredSession;
    try { next = await response.json() as StoredSession; } catch { return null; }
    if (typeof next.accessToken !== "string" || typeof next.refreshToken !== "string" || !Number.isFinite(next.expiresAt)) return null;
    if (!isCurrent()) {
      // Another tab finished this same refresh (it sent the same saved replacement): the session is theirs and ours.
      const latest = this.read();
      if (latest?.refreshToken === next.refreshToken) return latest.accessToken;
      // Rotation may have committed after sign-out revoked the old token.
      // Revoke the newly issued token rather than leaving that session alive,
      // but only while it is current: another tab may have finished this
      // refresh and renewed since, and that session is the reviewer's.
      await this.fetchFn(new URL("/auth/sign-out", this.signInUrl), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: next.refreshToken, onlyIfCurrent: true }),
      }).catch(() => undefined);
      return this.read()?.accessToken ?? null;
    }
    const { accessToken, refreshToken, expiresAt } = next;
    this.write({ accessToken, refreshToken, expiresAt });
    return accessToken;
  }

  private read(): StoredSession | null {
    try {
      const raw = this.storage.getItem(this.storageKey);
      return raw === null ? null : (JSON.parse(raw) as StoredSession);
    } catch {
      return null;
    }
  }

  private write(session: StoredSession | null) {
    if (session === null) this.storage.removeItem(this.storageKey);
    else this.storage.setItem(this.storageKey, JSON.stringify(session));
    window.dispatchEvent(new CustomEvent("critiqs:session-changed", { detail: { key: this.storageKey, source: this } }));
    this.changed();
  }

  private changed() {
    const reviewer = reviewerOf(this.read());
    if (JSON.stringify(reviewer) !== JSON.stringify(this.snapshot.reviewer)) this.snapshot = { reviewer };
    for (const listener of this.listeners) listener();
  }
}

/** Reads the reviewer's name and email from the token. Display only; the server verifies tokens. */
function reviewerOf(session: StoredSession | null): Reviewer | null {
  if (session === null) return null;
  try {
    const payload = session.accessToken.split(".")[1] ?? "";
    const json = decodeURIComponent(
      Array.from(atob(payload.replace(/-/g, "+").replace(/_/g, "/")), (char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""),
    );
    const claims = JSON.parse(json) as { sub?: string; name?: string; email?: string; picture?: string };
    return { id: claims.sub ?? "", name: claims.name ?? "Reviewer", email: claims.email ?? "", pictureUrl: claims.picture ?? null };
  } catch {
    return null;
  }
}

/** 32 random bytes, base64url: the form the sign-in service accepts for a refresh token a site chooses. */
function randomRefreshToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomState(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
