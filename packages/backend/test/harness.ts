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
