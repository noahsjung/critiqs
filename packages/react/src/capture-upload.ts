/** The deployment's own upload routes: the only addresses an upload sends the sign-in token to. */
const PROXIED = ["/capture/upload", "/mockup/upload"];

/**
 * Posts a file to the upload address its backend gave: the deployment's own
 * route, with the sign-in token, or a storage address from an older backend,
 * without it. Returns the stored file's ID.
 */
export async function uploadFile(
  uploadUrl: string,
  siteUrl: string,
  file: Blob,
  getToken: () => Promise<string | null>,
  fetchFn: typeof fetch = fetch,
  what: string,
): Promise<string> {
  const url = new URL(uploadUrl);
  const proxied = PROXIED.includes(url.pathname);
  const proxy = proxied && url.origin === new URL(siteUrl).origin;
  if (url.username || url.password || (proxied && !proxy)) {
    throw new Error(`The ${what} upload address is not trusted.`);
  }
  const headers: Record<string, string> = { "Content-Type": file.type };
  if (proxy) {
    const token = await getToken();
    if (token === null) throw new Error(`Sign in again to upload the ${what}.`);
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetchFn(url, { method: "POST", headers, body: file, redirect: "error" });
  if (!response.ok) throw new Error(`The ${what} could not be uploaded.`);
  const result = await response.json() as { storageId?: unknown };
  if (typeof result.storageId !== "string" || result.storageId === "") throw new Error(`The ${what} could not be uploaded.`);
  return result.storageId;
}

/** Upload credentials go only to the deployment's exact authenticated upload routes. */
export async function uploadCapture(
  uploadUrl: string,
  siteUrl: string,
  image: Blob,
  getToken: () => Promise<string | null>,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  return await uploadFile(uploadUrl, siteUrl, image, getToken, fetchFn, "screenshot");
}
