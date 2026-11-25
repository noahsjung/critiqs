import { expect, test } from "bun:test";
import { uploadCapture } from "../src/capture-upload.ts";

const site = "https://example.convex.site";
const image = new Blob(["png"], { type: "image/png" });

test("R2 proxy uploads carry a token only to the exact deployment route and refuse redirects", async () => {
  let request: Request | undefined;
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    request = new Request(url, init);
    return Response.json({ storageId: "opaque-file-id" });
  }) as typeof fetch;
  expect(await uploadCapture(`${site}/capture/upload?fileId=file`, site, image, async () => "secret", fetchFn)).toBe("opaque-file-id");
  expect(request!.headers.get("Authorization")).toBe("Bearer secret");
  expect(request!.redirect).toBe("error");
  expect(await request!.text()).toBe("png");
});

test("legacy storage receives the image without requesting or sending the sign-in token", async () => {
  let asked = false;
  const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    return Response.json({ storageId: "native-storage-id" });
  }) as typeof fetch;
  await uploadCapture("https://example.convex.cloud/api/storage/upload?token=upload-capability", site, image, async () => { asked = true; return "secret"; }, fetchFn);
  expect(asked).toBe(false);
});

test("lookalike origins and URL credentials cannot obtain an upload token", async () => {
  let asked = false;
  for (const url of ["https://evil.test/capture/upload", "https://example.convex.site.evil.test/capture/upload", "https://name:password@example.convex.site/capture/upload"]) {
    await expect(uploadCapture(url, site, image, async () => { asked = true; return "secret"; })).rejects.toThrow("not trusted");
  }
  expect(asked).toBe(false);
});

test("expired sign-in, server refusal and malformed upload results produce useful errors", async () => {
  const url = `${site}/capture/upload`;
  await expect(uploadCapture(url, site, image, async () => null)).rejects.toThrow("Sign in again");
  await expect(uploadCapture(url, site, image, async () => "token", (async () => new Response("provider details", { status: 503 })) as unknown as typeof fetch)).rejects.toThrow("could not be uploaded");
  await expect(uploadCapture(url, site, image, async () => "token", (async () => Response.json({ storageId: null })) as unknown as typeof fetch)).rejects.toThrow("could not be uploaded");
});
