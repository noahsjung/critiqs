import zlib from "node:zlib";

// Reading upstream bodies with hard limits. Every body is counted on the wire;
// a body the proxy rewrites is also decompressed here and counted again after
// decompression, so a small compressed response that expands enormously (a
// compression bomb) is stopped as soon as it passes the limit, not after it
// fills memory. Past a limit, or when the body goes quiet or runs too long,
// the upstream iteration is ended at once, which closes the connection.

export type BodyFailure = "too-large" | "timeout" | "unsupported";

export class BodyError extends Error {
  override name = "BodyError";
  constructor(readonly reason: BodyFailure) {
    super(reason === "too-large" ? "The response was larger than the proxy allows." : reason === "timeout" ? "The response took too long." : "The response used an encoding the proxy doesn't read.");
  }
}

export interface BodyLimits {
  /** Bytes as received. */
  wireBytes: number;
  /** Bytes after decompression; only for `readDecoded`. */
  decodedBytes: number;
  /** Longest gap between chunks. */
  idleMs: number;
  /** The whole body, from the first read. */
  totalMs: number;
}

/** Content-Encoding values the proxy decodes: what it asks for in Accept-Encoding, and none. */
export function decoderFor(encoding: string | undefined): (() => zlib.Gunzip | zlib.BrotliDecompress | zlib.Inflate) | null | "unsupported" {
  const name = (encoding ?? "").trim().toLowerCase();
  if (name === "" || name === "identity") return null;
  if (name === "gzip" || name === "x-gzip") return () => zlib.createGunzip();
  if (name === "br") return () => zlib.createBrotliDecompress();
  if (name === "deflate") return () => zlib.createInflate();
  return "unsupported";
}

/**
 * The chunks of `body`, ending it (and so the connection) as soon as it
 * passes `wireBytes`, goes `idleMs` without a chunk, runs past `totalMs`, or
 * `signal` aborts. `onBytes` hears every chunk's size, for usage counters.
 */
export async function* boundedChunks(
  body: AsyncIterable<Uint8Array>,
  limits: Pick<BodyLimits, "wireBytes" | "idleMs" | "totalMs">,
  signal: AbortSignal,
  onBytes: (bytes: number) => void = () => undefined,
): AsyncGenerator<Uint8Array> {
  const chunks = body[Symbol.asyncIterator]();
  const deadline = Date.now() + limits.totalMs;
  let size = 0;
  let finished = false;
  try {
    for (;;) {
      const wait = Math.min(limits.idleMs, deadline - Date.now());
      if (wait <= 0) throw new BodyError("timeout");
      const step = await within(chunks.next(), wait, signal);
      if (step.done) {
        finished = true;
        return;
      }
      size += step.value.byteLength;
      if (size > limits.wireBytes) throw new BodyError("too-large");
      onBytes(step.value.byteLength);
      yield step.value;
    }
  } finally {
    // Ends the upstream request when the body didn't finish: past a limit,
    // timed out, aborted, or the reader stopped early. Not awaited: a body
    // stuck mid-stream may never answer.
    if (!finished) void chunks.return?.()?.catch(() => undefined);
  }
}

/** The whole body, at most `wireBytes`. */
export async function readBounded(body: AsyncIterable<Uint8Array>, limits: Pick<BodyLimits, "wireBytes" | "idleMs" | "totalMs">, signal: AbortSignal): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of boundedChunks(body, limits, signal)) parts.push(chunk);
  return concat(parts);
}

/**
 * The whole body decompressed by its Content-Encoding, at most `wireBytes`
 * received and `decodedBytes` after decompression. Throws a `BodyError`.
 */
export async function readDecoded(body: AsyncIterable<Uint8Array>, encoding: string | undefined, limits: BodyLimits, signal: AbortSignal): Promise<Uint8Array> {
  const decoder = decoderFor(encoding);
  if (decoder === "unsupported") {
    void body[Symbol.asyncIterator]().return?.()?.catch(() => undefined);
    throw new BodyError("unsupported");
  }
  if (decoder === null) {
    const bytes = await readBounded(body, { ...limits, wireBytes: Math.min(limits.wireBytes, limits.decodedBytes) }, signal);
    return bytes;
  }
  const stream = decoder();
  const output: Uint8Array[] = [];
  let decoded = 0;
  let failure: Error | null = null;
  const done = new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Uint8Array) => {
      decoded += chunk.byteLength;
      if (decoded > limits.decodedBytes) {
        failure = new BodyError("too-large");
        stream.destroy();
        reject(failure);
        return;
      }
      output.push(chunk);
    });
    stream.on("end", resolve);
    stream.on("error", (error) => reject(failure ?? new BodyError("unsupported")));
    stream.on("close", () => {
      if (failure !== null) reject(failure);
    });
  });
  // Unhandled until awaited below; a rejection while still reading is picked up there.
  done.catch(() => undefined);
  try {
    for await (const chunk of boundedChunks(body, limits, signal)) {
      if (failure !== null) throw failure;
      // Waits for the decoder to take the chunk, so a bomb can't queue unbounded input.
      await new Promise<void>((resolve, reject) => stream.write(chunk, (error) => (error ? reject(failure ?? new BodyError("unsupported")) : resolve())));
      if (failure !== null) throw failure;
    }
    stream.end();
    await done;
  } catch (error) {
    stream.destroy();
    throw error instanceof BodyError ? error : failure ?? error;
  }
  return concat(output);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

/** `work`, or a `timeout` BodyError after `ms`, or the signal's reason. */
function within<T>(work: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(new BodyError("timeout"))), ms);
    const abort = () => finish(() => reject(signal.reason));
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      settle();
    };
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
