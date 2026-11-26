// The integration as Astro runs its hooks: the script it adds to every page,
// and the route list that script reads.
import { expect, test } from "bun:test";
import type { AstroIntegration, IntegrationResolvedRoute } from "astro";
import critiqs, { type CritiqsAstroOptions } from "../src/index.ts";

const PROJECT = "js71q5kzssedhq0rp6myv7zdf58gbb1t";

/**
 * Runs the integration's hooks as `astro build` does and returns the page
 * script and the route module's code. `config` is the final config, as
 * `astro:config:done` gets it; setup sees Astro's defaults, as it does
 * before a later integration changes them.
 */
function build(options?: CritiqsAstroOptions, routes: Partial<IntegrationResolvedRoute>[] = [], config = { base: "/", trailingSlash: "ignore" }) {
  const integration: AstroIntegration = critiqs(options);
  const scripts: [string, string][] = [];
  const middlewares: { order: string; entrypoint: string | URL }[] = [];
  const plugins: { resolveId: (id: string) => string | undefined; load: (id: string) => string | undefined }[] = [];
  const setup = integration.hooks["astro:config:setup"] as (params: unknown) => void;
  setup({
    config: { base: "/", trailingSlash: "ignore" },
    injectScript: (stage: string, content: string) => scripts.push([stage, content]),
    addMiddleware: (middleware: { order: string; entrypoint: string | URL }) => middlewares.push(middleware),
    updateConfig: (update: { vite: { plugins: never[] } }) => plugins.push(...update.vite.plugins),
  });
  (integration.hooks["astro:config:done"] as ((params: unknown) => void) | undefined)?.({ config });
  (integration.hooks["astro:routes:resolved"] as (params: unknown) => void)({ routes });
  const routeModule = () => {
    const plugin = plugins[0];
    const id = plugin?.resolveId("virtual:critiqs-astro/routes");
    return id === undefined ? null : plugin!.load(id)!;
  };
  return { scripts, routeModule, middlewares };
}

/** A route as Astro resolves `src/pages/<file>`, with the fields the integration reads. */
function route(pattern: string, segments: { content: string; dynamic: boolean; spread: boolean }[][], regex: RegExp, params: string[], extra: Partial<IntegrationResolvedRoute> = {}): Partial<IntegrationResolvedRoute> {
  return { pattern, segments, patternRegex: regex, params, type: "page", origin: "project", ...extra };
}
const text = (content: string) => ({ content, dynamic: false, spread: false });
const param = (content: string) => ({ content, dynamic: true, spread: content.startsWith("...") });

test("a project ID read from PUBLIC_CRITIQS_PROJECT_ID is required, and routes are on", () => {
  const { scripts } = build();
  expect(scripts).toHaveLength(1);
  const [stage, script] = scripts[0]!;
  expect(stage).toBe("page");
  expect(script).toContain('startCritiqs({ ...{"requireProjectId":true}, projectId: import.meta.env.PUBLIC_CRITIQS_PROJECT_ID }');
  expect(script).toContain('import routes from "virtual:critiqs-astro/routes";');
  expect(script).toContain('import("astro:transitions/client")');
});

test("a project ID written in the config isn't required unless asked, and other settings pass through", () => {
  const [[, script]] = build({ projectId: PROJECT, backend: "https://critiqs.example.com", version: "v2" }).scripts as [[string, string]];
  expect(script).toContain(`{"requireProjectId":false,"backend":"https://critiqs.example.com","version":"v2"}, projectId: "${PROJECT}"`);
  const [[, required]] = build({ projectId: PROJECT, requireProjectId: true }).scripts as [[string, string]];
  expect(required).toContain('"requireProjectId":true');
  const [[, named]] = build({ projectIdVariable: "PUBLIC_REVIEW_PROJECT" }).scripts as [[string, string]];
  expect(named).toContain("projectId: import.meta.env.PUBLIC_REVIEW_PROJECT");
});

test("routes on: a middleware marks each page with the route it was rendered from", () => {
  const { middlewares } = build();
  expect(middlewares).toHaveLength(1);
  expect(String(middlewares[0]!.entrypoint)).toEndWith("/middleware.js");
});

test("routes off: no route list, no navigation, no route marker", () => {
  const { scripts, routeModule, middlewares } = build({ router: false });
  expect(middlewares).toEqual([]);
  expect(scripts[0]![1]).not.toContain("routes");
  expect(scripts[0]![1]).not.toContain("astro:transitions");
  expect(routeModule()).toBeNull();
});

test("mistakes in astro.config stop the build with a clear message", () => {
  expect(() => critiqs({ projectId: 42 as never })).toThrow("critiqs-astro: projectId must be a string.");
  expect(() => critiqs({ router: "yes" as never })).toThrow("router must be true or false.");
  expect(() => critiqs({ projectId: PROJECT, projectIdVariable: "PUBLIC_X" })).toThrow("not both");
  expect(() => critiqs({ projectIdVariable: "CRITIQS_PROJECT_ID" })).toThrow("must be a variable name starting with PUBLIC_");
});

test("the page script gets the site's pages in Astro's order, as `:name` patterns with Astro's own matching, under the final config's base", () => {
  const routes = [
    route("/items/[id]", [[text("items")], [param("id")]], /^\/items\/([^/]+?)\/?$/, ["id"]),
    route("/docs/[...slug]", [[text("docs")], [param("...slug")]], /^\/docs(?:\/(.*?))?\/?$/, ["...slug"]),
    route("/[lang]-[version]", [[param("lang"), text("-"), param("version")]], /^\/([^/]+?)-([^/]+?)\/?$/, ["lang", "version"]),
    route("/api/items", [[text("api"), text("items")]], /^\/api\/items\/?$/, [], { type: "endpoint" }),
    route("/old", [[text("old")]], /^\/old\/?$/, [], { type: "redirect" }),
    route("/_image", [[text("_image")]], /^\/_image\/?$/, [], { type: "endpoint", origin: "internal" }),
    route("/", [], /^\/$/, []),
  ];
  const { routeModule } = build({}, routes, { base: "/shop", trailingSlash: "always" });
  expect(routeModule()).toBe(
    `export default ${JSON.stringify({
      base: "/shop",
      trailingSlash: "always",
      routes: [
        { pattern: "/items/:id", route: "/items/[id]", regex: "^\\/items\\/([^/]+?)\\/?$", params: ["id"] },
        { pattern: "/docs/:slug*", route: "/docs/[...slug]", regex: "^\\/docs(?:\\/(.*?))?\\/?$", params: ["slug"] },
        { pattern: "/:lang-:version", route: "/[lang]-[version]", regex: "^\\/([^/]+?)-([^/]+?)\\/?$", params: ["lang", "version"] },
        { pattern: "/", route: "/", regex: "^\\/$", params: [] },
      ],
    })};`,
  );
});
