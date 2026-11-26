import { fail } from "../errors.ts";

/** Reads a request body, stopping as soon as it is larger than `limit`. */
export async function readBody(request: Request, limit: number, tooLarge = "This request is too large."): Promise<Uint8Array> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > limit) fail("invalid", tooLarge);
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      fail("invalid", tooLarge);
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
