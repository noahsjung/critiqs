import { afterEach, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import type { ConvexReactClient } from "convex/react";
import type { Deployment } from "../src/deployment.ts";
import { convexTransport } from "../src/convex/transport.tsx";
import type { Session } from "../src/session.ts";

// A file stored through an address an older backend gave just before a newer
// one was deployed can never be attached. The newer backend says so
// (`reupload`), and the component uploads the file again and retries once.

const site = "https://example.convex.site";
const deployment = { siteUrl: site, backendUrl: "https://example.convex.cloud", transport: "convex" } as Deployment;
const session = { fetchAccessToken: async () => "token" } as unknown as Session;
const reupload = (what: string) => new ConvexError({ code: "invalid", message: `Upload the ${what} again.`, reupload: true });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A Convex client and storage that refuse `refused` files as unbound; records every call. */
function backend(refused: Set<string>) {
  const calls: string[] = [];
  let stored = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`POST ${new URL(String(input)).pathname} ${await new Response(init?.body).text()}`);
    return Response.json({ storageId: `file-${++stored}` });
  }) as typeof fetch;
  const attach = (name: string, fileId: string, result: string) => {
    calls.push(`${name} ${fileId}`);
    if (refused.has(fileId)) throw reupload(name.startsWith("threads") ? "screenshot" : "page copy");
    return result;
  };
  const client = {
    mutation: async (reference: unknown, args: Record<string, any>) => {
      const name = getFunctionName(reference as never);
      if (name === "captures:generateUploadUrl") return `${site}/capture/upload?uploadId=c${stored}&grant=g`;
      if (name === "mockups:generateUploadUrl") return `${site}/mockup/upload?uploadId=m${stored}&grant=g`;
      if (name === "threads:create") return attach(name, args.capture.storageId, "thread-1");
      if (name === "threads:attachScreenshot") return attach(name, args.storageId, "attached");
      throw new Error(`Unexpected ${name}`);
    },
    action: async (reference: unknown, args: Record<string, any>) => {
      const name = getFunctionName(reference as never);
      return attach(name, args.snapshot.storageId, name === "mockups:create" ? "mockup-1" : "snapshot-2");
    },
    query: async () => ({ projectId: "project-1", snapshots: [{ _id: "snapshot-1" }] }),
  } as unknown as ConvexReactClient;
  return { transport: convexTransport(client, deployment, session), calls };
}

const layout = { width: 1440, height: 2000, scrollY: 0, viewportHeight: 900, capturedAt: 1 };
const source = { url: "https://proto.example/", screen: "home", viewState: {}, revision: null, persona: null };

test("a page copy refused as unbound is uploaded again and the mockup started with the new file, once", async () => {
  const { transport, calls } = backend(new Set(["file-1"]));
  const mockups = transport.mockups!;
  const storageId = await mockups.uploadSnapshot("project-1", "<p>Page</p>");
  expect(await mockups.create({ projectId: "project-1", title: "Bigger", source, snapshot: { storageId, ...layout } })).toEqual({ mockupId: "mockup-1", snapshotId: "snapshot-1" });
  expect(calls).toEqual(["POST /mockup/upload <p>Page</p>", "mockups:create file-1", "POST /mockup/upload <p>Page</p>", "mockups:create file-2"]);
  // The copy just uploaded is kept, so opening it needs no download.
  expect(await mockups.loadSnapshot("snapshot-1")).toBe("<p>Page</p>");

  // A copy added at another width, too.
  const again = backend(new Set(["file-1"]));
  const added = await again.transport.mockups!.uploadSnapshot("project-1", "<p>Phone</p>");
  expect(await again.transport.mockups!.addSnapshot({ mockupId: "mockup-1", snapshot: { storageId: added, ...layout } })).toBe("snapshot-2");
  expect(again.calls).toEqual(["POST /mockup/upload <p>Phone</p>", "mockups:addSnapshot file-1", "POST /mockup/upload <p>Phone</p>", "mockups:addSnapshot file-2"]);
});

test("a screenshot refused as unbound is uploaded again and the thread started with the new file", async () => {
  const { transport, calls } = backend(new Set(["file-1"]));
  const fileId = await transport.uploadImage("project-1", new Blob(["png"], { type: "image/png" }));
  const thread = { projectId: "project-1", anchor: {} as never, body: "Spacing", tags: [], mentions: [] };
  expect(await transport.createThread({ ...thread, capture: { status: "captured", fileId } })).toBe("thread-1");
  expect(calls).toEqual(["POST /capture/upload png", "threads:create file-1", "POST /capture/upload png", "threads:create file-2"]);
});

test("a retry is tried once, and other refusals aren't retried", async () => {
  const { transport, calls } = backend(new Set(["file-1", "file-2"]));
  const storageId = await transport.mockups!.uploadSnapshot("project-1", "<p>Page</p>");
  await expect(transport.mockups!.create({ projectId: "project-1", title: "Bigger", source, snapshot: { storageId, ...layout } })).rejects.toThrow("Upload the page copy again.");
  expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(2);
  // A file this component didn't just upload isn't retried.
  const unknown = backend(new Set(["elsewhere"]));
  await expect(unknown.transport.mockups!.create({ projectId: "project-1", title: "Bigger", source, snapshot: { storageId: "elsewhere", ...layout } })).rejects.toThrow("Upload the page copy again.");
  expect(unknown.calls).toEqual(["mockups:create elsewhere"]);
});

test("a screenshot added to an existing thread and refused as unbound is uploaded again and attached, once", async () => {
  const { transport, calls } = backend(new Set(["file-1"]));
  const fileId = await transport.uploadImage("project-1", new Blob(["png"], { type: "image/png" }));
  await transport.attachScreenshot({ threadId: "thread-1", fileId });
  expect(calls.filter((call) => call.startsWith("threads:attachScreenshot"))).toEqual(["threads:attachScreenshot file-1", "threads:attachScreenshot file-2"]);
});
