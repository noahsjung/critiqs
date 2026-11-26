// The script-tag build (`dist/critiqs.js`), a classic script for pages with
// no build of their own:
//
//   <script src="https://cdn.jsdelivr.net/npm/critiqs@<version>/dist/critiqs.js"
//           data-project-id="…" async></script>
//
// With `data-project-id` on its tag it adds Critiqs to the page, requiring a
// valid project ID (an empty or malformed one, such as an unset server
// variable, adds nothing). `data-backend` and `data-version` set the other
// settings. It also defines <critiqs-app> and exposes `window.Critiqs`:
// `setContext`, `update`, and `destroy` for the tag's Critiqs, and `mount`
// for another one. A page can set `window.Critiqs = { context: {…} }` before
// the script loads to report its view from the start.
import type { CritiqsProps, HostContext } from "../../react/src/host.ts";
import { type CritiqsInstance, mountCritiqs } from "../../react/src/mount.tsx";
import "./element.ts";

/** What `window.Critiqs` offers once the script has loaded. */
export interface CritiqsGlobal {
  /** Adds another Critiqs with these settings. */
  mount: typeof mountCritiqs;
  /** Reports the view the reviewer is on, for the script tag's Critiqs. Kept until replaced. */
  setContext(context: HostContext): void;
  /** Replaces the script tag's settings. */
  update(options: CritiqsProps): void;
  /** Removes the script tag's Critiqs. */
  destroy(): void;
}

const script = document.currentScript instanceof HTMLScriptElement ? document.currentScript : null;
const early = (window as { Critiqs?: { context?: HostContext } }).Critiqs?.context;
let pushed: HostContext = early !== undefined && typeof early === "object" ? { ...early } : {};
let instance: CritiqsInstance | null = null;

if (script?.hasAttribute("data-project-id")) {
  const text = (name: string) => script.getAttribute(name) ?? undefined;
  instance = mountCritiqs({
    projectId: text("data-project-id"),
    requireProjectId: true,
    backend: text("data-backend"),
    version: text("data-version"),
  });
  if (Object.keys(pushed).length > 0) instance.setContext(pushed);
}

const api: CritiqsGlobal = {
  mount: mountCritiqs,
  setContext(context) {
    pushed = { ...context };
    instance?.setContext(pushed);
  },
  update(options) {
    if (instance !== null) {
      instance.update(options);
      return;
    }
    instance = mountCritiqs(options);
    if (Object.keys(pushed).length > 0) instance.setContext(pushed);
  },
  destroy() {
    instance?.destroy();
    instance = null;
  },
};
(window as { Critiqs?: CritiqsGlobal }).Critiqs = api;
document.dispatchEvent(new CustomEvent("critiqs:ready"));
