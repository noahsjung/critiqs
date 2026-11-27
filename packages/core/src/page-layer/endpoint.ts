import { ProtocolError } from "./check.ts";
import {
  INSTALLED_PAGE_LIMITS,
  pageEnvelope,
  type PageErrorCode,
  type PageEvent,
  type PageEvents,
  type PageMethod,
  type PageMessage,
  type PageParams,
  type PageLimits,
  parsePageMessage,
  type PageResult,
  pageResults,
} from "./protocol.ts";
import type { PageTransport } from "./transport.ts";

/** A request the other side refused or couldn't finish. */
export class PageLayerError extends Error {
  override name = "PageLayerError";
  constructor(
    readonly code: PageErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  /** Aborting sends a cancel; the request fails with `cancelled`. */
  signal?: AbortSignal;
  /** Fails with `timeout` when no answer arrives in time. No limit by default. */
  timeoutMs?: number;
  /** The page layer it is for (`PageState.document`); another document's refuses it as `gone`. Any by default. */
  document?: string | null;
}

/** The panel's end: sends requests to the page layer and hears its events. */
export interface PagePanelEndpoint {
  request<M extends PageMethod>(method: M, params: PageParams<M>, options?: RequestOptions): Promise<PageResult<M>>;
  on<E extends PageEvent>(event: E, handler: (data: PageEvents[E]) => void): () => void;
  close(): void;
}

/** Each request's handler in the page layer. A handler may answer at once or later; `signal` aborts when the panel cancels. */
export type PageHandlers = { [M in PageMethod]: (params: PageParams<M>, signal: AbortSignal) => PageResult<M> | Promise<PageResult<M>> };

/** The page layer's end: answers requests and sends events. */
export interface PageLayerEndpoint {
  emit<E extends PageEvent>(event: E, data: PageEvents[E]): void;
  close(): void;
}

/**
 * The panel's end: sends requests and hears events. `limits` bounds what it
 * takes from the page layer: installed Critiqs's by default,
 * `UNTRUSTED_PAGE_LIMITS` for a page layer in a frame it doesn't trust.
 */
export function panelEndpoint(transport: PageTransport, { channel, limits = INSTALLED_PAGE_LIMITS }: { channel: string; limits?: PageLimits }): PagePanelEndpoint {
  const results = pageResults(limits);
  let next = 1;
  let closed = false;
  const pending = new Map<number, { method: PageMethod; resolve: (value: unknown) => void; reject: (error: PageLayerError) => void }>();
  const handlers = new Map<PageEvent, Set<(data: never) => void>>();

  const stop = transport.listen((raw) => {
    const parsed = parsePageMessage(raw, channel, limits);
    if (!parsed.ok) {
      if (!parsed.ignore) {
        // A reply that can't be read fails its request rather than leaving it waiting.
        const waiting = parsed.reply === "answer" && parsed.id !== null ? pending.get(parsed.id) : undefined;
        if (waiting !== undefined) settle(parsed.id!, () => waiting.reject(new PageLayerError(parsed.code, parsed.reason)));
        else console.warn(`Critiqs: ignored a page layer message: ${parsed.reason}`);
      }
      return;
    }
    const message = parsed.message;
    if (message.kind === "event") {
      for (const handler of [...(handlers.get(message.event) ?? [])]) (handler as (data: unknown) => void)(message.data);
      return;
    }
    if (message.kind !== "result" && message.kind !== "error") return;
    const waiting = pending.get(message.id);
    if (waiting === undefined) return;
    if (message.kind === "error") {
      settle(message.id, () => waiting.reject(new PageLayerError(message.error.code, message.error.message)));
      return;
    }
    try {
      const result = (results[waiting.method] as (value: unknown, path: string) => unknown)(message.result, "result");
      settle(message.id, () => waiting.resolve(result));
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      settle(message.id, () => waiting.reject(new PageLayerError("bad-request", `The page layer's answer to ${waiting.method} can't be read: ${error.message}`)));
    }
  });

  const stopClosing = transport.onClose(() => close("The page layer connection closed."));

  const settle = (id: number, finish: () => void) => {
    if (!pending.delete(id)) return;
    finish();
  };

  return {
    request(method, params, { signal, timeoutMs, document = null } = {}) {
      return new Promise((resolve, reject) => {
        if (closed) return reject(new PageLayerError("closed", "The page layer connection is closed."));
        if (signal?.aborted) return reject(new PageLayerError("cancelled", `${method} was cancelled.`));
        const id = next++;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const giveUp = (code: PageErrorCode, reason: string) => {
          const waiting = pending.get(id);
          if (waiting === undefined) return;
          transport.send(pageEnvelope(channel, { kind: "cancel", id }) as PageMessage);
          settle(id, () => waiting.reject(new PageLayerError(code, reason)));
        };
        const onAbort = () => giveUp("cancelled", `${method} was cancelled.`);
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        pending.set(id, {
          method,
          resolve: (value) => {
            cleanup();
            resolve(value as PageResult<typeof method>);
          },
          reject: (error) => {
            cleanup();
            reject(error);
          },
        });
        signal?.addEventListener("abort", onAbort);
        if (timeoutMs !== undefined) timer = setTimeout(() => giveUp("timeout", `The page layer didn't answer ${method} in time.`), timeoutMs);
        transport.send(pageEnvelope(channel, { kind: "request", id, method, params, document }) as PageMessage);
      });
    },
    on(event, handler) {
      const set = handlers.get(event) ?? new Set();
      handlers.set(event, set);
      set.add(handler as (data: never) => void);
      return () => set.delete(handler as (data: never) => void);
    },
    close: () => close("The page layer connection closed."),
  };

  function close(reason: string) {
    if (closed) return;
    closed = true;
    // The page layer stops work no one will wait for, where the transport can still say so.
    for (const id of pending.keys()) transport.send(pageEnvelope(channel, { kind: "cancel", id }) as PageMessage);
    stop();
    stopClosing();
    for (const [id, waiting] of [...pending]) settle(id, () => waiting.reject(new PageLayerError("closed", reason)));
    handlers.clear();
  }
}

export function pageLayerEndpoint(
  transport: PageTransport,
  { channel, handlers, document = null }: { channel: string; handlers: PageHandlers; /** This page layer's `PageState.document`. */ document?: string | null },
): PageLayerEndpoint {
  let closed = false;
  const running = new Map<number, AbortController>();
  const reply = (id: number, body: { result: unknown } | { error: { code: PageErrorCode; message: string } }) => {
    if (closed) return;
    transport.send(pageEnvelope(channel, "result" in body ? { kind: "result", id, result: body.result } : { kind: "error", id, error: body.error }) as PageMessage);
  };

  const stop = transport.listen((raw) => {
    const parsed = parsePageMessage(raw, channel);
    if (!parsed.ok) {
      if (parsed.ignore) return;
      if (parsed.reply === "request" && parsed.id !== null) reply(parsed.id, { error: { code: parsed.code, message: parsed.reason } });
      else console.warn(`Critiqs: ignored a panel message: ${parsed.reason}`);
      return;
    }
    const message = parsed.message;
    if (message.kind === "cancel") {
      running.get(message.id)?.abort();
      return;
    }
    if (message.kind !== "request") return;
    const { id } = message;
    if (message.document !== null && document !== null && message.document !== document) {
      reply(id, { error: { code: "gone", message: "That page is gone: the prototype showed another one." } });
      return;
    }
    if (running.has(id)) {
      reply(id, { error: { code: "bad-request", message: `Request ${id} is already running.` } });
      return;
    }
    const controller = new AbortController();
    running.set(id, controller);
    const finish = (body: { result: unknown } | { error: { code: PageErrorCode; message: string } }) => {
      if (running.get(id) !== controller) return;
      running.delete(id);
      // A cancelled request's late answer would be ignored anyway; say so instead.
      reply(id, controller.signal.aborted ? { error: { code: "cancelled", message: `${message.method} was cancelled.` } } : body);
    };
    const handle = handlers[message.method] as (params: unknown, signal: AbortSignal) => unknown;
    let answer: unknown;
    try {
      answer = handle(message.params, controller.signal);
    } catch (error) {
      finish({ error: { code: "failed", message: describe(error) } });
      return;
    }
    if (answer instanceof Promise) {
      answer.then(
        (result) => finish({ result }),
        (error) => finish({ error: { code: "failed", message: describe(error) } }),
      );
    } else {
      finish({ result: answer });
    }
  });

  const close = () => {
    if (closed) return;
    for (const controller of running.values()) controller.abort();
    running.clear();
    closed = true;
    stop();
    stopClosing();
  };
  // Work for a panel that went away stops.
  const stopClosing = transport.onClose(close);

  return {
    emit(event, data) {
      if (!closed) transport.send(pageEnvelope(channel, { kind: "event", event, data }) as PageMessage);
    },
    close,
  };
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message || "The page layer couldn't finish this request.").slice(0, 4000);
}
