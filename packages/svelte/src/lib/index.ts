// Critiqs for Svelte and SvelteKit: <Critiqs /> adds Critiqs to the page while
// it is mounted, in the browser only. Only the small route helpers from
// `critiqs/router` load up front; the `critiqs` bundle (one 600 KB file with
// Critiqs's interface) is imported in the browser once it is used, so servers
// never load it. SvelteKit apps import `critiqs-svelte/kit`, which adds
// SvelteKit's router.
export { default as Critiqs } from './Critiqs.svelte';
export type { CritiqsProps, CritiqsRouter } from './types.js';
export type { HostContext, RestoreRequest, Scope, ViewState } from 'critiqs';

/** Elements with this attribute are covered in captures. The same as `critiqs`'s `MASK_ATTRIBUTE`, copied so importing it doesn't load that bundle. */
export const MASK_ATTRIBUTE = 'data-critiqs-mask';
