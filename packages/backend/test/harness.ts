import { convexTest } from "convex-test";
import schema from "../convex/schema";

const convexDir = new URL("../convex/", import.meta.url).pathname;

// convex-test expects Vite's import.meta.glob output; build the same map with Bun.
const modules = Object.fromEntries(
  Array.from(new Bun.Glob("**/*.{ts,js}").scanSync(convexDir))
    .filter((file) => !file.endsWith(".d.ts"))
    .map((file) => [`../convex/${file}`, () => import(`${convexDir}${file}`)]),
);

/** A fresh test deployment; with `limits`, Convex's per-transaction read and write limits are enforced. */
export function setup(options: { limits?: boolean } = {}) {
  return convexTest({ schema, modules, transactionLimits: options.limits ?? false });
}

export function reviewer(name: string) {
  return {
    subject: name.toLowerCase(),
    tokenIdentifier: `https://auth.example|${name.toLowerCase()}`,
    name,
    email: `${name.toLowerCase()}@example.com`,
    // Claims as Critiqs's tokens carry them; Convex does not rename custom JWT claims.
    email_verified: true,
  };
}

export const anchor = {
  screen: "user-details",
  viewState: { tab: "permissions" },
  target: {
    purposeId: "user.department",
    recordKey: "user:alex",
    clues: { tagName: "span", role: null, label: "Sales", path: "main:1/span:1" },
  },
  scope: "record" as const,
  evidence: {
    url: "https://proto.example/users/alex?tab=permissions",
    viewport: { width: 1440, height: 900 },
    marker: { x: 10, y: 20, width: 100, height: 24 },
    capturedAt: 1,
    revision: "abc123",
    persona: "Admin",
    userAgent: "Mozilla/5.0 (Macintosh) Chrome/140",
  },
};

/** What uploads a file: a test deployment as someone signed in, `t.withIdentity(...)`. */
type Uploader = {
  mutation: (reference: any, args: any) => Promise<any>;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
};

/**
 * Uploads a file as the component does: reserved in the project for a
 * capture (`captures.generateUploadUrl`) or a page copy
 * (`mockups.generateUploadUrl`), then posted to the address it gives.
 * Returns the stored file's ID; throws with the route's refusal.
 */
export async function upload(
  who: Uploader,
  projectId: string,
  body: BlobPart,
  options: { type?: string; purpose?: "capture" | "pageCopy" } = {},
): Promise<any> {
  const { api } = await import("../convex/_generated/api");
  const purpose = options.purpose ?? "capture";
  const site = process.env.CONVEX_SITE_URL;
  process.env.CONVEX_SITE_URL ??= "https://test.convex.site";
  let address: string;
  try {
    address = await who.mutation(purpose === "capture" ? api.captures.generateUploadUrl : api.mockups.generateUploadUrl, { projectId });
  } finally {
    if (site === undefined) delete process.env.CONVEX_SITE_URL;
  }
  const url = new URL(address);
  const type = options.type ?? (purpose === "capture" ? "image/png" : "text/html");
  const response = await who.fetch(url.pathname + url.search, { method: "POST", headers: { "Content-Type": type }, body });
  if (!response.ok) throw new Error(await response.text());
  return ((await response.json()) as { storageId: string }).storageId;
}
