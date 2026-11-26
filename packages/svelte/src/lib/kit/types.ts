import type { CritiqsProps } from '../types.js';

export interface KitCritiqsProps extends Omit<CritiqsProps, 'router'> {
	/** Reports SvelteKit routes and shows a thread's route again with `goto`; `false` turns that off. */
	router?: boolean;
}
