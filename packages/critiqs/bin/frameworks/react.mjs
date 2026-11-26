// React setup: adds <Critiqs /> from critiqs-react where the app renders,
// such as beside <App /> in createRoot(…).render(…). A Vite app reads its
// project ID from VITE_CRITIQS_PROJECT_ID; other builds get it written in.
import { jsxAdapter, usesVite } from "./jsx.mjs";
import { dependsOn } from "./shared.mjs";

/** @type {import("./types.d.mts").FrameworkAdapter} */
export const react = jsxAdapter({
  id: "react",
  name: "React",
  detect: (root) => dependsOn(root, "react") && dependsOn(root, "react-dom"),
  build: (root) => (usesVite(root) ? "vite" : null),
});
