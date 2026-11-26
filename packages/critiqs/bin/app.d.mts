import type { AppDescription, EnvTarget } from "./env.mjs";
import type { EnvConvention, FileWrite, FrameworkAdapter, Settings, Usage } from "./frameworks/types.d.mts";

export declare function shown(cwd: string, path: string): string;
export declare function isFolder(path: string): boolean;
export declare function isFile(path: string): boolean;
export declare function packageOf(adapter: FrameworkAdapter): string;
/** A path as a shell reads it: as it is when that's safe, otherwise in double quotes. */
export declare function quoted(path: string): string;
export interface LocatedApp {
  /** The first of `candidates`. */
  adapter: FrameworkAdapter;
  /**
   * Adapters that could connect the app, the app's framework's first, each with the Critiqs it sees: with Critiqs in the code, the
   * frameworks the app uses whose adapters see all of it (or the one adapter that does, when none of them does); without, the app's
   * framework's (or React's), and with an entry, the other frameworks' the app uses too.
   */
  candidates: { adapter: FrameworkAdapter; usages: Usage[] }[];
  /** The adapter of the framework the app is built with, or null when setup recognizes none. */
  framework: FrameworkAdapter | null;
  /** Critiqs already in the code. */
  usages: Usage[];
  /** Set when different framework packages each set up Critiqs: why setup changes nothing. */
  problem: string | null;
  /** Why the app's framework's adapter couldn't read its code, when it couldn't. */
  error?: unknown;
}
export declare function locateApp(root: string, cwd?: string, options?: { entry?: string | null }): LocatedApp;
export declare const UNRECOGNIZED: string;

interface WiringBase {
  adapter: FrameworkAdapter;
  /** Whether setup recognized the app's framework; when not, `adapter` is React's. */
  detected: boolean;
  app: AppDescription;
  envFile: string | null;
  /** Critiqs already in the code (see `locateApp`). */
  usages: Usage[];
  problem: string | null;
}
export type Wiring = (WiringBase & { mode: "literal" }) | (WiringBase & { mode: "env"; env: EnvConvention });

/** How setup connects the app; with several candidate adapters, the first whose plan can, with `entry` and `mount`. */
export declare function chooseWiring(root: string, options?: { envFile?: string | null; cwd?: string; entry?: string | null; mount?: string | null }): Wiring;
export declare function connectionSettings(wiring: Wiring, projectId: string, backend?: string | null): Settings;
export declare function envTargetOf(wiring: Wiring): EnvTarget | null;
export declare function readLocalValue(wiring: Wiring & { mode: "env" }, shell?: Record<string, string | undefined>): { value: string; file: string | null } | null;
export declare function installStep(adapter: FrameworkAdapter, root: string, cwd?: string): string | null;

export interface Written {
  ok: boolean;
  message: string;
  /** Why the adapter refused, when it did; "unreadable-env" when `file` is a `.env` file the app loads that setup can't read. */
  reason?: string;
  action?: "install" | "update" | "unchanged";
  file?: string;
  line?: number;
  changed?: string[];
  installed?: boolean;
  preview?: string;
  writes?: FileWrite[];
  /** Steps only the person can take: installing the framework's package, and the adapter's own. */
  next?: string[];
  /**
   * For an environment-backed project ID: the variable, the file set on this
   * computer (null where the framework loads none), and what each deployment
   * does. `changed`: this computer didn't already give the app this ID, so
   * setup set it in `file`, or with `file` null, the person still sets it.
   */
  env?: { name: string; file: string | null; advice: string; changed?: boolean; ignored?: boolean | null };
}
export declare function writeConnection(args: {
  root: string;
  cwd?: string;
  wiring: Wiring;
  projectId: string;
  backend?: string;
  dryRun?: boolean;
  entry?: string | null;
  mount?: string | null;
  /** The shell's environment, read where the framework loads no `.env` file. */
  shell?: Record<string, string | undefined>;
}): Written;
export declare function readUsage(root: string, cwd?: string): { error: string; missing?: boolean } | { usage: Usage };
export declare function workspaceApps(root: string): string[] | null;
export declare function workspaceRefusal(apps: string[], folder: string, show: (dir: string) => string, command: string): string;
