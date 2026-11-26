// Next.js setup: adds <Critiqs /> from critiqs-react inside <body> in the App
// Router's root layout, or beside <Component {...pageProps} /> in the Pages
// Router's custom App. The app reads its project ID from
// NEXT_PUBLIC_CRITIQS_PROJECT_ID.
import { configFile, jsxAdapter } from "./jsx.mjs";
import { dependsOn } from "./shared.mjs";

/** @type {import("./types.d.mts").FrameworkAdapter} */
export const next = jsxAdapter({
  id: "next",
  name: "Next.js",
  detect: (root) => dependsOn(root, "next") || configFile(root, "next") !== null,
  build: () => "next",
});
