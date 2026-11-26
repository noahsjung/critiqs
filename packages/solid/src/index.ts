// Critiqs for Solid and SolidStart. The interface is the shared `critiqs`
// package's own app, which draws above the page in its own shadow root, so
// this component only starts it, passes setting changes on, and removes it
// when the component goes away. It renders nothing. Apps with Solid Router
// import `critiqs-solid/router` instead, which also reports routes.
import { type CritiqsProps, useCritiqs } from "./core.js";

export type { CritiqsProps } from "./core.js";
export type { HostContext, RestoreRequest } from "critiqs";

/**
 * Adds Critiqs to the page: its toolbar, sidebar, and pins. Put it once in the
 * component every page renders. Changing a property updates Critiqs; removing
 * the component removes Critiqs.
 *
 * Critiqs runs only in the browser. Under SolidStart's or Solid's server
 * rendering, the server renders nothing for it and never loads Critiqs; the
 * browser loads it, in its own chunk, after the page first renders.
 */
export function Critiqs(props: CritiqsProps): null {
  return useCritiqs(props);
}
