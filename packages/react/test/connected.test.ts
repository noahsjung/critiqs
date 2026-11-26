import { expect, test } from "bun:test";
import { reportConnected } from "../src/connected.ts";

// The component tells the backend it loaded with a project's ID, so
// onboarding on the Critiqs website can say Connected: at most once an hour per browser.

const SITE = "https://happy-otter-123.convex.site";

function memory() {
  const items = new Map<string, string>();
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value), items };
}

test("reports the project as plain text, and not again within the hour once the backend took it", async () => {
  const asked: { url: string; init: RequestInit }[] = [];
  const storage = memory();
  const fetchFn = async (url: string, init: RequestInit) => (asked.push({ url, init }), new Response(null, { status: 204 }));
  const at = Date.UTC(2026, 10, 26, 9);
  reportConnected(SITE, "k57abcdefghijklmnop", { fetchFn, location: { protocol: "https:" }, storage, now: at });
  reportConnected(SITE, "k57abcdefghijklmnop", { fetchFn, location: { protocol: "https:" }, storage, now: at });
  await Bun.sleep(0);
  expect(asked.map(({ url, init }) => [url, init.method, init.body])).toEqual([[`${SITE}/critiqs/connected`, "POST", "k57abcdefghijklmnop"]]);
  // No Content-Type of its own: a plain text body is sent without asking the backend first.
  expect(asked[0]!.init.headers).toBeUndefined();
  // A later page load in this browser within the hour has nothing to report; an hour on, it reports again.
  expect([...storage.items.entries()]).toEqual([[`critiqs:connected:${SITE}:k57abcdefghijklmnop`, String(at)]]);
});

test("a browser reports again an hour after its last report, so the latest load is kept", async () => {
  const storage = memory();
  const key = `critiqs:connected:${SITE}:k57hourlyproject1`;
  storage.setItem(key, String(Date.UTC(2026, 10, 26, 9)));
  let calls = 0;
  const fetchFn = async () => (calls++, new Response(null, { status: 204 }));
  reportConnected(SITE, "k57hourlyproject1", { fetchFn, location: { protocol: "https:" }, storage, now: Date.UTC(2026, 10, 26, 9, 59) });
  await Bun.sleep(0);
  expect(calls).toBe(0);
  reportConnected(SITE, "k57hourlyproject1", { fetchFn, location: { protocol: "https:" }, storage, now: Date.UTC(2026, 10, 26, 10) });
  await Bun.sleep(0);
  expect([calls, storage.items.get(key)]).toEqual([1, String(Date.UTC(2026, 10, 26, 10))]);
  // A browser that reported with an older version, which stored "1", reports once more.
  storage.setItem(`critiqs:connected:${SITE}:k57olderversion12`, "1");
  reportConnected(SITE, "k57olderversion12", { fetchFn, location: { protocol: "https:" }, storage, now: Date.UTC(2026, 10, 26, 10, 1) });
  await Bun.sleep(0);
  expect(calls).toBe(2);
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
