import { afterEach, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import type { ConvexReactClient } from "convex/react";
import { type Deployment, madeWithArg } from "../src/deployment.ts";
import { convexTransport } from "../src/convex/transport.tsx";
import type { Session } from "../src/session.ts";

// A thread left from the browser extension's overlay, which runs in the
// reviewed page itself, records that it came from the extension: the page's
// own address can't say so there. An install's threads say nothing, as before.

const originalUrl = window.location.href;
afterEach(() => (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(originalUrl));

const deployment = { siteUrl: "https://example.convex.site", backendUrl: "https://example.convex.cloud", transport: "convex", threadMadeWith: true } as Deployment;
const session = { fetchAccessToken: async () => "token" } as unknown as Session;

/** A Convex client that records the arguments of each new thread. */
function recording() {
  const created: Record<string, unknown>[] = [];
  const client = {
    mutation: async (reference: unknown, args: Record<string, unknown>) => {
      if (getFunctionName(reference as never) !== "threads:create") throw new Error("Unexpected mutation");
      created.push(args);
      return "thread-1";
    },
  } as unknown as ConvexReactClient;
  return { client, created };
}

const thread = { projectId: "project-1", anchor: {} as never, body: "Spacing", tags: [], mentions: [], capture: { status: "failed" as const, failureReason: "Blocked." } };

test("with the extension's surface, a new thread is sent with madeWith extension, on any page", async () => {
  for (const address of ["https://prototype.example/pilot", "http://localhost:3000/", "file:///tmp/page.html"]) {
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(address);
    const { client, created } = recording();
    await convexTransport(client, deployment, session, "extension").createThread(thread);
    expect(created.map((args) => args.madeWith)).toEqual(["extension"]);
  }
  expect(madeWithArg(deployment, { protocol: "https:" }, "extension")).toEqual({ madeWith: "extension" });
  // An older backend would refuse an argument it doesn't know.
  expect(madeWithArg({ threadMadeWith: false } as Deployment, { protocol: "https:" }, "extension")).toEqual({});
});

test("without a surface, an install's new thread has no madeWith, whatever the page's protocol", async () => {
  for (const address of ["https://prototype.example/pilot", "http://localhost:3000/", "file:///tmp/page.html"]) {
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(address);
    const { client, created } = recording();
    await convexTransport(client, deployment, session).createThread(thread);
    expect(created).toHaveLength(1);
    expect("madeWith" in created[0]!).toBe(false);
  }
  for (const protocol of ["https:", "http:", "file:"]) expect(madeWithArg(deployment, { protocol })).toEqual({});
});
