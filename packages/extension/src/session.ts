import { type PanelSignedIn, type PanelSignIn, PanelSignInError, type PanelTokens } from "@critiqs/core";
import type { Reviewer, TokenSession } from "../../react/src/session.ts";
import type { ChromeApi, StorageArea } from "./chrome.ts";

/**
 * The reviewer's Critiqs sign-in in the extension: signed in inside the side
 * panel (no popup), kept in the extension's own storage so every part of the
 * extension shares it, renewed before it expires, and ended on sign-out.
 *
 * Every renewal replaces the refresh token, so changes to the stored session
 * happen one at a time across the extension (a Web Lock where there is one).
 * Signing out doesn't wait for that: it replaces a random sign-out mark at
 * once, and a session belongs to the mark it was signed in under, so every
 * session from before the sign-out counts as signed out from that moment,
 * including one a renewal under way writes afterwards, and whatever the
 * computer's clock does. Whichever part of the extension next finds such a
 * session clears it and ends it on the service, and keeps trying to end it
 * until the service has.
 *
 * A renewal's answer can be lost after the service has made the switch: the
 * side panel closes, Chrome stops the worker, or the network drops. So the
 * replacement refresh token is chosen here and saved before the renewal is
 * sent, and whichever part of the extension renews next sends the same pair
 * again; the service repeats a renewal sent that way. The lock makes the
 * parts take turns: it is per extension, so the side panel and the worker
 * share it, and Chrome releases it when the part holding it closes. Content
 * scripts never renew; they ask the worker.
 */

export interface StoredSession extends PanelTokens {
  /** When the session ends however often it is renewed, in milliseconds. */
  sessionEndsAt: number;
  reviewer: { id: string; name: string; email: string };
  /** The sign-out mark the session was signed in under; a sign-out replaces the mark. */
  mark?: string;
  /**
   * The refresh token chosen to replace `refreshToken`, saved before the
   * renewal is sent. While it is here, the service may already have switched
   * to it, so every renewal sends this same pair until one is answered.
   */
  nextRefreshToken?: string;
}

/** Renew this long before the access token expires. */
const RENEW_LEEWAY_MS = 60_000;

export const sessionKey = (signInUrl: string) => `session:${signInUrl}`;
/** The sign-out mark: replaced by every sign-out with this sign-in service. */
export const signedOutKey = (signInUrl: string) => `signed-out:${signInUrl}`;
/** Refresh tokens of sessions signed out here that the service hasn't confirmed ending yet. */
export const endingKey = (signInUrl: string) => `ending:${signInUrl}`;

export type Locks = { request<T>(name: string, callback: () => Promise<T>): Promise<T> };

export class ExtensionSession implements TokenSession {
  readonly #key: string;
  readonly #markKey: string;
  readonly #endingKey: string;
  /** Refresh tokens this part of the extension is ending on the service now. */
  readonly #ending = new Set<string>();
  readonly #listeners = new Set<() => void>();
  #snapshot: { reviewer: Reviewer | null } = { reviewer: null };
  #renewing: Promise<string | null> | null = null;
  #cleaning: Promise<void> | null = null;
  #cleanAgain = false;
  /** Resolves once the stored session has been read. */
  readonly ready: Promise<void>;

