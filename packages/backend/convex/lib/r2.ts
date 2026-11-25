import { AwsClient } from "aws4fetch";

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Only operators choose the provider. Partial R2 setup must never fall back. */
export function captureProvider(env = process.env): "convex" | "r2" {
  const provider = env.CRITIQS_CAPTURE_STORAGE ?? "convex";
  if (provider !== "convex" && provider !== "r2") throw new Error("CRITIQS_CAPTURE_STORAGE must be convex or r2.");
  return provider;
}

export function r2Config(env = process.env): R2Config {
  const accountId = env.CRITIQS_R2_ACCOUNT_ID ?? "";
  const bucket = env.CRITIQS_R2_BUCKET ?? "";
  const accessKeyId = env.CRITIQS_R2_ACCESS_KEY_ID ?? "";
  const secretAccessKey = env.CRITIQS_R2_SECRET_ACCESS_KEY ?? "";
  if (!/^[a-f0-9]{32}$/.test(accountId) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) || !accessKeyId || !secretAccessKey) {
    throw new Error("R2 screenshot storage is not configured. Set CRITIQS_R2_ACCOUNT_ID, CRITIQS_R2_BUCKET, CRITIQS_R2_ACCESS_KEY_ID, and CRITIQS_R2_SECRET_ACCESS_KEY.");
  }
  return { accountId, bucket, accessKeyId, secretAccessKey };
}

/** Public diagnostics contain no bucket credentials or signed URLs. */
export function captureStorageHealth() {
  try {
    const provider = captureProvider();
    if (provider === "r2") r2Config();
    return { provider, configured: true };
  } catch {
    const provider = process.env.CRITIQS_CAPTURE_STORAGE;
    return { provider: provider === "r2" || provider === "convex" ? provider : "invalid", configured: false };
  }
}

/** Server-only S3 client. The production endpoint is derived, never supplied by a browser. */
export function r2Storage(config: R2Config, fetchFn: typeof fetch = fetch) {
  const client = new AwsClient({ ...config, service: "s3", region: "auto", retries: 0 });
  async function request(location: { accountId: string; bucket: string; key: string }, method: string, body?: ArrayBuffer, contentType?: string) {
    if (location.accountId !== config.accountId) throw new Error("This capture belongs to another R2 account.");
    const path = [location.bucket, ...location.key.split("/")].map(encodeURIComponent).join("/");
    const url = `https://${config.accountId}.r2.cloudflarestorage.com/${path}`;
    const signed = await client.sign(url, {
      method,
      ...(body === undefined ? {} : { body }),
      headers: {
        ...(contentType === undefined ? {} : { "Content-Type": contentType }),
        // Convex streams signed Request bodies; R2 requires their explicit size.
        ...(body === undefined ? {} : { "Content-Length": String(body.byteLength) }),
      },
    });
    // Never follow a redirect with a signed request, or expose its response body in errors.
    return await fetchFn(signed, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  }
  return {
    put: async (location: { accountId: string; bucket: string; key: string }, body: ArrayBuffer, contentType: string) => {
      const response = await request(location, "PUT", body, contentType);
      if (!response.ok) throw new Error("R2 could not save the screenshot.");
    },
    get: async (location: { accountId: string; bucket: string; key: string }) => {
      const response = await request(location, "GET");
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("R2 could not load the screenshot.");
      return response;
    },
    remove: async (location: { accountId: string; bucket: string; key: string }) => {
      const response = await request(location, "DELETE");
      if (!response.ok && response.status !== 404) throw new Error("R2 could not remove the unused screenshot.");
    },
  };
}
