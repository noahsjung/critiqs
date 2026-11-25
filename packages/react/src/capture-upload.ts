/** Upload credentials go only to the deployment's exact authenticated capture route. */
export async function uploadCapture(
  uploadUrl: string,
  siteUrl: string,
  image: Blob,
  getToken: () => Promise<string | null>,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const url = new URL(uploadUrl);
  const proxy = url.origin === new URL(siteUrl).origin && url.pathname === "/capture/upload";
  if (url.username || url.password || (url.pathname === "/capture/upload" && !proxy)) {
    throw new Error("The screenshot upload address is not trusted.");
  }
  const headers: Record<string, string> = { "Content-Type": image.type };
  if (proxy) {
    const token = await getToken();
    if (token === null) throw new Error("Sign in again to upload the screenshot.");
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetchFn(url, { method: "POST", headers, body: image, redirect: "error" });
  if (!response.ok) throw new Error("The image could not be uploaded.");
  const result = await response.json() as { storageId?: unknown };
  if (typeof result.storageId !== "string" || result.storageId === "") throw new Error("The image could not be uploaded.");
  return result.storageId;
}