  constructor(
    readonly signInUrl: string,
    private readonly client: PanelSignIn,
    private readonly storage: StorageArea,
    onChanged: ChromeApi["storage"]["onChanged"] | null,
    /** Shows the panel's sign-in, when the interface asks the reviewer to sign in. */
    private readonly showSignIn: () => void = () => {},
    private readonly locks: Locks | null = (globalThis.navigator as { locks?: Locks } | undefined)?.locks ?? null,
    private readonly now: () => number = Date.now,
    private readonly newMark: () => string = () => crypto.randomUUID(),
  ) {
    this.#key = sessionKey(signInUrl);
    this.#markKey = signedOutKey(signInUrl);
    this.#endingKey = endingKey(signInUrl);
    // Sessions a sign-out left behind, here or in a panel that closed, are ended on the way.
    this.ready = this.#reload().then(() => void this.#cleanUp());
    onChanged?.addListener((changes, area) => {
      if (area === "local" && (this.#key in changes || this.#markKey in changes)) void this.#reload();
    });
  }

  getSnapshot = () => this.#snapshot;

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  /** The signed-in reviewer, once `ready`. */
  get reviewer(): Reviewer | null {
    return this.#snapshot.reviewer;
  }

  /**
   * Keeps a session the panel's sign-in just started, under the current
   * sign-out mark. A session it replaces, such as one signed out whose
   * clean-up hasn't run yet, is listed to end on the service first.
   */
  async signedIn(session: PanelSignedIn): Promise<void> {
    const { accessToken, refreshToken, expiresAt, sessionEndsAt, reviewer } = session;
    await this.#locked(async () => {
      const items = await this.storage.get([this.#key, this.#markKey, this.#endingKey]);
      const mark = items[this.#markKey];
      const kept = { [this.#key]: { accessToken, refreshToken, expiresAt, sessionEndsAt, reviewer, ...(typeof mark === "string" ? { mark } : {}) } };
      const replaced = parseStored(items[this.#key]);
      const listed = tokensIn(items[this.#endingKey]);
      if (replaced !== null && replaced.refreshToken !== refreshToken) for (const token of tokensOf(replaced)) if (!listed.includes(token)) listed.push(token);
      // One write: the replaced session is listed to end only if the new one is kept.
      await this.storage.set(listed.length === 0 ? kept : { ...kept, [this.#endingKey]: listed });
    });
    await this.#reload();
    void this.#cleanUp();
  }

  /** The interface asks for sign-in, such as on entering Comment mode signed out: the panel shows its own. */
  async signIn(): Promise<void> {
    this.showSignIn();
  }

  /**
   * Signs out: a new sign-out mark first, in one write, so the sign-out holds
   * at once everywhere even if this panel closes right after; then the
   * session is cleared and ended on the service.
   */
  async signOut(): Promise<void> {
    this.#show(null);
    await this.storage.set({ [this.#markKey]: this.newMark() });
    await this.#reload();
    await this.#cleanUp();
  }

  /**
   * Changes the display name everywhere, then renews so the token carries it.
   * Resolves to whether it does. Under the lock, so a renewal can't replace
   * the token while the service checks it.
   */
  async setDisplayName(name: string): Promise<boolean> {
    // The reviewer this panel showed when the name was saved: a sign-in elsewhere since mustn't get the name.
    const asked = this.#snapshot.reviewer?.id;
    const sameReviewer = (session: StoredSession | null) => session !== null && session.reviewer.id === asked;
    await this.#locked(async () => {
      let stored = await this.#read();
      if (stored === null) throw new Error("Sign in to change your name.");
      if (!sameReviewer(stored)) throw new Error("You signed out, so your name wasn't changed.");
      // A renewal whose answer was lost may have replaced this token; finish it first.
      if (stored.nextRefreshToken !== undefined) {
        await this.#renew(stored.refreshToken);
        stored = await this.#read();
        if (stored === null) throw new Error("Sign in to change your name.");
        if (!sameReviewer(stored)) throw new Error("You signed out, so your name wasn't changed.");
        // Still pending: the service couldn't be reached or didn't answer.
        if (stored.nextRefreshToken !== undefined) throw new Error("Your name couldn't be changed. Check your connection and try again.");
      }
      try {
        await this.client.setDisplayName(stored.refreshToken, name);
      } catch (error) {
        if (error instanceof PanelSignInError && error.code === "signed-out") await this.#endIfCurrent(stored);
        throw error;
      }
    });
    await this.fetchAccessToken({ forceRefreshToken: true });
    return this.#snapshot.reviewer?.name === name.trim();
  }

  /** The access token for Convex, renewed when asked or shortly before it expires; null once signed out. */
  fetchAccessToken = async ({ forceRefreshToken }: { forceRefreshToken: boolean }): Promise<string | null> => {
    const stored = await this.#read();
    if (stored === null) return null;
    if (!forceRefreshToken && stored.expiresAt - this.now() > RENEW_LEEWAY_MS) return stored.accessToken;
    this.#renewing ??= this.#locked(() => this.#renew(stored.refreshToken)).finally(() => {
      this.#renewing = null;
    });
    return await this.#renewing;
  };

  /** Renews the session; runs under the lock. */
  async #renew(seen: string): Promise<string | null> {
    // Another part of the extension may have renewed while this one waited for the lock.
    const current = await this.#read();
    if (current === null) return null;
    if (current.refreshToken !== seen) return current.accessToken;
    // Saved before it is sent, so whichever part renews next can finish this renewal if its answer is lost.
    const nextRefreshToken = current.nextRefreshToken ?? randomRefreshToken();
    if (current.nextRefreshToken === undefined) await this.storage.set({ [this.#key]: { ...current, nextRefreshToken } });
    let tokens: PanelTokens;
    try {
      tokens = await this.client.refresh(current.refreshToken, nextRefreshToken);
    } catch (error) {
      if (error instanceof PanelSignInError && error.code === "signed-out") {
        await this.#endIfCurrent(current);
        return null;
      }
      // Refused while this token is still the session's (the service repeats a renewal it already made):
      // the replacement can't be used, so the next renewal chooses another.
      if (error instanceof PanelSignInError && error.code === "invalid-request") {
        const latest = parseStored((await this.storage.get(this.#key))[this.#key]);
        if (latest?.refreshToken === current.refreshToken && latest.nextRefreshToken === nextRefreshToken) {
          const { nextRefreshToken: _dropped, ...kept } = latest;
          await this.storage.set({ [this.#key]: kept });
        }
      }
      // Offline, no answer, or a passing failure: keep the session and the pair. The next request
      // for a token sends the pair again, such as the panel opening or the worker reading pins.
      return null;
    }
    // Kept under the mark it was signed in under: a sign-out while the service answered still ends it.
    // The token the service sent, which an older service chooses itself.
    const { nextRefreshToken: _sent, ...kept } = current;
    const renewed: StoredSession = { ...kept, ...tokens, reviewer: { ...current.reviewer, name: nameIn(tokens.accessToken) ?? current.reviewer.name } };
    await this.storage.set({ [this.#key]: renewed });
    const latest = await this.#read();
    this.#show(latest);
    return latest?.accessToken ?? null;
  }

  /** Clears a session the service says has ended, unless another has replaced it. Runs under the lock. */
  async #endIfCurrent(session: StoredSession) {
    if (parseStored((await this.storage.get(this.#key))[this.#key])?.refreshToken === session.refreshToken) await this.storage.remove(this.#key);
    await this.#reload();
  }

  /**
   * Moves a session from before the last sign-out out of storage and into
   * the list to end, under the lock so a new sign-in can't be cleared by
   * mistake; then ends each listed session on the service, outside the lock,
   * keeping any the service couldn't be reached for.
   */
  #cleanUp(): Promise<void> {
    // One at a time here. Asked again while one runs, such as by a second
    // sign-out, it runs once more afterwards, since the first may have read
    // storage before the change.
    if (this.#cleaning !== null) {
      this.#cleanAgain = true;
      return this.#cleaning;
    }
    this.#cleaning = (async () => {
      // A token the service couldn't be reached for waits for the next clean-up, not this one's next pass.
      const tried = new Set<string>();
      do {
        this.#cleanAgain = false;
        await this.#cleanUpNow(tried);
      } while (this.#cleanAgain);
    })().finally(() => {
      this.#cleaning = null;
    });
    return this.#cleaning;
  }

  async #cleanUpNow(tried: Set<string>): Promise<void> {
    const ending = await this.#locked(async () => {
      const items = await this.storage.get([this.#key, this.#markKey, this.#endingKey]);
      const session = parseStored(items[this.#key]);
      const listed = tokensIn(items[this.#endingKey]);
      if (session !== null && !current(session, items[this.#markKey])) {
        for (const token of tokensOf(session)) if (!listed.includes(token)) listed.push(token);
        // Listed first: if this stops between the two writes, the next reader finds both and carries on.
        await this.storage.set({ [this.#endingKey]: listed });
        await this.storage.remove(this.#key);
      }
      return listed;
    });
    await Promise.all(
      ending.filter((token) => !this.#ending.has(token) && !tried.has(token)).map(async (token) => {
        tried.add(token);
        this.#ending.add(token);
        try {
          await this.client.signOut(token);
        } catch {
          // Kept in the list: the next part of the extension to start tries again.
          return;
        } finally {
          this.#ending.delete(token);
        }
        await this.#locked(async () => {
          const listed = tokensIn((await this.storage.get(this.#endingKey))[this.#endingKey]).filter((other) => other !== token);
          if (listed.length === 0) await this.storage.remove(this.#endingKey);
          else await this.storage.set({ [this.#endingKey]: listed });
        });
      }),
    );
  }


  #locked<T>(work: () => Promise<T>): Promise<T> {
    return this.locks === null ? work() : this.locks.request(this.#key, work);
  }

  /** The current session, or null when signed out: none, one from before the last sign-out, or one past its end. */
  async #read(): Promise<StoredSession | null> {
    const items = await this.storage.get([this.#key, this.#markKey]);
    const session = parseStored(items[this.#key]);
    if (session === null) return null;
    if (!current(session, items[this.#markKey])) {
      // Cleared once whatever holds the lock now, such as a renewal, has finished.
      void this.#cleanUp();
      return null;
    }
    // A session past its end can't be renewed; treat it as signed out.
    return session.sessionEndsAt > this.now() ? session : null;
  }

  async #reload() {
    this.#show(await this.#read());
  }

  #show(session: StoredSession | null) {
    const reviewer = session === null ? null : { ...session.reviewer, pictureUrl: null };
    if (JSON.stringify(reviewer) !== JSON.stringify(this.#snapshot.reviewer)) this.#snapshot = { reviewer };
    for (const listener of [...this.#listeners]) listener();
  }
}

/** Whether a session was signed in under the current sign-out mark, so no sign-out has come since. */
function current(session: StoredSession, mark: unknown): boolean {
  return (session.mark ?? null) === (typeof mark === "string" ? mark : null);
}

/** A stored session, or null for anything else (an older shape, or tampering). */
function parseStored(value: unknown): StoredSession | null {
  if (typeof value !== "object" || value === null) return null;
  const { accessToken, refreshToken, expiresAt, sessionEndsAt, reviewer, mark, nextRefreshToken } = value as Record<string, unknown>;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string" || typeof expiresAt !== "number" || typeof sessionEndsAt !== "number") return null;
  if (typeof reviewer !== "object" || reviewer === null) return null;
  const { id, name, email } = reviewer as Record<string, unknown>;
  if (typeof id !== "string" || typeof name !== "string" || typeof email !== "string") return null;
  return {
    accessToken,
    refreshToken,
    expiresAt,
    sessionEndsAt,
    reviewer: { id, name, email },
    ...(typeof mark === "string" ? { mark } : {}),
    // Only a replacement the service would accept; anything else is chosen again.
    ...(typeof nextRefreshToken === "string" && CHOSEN_REFRESH_TOKEN.test(nextRefreshToken) && nextRefreshToken !== refreshToken ? { nextRefreshToken } : {}),
  };
}

/** A refresh token a client chooses, as the sign-in service accepts it. */
const CHOSEN_REFRESH_TOKEN = /^[A-Za-z0-9_-]{43,128}$/;

/** A session's refresh tokens: after a renewal whose answer was lost, the service holds whichever it switched to. */
function tokensOf(session: StoredSession): string[] {
  return session.nextRefreshToken === undefined ? [session.refreshToken] : [session.refreshToken, session.nextRefreshToken];
}

/** 32 random bytes, base64url: the form the sign-in service accepts for a refresh token a client chooses. */
function randomRefreshToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function tokensIn(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((token): token is string => typeof token === "string") : [];
}

/** The display name a token carries, so a rename made elsewhere shows after the next renewal. Display only. */
function nameIn(token: string): string | null {
  try {
    const payload = token.split(".")[1] ?? "";
    const json = new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0)));
    const { name } = JSON.parse(json) as { name?: unknown };
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}
