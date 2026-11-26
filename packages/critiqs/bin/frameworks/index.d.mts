import type { FrameworkAdapter } from "./types.d.mts";
export declare const FRAMEWORKS: readonly FrameworkAdapter[];
export declare function detectApp(root: string): FrameworkAdapter | null;
