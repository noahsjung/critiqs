/** A stand-in for SvelteKit's `page` from `$app/state`: reactive, changed by tests to navigate. */
export const page = $state({
	route: { id: /** @type {string | null} */ ('/') },
	params: /** @type {Record<string, string | number>} */ ({}),
	url: new URL('http://localhost/base/')
});
/** A stand-in for SvelteKit's `navigating` from `$app/state`: its `type` is set while a navigation is under way. */
export const navigating = $state({ type: /** @type {string | null} */ (null) });
