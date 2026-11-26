// The Astro integration: `critiqs()` in astro.config's `integrations` adds a
// script to every page that starts Critiqs in the browser. Astro builds the
// script with the page, so a project ID read from a public environment
// variable is written into the site when it builds. Nothing runs on the server.
//
// Routes: the script carries the site's route list (each route's pattern and
// the regular expression Astro matches it with, in Astro's priority order),
// so the browser finds the current page's route from its URL, on the first
// page and after each <ClientRouter /> navigation alike. One script serves
// every page, so a per-page value would mean rewriting each page's HTML.
import type { AstroIntegration, IntegrationResolvedRoute } from "astro";
import type { RouteTable } from "./client.ts";

/** The public variable Critiqs reads its project ID from when the config doesn't give one. */
export const DEFAULT_PROJECT_ID_VARIABLE = "PUBLIC_CRITIQS_PROJECT_ID";

export interface CritiqsAstroOptions {
  /**
   * The Critiqs project for this site. Without it, Critiqs reads the project
   * ID from `projectIdVariable` when the site builds.
   */
  projectId?: string;
  /**
   * The public environment variable that holds the project ID, read when
   * `projectId` isn't set. Defaults to `PUBLIC_CRITIQS_PROJECT_ID`; Astro only
   * gives the browser variables that start with `PUBLIC_`.
   */
  projectIdVariable?: string;
  /**
   * Show Critiqs only where the project ID is a valid project ID; without one,
   * Critiqs adds nothing to the page. Defaults to true when the project ID
   * comes from the environment, so a deployment without the variable shows no
   * Critiqs, and false when `projectId` is set, as in `CritiqsOptions`.
   */
  requireProjectId?: boolean;
  /** A team's own backend URL. Defaults to Critiqs's hosted service. */
  backend?: string;
  /** Prototype version, such as a release label or Git commit, recorded with each message. */
  version?: string;
  /**
   * Report each page's route as the screen (`items/:id` for
   * `src/pages/items/[id].astro`) and open a thread's page to show it.
   * Defaults to true; false leaves the screen as the URL path.
   */
  router?: boolean;
}

const ROUTES_MODULE = "virtual:critiqs-astro/routes";
const RESOLVED_ROUTES_MODULE = `\0${ROUTES_MODULE}`;

/** Adds Critiqs to every page of the site. */
export default function critiqs(options: CritiqsAstroOptions = {}): AstroIntegration {
  const script = pageScript(options);
  const router = options.router ?? true;
  let table: RouteTable = { base: "/", trailingSlash: "ignore", routes: [] };
  let invalidate = () => {};
  return {
    name: "critiqs-astro",
    hooks: {
      "astro:config:setup": ({ addMiddleware, injectScript, updateConfig }) => {
        if (router) {
          // Marks each page with its route, so restoring a thread can tell its page from the 404 page at the same URL.
          addMiddleware({ order: "pre", entrypoint: new URL("./middleware.js", import.meta.url) });
          updateConfig({
            vite: {
              plugins: [
                {
                  name: "critiqs-astro:routes",
                  resolveId: (id) => (id === ROUTES_MODULE ? RESOLVED_ROUTES_MODULE : undefined),
                  load: (id) => (id === RESOLVED_ROUTES_MODULE ? `export default ${JSON.stringify(table)};` : undefined),
                },
              ],
            },
          });
        }
        injectScript("page", script);
      },
      // The final config, after every integration's changes; the route module reads it when Vite loads it.
      "astro:config:done": ({ config }) => {
        table = { ...table, base: config.base, trailingSlash: config.trailingSlash };
      },
      "astro:server:setup": ({ server }) => {
        // Pages added while the dev server runs: the next page load gets the new list.
        invalidate = () => {
          for (const environment of Object.values(server.environments)) {
            const module = environment.moduleGraph.getModuleById(RESOLVED_ROUTES_MODULE);
            if (module !== undefined) environment.moduleGraph.invalidateModule(module);
          }
        };
      },
      "astro:routes:resolved": ({ routes }) => {
        table = { ...table, routes: routes.filter(isPage).map(toRoute) };
        invalidate();
      },
    },
  };
}

/** Pages a visitor can be on: not endpoints, redirects, or Astro's own routes. */
function isPage(route: IntegrationResolvedRoute): boolean {
  return (route.type === "page" || route.type === "fallback") && route.origin !== "internal";
}

/** A route as the browser matches it: its pattern in `:name` form, and Astro's own pattern, regular expression and parameter names. */
function toRoute(route: IntegrationResolvedRoute): RouteTable["routes"][number] {
  const pattern = route.segments.map((segment) => "/" + segment.map((part) => (part.spread ? `:${part.content.slice(3)}*` : part.dynamic ? `:${part.content}` : part.content)).join("")).join("");
  return {
    pattern: pattern === "" ? "/" : pattern,
    route: route.pattern,
    regex: route.patternRegex.source,
    params: route.params.map((name) => name.replace(/^\.\.\./, "")),
  };
}

/** The module added to every page, checked here so a mistake in astro.config stops the build with a clear message. */
function pageScript(options: CritiqsAstroOptions): string {
  const fail = (message: string): never => {
    throw new Error(`critiqs-astro: ${message}`);
  };
  for (const key of ["projectId", "projectIdVariable", "backend", "version"] as const) {
    if (options[key] !== undefined && typeof options[key] !== "string") fail(`${key} must be a string.`);
  }
  for (const key of ["requireProjectId", "router"] as const) {
    if (options[key] !== undefined && typeof options[key] !== "boolean") fail(`${key} must be true or false.`);
  }
  if (options.projectId !== undefined && options.projectIdVariable !== undefined) {
    fail("set projectId or projectIdVariable, not both: projectId is written into the config, projectIdVariable names the variable that holds it.");
  }
  const variable = options.projectIdVariable ?? DEFAULT_PROJECT_ID_VARIABLE;
  if (!/^PUBLIC_[A-Za-z0-9_]+$/.test(variable)) {
    fail(`projectIdVariable ${JSON.stringify(variable)} must be a variable name starting with PUBLIC_, which Astro gives the browser.`);
  }

  const fromEnv = options.projectId === undefined;
  const settings = {
    requireProjectId: options.requireProjectId ?? fromEnv,
    ...(options.backend !== undefined && { backend: options.backend }),
    ...(options.version !== undefined && { version: options.version }),
  };
  const projectId = fromEnv ? `import.meta.env.${variable}` : JSON.stringify(options.projectId);
  const start = `startCritiqs({ ...${JSON.stringify(settings)}, projectId: ${projectId} }`;
  if (options.router === false) return `import { startCritiqs } from "critiqs-astro/client";\n${start});\n`;
  // The router module is loaded only to navigate on a page with <ClientRouter />, which has already loaded it.
  return [
    `import { startCritiqs } from "critiqs-astro/client";`,
    `import routes from "${ROUTES_MODULE}";`,
    `${start}, { routes, navigate: (href) => import("astro:transitions/client").then((router) => router.navigate(href)) });`,
    "",
  ].join("\n");
}
