<!--
	Adds Critiqs to the page while this component is mounted. It renders nothing
	in place: Critiqs draws above the app in its own shadow root on the page's
	body. Critiqs runs only in the browser, so server rendering and prerendering
	output nothing for it, and the `critiqs` bundle is loaded on first use.
-->
<script lang="ts">
	import type { CritiqsInstance, CritiqsOptions, RestoreRequest } from 'critiqs';
	import { ROUTE_PARAM_PREFIX, routeContext, routePath } from 'critiqs/router';
	import type { CritiqsProps } from './types.js';

	let { projectId, requireProjectId, backend, version, getContext, restoreContext, router }: CritiqsProps = $props();

	let instance: CritiqsInstance | null = null;
	let loading = false;
	let destroyed = false;

	/** Whether the router shows the request's screen, with the same route parameters. */
	function showing(request: RestoreRequest): boolean {
		if (router === undefined || router.pattern === null) return false;
		const current = routeContext(router.pattern, router.params);
		if (current.screen !== request.screen) return false;
		const keys = new Set([...Object.keys(current.viewState), ...Object.keys(request.viewState)].filter((key) => key.startsWith(ROUTE_PARAM_PREFIX)));
		return [...keys].every((key) => current.viewState[key] === request.viewState[key]);
	}

	/**
	 * Navigates the router to a thread's route, unless the app is already on it.
	 * true only when the router then shows that route: a guard that cancels the
	 * navigation, a redirect, or a screen that isn't one of the app's routes
	 * (an app's own `user-details`) gives false.
	 */
	async function restoreRoute(request: RestoreRequest): Promise<boolean> {
		if (router === undefined) return false;
		const path = routePath(request);
		// A parameter routePath couldn't fill (several in one segment, such as `:slug-:id`) leaves no real address.
		if (path === null || path.includes(':')) return false;
		if (showing(request)) return true;
		if (request.signal.aborted) return false;
		try {
			await router.navigate(path, request);
		} catch {
			return false;
		}
		return !request.signal.aborted && showing(request);
	}

	// Whether there is a router changes rarely; its route changes on every navigation.
	const routed = $derived(router !== undefined);

	// The app's own restoreContext replaces the router's.
	const options = (): CritiqsOptions => ({
		projectId,
		requireProjectId,
		backend,
		version,
		getContext,
		restoreContext: restoreContext ?? (routed ? restoreRoute : undefined)
	});

	/** Pushes the current route, so `getContext` (when given) adds to it; nothing without a router. */
	function pushRoute() {
		instance?.setContext(router?.pattern == null ? {} : routeContext(router.pattern, router.params));
	}

	$effect(() => () => {
		destroyed = true;
		instance?.destroy();
		instance = null;
	});

	$effect(() => {
		const current = options();
		if (instance !== null) {
			instance.update(current);
			return;
		}
		// A required project ID that is unset is how a deployment turns Critiqs off, so its visitors never download it.
		if (loading || (current.requireProjectId === true && !current.projectId?.trim())) return;
		loading = true;
		import('critiqs').then(
			(loaded) => {
				if (destroyed) return;
				// Settings may have changed while the bundle loaded; mount with the latest.
				instance = loaded.mountCritiqs(options());
				pushRoute();
			},
			(error: unknown) => {
				loading = false;
				console.error('Critiqs: could not load the critiqs package.', error);
			}
		);
	});

	$effect(() => {
		// Read on every navigation, before the bundle has loaded too, so later routes re-run this.
		void [router?.pattern, ...Object.entries(router?.params ?? {}).flat()];
		pushRoute();
	});
</script>
