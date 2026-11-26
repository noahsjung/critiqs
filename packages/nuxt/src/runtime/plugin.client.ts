// Starts Critiqs in the browser once the app has mounted. Server rendering
// never loads it, and with a required project ID that is unset, neither does
// the browser. With pages (Vue Router), each route is reported to Critiqs and
// a thread's route is shown again with router.push. The app's own plugins
// can give their getContext and restoreContext through the critiqs:options hook.
import { defineNuxtPlugin, useRuntimeConfig } from "#app";
import { followRouter, routerRestore, usableRouter } from "critiqs-vue/router";
import type { CritiqsHookOptions } from "../module.ts";
import { critiqsOptions } from "./options.ts";

export default defineNuxtPlugin({
  name: "critiqs",
  setup(nuxtApp) {
    const { router: routed, ...options } = critiqsOptions(useRuntimeConfig().public.critiqs);
    if (options.requireProjectId && options.projectId === undefined) return;
    nuxtApp.hook("app:mounted", async () => {
      const own: CritiqsHookOptions = {};
      await nuxtApp.callHook("critiqs:options", own);
      const shared = await import("critiqs");
      const router = routed ? usableRouter(nuxtApp.$router) : null;
      // The app's restoreContext replaces the router's; its getContext combines with the pushed route.
      const restoreContext = own.restoreContext ?? (router === null ? undefined : routerRestore(router));
      const instance = shared.mountCritiqs({ ...options, getContext: own.getContext, restoreContext });
      if (router !== null) followRouter(router, instance);
    });
  },
});
