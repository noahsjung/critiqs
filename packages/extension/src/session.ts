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
 */

export interface StoredSession extends PanelTokens {
  /** When the session ends however often it is renewed, in milliseconds. */
  sessionEndsAt: number;
  reviewer: { id: string; name: string; email: string };
  /** The sign-out mark the session was signed in under; a sign-out replaces the mark. */
  mark?: string;
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

  /** Keeps a session the panel's sign-in just started, under the current sign-out mark. */
  async signedIn(session: PanelSignedIn): Promise<void> {
    const { accessToken, refreshToken, expiresAt, sessionEndsAt, reviewer } = session;
    await this.#locked(async () => {
      const mark = await this.#mark();
      await this.storage.set({ [this.#key]: { accessToken, refreshToken, expiresAt, sessionEndsAt, reviewer, ...(mark === undefined ? {} : { mark }) } });
    });
    await this.#reload();
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

  /** Changes the display name everywhere, then renews so the token carries it. Resolves to whether it does. */
  async setDisplayName(name: string): Promise<boolean> {
    const stored = await this.#read();
    if (stored === null) throw new Error("Sign in to change your name.");
    try {
      await this.client.setDisplayName(stored.refreshToken, name);
    } catch (error) {
      if (error instanceof PanelSignInError && error.code === "signed-out") await this.#locked(() => this.#endIfCurrent(stored));
      throw error;
    }
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
    let tokens: PanelTokens;
    try {
      tokens = await this.client.refresh(current.refreshToken);
    } catch (error) {
      if (error instanceof PanelSignInError && error.code === "signed-out") {
        await this.#endIfCurrent(current);
        return null;
      }
      // Offline or a passing failure: keep the session; Convex asks again.
      return null;
    }
    // Kept under the mark it was signed in under: a sign-out while the service answered still ends it.
    const renewed: StoredSession = { ...current, ...tokens, reviewer: { ...current.reviewer, name: nameIn(tokens.accessToken) ?? current.reviewer.name } };
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
    // One at a time here; a later read starts another if something changed meanwhile.
    this.#cleaning ??= this.#cleanUpNow().finally(() => {
      this.#cleaning = null;
    });
    return this.#cleaning;
  }

  async #cleanUpNow(): Promise<void> {
    const ending = await this.#locked(async () => {
      const items = await this.storage.get([this.#key, this.#markKey, this.#endingKey]);
      const session = parseStored(items[this.#key]);
      const listed = tokensIn(items[this.#endingKey]);
      if (session !== null && !current(session, items[this.#markKey])) {
        if (!listed.includes(session.refreshToken)) listed.push(session.refreshToken);
        // Listed first: if this stops between the two writes, the next reader finds both and carries on.
        await this.storage.set({ [this.#endingKey]: listed });
        await this.storage.remove(this.#key);
      }
      return listed;
    });
    await Promise.all(
      ending.filter((token) => !this.#ending.has(token)).map(async (token) => {
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

  async #mark(): Promise<string | undefined> {
    const mark = (await this.storage.get(this.#markKey))[this.#markKey];
    return typeof mark === "string" ? mark : undefined;
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
  const { accessToken, refreshToken, expiresAt, sessionEndsAt, reviewer, mark } = value as Record<string, unknown>;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string" || typeof expiresAt !== "number" || typeof sessionEndsAt !== "number") return null;
  if (typeof reviewer !== "object" || reviewer === null) return null;
  const { id, name, email } = reviewer as Record<string, unknown>;
  if (typeof id !== "string" || typeof name !== "string" || typeof email !== "string") return null;
  return { accessToken, refreshToken, expiresAt, sessionEndsAt, reviewer: { id, name, email }, ...(typeof mark === "string" ? { mark } : {}) };
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
