/**
 * A SvelteKit route ID in the `:name` form Critiqs's route convention uses:
 * `/users/[id]` -> `/users/:id`, `[[lang]]` -> `:lang?`, `[...path]` ->
 * `:path*`, keeping hyphens (`[item-id]` -> `:item-id`); matchers
 * (`[id=integer]`) and route groups (`(app)`) are dropped.
 * null when no route matched.
 */
export function routePattern(id: string | null): string | null {
	if (id === null) return null;
	const segments = id
		.split('/')
		.filter((segment) => segment !== '' && !/^\(.*\)$/.test(segment))
		.map((segment) =>
			segment
				.replace(/\[\[([\w-]+)(?:=[\w-]+)?\]\]/g, ':$1?')
				.replace(/\[\.\.\.([\w-]+)(?:=[\w-]+)?\]/g, ':$1*')
				.replace(/\[([\w-]+)(?:=[\w-]+)?\]/g, ':$1')
		);
	return `/${segments.join('/')}`;
}
