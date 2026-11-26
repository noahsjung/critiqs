// Solid 2 with Solid Router 2, as `npm create solid` apps use them.
import * as Router from "@solidjs/router";
import * as Web from "@solidjs/web";
import * as Solid from "solid-js";
import { later, routesSuite } from "./routes.ts";

const PATTERNS = ["/", "/users/:id", "/files/*rest", "*404"];

routesSuite("Solid 2 with Router 2", {
  createComponent: Solid.createComponent as never,
  flush: Solid.flush,
  blockLeaving: () => Router.useBeforeLeave((event) => event.preventDefault()),
  mount(path, element, base) {
    const target = document.createElement("div");
    document.body.append(target);
    const history = Router.memoryHistory(path ?? "/");
    const routes = [
      ...PATTERNS.map((pattern) => ({ path: pattern, component: () => pattern as never })),
      { path: "/slow", component: Solid.lazy(() => new Promise<never>(() => {})) as never },
      { path: "/later", component: Solid.lazy(() => later.next(() => "later") as never) as never },
      // A layout route with a child: the screen is the child's whole pattern.
      { path: "/team", component: (props: { children?: unknown }) => props.children as never, children: [{ path: "/:member", component: () => "member" as never }] },
    ];
    const AppRouter = Router.createRouter({ routes, history, base });
    const dispose = Web.render(() => (path === null ? element() : Solid.createComponent(AppRouter, { children: (props: { children: unknown }) => [element(), props.children] } as never)) as never, target);
    return {
      go: (next) => history.set({ value: next }),
      back: () => history.back(),
      location: () => history.get() as string,
      dispose() {
        dispose();
        target.remove();
      },
    };
  },
});
