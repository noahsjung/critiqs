import { expect, test } from "bun:test";
import { readBoundedBody } from "../convex/lib/body";

/** A streamed request body of `chunks` 100-byte chunks, whose cancellation does `cancel`. */
function streamed(chunks: number, cancel: () => Promise<void>): Request {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++pulled > chunks) return controller.close();
      controller.enqueue(new Uint8Array(100).fill(0x20));
    },
    cancel,
  });
  return new Request("https://backend.example/upload", { method: "POST", body, duplex: "half" } as RequestInit);
}

/** The reader's answer, or "timed out" when it hasn't answered within a second. */
const within = async (read: Promise<unknown>) => await Promise.race([read, new Promise((resolve) => setTimeout(() => resolve("timed out"), 1_000))]);

test("a body past the limit is too large at once, even when cancelling its stream fails", async () => {
  let cancelled = false;
  const request = streamed(10, async () => {
    cancelled = true;
    throw new Error("cancel failed");
  });
  expect(await within(readBoundedBody(request, 250))).toBe("too-large");
  expect(cancelled).toBe(true);
});

test("a body past the limit is too large at once, even when cancelling its stream never finishes", async () => {
  let cancelled = false;
  const request = streamed(10, () => {
    cancelled = true;
    return new Promise<void>(() => undefined);
  });
  expect(await within(readBoundedBody(request, 250))).toBe("too-large");
  expect(cancelled).toBe(true);
});

test("a body within the limit is read whole", async () => {
  const body = await readBoundedBody(streamed(3, async () => undefined), 300);
  expect(body instanceof Uint8Array ? body.byteLength : body).toBe(300);
});
