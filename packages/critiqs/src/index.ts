// Critiqs for any web app. The interface is Critiqs's own React app, bundled
// here with its own copy of React, so the host app needs no framework at all.
// Framework packages (critiqs-vue, critiqs-svelte, …) call `mountCritiqs`
// from their components; `critiqs/element` defines <critiqs-app> for pages
// without a JavaScript build.
export { type CritiqsInstance, mountCritiqs } from "../../react/src/mount.tsx";
export type { CritiqsProps as CritiqsOptions, HostContext, RestoreRequest } from "../../react/src/host.ts";
export { MASK_ATTRIBUTE } from "../../react/src/constants.ts";
export type { Scope, ViewState } from "@critiqs/core";
export { ROUTE_PARAM_PREFIX, type RouteParam, routeContext, routePath } from "./router.ts";
