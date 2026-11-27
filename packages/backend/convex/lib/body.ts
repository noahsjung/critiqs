/**
 * Reads a request's body as its raw bytes, at most `max` of them. A
 * Content-Length that isn't a whole number is `"invalid"`; one over `max`, or
 * a body that grows past `max` while it streams, is `"too-large"` as soon as
 * that is known, and the rest is never read: the stream is cancelled, not
 * waited on. A request without a body reads as no bytes.
 */
export async function readBoundedBody(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | "too-large" | "invalid"> {
  const length = request.headers.get("Content-Length");
  if (length !== null && !/^\d+$/.test(length)) return "invalid";
  if (length !== null && Number(length) > max) return "too-large";
  const reader = request.body?.getReader();
  if (reader === undefined) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      // Stop the stream without waiting on it: a cancellation that fails or never finishes can't hold up or break the answer.
      reader.cancel().catch(() => undefined);
      return "too-large";
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
