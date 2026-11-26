// Critiqs for SvelteKit: <Critiqs /> with SvelteKit's router, so threads name
// routes (`users/:id`) and are shown again with `goto`. Needs SvelteKit 2.26 or
// later; plain Svelte apps import `critiqs-svelte` instead.
export { default as Critiqs } from './Critiqs.svelte';
export type { KitCritiqsProps as CritiqsProps } from './types.js';
export type { HostContext, RestoreRequest, Scope, ViewState } from 'critiqs';
export { MASK_ATTRIBUTE } from '../index.js';
