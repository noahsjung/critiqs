// Critiqs for Nuxt: add `critiqs-nuxt` to `modules`, and Critiqs appears above
// the app in the browser. Its settings live in public runtime config, so
// NUXT_PUBLIC_CRITIQS_PROJECT_ID (and the other NUXT_PUBLIC_CRITIQS_…
// variables) set them per deployment when the server starts.
import { addPlugin, createResolver, defineNuxtModule } from "@nuxt/kit";
import type { CritiqsOptions } from "critiqs";
import type {} from "nuxt/app";
import type { NuxtModule } from "nuxt/schema";

/** `runtimeConfig.public.critiqs`: strings are empty when unset, so environment variables can fill them. */
export interface PublicCritiqsConfig {
  projectId: string;
  requireProjectId: boolean;
  backend: string;
  version: string;
  router: boolean;
}

/** `critiqs: { … }` in nuxt.config. Each setting means what `CritiqsOptions` in the `critiqs` package documents. */
export interface ModuleOptions {
  /** The Critiqs project. NUXT_PUBLIC_CRITIQS_PROJECT_ID overrides it when the server starts. */
  projectId?: string;
  /** Show Critiqs only where the project ID is valid. On by default: an app without one shows nothing. */
  requireProjectId?: boolean;
  /** A team's own backend URL. Defaults to Critiqs Cloud. */
  backend?: string;
  /** Prototype version, such as a release label or Git commit, recorded with each message. */
  version?: string;
  /**
   * Report each page's route to Critiqs (`users/:id`) and show a thread's
   * route again with the router. On by default; false turns it off.
   */
  router?: boolean;
}

/**
 * The app's own callbacks, which a plugin in the app sets through the
 * `critiqs:options` hook before Critiqs starts. Each means what
 * `CritiqsOptions` in the `critiqs` package documents: `restoreContext`
 * replaces showing a thread's route with the router, and `getContext`'s keys
 * win over the route's, which fill in the rest.
 */
export interface CritiqsHookOptions {
  getContext?: CritiqsOptions["getContext"];
  restoreContext?: CritiqsOptions["restoreContext"];
}

declare module "nuxt/app" {
  interface RuntimeNuxtHooks {
    /** Called once in the browser, after the app mounts and before Critiqs starts: set the app's own callbacks on `options`. */
    "critiqs:options": (options: CritiqsHookOptions) => void | Promise<void>;
  }
}

/** The shared package's browser bundle, as a build manifest names it. */
const CRITIQS_BUNDLE = /(?:^|\/)critiqs\/dist\/[^/]+\.js$/;

const module: NuxtModule<ModuleOptions> = defineNuxtModule<ModuleOptions>({
  meta: { name: "critiqs-nuxt", configKey: "critiqs", compatibility: { nuxt: ">=4.0.0" } },
  defaults: {},
  setup(options, nuxt) {
    // Every key exists, even empty, so its NUXT_PUBLIC_CRITIQS_… variable can
    // override it at run time. Values already in runtimeConfig win.
    const defaults: PublicCritiqsConfig = {
      projectId: options.projectId ?? "",
      requireProjectId: options.requireProjectId ?? true,
      backend: options.backend ?? "",
      version: options.version ?? "",
      router: options.router ?? true,
    };
    nuxt.options.runtimeConfig.public.critiqs = { ...defaults, ...(nuxt.options.runtimeConfig.public.critiqs as Partial<PublicCritiqsConfig> | undefined) };
    addPlugin({ src: createResolver(import.meta.url).resolve("./runtime/plugin.client"), mode: "client" });
    // The app's types load this package, which types the critiqs:options hook.
    // Nuxt references modules listed by name itself, but not one listed as
    // ['critiqs-nuxt', { … }] or as the imported module.
    nuxt.hook("prepare:types", ({ references }) => {
      if (!references.some((reference) => "types" in reference && reference.types === "critiqs-nuxt")) references.push({ types: "critiqs-nuxt" });
    });
    // The plugin loads Critiqs only when it will show, so pages don't prefetch
    // it: a deployment without a project ID never downloads it.
    nuxt.hook("build:manifest", (manifest) => {
      for (const chunk of Object.values(manifest)) chunk.dynamicImports = chunk.dynamicImports?.filter((key) => !CRITIQS_BUNDLE.test(key));
    });
  },
});

export default module;
