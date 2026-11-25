import { type Reviewer, type ReviewerSession, SignInError } from "../session.ts";

/** Header every call to a server in the host app carries; see the server's handler. */
export const REQUEST_HEADER = { "X-Critiqs-Request": "1" };

/**
 * Sign-in with a server in the host app. The server keeps the session in a
 * cookie on this site, so the browser holds no tokens. With the host app's
 * own sign-in, whoever is signed in to the app is the reviewer.
 */
export class CookieSession implements ReviewerSession {
  private snapshot: { reviewer: Reviewer | null } = { reviewer: null };
  private readonly listeners = new Set<() => void>();
  /** Whether the server has said who is signed in yet. */
  loaded = false;

  constructor(
    readonly baseUrl: string,
    readonly mode: "host" | "email" | "development" | "unavailable" | null,
    private readonly fetchFn: (input: string, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
  ) {}

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Asks the server who is signed in. */
  async refresh(): Promise<void> {
    const response = await this.fetchFn(`${this.baseUrl}/me`, { credentials: "same-origin", headers: REQUEST_HEADER });
    if (!response.ok) return;
    const { reviewer } = (await response.json()) as { reviewer: Reviewer | null };
    this.loaded = true;
    if (JSON.stringify(reviewer) === JSON.stringify(this.snapshot.reviewer)) return;
    this.snapshot = { reviewer };
    for (const listener of this.listeners) listener();
  }

  signIn(): Promise<void> {
    if (this.mode === "host") {
      return Promise.reject(new SignInError("cancelled", "Sign in to this app to comment."));
    }
    const state = crypto.randomUUID();
    const popup = window.open(`${this.baseUrl}/auth/start?state=${encodeURIComponent(state)}`, "critiqs-sign-in", "popup,width=480,height=640");
    if (popup === null) {
      return Promise.reject(new SignInError("popup-blocked", "Your browser blocked the sign-in window. Allow pop-ups for this site and try again."));
    }
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error?: SignInError) => {
        if (done) return;
        done = true;
        window.removeEventListener("message", onMessage);
        clearInterval(closedPoll);
        if (error === undefined) this.refresh().then(resolve, reject);
        else reject(error);
      };
      const onMessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; state?: string } | null;
        // Only this sign-in's own window, from this site, with this sign-in's nonce.
        if (event.source !== popup || event.origin !== window.location.origin || data?.type !== "critiqs:sign-in" || data.state !== state) return;
        finish();
      };
      const closedPoll = setInterval(() => {
        if (!popup.closed) return;
        clearInterval(closedPoll);
        setTimeout(() => finish(new SignInError("closed", "The sign-in window was closed.")), 500);
      }, 500);
      window.addEventListener("message", onMessage);
    });
  }

  async signOut(): Promise<void> {
    await this.fetchFn(`${this.baseUrl}/auth/sign-out`, { method: "POST", credentials: "same-origin", headers: REQUEST_HEADER }).catch(() => undefined);
    await this.refresh().catch(() => undefined);
  }

  async setDisplayName(name: string): Promise<boolean> {
    const response = await this.fetchFn(`${this.baseUrl}/auth/profile`, {
      method: "POST",
      credentials: "same-origin",
      headers: { ...REQUEST_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) {
      const { error } = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(error?.message ?? "Your name couldn't be changed.");
    }
    await this.refresh();
    return true;
  }
}
