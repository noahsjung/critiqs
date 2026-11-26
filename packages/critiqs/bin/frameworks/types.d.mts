// The contract between the setup CLI (`critiqs init`, the MCP setup tools,
// `critiqs doctor`) and each framework's setup code. An adapter only reads
// files and returns data; the CLI asks the person, writes files, sets `.env`
// values, and prints. Each adapter lives in `./<id>.mjs` and is listed once in
// `./index.mjs`.

export type FrameworkId =
  | "react" | "next"
  | "vue" | "nuxt"
  | "svelte" | "sveltekit"
  | "angular"
  | "astro"
  | "solid"
  | "rails"
  | "django" | "flask";

/** Where the framework's Critiqs package comes from, and the command that installs it. */
export type Install =
  | { ecosystem: "npm"; packages: string[] }
  | { ecosystem: "rubygems"; gem: string }
  | { ecosystem: "pypi"; package: string };

/**
 * How a project ID set per deployment reaches the app. `build`: a public
 * variable the framework inlines when it builds (Vite's `VITE_`, Next.js's
 * `NEXT_PUBLIC_`, Nuxt's `NUXT_PUBLIC_`, SvelteKit's and Astro's `PUBLIC_`).
 * `runtime`: a server reads it from its environment on each request (Rails,
 * Django, Flask).
 */
export interface EnvConvention {
  /** The variable's name, such as `VITE_CRITIQS_PROJECT_ID`. */
  variable: string;
  /** Code that reads it where the setting is written, such as `import.meta.env.VITE_CRITIQS_PROJECT_ID`. */
  expression: string;
  readsAt: "build" | "runtime";
  /** The file setup writes for this computer, relative to the app, such as `.env.local`; null when the framework loads none. */
  localFile: string | null;
  /** One or two sentences for the person: what each deployment sets, and when it takes effect. */
  deploymentAdvice: string;
}

/** A setting as the code gives it. */
export type SettingRead =
  | { kind: "literal"; value: string }
  | { kind: "env"; variable: string }
  /** Code whose value setup can't know, such as a computed value or a spread. */
  | { kind: "expression"; text: string }
  | null;

/** Critiqs already set up in the app's code. */
export interface Usage {
  /** Absolute path. */
  file: string;
  /** 1-based. */
  line: number;
  projectId: SettingRead;
  backend: SettingRead;
  requireProjectId: boolean;
}

/** What setup wants the code to say. A project ID is either written into the code or read from `env`. */
export interface Settings {
  projectId: { literal: string } | { env: EnvConvention };
  /** Turns Critiqs off where the ID is unset; always true with `env`. */
  requireProjectId: boolean;
  /** A team's own backend, when not Critiqs Cloud. */
  backend?: string;
}

/** One file a plan writes; `original` null means a new file. */
export interface FileWrite {
  /** Absolute path. */
  file: string;
  original: string | null;
  source: string;
}

export type Plan =
  | {
      ok: true;
      action: "install" | "update" | "unchanged";
      /** Every file to write, in order. Empty for "unchanged". */
      writes: FileWrite[];
      /** Where Critiqs is, for messages: absolute path and 1-based line. */
      file: string;
      line: number;
      /** Setting names this plan adds or changes, such as ["projectId", "requireProjectId"]. */
      changed: string[];
      /** A few lines of the main change, for the person to review. */
      preview: string;
      /** Steps left to the person, such as "Run bundle install." */
      next: string[];
    }
  | {
      ok: false;
      /** "manual": this framework has no automated setup yet, or the app's layout is one setup can't edit safely. */
      reason: "manual" | "ambiguous" | "unreadable" | "expression";
      /** Complete instructions to finish by hand, naming files and lines. */
      message: string;
    };

export interface PlanOptions {
  /** A file the person chose, relative to the app, overriding where setup would put Critiqs. */
  entry: string | null;
}

export interface FrameworkAdapter {
  id: FrameworkId;
  /** As people say it: "Nuxt", "SvelteKit", "Ruby on Rails". */
  name: string;
  install: Install;
  /**
   * Whether `root` is this framework's app. Several can match (Nuxt is also
   * Vue); the CLI picks the matching adapter that appears first in the
   * registry, so meta-frameworks come before the libraries they build on.
   */
  detect(root: string): boolean;
  /** The public setting this app reads its project ID from, or null when it has no convention setup can use. `suffix` names one app of a workspace, such as `_WEB`, or is "". */
  env(root: string, suffix: string): EnvConvention | null;
  /** Critiqs already in the app's code, most often zero or one. */
  find(root: string): Usage[];
  /** Adds Critiqs where the app renders, or updates the one already there. Writes nothing. */
  plan(root: string, settings: Settings, options: PlanOptions): Plan;
  /** Complete instructions for adding Critiqs by hand with these settings. */
  manual(settings: Settings): string;
}
