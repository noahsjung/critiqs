import { expect, test } from "bun:test";
import { reportConnected } from "../src/connected.ts";

// The component tells the backend it loaded with a project's ID, so
// onboarding on the Critiqs website can say Connected: once per browser.

const SITE = "https://happy-otter-123.convex.site";

function memory() {
  const items = new Map<string, string>();
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value), items };
}

test("reports the project once, as plain text, and not again once the backend took it", async () => {
  const asked: { url: string; init: RequestInit }[] = [];
  const storage = memory();
  const fetchFn = async (url: string, init: RequestInit) => (asked.push({ url, init }), new Response(null, { status: 204 }));
  reportConnected(SITE, "k57abcdefghijklmnop", { fetchFn, location: { protocol: "https:" }, storage });
  reportConnected(SITE, "k57abcdefghijklmnop", { fetchFn, location: { protocol: "https:" }, storage });
  await Bun.sleep(0);
  expect(asked.map(({ url, init }) => [url, init.method, init.body])).toEqual([[`${SITE}/critiqs/connected`, "POST", "k57abcdefghijklmnop"]]);
  // No Content-Type of its own: a plain text body is sent without asking the backend first.
  expect(asked[0]!.init.headers).toBeUndefined();
  // A later page load in this browser has nothing to report.
  expect([...storage.items.keys()]).toEqual([`critiqs:connected:${SITE}:k57abcdefghijklmnop`]);
});

test("a report that didn't arrive is sent again on the next load", async () => {
  const storage = memory();
  let calls = 0;
  const failing = async () => (calls++, Promise.reject(new Error("offline")));
  reportConnected(SITE, "k57failingproject1", { fetchFn: failing, location: { protocol: "http:" }, storage });
  await Bun.sleep(0);
  reportConnected(SITE, "k57failingproject1", { fetchFn: async () => (calls++, new Response(null, { status: 503 })), location: { protocol: "http:" }, storage });
  await Bun.sleep(0);
  expect(calls).toBe(2);
  expect(storage.items.size).toBe(0);
});

test("the browser extension's panel never reports: it isn't an install", async () => {
  let calls = 0;
  const fetchFn = async () => (calls++, new Response(null, { status: 204 }));
  reportConnected(SITE, "k57extensionproject", { fetchFn, location: { protocol: "chrome-extension:" }, storage: memory() });
  reportConnected(SITE, "k57extensionproject", { fetchFn, location: undefined, storage: memory() });
  await Bun.sleep(0);
  expect(calls).toBe(0);
});
