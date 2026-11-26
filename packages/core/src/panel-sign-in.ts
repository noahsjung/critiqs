/**
 * Signing in inside one of Critiqs's own panels, without a popup: Critiqs's
 * website (a review link's panel) and its browser extension's side panel. The
 * sign-in service answers these routes only for the exact origins it lists in
 * `CRITIQS_WEB_ORIGINS` and `CRITIQS_EXTENSION_IDS`; from any other page a
 * browser refuses every answer, which shows up here as a `network` error.
 *
 * The client keeps no state: the panel stores the attempt key between steps,
 * and the tokens afterwards, wherever suits it (the extension's storage, or
 * the website's). Every refresh replaces the refresh token, so a panel open in
 * several places must let one of them refresh at a time.
 */

export interface PanelTokens {
  accessToken: string;
  refreshToken: string;
  /** When the access token expires, in milliseconds. */
  expiresAt: number;
}

export interface PanelReviewer {
  /** The reviewer's permanent Critiqs ID. */
  id: string;
  name: string;
  email: string;
}

export interface PanelSignedIn extends PanelTokens {
  /** When the session ends however often it is renewed, in milliseconds. */
  sessionEndsAt: number;
  reviewer: PanelReviewer;
}

export interface PanelCodeSent {
  /** Pass this to the next step, and to `sendCode` for a new code. */
  attempt: string;
  /** The address as Critiqs will use it. */
  email: string;
  /** Only from a local development deployment, which shows codes instead of emailing them. */
  developmentCode?: string;
}

/** A returning reviewer is signed in; a new one chooses a display name next. */
export type PanelCodeResult = ({ status: "signed-in" } & PanelSignedIn) | { status: "needs-name" };

export type PanelSignInErrorCode =
  /** Fix the request: */
  | "invalid-email"
  | "invalid-code"
  | "invalid-name"
  | "wrong-code"
  | "code-expired"
  /** Start again with `sendCode` and no attempt: */
  | "expired"
  | "locked"
  | "too-many-codes"
  /** Wait `retryAfter` seconds: */
  | "rate-limited"
  | "send-failed"
  /** The session ended; sign in again. */
  | "signed-out"
  /** This page isn't one of Critiqs's panels, or the service can't sign anyone in. */
  | "origin-not-allowed"
  | "unavailable"
  | "invalid-request"
  /** No answer, or one a browser hid (as it does for an origin the service doesn't allow). */
  | "network"
  | "unexpected";

