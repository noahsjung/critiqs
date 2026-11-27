import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * The headers a review link's page (/r/<key>) and a project's review links
 * (/review-links/<id>) need from whatever serves the website: never framed by
 * another site, no referrer, kept out of search engines, and frames only from
 * the review proxy's lease hosts when CRITIQS_REVIEW_FRAMES (such as
 * `https://*.critiqs-review.net`) names them. Set here for `vite` and
 * `vite preview`; the website's host sets the same (site/vercel.json, which
 * serves the app on the landing site's origin, checked against this function
 * by test/review-page-details.test.tsx).
 */
export function reviewPageHeaders(frames: string | undefined): Record<string, string> {
  const policy = ["frame-ancestors 'none'", ...(frames ? [`frame-src ${frames}`] : [])].join("; ");
  return { "Content-Security-Policy": policy, "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" };
}

/** The paths those headers cover. */
export const REVIEW_PATHS = ["/r/", "/review-links/"] as const;

/** The review headers for a request's path, or null for the website's other pages. */
export function reviewHeadersFor(url: string | undefined, frames: string | undefined): Record<string, string> | null {
  return REVIEW_PATHS.some((prefix) => url?.startsWith(prefix)) ? reviewPageHeaders(frames) : null;
}

function reviewHeaders(): Plugin {
  const frames = process.env.CRITIQS_REVIEW_FRAMES;
  // Returns nothing: a function returned from these hooks would run after Vite's own middleware.
  const apply = (server: { middlewares: { use(handler: (req: { url?: string }, res: { setHeader(name: string, value: string): void }, next: () => void) => void): unknown } }): void => {
    server.middlewares.use((req, res, next) => {
      for (const [name, value] of Object.entries(reviewHeadersFor(req.url, frames) ?? {})) res.setHeader(name, value);
      next();
    });
  };
  return { name: "critiqs-review-headers", configureServer: apply, configurePreviewServer: apply };
}

// Every path serves index.html, so /start and /setup/<id> both load the app.
export default defineConfig({ plugins: [react(), reviewHeaders()], appType: "spa" });
