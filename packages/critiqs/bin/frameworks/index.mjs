// Every framework setup knows, in detection order: a meta-framework comes
// before the library it builds on, so a Nuxt app is set up as Nuxt, not Vue.
import { angular } from "./angular.mjs";
import { astro } from "./astro.mjs";
import { django } from "./django.mjs";
import { flask } from "./flask.mjs";
import { next } from "./next.mjs";
import { nuxt } from "./nuxt.mjs";
import { rails } from "./rails.mjs";
import { react } from "./react.mjs";
import { solid } from "./solid.mjs";
import { svelte } from "./svelte.mjs";
import { sveltekit } from "./sveltekit.mjs";
import { vue } from "./vue.mjs";

/** @type {readonly import("./types.d.mts").FrameworkAdapter[]} */
export const FRAMEWORKS = [next, nuxt, sveltekit, astro, react, vue, svelte, angular, solid, rails, django, flask];

/** The framework `root` is built with, or null when setup recognizes none. */
export function detectApp(root) {
  return FRAMEWORKS.find((adapter) => adapter.detect(root)) ?? null;
}
