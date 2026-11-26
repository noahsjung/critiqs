// The middleware that marks each page with the route Astro rendered it from.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect, test } from "bun:test";

// It runs on the server: Bun's own streams, not the test preload's browser globals.
if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
const { afterHead, onRequest } = await import("../src/middleware.ts");

type Context = Parameters<typeof import("../src/middleware.ts").onRequest>[0];

/** Runs the middleware on a page rendered from `routePattern` whose body arrives in `chunks`. */
async function render(routePattern: string, chunks: string[], init: ResponseInit = { headers: { "content-type": "text/html", "content-length": "999" } }) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const response = (await onRequest({ routePattern } as Context, async () => new Response(body, init))) as Response;
  return { response, text: await response.text() };
}

test("a page gets its route in its head, with its status and headers, as it streams", async () => {
  const { response, text } = await render("/items/[id]", ["<!DOCTYPE html><html lang=\"en\"><he", "ad><title>Item</title></head><body>caf", "é</body></html>"], {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8", "content-length": "80", "x-site": "1" },
  });
  expect(text).toBe('<!DOCTYPE html><html lang="en"><head><meta name="critiqs-astro-route" content="/items/[id]"><title>Item</title></head><body>café</body></html>');
  expect(response.status).toBe(404);
  expect(response.headers.get("x-site")).toBe("1");
  expect(response.headers.get("content-length")).toBeNull();
});

test("a head with attributes takes the marker, a <header> doesn't, and the route is escaped", async () => {
  const { text } = await render('/a/"[b]"', ['<html><body><header>x</header></body><head data-x="1">', "</head></html>"]);
  expect(text).toBe('<html><body><header>x</header></body><head data-x="1"><meta name="critiqs-astro-route" content="/a/&quot;[b]&quot;"></head></html>');
});

test("other responses pass through untouched", async () => {
  const json = new Response('{"a":1}', { headers: { "content-type": "application/json" } });
  expect(await onRequest({ routePattern: "/api" } as Context, async () => json)).toBe(json);
  const { text } = await render("/plain", ["<p>no head</p>"]);
  expect(text).toBe("<p>no head</p>");
});

test("a multi-byte character split across chunks after the head survives", async () => {
  const bytes = new TextEncoder().encode("<head></head><p>é</p>");
  const split = bytes.indexOf(0xc3) + 1;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, split));
      controller.enqueue(bytes.slice(split));
      controller.close();
    },
  });
  expect(await new Response(stream.pipeThrough(afterHead("<m>"))).text()).toBe("<head><m></head><p>é</p>");
});
