// Public types for `critiqs-react/server`: Critiqs's server inside the host
// app's own Node or Bun server, storing feedback in a SQLite file.
// Built-in SQLite requires Node.js 22.13 or later, or Bun; the setup CLI also supports Node.js 20.

/** Someone the host app has already signed in. */
export interface HostUser {
  /** The host app's permanent ID for them. */
  id: string;
  name: string;
  /** Where mention emails go; the host app vouches that it is theirs. */
  email: string;
  pictureUrl?: string | null;
}

/** The few calls Critiqs needs from a SQLite library. */
export interface SqlDriver {
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): void;
  get<T>(sql: string, params?: unknown[]): T | undefined;
  all<T>(sql: string, params?: unknown[]): T[];
}

export interface CritiqsHandlerOptions {
  /** A SQLite file path (Bun's SQLite under Bun, node:sqlite under Node), or a driver. */
  database: string | SqlDriver;
  /** Where the handler is mounted; the component's `backend` is this path. Default `/critiqs`. */
  basePath?: string;
  /** Resend key and sender, for sign-in codes and mention emails. */
  email?: { resendApiKey: string; from: string };
  /**
   * Uses the host app's own sign-in instead of Critiqs's email codes: returns
   * who made the request, or null when nobody is signed in to the app.
   */
  identify?: (request: Request) => HostUser | null | Promise<HostUser | null>;
  /**
   * Shows sign-in codes on screen instead of emailing them, only for requests
   * whose connection comes from this computer (see `fetch`'s `remoteAddress`).
   */
  developmentSignIn?: boolean;
  /**
   * AI for automatic tag grouping, natural-language search, and insights. The
   * provider here is the default for every project; with `encryptionKey`,
   * project owners can also connect their own provider in Critiqs, whose keys
   * are stored encrypted. Read these from your server's environment; never
   * put keys in browser code. Search and grouping still work without AI.
   */
  ai?: CritiqsAiOptions;
  /**
   * `false` turns off onboarding's check of a prototype's address, which
   * fetches pages from this server. Turn it off unless the server's outbound
   * traffic is kept off private networks. On by default.
   */
  addressCheck?: false;
  /**
   * The Critiqs website that setup links in developer setup emails open, such
   * as `https://critiqs.app`: HTTPS, or HTTP on this computer. Without it,
   * `publicUrl`, or `email`, this server sends no setup emails.
   */
  webUrl?: string;
  /**
   * The public address of the app this server runs in, such as
   * `https://app.example.com`: HTTPS, or HTTP on this computer. Report links
   * in developer setup emails start with it, then `basePath`. Without it,
   * `webUrl`, or `email`, this server sends no setup emails.
   */
  publicUrl?: string;
}

export interface CritiqsAiOptions {
  provider?: "openai" | "anthropic" | "google" | "openrouter" | "gateway" | "compatible";
  model?: string;
  apiKey?: string;
  /** The provider's address; required for an OpenAI-compatible endpoint, such as `http://localhost:11434/v1` for Ollama. */
  baseURL?: string;
  /** At least 32 random characters, such as from `openssl rand -base64 32`; lets owners store their own keys, encrypted. */
  encryptionKey?: string;
  /** Endpoint addresses owners may enter, such as `https://llm.example.com/v1`. */
  allowedEndpoints?: string[];
  /** Allows `http://` and private-network addresses among `allowedEndpoints`, for providers on your own network. */
  allowLocalEndpoints?: boolean;
  /** Longest a model request may take. Default 30 seconds. */
  timeoutMs?: number;
}

export interface CritiqsHandler {
  /**
   * Answers requests under `basePath`; others get 404. `remoteAddress` is the
   * connection's address (Bun: `server.requestIP(request)?.address`), which
   * development sign-in needs to know a request comes from this computer.
   */
  fetch(request: Request, connection?: { remoteAddress?: string }): Promise<Response>;
  /** Sends due mention emails now; this also runs every minute. */
  deliverMentionEmails(): Promise<void>;
  /** Groups tags waiting for automatic grouping now; this also runs every minute. */
  groupTags(): Promise<void>;
  /** Stops the mention email and grouping timer. */
  close(): void;
}

/** Creates Critiqs's request handler for a host app's server. */
export declare function createCritiqsHandler(options: CritiqsHandlerOptions): Promise<CritiqsHandler>;

/** The handler as a Node `(req, res)` listener, for `http.createServer` or Express. */
export declare function toNodeListener(
  handler: CritiqsHandler,
): (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => Promise<void>;