export class PanelSignInError extends Error {
  constructor(
    readonly code: PanelSignInErrorCode,
    message: string,
    /** Wrong codes still allowed for this attempt, after `wrong-code`. */
    readonly guessesLeft?: number,
    /** Seconds to wait, after `rate-limited`. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "PanelSignInError";
  }
}

export interface PanelSignIn {
  /**
   * Whether this page can sign in here: the sign-in service has panel
   * sign-in, lists this page's origin, and can send codes. Asks the service
   * itself, since a backend's `signInUrl` may name an older one.
   */
  available(): Promise<boolean>;
  /** Sends a code to an address. With the attempt from an earlier call, sends a new code for the same sign-in. */
  sendCode(email: string, attempt?: string): Promise<PanelCodeSent>;
  /** Checks the code typed. */
  checkCode(attempt: string, code: string): Promise<PanelCodeResult>;
  /** A new reviewer's display name, after their code matched. */
  chooseName(attempt: string, name: string): Promise<PanelSignedIn>;
  /** New tokens for the session. Throws `signed-out` once it has ended. */
  refresh(refreshToken: string): Promise<PanelTokens>;
  /** Changes the reviewer's display name everywhere; the next `refresh` carries it. */
  setDisplayName(refreshToken: string, name: string): Promise<void>;
  /** Ends the session; resolves to whether the service found it. */
  signOut(refreshToken: string): Promise<boolean>;
}

const CODE_MESSAGES: Partial<Record<PanelSignInErrorCode, string>> = {
  "signed-out": "Your sign-in has ended. Sign in again.",
  network: "Critiqs's sign-in service couldn't be reached. Check your connection and try again.",
  unexpected: "Critiqs's sign-in service gave an answer this panel doesn't understand. Try again.",
};

const KNOWN_ERRORS = new Set<string>([
  "invalid-email", "invalid-code", "invalid-name", "wrong-code", "code-expired", "expired", "locked", "too-many-codes",
  "rate-limited", "send-failed", "signed-out", "origin-not-allowed", "unavailable", "invalid-request",
]);

/**
 * A client for one sign-in service, such as `https://<deployment>.convex.site`
 * (the `signInUrl` that `/critiqs/config` reports).
 */
export function panelSignIn(
  signInUrl: string,
  options: { fetch?: (input: URL, init: RequestInit) => Promise<Response>; timeoutMs?: number } = {},
): PanelSignIn {
  const send = options.fetch ?? ((input: URL, init: RequestInit) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function post(path: string, body: Record<string, unknown>): Promise<Response> {
    try {
      return await send(new URL(path, signInUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        // Nothing here uses cookies, and credentials never follow a redirect.
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw failure("network");
    }
  }

  /** The service's JSON answer, or the error it describes. */
  async function answer(response: Response): Promise<Record<string, unknown>> {
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (response.ok && isObject(body)) return body;
    if (isObject(body) && typeof body.error === "string" && KNOWN_ERRORS.has(body.error)) {
      throw new PanelSignInError(
        body.error as PanelSignInErrorCode,
        typeof body.message === "string" ? body.message : body.error,
        typeof body.guessesLeft === "number" ? body.guessesLeft : undefined,
        typeof body.retryAfter === "number" ? body.retryAfter : retryAfterOf(response),
      );
    }
    throw failure("unexpected");
  }

  return {
    async available() {
      try {
        // A POST, since browsers send Origin with every POST, even to the same origin.
        const response = await post("/auth/panel/status", {});
        if (!response.ok) return false;
        const body = await response.json().catch(() => null);
        return isObject(body) && body.ready === true;
      } catch {
        return false;
      }
    },

    async sendCode(email, attempt) {
      const body = await answer(await post("/auth/panel/email", attempt === undefined ? { email } : { email, attempt }));
      if (typeof body.attempt !== "string" || typeof body.email !== "string") throw failure("unexpected");
      return {
        attempt: body.attempt,
        email: body.email,
        ...(typeof body.developmentCode === "string" ? { developmentCode: body.developmentCode } : {}),
      };
    },

    async checkCode(attempt, code) {
      const body = await answer(await post("/auth/panel/code", { attempt, code }));
      if (body.status === "needs-name") return { status: "needs-name" };
      return { status: "signed-in", ...signedIn(body) };
    },

    async chooseName(attempt, name) {
      return signedIn(await answer(await post("/auth/panel/name", { attempt, name })));
    },

    async refresh(refreshToken) {
      const response = await post("/auth/refresh", { refreshToken });
      if (response.status === 401) throw failure("signed-out");
      if (!response.ok) throw failure("unexpected");
      const body = await response.json().catch(() => null);
      if (!isObject(body)) throw failure("unexpected");
      return tokens(body);
    },

    async setDisplayName(refreshToken, name) {
      const response = await post("/auth/profile", { refreshToken, name });
      if (response.status === 204) return;
      if (response.status === 401) throw failure("signed-out");
      if (response.status === 400) {
        const body = await response.json().catch(() => null);
        if (isObject(body) && typeof body.error === "string") throw new PanelSignInError("invalid-name", body.error);
        throw failure("invalid-request", "This request is incomplete.");
      }
      throw failure("unexpected");
    },

    async signOut(refreshToken) {
      const response = await post("/auth/sign-out", { refreshToken });
      if (!response.ok) throw failure("unexpected");
      return response.headers.get("Critiqs-Session-Ended") === "true";
    },
  };
}

function failure(code: PanelSignInErrorCode, message = CODE_MESSAGES[code] ?? code): PanelSignInError {
  return new PanelSignInError(code, message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retryAfterOf(response: Response): number | undefined {
  const seconds = Number(response.headers.get("Retry-After"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function tokens(body: Record<string, unknown>): PanelTokens {
  const { accessToken, refreshToken, expiresAt } = body;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string" || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    throw failure("unexpected");
  }
  return { accessToken, refreshToken, expiresAt };
}

function signedIn(body: Record<string, unknown>): PanelSignedIn {
  const { sessionEndsAt, reviewer } = body;
  if (body.status !== "signed-in" || typeof sessionEndsAt !== "number" || !isObject(reviewer)) throw failure("unexpected");
  const { id, name, email } = reviewer;
  if (typeof id !== "string" || typeof name !== "string" || typeof email !== "string") throw failure("unexpected");
  return { ...tokens(body), sessionEndsAt, reviewer: { id, name, email } };
}
