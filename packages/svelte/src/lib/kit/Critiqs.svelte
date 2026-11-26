<!--
	<Critiqs /> for SvelteKit: the same component, with SvelteKit's router.
	Each navigation reports its route (`users/:id`, with `route.id` in the view
	state), and a thread's route is shown again with `goto` unless the app gives
	its own restoreContext. `router={false}` turns that off.
-->
<script lang="ts">
	import { VERSION } from '@sveltejs/kit';
	import { beforeNavigate, goto, preloadData } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { navigating, page } from '$app/state';
	import type { RestoreRequest } from 'critiqs';
	import { routeContext } from 'critiqs/router';
	import Critiqs from '../Critiqs.svelte';
	import type { CritiqsRouter } from '../types.js';
	import type { KitCritiqsProps } from './types.js';
	import { routePattern } from './route.js';

	let { router = true, ...settings }: KitCritiqsProps = $props();

	/** The restore whose `goto` is under way, so the navigation it starts can be checked before it happens. */
	let restoring: RestoreRequest | null = null;

	// A path can match another route than the thread's (a catch-all `[...rest]` matches
	// `/user-details`), and the reviewer can close the thread meanwhile: either way, stay put.
	beforeNavigate((navigation) => {
		if (restoring === null || navigation.type !== 'goto') return;
		const id = navigation.to?.route.id ?? null;
		if (restoring.signal.aborted || id === null || routeContext(routePattern(id)!, {}).screen !== restoring.screen) navigation.cancel();
	});

	/** A page's address as `goto` takes it, ignoring a trailing slash SvelteKit may add or drop. */
	const address = (url: Pick<URL, 'pathname' | 'search'>) => `${url.pathname.replace(/(.)\/$/, '$1')}${url.search}`;

	const kitRouter: CritiqsRouter = {
		get pattern() {
			return routePattern(page.route.id);
		},
		get params() {
			// SvelteKit 3's typed matchers can give numbers; Critiqs reports them as text.
			return page.params;
		},
		// `resolve` adds the app's base path (typed for the app's own routes, so widened here).
		// `preloadData` throws when none of the app's routes matches, so a screen that isn't
		// one (an app's own `user-details`) never opens a 404; a load that fails or redirects
		// stays put too. `goto` then reuses what it loaded and resolves once the navigation
		// has settled.
		async navigate(path: string, request: RestoreRequest) {
			// SvelteKit runs no beforeNavigate during another navigation, so the check above
			// couldn't stop a path another route matches; and `goto` would cut that navigation short.
			if (navigating.type !== null) return;
			const href = (resolve as (path: string) => string)(path);
			const preloaded = await preloadData(href);
			if (request.signal.aborted || navigating.type !== null || preloaded.type !== 'loaded' || preloaded.status >= 400) return;
			const from = new URL(page.url.href);
			restoring = request;
			try {
				await goto(href);
			} finally {
				restoring = null;
			}
			// Aborted once SvelteKit had begun loading the route: if it was shown anyway and the
			// app hasn't navigated since, put back the page the reviewer was on.
			if (request.signal.aborted && navigating.type === null && address(page.url) === address(new URL(href, from))) {
				const back = `${from.pathname}${from.search}${from.hash}`;
				// SvelteKit 3 renamed `replaceState` to `replace`.
				await (goto as (url: string, options: Record<string, boolean>) => Promise<void>)(back, VERSION.startsWith('2.') ? { replaceState: true } : { replace: true });
			}
		}
	};
</script>

<Critiqs {...settings} router={router === false ? undefined : kitRouter} />
