import type { CritiqsOptions, RestoreRequest } from 'critiqs';
import type { RouteParam } from 'critiqs/router';

/**
 * The app's router as Critiqs uses it: the current route, reported on every
 * navigation so threads name `users/:id` rather than `/users/42`, and a way to
 * navigate back to a thread's route when the app gives no `restoreContext`.
 */
export interface CritiqsRouter {
	/** The current route's pattern in `:name` form, such as `/users/:id`; null when no route matched. */
	pattern: string | null;
	/** The current route's parameters, such as `{ id: "42" }`; typed values (`{ id: 42 }`) are reported as text. */
	params: Record<string, RouteParam>;
	/**
	 * Navigates to a thread's path, such as `/users/42`, built from `request`.
	 * Resolves once the navigation has settled, with `pattern` and `params`
	 * showing where it went (a restore counts only when that is the thread's
	 * route); throw when the path is none of the app's routes. A router that can
	 * tell beforehand can stay put when the path would show another route than
	 * `request.screen`, or once `request.signal` is aborted.
	 */
	navigate(path: string, request: RestoreRequest): unknown;
}

export interface CritiqsProps extends CritiqsOptions {
	/** Reports routes to Critiqs and shows a thread's route again; see the README's "Routes". */
	router?: CritiqsRouter | undefined;
}
